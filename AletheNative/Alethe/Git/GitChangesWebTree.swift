import AletheDesign
import AletheGit
import AppKit
import SwiftUI

/// Web changes tree (`plugins/git-control/GitControl.tsx` `ChangeGroup` / `TreeNodeView` +
/// `GitControl.module.css`): files nested by folder (single-child folders collapsed), with stage /
/// discard at group, folder and file level.
indirect enum GitWebTreeNode: Identifiable {
    case dir(name: String, path: String, children: [GitWebTreeNode])
    case file(name: String, entry: GitStatusEntry)

    var id: String {
        switch self {
        case .dir(_, let path, _): "d:\(path)"
        case .file(_, let entry): "f:\(entry.path)"
        }
    }

    private var isDir: Bool { if case .dir = self { true } else { false } }
    private var name: String {
        switch self {
        case .dir(let name, _, _), .file(let name, _): name
        }
    }

    /// `buildTree`.
    static func build(_ entries: [GitStatusEntry]) -> [GitWebTreeNode] {
        final class Dir {
            var name: String, path: String
            var dirs: [Dir] = []
            var files: [(String, GitStatusEntry)] = []
            init(_ name: String, _ path: String) { self.name = name; self.path = path }
        }
        let root = Dir("", "")
        for entry in entries {
            var parts = entry.path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            let fileName = parts.popLast() ?? entry.path
            var cursor = root
            var acc = ""
            for part in parts {
                acc = acc.isEmpty ? part : "\(acc)/\(part)"
                if let next = cursor.dirs.first(where: { $0.name == part }) {
                    cursor = next
                } else {
                    let next = Dir(part, acc)
                    cursor.dirs.append(next)
                    cursor = next
                }
            }
            cursor.files.append((fileName, entry))
        }
        func convert(_ dir: Dir) -> [GitWebTreeNode] {
            dir.dirs.map { .dir(name: $0.name, path: $0.path, children: convert($0)) }
                + dir.files.map { .file(name: $0.0, entry: $0.1) }
        }
        return convert(root).map(compress).sorted(by: compare)
    }

    /// `compress`: a folder holding a single folder is shown as `a/b`.
    private static func compress(_ node: GitWebTreeNode) -> GitWebTreeNode {
        guard case .dir(var name, var path, var children) = node else { return node }
        while children.count == 1, case .dir(let childName, let childPath, let grandchildren) = children[0] {
            name = "\(name)/\(childName)"
            path = childPath
            children = grandchildren
        }
        return .dir(name: name, path: path, children: children.map(compress).sorted(by: compare))
    }

    private static func compare(_ a: GitWebTreeNode, _ b: GitWebTreeNode) -> Bool {
        if a.isDir != b.isDir { return a.isDir }
        return a.name.localizedCompare(b.name) == .orderedAscending
    }

    /// `collectPaths`.
    var paths: [String] {
        switch self {
        case .file(_, let entry): [entry.path]
        case .dir(_, _, let children): children.flatMap(\.paths)
        }
    }
}

/// One group of the changes list (`ChangeGroup`).
struct GitWebChangeGroup: View {
    enum Kind { case staged, changes, untracked, conflicts }

