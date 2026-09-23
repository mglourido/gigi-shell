export function canFitPopup(
  visibleHeights: number[],
  candidateHeight: number,
  availableHeight: number,
  maxVisible: number,
  gap: number,
): boolean {
  if (visibleHeights.length >= maxVisible) return false

  // Always let one popup through so an unusually small monitor cannot stall the queue.
  if (visibleHeights.length === 0) return true

  const currentHeight = visibleHeights.reduce((total, height) => total + height, 0)
    + gap * (visibleHeights.length - 1)

  return currentHeight + gap + candidateHeight <= availableHeight
}
