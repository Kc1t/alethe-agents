/** A one-shot timeout that stops counting while paused and runs only what was left on resume. */
export class PausableTimer {
  private handle: ReturnType<typeof setTimeout> | undefined
  private deadline = 0
  /** What is left to run; null when nothing is armed. */
  private remaining: number | null = null

  constructor(
    private readonly onFire: () => void,
    private paused = false,
  ) {}

  arm(ms: number): void {
    this.stopCounting()
    this.remaining = ms
    if (!this.paused) this.count()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    if (this.handle !== undefined && this.remaining !== null) {
      this.remaining = Math.max(0, this.deadline - Date.now())
    }
    this.stopCounting()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.remaining !== null) this.count()
  }

  clear(): void {
    this.stopCounting()
    this.remaining = null
  }

  private count(): void {
    const ms = this.remaining ?? 0
    this.deadline = Date.now() + ms
    this.handle = setTimeout(() => {
      this.handle = undefined
      this.remaining = null
      this.onFire()
    }, ms)
  }

  private stopCounting(): void {
    if (this.handle !== undefined) clearTimeout(this.handle)
    this.handle = undefined
  }
}
