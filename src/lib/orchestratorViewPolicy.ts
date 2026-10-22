export function shouldAutoFit(moved: boolean, pointerOverBoard: boolean, forced = false): boolean {
  return forced || (!moved && !pointerOverBoard)
}
