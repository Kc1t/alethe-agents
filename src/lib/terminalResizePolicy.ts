export const OPENCODE_MIN_SAFE_COLUMNS = 48

export type StableTerminalGrid = {
  cols: number
  rows: number
  horizontalViewport: boolean
}

/**
 * OpenCode 1.18.x can crash inside Bun/OpenTUI when a Linux PTY is resized to
 * an extremely narrow grid. Keep the process on a usable logical width while
 * the pane remains free to shrink and expose the grid through a horizontal
 * viewport. This pure normalization does not impose an OpenCode-specific
 * minimum on other agents or shells.
 */
export function stabilizeTerminalGrid(
  command: string | null | undefined,
  cols: number,
  rows: number,
): StableTerminalGrid {
  const normalizedCols = Math.max(1, Math.floor(cols))
  const normalizedRows = Math.max(1, Math.floor(rows))
  const horizontalViewport = command === 'opencode' && normalizedCols < OPENCODE_MIN_SAFE_COLUMNS

  return {
    cols: horizontalViewport ? OPENCODE_MIN_SAFE_COLUMNS : normalizedCols,
    rows: normalizedRows,
    horizontalViewport,
  }
}

/** Keeps a TUI's logical grid stable while its visual pane acts as a viewport. */
export function createTerminalResizePolicy(
  command: string | null | undefined,
  pinGrid: boolean,
): { resolve: (cols: number, rows: number, adopt?: boolean) => StableTerminalGrid } {
  let pinnedGrid: { cols: number; rows: number } | null = null

  return {
    resolve(cols, rows, adopt = false) {
      const measuredCols = Math.max(1, Math.floor(cols))
      if (!pinGrid) {
        return {
          cols: measuredCols,
          rows: Math.max(1, Math.floor(rows)),
          horizontalViewport: false,
        }
      }

      const candidate = stabilizeTerminalGrid(command, cols, rows)
      if (adopt || !pinnedGrid) pinnedGrid = { cols: candidate.cols, rows: candidate.rows }

      return {
        ...pinnedGrid,
        horizontalViewport: measuredCols < pinnedGrid.cols,
      }
    },
  }
}
