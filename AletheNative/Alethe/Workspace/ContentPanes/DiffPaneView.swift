import AletheDesign
import AletheDocuments
import Observation
import SwiftUI

/// `git diff` of a project or a file, loaded off the main actor.
@Observable
@MainActor
final class DiffModel {
    enum State: Equatable {
        case loading
        case loaded(DiffDocument)
        case failed(GitDiffError)
    }

    let folder: String
    let path: String?
    private(set) var staged: Bool
    private(set) var source = ""
    private(set) var state = State.loading
    @ObservationIgnored private var generation = 0

    init(folder: String, path: String?, staged: Bool) {
        self.folder = folder
        self.path = path
        self.staged = staged
        reload()
    }

    func setStaged(_ staged: Bool) {
        guard staged != self.staged else { return }
        self.staged = staged
        reload()
    }

    func reload() {
        generation += 1
        let generation = generation
        let (folder, path, staged) = (folder, path, staged)
        Task {
            let result = await GitDiff.run(folder: folder, path: path, staged: staged)
            guard generation == self.generation else { return }
            switch result {
            case .success(let text):
                source = text
                state = .loaded(DiffParser.parse(text))
            case .failure(let error): state = .failed(error)
            }
        }
    }
}

/// Diff pane (upstream `DiffPane`): changes colored by line with old/new line numbers, unified or
/// side by side, working tree or staged.
struct DiffPaneView: View {
    let model: DiffModel
    let isFocused: Bool
    let onStagedChange: (Bool) -> Void
    let onClose: () -> Void
    let onDrag: (CGSize?) -> Void
    @State private var sideBySide = false
    @Environment(\.theme) private var theme
    @Environment(\.metrics) private var metrics

    private var url: URL {
        let folder = URL(filePath: model.folder, directoryHint: .isDirectory)
        return model.path.map { folder.appending(path: $0) } ?? folder
    }

    var body: some View {
        VStack(spacing: 0) {
            if metrics.isWebInterface {
                webHeader
            } else {
            ContentPaneHeader(symbol: "plusminus", url: url, isFocused: isFocused, onClose: onClose, onDrag: onDrag) {
                Text(model.staged ? LocalizedStringKey("diff.staged") : "diff.unstaged")
                    .font(metrics.font(.caption))
                    .foregroundStyle(theme[.textTertiary])
                Spacer(minLength: 0)
                ContentPaneButton(symbol: model.staged ? "tray.full" : "tray",
                                  label: model.staged ? "diff.showUnstaged" : "diff.showStaged", id: "diff.staged") {
                    onStagedChange(!model.staged)
                }
                ContentPaneButton(symbol: sideBySide ? "rectangle.split.1x2" : "rectangle.split.2x1",
                                  label: sideBySide ? "diff.unified" : "diff.sideBySide", id: "diff.layout") {
                    sideBySide.toggle()
                }
                ContentPaneButton(symbol: "arrow.clockwise", label: "diff.refresh", id: "diff.refresh") { model.reload() }
            }
            }
            if metrics.isWebInterface { webContent } else { content }
        }
        .background(theme[.bg])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("diff.pane")
    }

    private var webHeader: some View {
        HStack(spacing: metrics.size(8)) {
            Text(verbatim: url.lastPathComponent)
                .font(metrics.font(size: 13, weight: .medium))
                .foregroundStyle(theme[.fgMuted])
                .lineLimit(1)
            Text(verbatim: (model.path ?? "") + " " + String(localized: model.staged ? "diff.staged" : "diff.unstaged"))
                .font(metrics.font(size: 11))
                .foregroundStyle(theme[.fgFaint])
                .lineLimit(1)
            Spacer(minLength: 0)
            ContentPaneButton(symbol: "xmark", label: "markdown.close", id: "pane.close", webSize: 24, webIconSize: 14, action: onClose)
        }
        .padding(.horizontal, metrics.size(12))
        .frame(height: metrics.size(36))
        .background(theme[.bgElevated])
        .overlay(alignment: .bottom) { Rectangle().fill(theme[.border]).frame(height: metrics.size(1)) }
        .accessibilityIdentifier("pane.header.\(url.lastPathComponent)")
    }