    let kind: Kind
    let title: LocalizedStringKey
    let entries: [GitStatusEntry]
    let busy: Bool
    let primary: ([String]) -> Void
    let discard: (([String]) -> Void)?
    let open: (GitStatusEntry) -> Void
    let reveal: (String) -> Void
    let addToGrid: (String) -> Bool
    let addToGridAvailable: (String) -> Bool
    @State private var expanded = true
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        if !entries.isEmpty {
            let paths = Array(NSOrderedSet(array: entries.map(\.path))) as? [String] ?? entries.map(\.path)
            let staged = kind == .staged
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    Button { expanded.toggle() } label: {
                        HStack(spacing: metrics.size(5)) {
                            Image(systemName: expanded ? "chevron.down" : "chevron.right").font(metrics.font(size: 13))
                            Text(title).textCase(.uppercase)
                                .font(metrics.font(size: 10, weight: .bold)).tracking(metrics.size(0.4)).lineLimit(1)
                            Text(verbatim: "\(entries.count)").font(metrics.font(size: 9))
                                .foregroundStyle(theme[.fgMuted])
                                .frame(minWidth: metrics.size(18), minHeight: metrics.size(18))
                                .background(theme[.panel], in: RoundedRectangle(cornerRadius: metrics.size(9)))
                                .padding(.leading, metrics.size(2))
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(theme[.fg])
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    HStack(spacing: metrics.size(2)) {
                        if let discard {
                            GitWebIconButton(symbol: "arrow.counterclockwise", size: 22, glyph: 13,
                                             help: "git.web.discardAll", disabled: busy) { discard(paths) }
                        }
                        GitWebIconButton(symbol: staged ? "minus" : "plus", size: 22, glyph: 14,
                                         help: staged ? "git.unstageAll" : "git.stageAll", disabled: busy) { primary(paths) }
                    }
                }
                .frame(height: metrics.size(32)).padding(.leading, metrics.size(4)).padding(.trailing, metrics.size(6))
                if expanded {
                    VStack(spacing: 0) {
                        ForEach(GitWebTreeNode.build(entries)) { node in
                            GitWebTreeRow(node: node, kind: kind, depth: 0, busy: busy, primary: primary,
                                          discard: discard, open: open, reveal: reveal,
                                          addToGrid: addToGrid, addToGridAvailable: addToGridAvailable)
                        }
                    }
                    .padding(.horizontal, metrics.size(4)).padding(.bottom, metrics.size(4))
                }
                Rectangle().fill(theme[.border]).frame(height: metrics.size(1))
            }
        }
    }
}

