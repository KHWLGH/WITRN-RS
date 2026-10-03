// @ts-check

/** Reserve time for input, including raster work that finishes after the JS draw hook. */
export function liveChartIntervalMs(
  workMs,
  dense = false,
  nextFrameDelayMs = 0,
  idleFrameMs = 1000 / 60,
  sampleIntervalMs = 10,
) {
  const cpu = Number.isFinite(workMs) ? Math.max(0, workMs) : 0;
  const raster = dense && Number.isFinite(nextFrameDelayMs) ? Math.max(0, nextFrameDelayMs - idleFrameMs) : 0;
  const work = cpu + raster;
  const highRate = Number.isFinite(sampleIntervalMs) && sampleIntervalMs > 0 && sampleIntervalMs <= 1;
  if (!highRate && work <= 8) return 0;
  return Math.min(100, Math.max(highRate ? 50 : 20, work * 3));
}

/** Display-only feedback; acquisition and the stored samples never use this policy. */
export class ChartRenderPolicy {
  /** @param {{initialDensity?:number, maxDensity?:number}} [options] */
  constructor({ initialDensity = 2, maxDensity = 16 } = {}) {
    this.initialDensity = initialDensity;
    this.maxDensity = maxDensity;
    this.pixelsPerBucket = initialDensity;
  }
  idleFrameMs = 1000 / 60;
  nextFrameDelayMs = 0;
  slowFrames = 0;
  /** @type {number|null} */
  stableSince = null;
  lastChangeAt = 0;
  /** @type {number|null} */
  lastFeedbackAt = null;

  reset() {
    this.pixelsPerBucket = this.initialDensity;
    this.nextFrameDelayMs = 0;
    this.lastChangeAt = 0;
    this.breakFeedback();
  }

  /** Background time and unrelated windows cannot count towards stable recovery. */
  breakFeedback() {
    this.slowFrames = 0;
    this.stableSince = null;
    this.lastFeedbackAt = null;
  }

  /**
   * @param {{delayMs: number, at: number, idleFrameMs?: number, visible: boolean, dense: boolean, interactive?: boolean}} sample
   * @returns {boolean} Whether the display density changed.
   */
  observe({ delayMs, at, idleFrameMs = this.idleFrameMs, visible, dense, interactive = false }) {
    if (!visible || !dense || !Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(at)) {
      this.breakFeedback();
      return false;
    }
    if (Number.isFinite(idleFrameMs) && idleFrameMs > 0) this.idleFrameMs = idleFrameMs;
    this.nextFrameDelayMs = delayMs;
    // Sparse/hidden intervals are not evidence of two seconds of healthy chart paints.
    if (this.lastFeedbackAt !== null && (at < this.lastFeedbackAt || at - this.lastFeedbackAt > 250)) {
      this.slowFrames = 0;
      this.stableSince = null;
    }
    this.lastFeedbackAt = at;
    const slow = delayMs > Math.max(33, this.idleFrameMs * 2);
    this.slowFrames = slow ? this.slowFrames + 1 : 0;
    if (slow) this.stableSince = null;
    const old = this.pixelsPerBucket;
    // Continuous input needs the next window promptly; a measured slow frame
    // can lower its display budget immediately. Static/live paints still confirm.
    if (delayMs > 100 || this.slowFrames >= 2 || (interactive && slow)) {
      this.pixelsPerBucket = Math.min(this.maxDensity, old * (delayMs > 100 ? 4 : 2));
      this.slowFrames = 0;
    } else if (delayMs <= this.idleFrameMs * 1.5) {
      this.stableSince ??= at;
      if (at - this.stableSince >= 2000 && at - this.lastChangeAt >= 5000) {
        this.pixelsPerBucket = Math.max(1, old / 2);
        this.stableSince = at;
      }
    } else {
      this.stableSince = null;
    }
    if (old === this.pixelsPerBucket) return false;
    this.lastChangeAt = at;
    this.stableSince = null;
    return true;
  }
}

/** Recording reduces density first; review protects fill without losing detail. */
export class ChartFillPolicy {
  suppressed = false;
  /** @type {'severe-frame'|'persistent-slow-frame'|'large-batch-slow-frame'|null} */
  reason = null;
  slowFrames = 0;
  reducedDensity = 0;
  /** @type {number|null} */
  stableSince = null;
  /** @type {number|null} */
  lastFeedbackAt = null;
  lastSuppressedAt = 0;

  /** Retire timing evidence without retrying a known expensive fill on every dense window. */
  breakFeedback() {
    this.slowFrames = 0;
    this.reducedDensity = 0;
    this.stableSince = null;
    this.lastFeedbackAt = null;
  }

  /** Retire evidence from another window, source, visibility or fill setting. */
  reset() {
    const changed = this.suppressed;
    this.suppressed = false;
    this.reason = null;
    this.breakFeedback();
    this.lastSuppressedAt = 0;
    return changed;
  }

  get needsConfirmation() {
    return !this.suppressed && this.slowFrames === 1;
  }

  /**
   * @param {{delayMs:number, at:number, idleFrameMs:number, visible:boolean, eligible:boolean, paintedDensity:number, nextDensity:number, densityLimit?:number, largeBatch?:boolean}} sample
   * @returns {boolean} Whether a repaint must pick up a changed fill state.
   */
  observe({
    delayMs,
    at,
    idleFrameMs,
    visible,
    eligible,
    paintedDensity,
    nextDensity,
    densityLimit = 16,
    largeBatch = false,
  }) {
    if (!visible || !eligible || !Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(at)) return this.reset();
    if (this.lastFeedbackAt !== null && (at < this.lastFeedbackAt || at - this.lastFeedbackAt > 250)) {
      this.slowFrames = 0;
      this.stableSince = null;
    }
    this.lastFeedbackAt = at;
    const idle = Number.isFinite(idleFrameMs) && idleFrameMs > 0 ? idleFrameMs : 1000 / 60;
    const slow = delayMs > Math.max(33, idle * 2);
    const old = this.suppressed;
    this.slowFrames = slow ? this.slowFrames + 1 : 0;
    if (slow) {
      this.stableSince = null;
      const severe = delayMs > 100;
      if (severe || this.slowFrames >= 2) {
        // Recording confirms a cheaper density first. Review's fixed limit
        // protects fill after confirmation without discarding curve detail.
        if (
          severe ||
          paintedDensity >= densityLimit ||
          (this.reducedDensity > 0 && paintedDensity >= this.reducedDensity)
        ) {
          if (!this.suppressed) this.lastSuppressedAt = at;
          this.suppressed = true;
          this.reason = severe ? 'severe-frame' : largeBatch ? 'large-batch-slow-frame' : 'persistent-slow-frame';
        }
        this.slowFrames = 0;
      }
      // Gestures can lower density after their first measured slow paint. Keep
      // that evidence too, so the next confirmed pair knows a cheaper draw ran.
      if (!this.suppressed && nextDensity > paintedDensity) this.reducedDensity = nextDensity;
    } else if (delayMs <= idle * 1.5) {
      this.stableSince ??= at;
      if (at - this.stableSince >= 2000) {
        this.reducedDensity = 0;
        // A stable unfilled chart gets a filled trial, bounded to once per five seconds.
        if (at - this.lastSuppressedAt >= 5000) {
          this.suppressed = false;
          this.reason = null;
        }
      }
    } else {
      this.stableSince = null;
    }
    return old !== this.suppressed;
  }
}
