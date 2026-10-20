#if DEBUG
import AletheModel
import AppKit

/// Debug-only check of the sidebar drag inside the running app, for when nobody can drag by hand:
/// `defaults write com.kc1t.alethe.mac debug.sidebarDragSelfTest -bool true`, then launch. It cross-checks the
/// registered row frames against the List's own table rows, feeds scripted pointer positions through
/// `SidebarWebDropRules` and checks that every mark is drawn next to the pointer. With
/// `debug.sidebarDragSelfTest.drags` it also drives whole drags with synthetic mouse events (only while the app is
/// active and the window key). The report lands in `~/Library/Application Support/com.kc1t.alethe.mac/logs/sidebar-drag-selftest.log`.
@MainActor
enum SidebarDragSelfTest {
    static var enabled: Bool { UserDefaults.standard.bool(forKey: "debug.sidebarDragSelfTest") }

    static func run(state: SidebarWebDragState, geometry: SidebarDropGeometry, document: @escaping () -> WorkspaceDocument,
                    restore: @escaping () -> Void) async {
        try? await Task.sleep(for: .seconds(3))
        var report: [String] = ["\(Date()) sidebar drag self-test"]
        var failures = 0
        defer { write(report) }
        guard let surface = geometry.surface, let window = surface.window else {
            report.append("FAIL no surface or window")
            return
        }
        let size = surface.bounds.size
        report.append("window visible=\(window.isVisible) onActiveSpace=\(window.isOnActiveSpace) key=\(window.isKeyWindow) fullscreen=\(window.styleMask.contains(.fullScreen)) app active=\(NSApp.isActive) surface=\(Int(size.width))x\(Int(size.height))")
        let regions = geometry.regions().sorted { $0.hit.minY < $1.hit.minY }
        report.append("regions=\(regions.count)")
        guard !regions.isEmpty else {
            report.append("FAIL no registered regions (sidebar not laid out)")
            return
        }
        func r(_ rect: CGRect) -> String { "(\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height)))" }
        for region in regions { report.append("  \(region.target) hit=\(r(region.hit)) visual=\(r(region.visual))") }

        // 1. The probes must agree with the table's own row frames.
        if let table = findTable(from: surface) {
            var worst: CGFloat = 0
            var matched = 0
            var skipped = 0
            let rows = table.rows(in: table.visibleRect)
            let rowRegions = regions.filter { $0.target != .ungrouped }
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
            let ok = matched > 0 && worst <= 2
            if !ok { failures += 1 }
            report.append("\(ok ? "PASS" : "FAIL") table rows matched=\(matched) unmatched=\(skipped) worstEdgeDelta=\(String(format: "%.1f", worst))pt")
        } else {
            report.append("CHECK no NSTableView found to cross-check")
        }

        // 2. Plans on live geometry: every mark must be drawn near the pointer that produced it.
        let doc = document()
        func markY(_ plan: SidebarDropPlan) -> CGFloat {
            switch plan.mark {
            case .line(let rect, let edge, _): edge == .before ? rect.minY : rect.maxY
            case .box(let rect): rect.midY
            }
        }
        var samples = 0
        var plans = 0
        var stray: [String] = []
        let projectIDs = regions.compactMap { region -> ProjectID? in if case .project(let id) = region.target { id } else { nil } }
        let groupIDs = regions.compactMap { region -> GroupID? in if case .groupHeader(let id) = region.target { id } else { nil } }
        let paneID = doc.projects.compactMap { $0.panes.first?.id }.first
        for region in regions where region.target != .ungrouped {
            for y in [region.hit.minY + 1, region.visual.minY + 2, region.visual.midY, region.visual.maxY - 2]
            where region.hit.contains(CGPoint(x: region.hit.midX, y: y)) {
                let point = CGPoint(x: region.visual.midX, y: y)
                var sources: [SidebarWebDropRules.Source] = [.files]
                if let project = projectIDs.first(where: { region.target != .project($0) && region.target != .terminals($0) }) {
                    sources.append(.item(.project(project)))
                }
                if let group = groupIDs.first(where: { region.target != .groupHeader($0) }) { sources.append(.item(.group(group))) }
                if let paneID { sources.append(.item(.pane(paneID))) }
                for source in sources {
                    samples += 1
                    guard let plan = SidebarWebDropRules.plan(source, regions: regions, at: point, width: size.width, in: doc) else { continue }
                    plans += 1
                    var reach = max(region.hit.height, 60)
                    if case .terminals(let project) = region.target {
                        reach += regions.filter { $0.target == .terminals(project) }.map(\.hit.height).reduce(0, +)
                    }
                    if abs(markY(plan) - y) > reach {
                        stray.append("\(source) over \(region.target) at y=\(Int(y)) draws at y=\(Int(markY(plan)))")
                    }
                }
            }
        }
        if !stray.isEmpty { failures += 1 }
        report.append("\(stray.isEmpty ? "PASS" : "FAIL") marks near the pointer: samples=\(samples) plans=\(plans) stray=\(stray.count)")
        for line in stray.prefix(10) { report.append("  stray: \(line)") }

        // A canonical case computed from the document, not from the rules.
        let rows = regions.compactMap { region -> (ProjectID, SidebarDropRegion)? in
            if case .project(let id) = region.target { (id, region) } else { nil }
        }
        if rows.count >= 2 {
            let moving = rows[0].0
            let (target, targetRegion) = rows[rows.count - 1]
            let container: GroupID? = if case .group(let id)? = doc.location(of: target) { id } else { nil }
            let upper = SidebarWebDropRules.plan(.item(.project(moving)), regions: regions,
                                                 at: CGPoint(x: targetRegion.visual.midX, y: targetRegion.visual.minY + 2),
                                                 width: size.width, in: doc)
            let ok = upper?.action == .place(.project(moving), container: container, before: .project(target))
            if !ok { failures += 1 }
            report.append("\(ok ? "PASS" : "FAIL") first project onto the top half of the last project row -> \(upper.map { "\($0.action)" } ?? "none")")
        }

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
        // Synthetic mouse events go through the real window, so the rows' DragGesture, the engine, the preview
        // window and the drop plumbing all run. The drop goes to a recorder, never to the workspace, and the real
        // mouse is untouched (the engine reads a scripted pointer).
        var recorded: SidebarDropPlan.Action?
        state.configure(geometry: geometry, document: document, perform: { recorded = $0 })
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
        func projectRegion(_ id: ProjectID) -> SidebarDropRegion? { geometry.regions().first { $0.target == .project(id) } }
        func grab(_ region: SidebarDropRegion) -> CGPoint {
            CGPoint(x: region.visual.minX + region.visual.width * 0.35, y: region.visual.midY)
        }

        /// `to` is evaluated after the drag has started, because the list lays out extra rows while dragging.
        func scenario(_ name: String, source: SidebarWebDropRules.Source, from start: CGPoint,
                      escapeBeforeRelease: Bool = false, to: () -> CGPoint?) async {
            recorded = nil
            state.debugHoldsButton = true
            send(.mouseMoved, start)
            try? await Task.sleep(for: .milliseconds(60))
            send(.leftMouseDown, start)
            try? await Task.sleep(for: .milliseconds(60))
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
            let from = point
            for step in 1...12 {
                let t = CGFloat(step) / 12
                send(.leftMouseDragged, CGPoint(x: from.x + (end.x - from.x) * t, y: from.y + (end.y - from.y) * t))
                try? await Task.sleep(for: .milliseconds(40))
                if startedAt == nil, state.isDragging { startedAt = 6 + step }
                sawGhost = sawGhost || state.debugGhostVisible
            }
            let expected = escapeBeforeRelease ? nil : SidebarWebDropRules.plan(source, regions: geometry.regions(), at: end,
                                                                                  width: size.width, in: document())?.action
            if escapeBeforeRelease, let esc = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
                NSApp.sendEvent(esc)
                try? await Task.sleep(for: .milliseconds(60))
            }
            send(.leftMouseUp, end)
            try? await Task.sleep(for: .milliseconds(200))
            state.debugHoldsButton = false
            let idle = !state.isDragging && !state.debugGhostVisible
            let ok = recorded == expected && idle && (expected == nil || (startedAt != nil && sawGhost))
            if !ok { failures += 1 }
            report.append("\(ok ? "PASS" : "FAIL") drag \(name): startedAtStep=\(startedAt.map(String.init) ?? "never") ghost=\(sawGhost) key=\(window.isKeyWindow) dropped=\(recorded.map { "\($0)" } ?? "nothing") expected=\(expected.map { "\($0)" } ?? "nothing") idleAfter=\(idle)")
        }

        if rows.count >= 2 {
            let a = rows[0].0, b = rows[rows.count - 1].0
            for fraction in [0.12, 0.88] as [CGFloat] {
                guard let start = projectRegion(a).map(grab) else { continue }
                await scenario("project onto the last row (\(fraction))", source: .item(.project(a)), from: start, to: {
                    projectRegion(b).map { CGPoint(x: $0.visual.midX, y: $0.visual.minY + $0.visual.height * fraction) }
                })
            }
            if let start = projectRegion(a).map(grab) {
                await scenario("project, Escape cancels", source: .item(.project(a)), from: start, escapeBeforeRelease: true, to: {
                    projectRegion(b).map { CGPoint(x: $0.visual.midX, y: $0.visual.minY + 3) }
                })
                await scenario("project released outside the list", source: .item(.project(a)), from: start, to: { nil })
            }
        } else {
            report.append("CHECK fewer than two project rows; project drags skipped")
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