private struct GitWebTreeRow: View {
    let node: GitWebTreeNode
    let kind: GitWebChangeGroup.Kind
    let depth: Int
    let busy: Bool
    let primary: ([String]) -> Void
    let discard: (([String]) -> Void)?
    let open: (GitStatusEntry) -> Void
    let reveal: (String) -> Void
    let addToGrid: (String) -> Bool
    let addToGridAvailable: (String) -> Bool
    @State private var expanded = true
    @State private var hovering = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        switch node {
        case .file(let name, let entry): file(name, entry)
        case .dir(let name, _, let children): dir(name, children)
        }
    }

    private var staged: Bool { kind == .staged }
    private var rowPadding: CGFloat { metrics.size(CGFloat(8 + depth * 12)) }

    private func file(_ name: String, _ entry: GitStatusEntry) -> some View {
        let letter = statusLetter(entry)
        return HStack(spacing: metrics.size(4)) {
            Text(verbatim: name).font(metrics.font(size: 11)).foregroundStyle(theme[.fg])
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hovering {
                HStack(spacing: metrics.size(1)) {
                    GitWebIconButton(symbol: "folder.badge.magnifyingglass", size: 20, glyph: 12,
                                     help: "files.revealInFinder", disabled: false) { reveal(entry.path) }
                    if addToGridAvailable(entry.path) {
                        GitWebIconButton(symbol: "square.grid.2x2", size: 20, glyph: 12,
                                         help: "git.web.addToGrid", disabled: false) { _ = addToGrid(entry.path) }
                    }
                    if let discard {
                        GitWebIconButton(symbol: "arrow.counterclockwise", size: 20, glyph: 12,
                                         help: "git.discard", disabled: busy) { discard([entry.path]) }
                    }
                    GitWebIconButton(symbol: staged ? "minus" : "plus", size: 20, glyph: 13,
                                     help: staged ? "git.unstage" : "git.stage", disabled: busy) { primary([entry.path]) }
                }
            } else {
                Text(verbatim: letter.0).font(metrics.monoFont(size: 11, weight: .bold))
                    .foregroundStyle(theme[letter.1]).frame(width: metrics.size(14))
            }
        }
        .padding(.leading, rowPadding).padding(.trailing, metrics.size(4)).padding(.vertical, metrics.size(2))
        .frame(minHeight: metrics.size(26))
        .background(theme[.panelHover].opacity(hovering ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.size(4)))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(count: 2) { open(entry) }
        .help(Text(verbatim: entry.originalPath.map { "\($0) → \(entry.path)" } ?? entry.path))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("git.file.\(entry.path)")
    }

    private func dir(_ name: String, _ children: [GitWebTreeNode]) -> some View {
        let descendants = node.paths
        return VStack(spacing: 0) {
            HStack(spacing: metrics.size(4)) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: metrics.size(4)) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").font(metrics.font(size: 12))
                            .foregroundStyle(theme[.fgFaint])
                        Image(systemName: "folder").font(metrics.font(size: 13)).foregroundStyle(theme[.fgMuted])
                        Text(verbatim: name).font(metrics.font(size: 11)).foregroundStyle(theme[.fg])
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if hovering {
                    HStack(spacing: metrics.size(1)) {
                        if let discard {
                            GitWebIconButton(symbol: "arrow.counterclockwise", size: 20, glyph: 12,
                                             help: "git.web.discardAll", disabled: busy) { discard(descendants) }
                        }
                        GitWebIconButton(symbol: staged ? "minus" : "plus", size: 20, glyph: 13,
                                         help: staged ? "git.unstageAll" : "git.stageAll", disabled: busy) { primary(descendants) }
                    }
                }
            }
            .padding(.leading, rowPadding).padding(.trailing, metrics.size(4)).padding(.vertical, metrics.size(2))
            .frame(minHeight: metrics.size(26))
            .background(theme[.panelHover].opacity(hovering ? 1 : 0), in: RoundedRectangle(cornerRadius: metrics.size(4)))
            .onHover { hovering = $0 }
            if expanded {
                ForEach(children) { child in
                    GitWebTreeRow(node: child, kind: kind, depth: depth + 1, busy: busy, primary: primary,
                                  discard: discard, open: open, reveal: reveal,
                                  addToGrid: addToGrid, addToGridAvailable: addToGridAvailable)
                }
            }
        }
    }

    /// `statusChar` / `statusClass`.
    private func statusLetter(_ entry: GitStatusEntry) -> (String, ThemeToken) {
        if kind == .untracked { return ("U", .statusWorking) }
        if kind == .conflicts { return ("!", .statusOffline) }
        let code = (staged ? entry.index : entry.worktree) ?? entry.worktree ?? entry.index
        switch code {
        case .added: return ("A", .statusWorking)
        case .deleted: return ("D", .statusOffline)
        case .renamed: return ("R", .agentCodex)
        case .copied: return ("C", .agentCodex)
        case .modified: return ("M", .statusWaiting)
        case .some(let other): return (other.rawValue, .fgMuted)
        case nil: return ("•", .fgMuted)
        }
    }
}

/// `.iconButton` / `.groupActions button` / `.fileActions button`: a square muted glyph with a hover fill.
struct GitWebIconButton: View {
    let symbol: String
    let size: CGFloat
    let glyph: CGFloat
    let help: LocalizedStringKey
    let disabled: Bool
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.metrics) private var metrics
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(metrics.font(size: glyph))
                .foregroundStyle(theme[hovering && !disabled ? .fg : .fgMuted])
                .frame(width: metrics.size(size), height: metrics.size(size))
                .background(theme[.panelHover].opacity(hovering && !disabled ? 1 : 0),
                            in: RoundedRectangle(cornerRadius: metrics.size(4)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.4 : 1)
        .disabled(disabled)
        .onHover { hovering = $0 }
        .help(Text(help))
        .accessibilityLabel(Text(help))
    }
}
