export function canFitPopup(
  visibleHeights: number[],
  candidateHeight: number,
  availableHeight: number,
  maxVisible: number,
  gap: number,
  guaranteedVisible: number,
  stackBudget: number,
): boolean {
  if (visibleHeights.length >= maxVisible) return false

  // Always let one popup through so an unusually small monitor cannot stall the queue.
  if (visibleHeights.length === 0) return true

  const currentHeight = visibleHeights.reduce((total, height) => total + height, 0)
    + gap * (visibleHeights.length - 1)

  const nextHeight = currentHeight + gap + candidateHeight
  if (nextHeight > availableHeight) return false

  // Popups with buttons are taller than the reference, and must not cost a guaranteed slot.
  return visibleHeights.length < guaranteedVisible || nextHeight <= stackBudget
}
