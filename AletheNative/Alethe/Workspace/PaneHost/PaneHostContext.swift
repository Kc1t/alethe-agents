import AletheDesign
import AletheModel
import AppKit
import SwiftUI

/// What the AppKit pane host needs from the SwiftUI side: the environment, the current look, and
/// the undoable edits it triggers.
@MainActor
struct PaneHostContext {
    let environment: AppEnvironment
    let theme: Theme
    let metrics: Metrics
    let undoManager: () -> UndoManager?

    var workspace: WorkspaceModel? { environment.workspace }

    /// Focused pane border: the focus ring in Normal (upstream `.pane.focused`), a strong neutral
    /// border in Clean (upstream `--clean-focus-border`).
    var focusBorder: ThemeToken { metrics.style == .clean ? .borderStrong : .focusRing }

    /// A SwiftUI view with the environment every Alethe view expects.
    func hosted(_ view: some View) -> AnyView {
        AnyView(view
            .environment(environment)
            .environment(\.theme, theme)
            .environment(\.metrics, metrics))
    }

    func closePane(_ pane: PaneID) {
        workspace?.update(undoManager: undoManager(), actionName: String(localized: "undo.closeTerminal")) {
            $0.closePane(pane)
        }
    }

    func closeContainer(_ project: ProjectID) {
        workspace?.update(undoManager: undoManager(), actionName: String(localized: "undo.closeProject")) {
            $0.close(project)
        }
    }

    func closeTab(_ tab: TabID) {
        workspace?.update(undoManager: undoManager(), actionName: String(localized: "undo.closeTerminal")) {
            $0.closeTab(tab)
        }
    }

    /// Switching sub-tabs is navigation, not an edit: not undoable.
    func activateTab(_ tab: TabID) {
        workspace?.update { $0.activateTab(tab) }
    }

    func newSubTab(in pane: PaneID) {
        environment.editorRequest = .newSubTab(pane)
    }

    func restart(_ tab: PaneTab, in project: Project) {
        environment.terminals.restart(tab, in: project, environment: environment)
    }

    func setLaneVisible(_ visible: Bool, for pane: PaneID) {
        workspace?.update { $0.setLaneVisible(visible, for: pane) }
    }

    /// What a file pane shows changed (a diff's staged toggle): a view setting, not undoable.
    func setContent(_ content: PaneContent, for pane: PaneID) {
        workspace?.update { $0.updatePane(pane) { $0.content = content } }
    }

    func swapPanes(_ first: PaneID, _ second: PaneID) {
        workspace?.update(undoManager: undoManager(), actionName: String(localized: "undo.move")) {
            $0.swapPanes(first, second)
        }
    }

    /// Clicking a pane focuses it and selects its project; not undoable (navigation, not an edit).
    func focus(_ pane: PaneID, in project: ProjectID) {
        guard let doc = workspace?.document,
              doc.workspace.focusedPaneID != pane || doc.workspace.selectedProjectID != project else { return }
        workspace?.update {
            $0.workspace.focusedPaneID = pane
            $0.workspace.selectedProjectID = project
        }
    }

    /// Layout changes (order, collapse, fullscreen, isolation) are view settings: not undoable.
    func moveContainer(_ project: ProjectID, to index: Int) {
        workspace?.update { $0.moveContainer(project, to: index) }
    }

    func setCollapsed(_ project: ProjectID, _ collapsed: Bool) {
        workspace?.update { $0.setCollapsed(project, collapsed) }
    }

    func setFullscreen(_ project: ProjectID?) {
        workspace?.update { $0.setFullscreen(project) }
    }

    func setLayoutMode(_ mode: PaneLayoutMode, for project: ProjectID) {
        workspace?.update { $0.setLayoutMode(mode, for: project) }
    }

    /// Disabling ends the pane's processes (their output is kept); undoable.
    func setDisabled(_ pane: PaneID, _ disabled: Bool) {
        workspace?.update(undoManager: undoManager(),
                          actionName: String(localized: disabled ? "undo.disableTerminal" : "undo.enableTerminal")) {
            $0.setDisabled(pane, disabled)
        }
    }

    func isolate(_ pane: PaneID?) {
        workspace?.update { $0.isolate(pane) }
    }