    @ViewBuilder
    private var webContent: some View {
        switch model.state {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let error):
            message(errorText(error)).accessibilityIdentifier("diff.error")
        case .loaded where model.source.isEmpty:
            message(String(localized: "diff.empty")).accessibilityIdentifier("diff.empty")
        case .loaded:
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(model.source.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                        Text(verbatim: line.isEmpty ? " " : line)
                            .font(metrics.monoFont(size: 13))
                            .lineSpacing(metrics.size(6.5))
                            .foregroundStyle(theme[webLineColor(line)])
                            .frame(minHeight: metrics.size(19.5), alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(webLineBackground(line))
                    }
                }
                .textSelection(.enabled)
                .padding(metrics.size(16))
            }
            .accessibilityIdentifier("diff.unified")
        }
    }

    private func webLineColor(_ line: String) -> ThemeToken {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .statusWorking }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .statusOffline }
        if line.hasPrefix("@@ ") { return .accent }
        return line.hasPrefix("diff ") || line.hasPrefix("index ") || line.hasPrefix("--- ") || line.hasPrefix("+++ ")
            ? .fgFaint : .fgMuted
    }

    private func webLineBackground(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return theme[.statusWorkingSoft] }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return theme[.statusOfflineSoft] }
        if line.hasPrefix("@@ ") { return theme[.accentBgSoft] }
        return theme[.bg]
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let error):
            message(errorText(error)).accessibilityIdentifier("diff.error")
        case .loaded(let document) where document.isEmpty:
            message(String(localized: "diff.empty")).accessibilityIdentifier("diff.empty")
        case .loaded(let document):
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(document.files) { file in
                        fileSection(file)
                    }
                }
                .font(metrics.font(.footnote).monospaced())
                .textSelection(.enabled)
            }
            .accessibilityIdentifier(sideBySide ? "diff.split" : "diff.unified")
        }
    }

    @ViewBuilder
    private func fileSection(_ file: DiffFile) -> some View {
        Text(verbatim: file.path)
            .font(metrics.font(.footnote).weight(.semibold))
            .foregroundStyle(theme[.textPrimary])
            .padding(.horizontal, metrics.space(.m))
            .padding(.vertical, metrics.space(.xs))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme[.bgElevated])
        ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
            Text(verbatim: hunk.header)
                .foregroundStyle(theme[.accent])
                .padding(.horizontal, metrics.space(.m))
                .padding(.vertical, metrics.space(.xxs))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme[.accentFaint])
            if sideBySide {
                ForEach(Array(DiffParser.split(hunk).enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 0) {
                        splitCell(row.left, number: row.left?.oldNumber)
                        Rectangle().fill(theme[.borderSubtle]).frame(width: metrics.size(1))
                        splitCell(row.right, number: row.right?.newNumber)
                    }
                }
            } else {
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 0) {
                        gutter(line.oldNumber)
                        gutter(line.newNumber)
                        lineText(line)
                    }
                    .background(background(line.kind))
                }
            }
        }
    }

    private func splitCell(_ line: DiffLine?, number: Int?) -> some View {
        HStack(spacing: 0) {
            gutter(line == nil ? nil : number)
            if let line { lineText(line) } else { Spacer(minLength: 0) }
        }
        .frame(minWidth: metrics.size(360), maxWidth: .infinity, alignment: .leading)
        .background(line.map { background($0.kind) } ?? theme[.bgSunken])
    }

    private func gutter(_ number: Int?) -> some View {
        Text(verbatim: number.map(String.init) ?? "")
            .foregroundStyle(theme[.textTertiary])
            .frame(width: metrics.size(44), alignment: .trailing)
            .padding(.trailing, metrics.space(.xs))
    }

    private func lineText(_ line: DiffLine) -> some View {
        let sign = switch line.kind {
        case .added: "+"
        case .removed: "-"
        case .context, .note: " "
        }
        return Text(verbatim: line.kind == .note ? line.text : sign + line.text)
            .foregroundStyle(theme[line.kind == .note ? .textTertiary : .textPrimary])
            .fixedSize()
            .padding(.trailing, metrics.space(.m))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func background(_ kind: DiffLine.Kind) -> Color {
        switch kind {
        case .added: theme[.statusActive].opacity(0.14)
        case .removed: theme[.statusStopped].opacity(0.14)
        case .context, .note: .clear
        }
    }

    private func message(_ text: String) -> some View {
        Text(verbatim: text)
            .foregroundStyle(theme[.textSecondary])
            .multilineTextAlignment(.center)
            .padding(metrics.space(.xl))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorText(_ error: GitDiffError) -> String {
        switch error {
        case .notARepository: String(localized: "diff.error.notARepository")
        case .tooLarge: String(localized: "diff.error.tooLarge")
        case .binary: String(localized: "diff.error.binary")
        case .failed(let detail): format("diff.error.generic", detail)
        }
    }
}
