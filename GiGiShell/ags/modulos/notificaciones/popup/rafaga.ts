export interface BurstResult {
  bursting: boolean
  triggered: boolean
  count: number
}

export class PopupBurstGuard {
  private timestamps: number[] = []
  private burstCount = 0
  private readonly threshold: number
  private readonly windowMs: number

  constructor(threshold: number, windowMs: number) {
    this.threshold = threshold
    this.windowMs = windowMs
  }

  record(now: number): BurstResult {
    if (this.burstCount > 0) {
      this.burstCount += 1
      return { bursting: true, triggered: false, count: this.burstCount }
    }

    this.timestamps = this.timestamps.filter(timestamp => now - timestamp <= this.windowMs)
    this.timestamps.push(now)

    if (this.timestamps.length > this.threshold) {
      this.burstCount = this.timestamps.length
      return { bursting: true, triggered: true, count: this.burstCount }
    }

    return { bursting: false, triggered: false, count: this.timestamps.length }
  }

  finish(): number {
    const count = this.burstCount
    this.timestamps = []
    this.burstCount = 0
    return count
  }
}