    /// Resizes are committed once, on release; not undoable (like upstream).
    func setContainerWeights(_ weights: [Double]) {
        workspace?.update { $0.workspace.containerWeights = weights }
    }

    func setGridWeights(_ weights: GridWeights, for project: ProjectID) {
        guard project != PaneHostView.flatID else {
            workspace?.update { $0.workspace.gridWeights[WorkspaceState.flatWeightsKey] = weights }
            return
        }
        workspace?.update { $0.setTrackWeights(weights, for: project) }
    }

    /// Focus mode is a momentary view, not saved (upstream keeps it in the UI store).
    func setFocusMode(_ pane: PaneID?) {
        if let pane, let project = workspace?.document.pane(pane)?.project.id {
            focus(pane, in: project)
        }
        environment.focusModePaneID = pane
    }

    /// Dropping a grid pane on another pane or a free slot.
    func moveGridCell(_ pane: PaneID, toCol col: Int, row: Int) {
        workspace?.update(undoManager: undoManager(), actionName: String(localized: "undo.move")) {
            $0.moveGridCell(pane, toCol: col, row: row)
        }
    }

    func fillFreeSpace(_ pane: PaneID) {
        workspace?.update(undoManager: undoManager(), actionName: String(localized: "undo.layout")) {
            $0.fillFreeSpace(pane)
        }
    }

    // MARK: - Named grids (P2-20)

    func activateGrid(_ grid: ProjectGridID?, in project: ProjectID) {
        workspace?.update { $0.activateGrid(grid, in: project) }
    }

    func newGrid(in project: ProjectID) {
        guard let workspace else { return }
        ProjectGridPrompts.createGrid(in: project, workspace: workspace, undoManager: undoManager())
    }

    func renameGrid(_ grid: ProjectGridID, in project: ProjectID) {
        if WebDialogCenter.shared.themed {
            guard let workspace, let current = workspace.document.project(project)?.gridName(grid) else { return }
            Task {
                guard let name = await ProjectGridPrompts.webName(rename: true, initial: current, problem: {
                    workspace.document.gridNameProblem($0, in: project, except: grid)
                }) else { return }
                workspace.update(undoManager: undoManager(), actionName: String(localized: "undo.renameGrid")) {
                    $0.renameGrid(grid, in: project, to: name)
                }
            }
            return
        }
        guard let workspace, let current = workspace.document.project(project)?.gridName(grid),
              let name = ProjectGridPrompts.name(
                title: String(localized: "projectGrid.rename.title"), initial: current,
                action: String(localized: "projectGrid.rename"),
                problem: { workspace.document.gridNameProblem($0, in: project, except: grid) }) else { return }
        workspace.update(undoManager: undoManager(), actionName: String(localized: "undo.renameGrid")) {
            $0.renameGrid(grid, in: project, to: name)
        }
    }

    func deleteGrid(_ grid: ProjectGridID, in project: ProjectID) {
        if WebDialogCenter.shared.themed {
            guard let workspace, let model = workspace.document.project(project), let name = model.gridName(grid) else { return }
            let count = model.panes(in: grid).count
            Task {
                guard let choice = await ProjectGridPrompts.webDelete(grid: name, paneCount: count) else { return }
                workspace.update(undoManager: undoManager(), actionName: String(localized: "undo.deleteGrid")) {
                    $0.deleteGrid(grid, in: project, closingPanes: choice == .closePanes)
                }
            }
            return
        }
        guard let workspace, let model = workspace.document.project(project), let name = model.gridName(grid),
              let choice = ProjectGridPrompts.delete(grid: name, paneCount: model.panes(in: grid).count) else { return }
        workspace.update(undoManager: undoManager(), actionName: String(localized: "undo.deleteGrid")) {
            $0.deleteGrid(grid, in: project, closingPanes: choice == .closePanes)
        }
    }

    func movePane(_ pane: PaneID, toGrid grid: ProjectGridID?) {
        workspace?.update(undoManager: undoManager(), actionName: String(localized: "undo.move")) {
            $0.movePane(pane, toGrid: grid)
        }
    }

    func designLayout(for project: ProjectID) {
        environment.editorRequest = .layoutDesigner(.project(project))
    }
}
