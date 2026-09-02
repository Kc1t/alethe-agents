import styles from './DiffStatBar.module.css'

const DIFF_BAR_BLOCKS = 5

/**
 * GitHub-style five-block bar showing how much of a change was additions vs. deletions.
 *
 * Proportional to the file's own total, not the whole commit's — the bar answers "what kind of
 * change was this", while the raw counts beside it carry the magnitude. A file with two added
 * lines and a file with two hundred both fill the bar the same way, and that is the point.
 */
export function DiffStatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  if (total === 0) return null
  // At least one block for a side that changed anything at all, so a small number of additions
  // among many deletions never renders as "no additions".
  const addedBlocks = Math.min(
    DIFF_BAR_BLOCKS,
    Math.max(1, Math.round((additions / total) * DIFF_BAR_BLOCKS)),
  )
  const removedBlocks = Math.min(
    DIFF_BAR_BLOCKS - addedBlocks,
    additions === 0
      ? DIFF_BAR_BLOCKS
      : Math.max(deletions > 0 ? 1 : 0, DIFF_BAR_BLOCKS - addedBlocks),
  )

  return (
    <span className={styles.bar} aria-hidden="true">
      {Array.from({ length: DIFF_BAR_BLOCKS }, (_, index) => {
        const kind =
          index < addedBlocks
            ? styles.added
            : index < addedBlocks + removedBlocks
              ? styles.removed
              : styles.empty
        return <span key={index} className={`${styles.block} ${kind}`} />
      })}
    </span>
  )
}
