#if DEBUG
import AletheModel
import AppKit

/// Debug-only check of the sidebar drag geometry inside the running app, for when nobody can drag by hand:
/// `defaults write com.kc1t.alethe.mac debug.sidebarDragSelfTest -bool true`, then launch. It cross-checks the
/// registered row frames against the List's own table rows and feeds synthetic pointer positions through
/// `SidebarWebDropRules`. The report lands in `~/Library/Application Support/com.kc1t.alethe.mac/logs/sidebar-drag-selftest.log`.
@MainActor
enum SidebarDragSelfTest {
    static var enabled: Bool { UserDefaults.standard.bool(forKey: "debug.sidebarDragSelfTest") }

    static func run(state: SidebarWebDragState, geometry: SidebarDropGeometry, document: @escaping () -> WorkspaceDocument,
                    restore: @escaping () -> Void) async {
        try? await Task.sleep(for: .seconds(3))
        var report: [String] = ["\(Date()) sidebar drag self-test"]
        defer { write(report) }
        guard let surface = geometry.surface, let window = surface.window else {
            report.append("FAIL no surface or window")
            return
        }
        let size = surface.bounds.size
        report.append("window visible=\(window.isVisible) onActiveSpace=\(window.isOnActiveSpace) surface=\(Int(size.width))x\(Int(size.height))")
        report.append("window key=\(window.isKeyWindow) main=\(window.isMainWindow) mini=\(window.isMiniaturized) occluded=\(!window.occlusionState.contains(.visible)) fullscreen=\(window.styleMask.contains(.fullScreen)) frame=\(window.frame) screen=\(window.screen?.frame.debugDescription ?? "nil")")
        report.append("app active=\(NSApp.isActive) hidden=\(NSApp.isHidden) windows=\(NSApp.windows.map { "\(type(of: $0))#\($0.windowNumber)v=\($0.isVisible)k=\($0.isKeyWindow)" }.joined(separator: ","))")
        let regions = geometry.regions()
        report.append("regions=\(regions.count)")
        guard !regions.isEmpty else {
            report.append("FAIL no registered regions (sidebar not laid out)")
            return
        }
        func r(_ rect: CGRect) -> String { "(\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height)))" }
        for region in regions.sorted(by: { $0.hit.minY < $1.hit.minY }) {
            report.append("  \(region.target) hit=\(r(region.hit)) visual=\(r(region.visual))")
        }

        // 1. The probes must agree with the table's own row frames (rows without a project or header region,
        // such as terminals, are skipped).
        if let table = findTable(from: surface) {
            var worst: CGFloat = 0
            var matched = 0
            var skipped = 0
            let rows = table.rows(in: table.visibleRect)
            let rowRegions = regions.filter {
                if case .project = $0.target { return true }
                if case .groupHeader = $0.target { return true }
                return false
            }
            for row in rows.location..<(rows.location + rows.length) {
                var rect = surface.convert(table.rect(ofRow: row), from: table)
                if !surface.isFlipped { rect.origin.y = surface.bounds.height - rect.maxY }
                let best = rowRegions.max { $0.hit.intersection(rect).height < $1.hit.intersection(rect).height }
                if let best, best.hit.intersection(rect).height >= 0.5 * min(rect.height, best.hit.height) {
                    matched += 1
                    worst = max(worst, abs(best.hit.minY - rect.minY), abs(best.hit.maxY - rect.maxY))
                } else {
                    skipped += 1
                }
            }
            report.append("table rows matched=\(matched) skipped=\(skipped) worstEdgeDelta=\(String(format: "%.1f", worst))pt \(matched > 0 && worst <= 2 ? "PASS" : "CHECK")")
        } else {
            report.append("CHECK no NSTableView found to cross-check")
        }

        // 2. Rules applied on live geometry.
        let doc = document()
        let projectRows = regions.compactMap { region -> (ProjectID, SidebarDropRegion)? in
            if case .project(let id) = region.target { return (id, region) }
            return nil
        }
        let headers = regions.compactMap { region -> (GroupID, SidebarDropRegion)? in
            if case .groupHeader(let id) = region.target { return (id, region) }
            return nil
        }
        var failures = 0
        func check(_ name: String, _ source: SidebarWebDropRules.Source, _ point: CGPoint,
                   expect target: SidebarWebDropTarget, _ edge: SidebarDropEdge) {
            let hit = SidebarWebDropRules.resolve(source, regions: regions, at: point, width: size.width, in: doc)
            let ok = hit?.region.target == target && hit?.edge == edge
            if !ok { failures += 1 }
            report.append("\(ok ? "PASS" : "FAIL") \(name) at (\(Int(point.x)),\(Int(point.y))) -> \(hit.map { "\($0.region.target) \($0.edge)" } ?? "none"), expected \(target) \(edge)")
        }
        if let any = projectRows.first {
            for (id, region) in projectRows {
                let source = projectRows.first { $0.0 != id }?.0 ?? any.0
                let x = region.visual.midX
                check("project over row top", .item(.project(source)), CGPoint(x: x, y: region.visual.minY + 2), expect: .project(id), .before)
                check("project over row bottom", .item(.project(source)), CGPoint(x: x, y: region.visual.maxY - 2), expect: .project(id), .after)
            }
            let source = any.0
            for (group, region) in headers {
                check("project over header", .item(.project(source)), CGPoint(x: region.visual.midX, y: region.visual.midY),
                      expect: .groupHeader(group), .inside)
            }
        }
        for (group, region) in headers {
            guard let other = headers.first(where: { $0.0 != group && !doc.isGroup(group, inside: $0.0) && !doc.isGroup($0.0, inside: group) })?.0 else { continue }
            check("group over header top", .item(.group(other)), CGPoint(x: region.visual.midX, y: region.visual.minY + 2),
                  expect: .groupHeader(group), .before)
            check("group over header bottom", .item(.group(other)), CGPoint(x: region.visual.midX, y: region.visual.maxY - 2),
                  expect: .groupHeader(group), .after)
        }
        report.append("rule checks failures=\(failures)")

        // 3. Whole drags (opt-in: they synthesize clicks in the live window, so never while someone is using it).
        guard UserDefaults.standard.bool(forKey: "debug.sidebarDragSelfTest.drags") else {
            report.append("SKIPPED scripted drags (set debug.sidebarDragSelfTest.drags to run them)")
            report.append("selftest failures=\(failures)")
            return
        }
        guard NSApp.isActive, window.isKeyWindow else {
            report.append("SKIPPED scripted drags: the app is inactive or the window is not key (it lives in another Space)")
            report.append("selftest failures=\(failures)")
            return
        }
        // Synthetic mouse events go through the real window, so the rows' DragGesture, the
        // engine, the preview window and the drop plumbing all run. The drop goes to a recorder, never to the
        // workspace, and the real mouse is untouched (the engine reads a scripted pointer).
        var recorded: (SidebarDragPayload, SidebarWebDropTarget, SidebarDropEdge)?
        state.configure(geometry: geometry, document: document, perform: { recorded = ($0, $1, $2) })
        defer { restore(); geometry.pointerOverride = nil; state.debugHoldsButton = false }

        func event(_ type: NSEvent.EventType, _ point: CGPoint) -> NSEvent? {
            let local = CGPoint(x: point.x, y: surface.isFlipped ? point.y : surface.bounds.height - point.y)
            return NSEvent.mouseEvent(with: type, location: surface.convert(local, to: nil), modifierFlags: [],
                                      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                      context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
        }
        func send(_ type: NSEvent.EventType, _ point: CGPoint) {
            geometry.pointerOverride = point
            if let event = event(type, point) { window.sendEvent(event) }
        }
        func live<T: Hashable>(_ id: T, _ pick: (SidebarWebDropTarget) -> T?) -> SidebarDropRegion? {
            geometry.regions().first { pick($0.target) == id }
        }
        func projectRegion(_ id: ProjectID) -> SidebarDropRegion? {
            live(id) { if case .project(let value) = $0 { return value } else { return nil } }
        }
        func headerRegion(_ id: GroupID) -> SidebarDropRegion? {
            live(id) { if case .groupHeader(let value) = $0 { return value } else { return nil } }
        }
        func grab(_ region: SidebarDropRegion) -> CGPoint { CGPoint(x: region.visual.minX + region.visual.width * 0.35, y: region.visual.midY) }

        /// `to` is evaluated after the drag has started, because the list lays out extra rows while dragging.
        func scenario(_ name: String, from start: CGPoint, escapeBeforeRelease: Bool = false, to: () -> CGPoint?,
                      expect: (SidebarDragPayload, SidebarWebDropTarget, SidebarDropEdge)?) async {
            recorded = nil
            state.debugHoldsButton = true
            send(.mouseMoved, start)
            try? await Task.sleep(for: .milliseconds(60))
            send(.leftMouseDown, start)
            try? await Task.sleep(for: .milliseconds(60))
            // Leave the row first (a few small steps), then settle on the target.
            var point = start
            var startedAt: Int?
            var sawGhost = false
            for step in 1...6 {
                point = CGPoint(x: start.x, y: start.y + CGFloat(step) * 3)
                send(.leftMouseDragged, point)
                try? await Task.sleep(for: .milliseconds(30))
                if startedAt == nil, state.isDragging { startedAt = step }
                sawGhost = sawGhost || state.debugGhostVisible
            }
            try? await Task.sleep(for: .milliseconds(150))
            let end = to() ?? CGPoint(x: -8, y: size.height / 2)
            let steps = 12
            let from = point
            for step in 1...steps {
                let t = CGFloat(step) / CGFloat(steps)
                send(.leftMouseDragged, CGPoint(x: from.x + (end.x - from.x) * t, y: from.y + (end.y - from.y) * t))
                try? await Task.sleep(for: .milliseconds(40))
                if startedAt == nil, state.isDragging { startedAt = 6 + step }
                sawGhost = sawGhost || state.debugGhostVisible
            }
            let shown = state.indicator.map { "\($0.target) \(state.edge.map { "\($0)" } ?? "?")" } ?? "none"
            if escapeBeforeRelease, let esc = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
                NSApp.sendEvent(esc)
                try? await Task.sleep(for: .milliseconds(60))
            }
            let stillDragging = state.isDragging
            send(.leftMouseUp, end)
            try? await Task.sleep(for: .milliseconds(200))
            state.debugHoldsButton = false
            let got = recorded
            let matches: Bool
            if let expect, let got { matches = got.0 == expect.0 && got.1 == expect.1 && got.2 == expect.2 }
            else { matches = expect == nil && got == nil }
            let idle = !state.isDragging && !state.debugGhostVisible
            let ok = matches && idle && (expect == nil || (startedAt != nil && sawGhost))
            if !ok { failures += 1 }
            report.append("\(ok ? "PASS" : "FAIL") drag \(name): startedAtStep=\(startedAt.map(String.init) ?? "never") ghost=\(sawGhost) key=\(window.isKeyWindow) indicator=[\(shown)] stillDraggingBeforeRelease=\(stillDragging) dropped=\(got.map { "\($0.0) -> \($0.1) \($0.2)" } ?? "nothing") idleAfter=\(idle)")
        }

        let rows = projectRows.sorted { $0.1.visual.minY < $1.1.visual.minY }
        if rows.count >= 2 {
            let a = rows[0].0, b = rows[rows.count - 1].0
            for (name, edge, fraction) in [("before", SidebarDropEdge.before, CGFloat(0.12)), ("after", .after, 0.88)] {
                guard let start = projectRegion(a).map(grab) else { continue }
                await scenario("project onto the last row (\(name))", from: start, to: {
                    projectRegion(b).map { CGPoint(x: $0.visual.midX, y: $0.visual.minY + $0.visual.height * fraction) }
                }, expect: (.project(a), .project(b), edge))
            }
            if let start = projectRegion(b).map(grab) {
                await scenario("project upward onto the first row (before)", from: start, to: {
                    projectRegion(a).map { CGPoint(x: $0.visual.midX, y: $0.visual.minY + 3) }
                }, expect: (.project(b), .project(a), .before))
            }
            if let start = projectRegion(a).map(grab) {
                await scenario("project, Escape cancels", from: start, escapeBeforeRelease: true, to: {
                    projectRegion(b).map { CGPoint(x: $0.visual.midX, y: $0.visual.minY + 3) }
                }, expect: nil)
                await scenario("project released outside the list", from: start, to: { nil }, expect: nil)
            }
        } else {
            report.append("CHECK fewer than two project rows; project drags skipped")
        }
        if let a = rows.first?.0, let group = headers.first?.0, let start = projectRegion(a).map(grab) {
            await scenario("project onto a group header (inside)", from: start, to: {
                headerRegion(group).map { CGPoint(x: $0.visual.midX, y: $0.visual.midY) }
            }, expect: (.project(a), .groupHeader(group), .inside))
        }
        let ordered = headers.sorted { $0.1.visual.minY < $1.1.visual.minY }
        if let source = ordered.first(where: { source in
            ordered.contains { $0.0 != source.0 && !doc.isGroup($0.0, inside: source.0) } }),
           let target = ordered.last(where: { $0.0 != source.0 && !doc.isGroup($0.0, inside: source.0) }),
           let start = headerRegion(source.0).map({ CGPoint(x: $0.visual.minX + 30, y: $0.visual.midY) }) {
            await scenario("group onto another header (after)", from: start, to: {
                headerRegion(target.0).map { CGPoint(x: $0.visual.midX, y: $0.visual.maxY - 2) }
            }, expect: (.group(source.0), .groupHeader(target.0), .after))
        }
        report.append("selftest failures=\(failures)")
    }

    private static func findTable(from surface: NSView) -> NSTableView? {
        var ancestor = surface.superview
        while let root = ancestor {
            var queue = [root]
            while !queue.isEmpty {
                let view = queue.removeFirst()
                if let table = view as? NSTableView { return table }
                queue.append(contentsOf: view.subviews)
            }
            ancestor = root.superview
        }
        return nil
    }

    private static func write(_ lines: [String]) {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/com.kc1t.alethe.mac/logs/sidebar-drag-selftest.log")
        try? Data((lines.joined(separator: "\n") + "\n").utf8).write(to: url)
    }
}
#endif
