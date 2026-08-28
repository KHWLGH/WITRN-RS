// @ts-check
/**
 * 主图显示用 min/max 桶。全量数据仍在 F64Col；这里只为 uPlot 准备 O(宽度) 顶点。
 */

export const BUCKET_MIN = 64;
export const DISPLAY_SERIES = 8;

/** @param {number} width */
export function bucketCap(width) {
  const w = Number.isFinite(width) && width > 0 ? width : 600;
  return Math.max(BUCKET_MIN, Math.floor(w));
}

/**
 * @param {ArrayLike<number>} xs
 * @param {number} length
 * @param {number} xVal
 * @returns {number}
 */
export function nearestIndex(xs, length, xVal) {
  if (length <= 0) return 0;
  if (!Number.isFinite(xVal)) return 0;
  let lo = 0;
  let hi = length - 1;
  const first = Number(xs[lo]);
  const last = Number(xs[hi]);
  if (xVal <= first) return lo;
  if (xVal >= last) return hi;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(xs[mid]) <= xVal) lo = mid;
    else hi = mid;
  }
  return xVal - Number(xs[lo]) <= Number(xs[hi]) - xVal ? lo : hi;
}

/**
 * 第一个 x >= target 的下标；全部更小则返回 length。
 * @param {ArrayLike<number>} xs
 * @param {number} length
 * @param {number} target
 */
export function firstIndexAtOrAfter(xs, length, target) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * 第一个 x > target 的下标（exclusive end）。
 * @param {ArrayLike<number>} xs
 * @param {number} length
 * @param {number} target
 */
export function firstIndexAfter(xs, length, target) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * @typedef {{
 *   x0: number, x1: number, n: number,
 *   min: number[], max: number[],
 * }} DisplayBucket
 */

export class SeriesBuckets {
  /** @type {DisplayBucket[]} */
  list = [];
  ppb = 1;
  srcStart = 0;
  srcEnd = 0;
  cap = BUCKET_MIN;
  /** @type {Float64Array|null} */
  _flatX = null;
  /** @type {Float64Array[]|null} */
  _flatYs = null;
  _flatCap = 0;

  constructor() {
    this.reset(0);
  }

  /** @param {number} [srcStart=0] */
  reset(srcStart = 0) {
    /** @type {DisplayBucket[]} */
    this.list = [];
    this.ppb = 1;
    this.srcStart = srcStart;
    this.srcEnd = srcStart;
    this.cap = BUCKET_MIN;
  }

  /**
   * @param {number} srcStart
   * @param {number} srcEndWanted
   */
  canAppend(srcStart, srcEndWanted) {
    return this.srcStart === srcStart && this.srcEnd >= srcStart && this.srcEnd <= srcEndWanted;
  }

  /**
   * 当前桶是否覆盖 [start, end)（拖动缩进时可只改 X 窗、不必重建）。
   * @param {number} start
   * @param {number} end
   */
  covers(start, end) {
    return end >= start && this.srcStart <= start && this.srcEnd >= end && (this.list.length > 0 || end === start);
  }

  /**
   * @param {number} x
   * @param {number[]} values
   */
  pushSample(x, values) {
    const last = this.list[this.list.length - 1];
    if (last && last.n < this.ppb) {
      last.x1 = x;
      last.n += 1;
      foldValues(last, values);
    } else {
      this.list.push(makeBucket(x, values));
      this.mergeDown();
    }
    this.srcEnd += 1;
  }

  mergeDown() {
    while (this.list.length > this.cap) {
      /** @type {DisplayBucket[]} */
      const merged = [];
      for (let i = 0; i < this.list.length; i += 2) {
        const a = this.list[i];
        const b = this.list[i + 1];
        if (!a) break;
        if (!b) {
          merged.push(a);
          break;
        }
        merged.push(mergeBucket(a, b));
      }
      this.list = merged;
      this.ppb *= 2;
    }
  }

  /**
   * 单遍按条带折叠，不给每个样本分配中间数组。
   * @param {ArrayLike<number>} xs
   * @param {ArrayLike<number>[]} series
   * @param {number} start
   * @param {number} end
   * @param {number} cap
   */
  rebuild(xs, series, start, end, cap) {
    this.reset(start);
    this.cap = Math.max(BUCKET_MIN, cap | 0);
    if (end <= start) return;
    const n = end - start;
    const ppb = Math.max(1, Math.ceil(n / this.cap));
    this.ppb = ppb;
    for (let i = start; i < end; i += ppb) {
      const stripeEnd = i + ppb < end ? i + ppb : end;
      const bucket = makeBucketFromIndex(xs, series, i);
      for (let j = i + 1; j < stripeEnd; j++) foldIndex(bucket, xs, series, j);
      this.list.push(bucket);
    }
    this.srcEnd = end;
  }

  /**
   * @param {ArrayLike<number>} xs
   * @param {ArrayLike<number>[]} series
   * @param {number} end
   */
  appendThrough(xs, series, end) {
    const values = new Array(DISPLAY_SERIES);
    for (let i = this.srcEnd; i < end; i++) {
      for (let s = 0; s < DISPLAY_SERIES; s++) {
        const col = series[s];
        values[s] = col ? Number(col[i]) : Number.NaN;
      }
      this.pushSample(Number(xs[i]), values);
    }
  }

  /** @returns {{ x: Float64Array, ys: Float64Array[] }} */
  flatten() {
    const n = this.list.length * 2;
    if (n === 0) {
      const empty = new Float64Array(0);
      return { x: empty, ys: Array.from({ length: DISPLAY_SERIES }, () => empty) };
    }
    if (!this._flatX || !this._flatYs || this._flatCap < n) {
      this._flatCap = Math.max(n, this._flatCap * 2 || 64);
      this._flatX = new Float64Array(this._flatCap);
      this._flatYs = Array.from({ length: DISPLAY_SERIES }, () => new Float64Array(this._flatCap));
    }
    const x = this._flatX;
    const ys = this._flatYs;
    let k = 0;
    for (const b of this.list) {
      const xm = (b.x0 + b.x1) / 2;
      x[k] = xm;
      x[k + 1] = xm;
      for (let s = 0; s < DISPLAY_SERIES; s++) {
        const col = ys[s];
        if (!col) continue;
        col[k] = Number(b.min[s]);
        col[k + 1] = Number(b.max[s]);
      }
      k += 2;
    }
    return {
      x: x.subarray(0, n),
      ys: ys.map((col) => col.subarray(0, n)),
    };
  }
}

/**
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>[]} series
 * @param {number} i
 */
function makeBucketFromIndex(xs, series, i) {
  /** @type {number[]} */
  const values = new Array(DISPLAY_SERIES);
  for (let s = 0; s < DISPLAY_SERIES; s++) {
    const col = series[s];
    values[s] = col ? Number(col[i]) : Number.NaN;
  }
  return makeBucket(Number(xs[i]), values);
}

/**
 * @param {DisplayBucket} bucket
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>[]} series
 * @param {number} i
 */
function foldIndex(bucket, xs, series, i) {
  bucket.x1 = Number(xs[i]);
  bucket.n += 1;
  for (let s = 0; s < DISPLAY_SERIES; s++) {
    const col = series[s];
    const v = col ? Number(col[i]) : Number.NaN;
    if (!Number.isFinite(v)) continue;
    const curMin = bucket.min[s];
    const curMax = bucket.max[s];
    if (curMin === undefined || !Number.isFinite(curMin) || v < curMin) bucket.min[s] = v;
    if (curMax === undefined || !Number.isFinite(curMax) || v > curMax) bucket.max[s] = v;
  }
}

/** @param {number} x @param {number[]} values */
function makeBucket(x, values) {
  /** @type {number[]} */
  const min = new Array(DISPLAY_SERIES);
  /** @type {number[]} */
  const max = new Array(DISPLAY_SERIES);
  for (let s = 0; s < DISPLAY_SERIES; s++) {
    const v = values[s];
    if (Number.isFinite(v)) {
      min[s] = v;
      max[s] = v;
    } else {
      min[s] = Number.NaN;
      max[s] = Number.NaN;
    }
  }
  return { x0: x, x1: x, n: 1, min, max };
}

/** @param {DisplayBucket} bucket @param {number[]} values */
function foldValues(bucket, values) {
  for (let s = 0; s < DISPLAY_SERIES; s++) {
    const v = values[s];
    if (v === undefined || !Number.isFinite(v)) continue;
    const curMin = bucket.min[s];
    const curMax = bucket.max[s];
    if (curMin === undefined || !Number.isFinite(curMin) || v < curMin) bucket.min[s] = v;
    if (curMax === undefined || !Number.isFinite(curMax) || v > curMax) bucket.max[s] = v;
  }
}

/** @param {DisplayBucket} a @param {DisplayBucket} b */
function mergeBucket(a, b) {
  /** @type {number[]} */
  const min = new Array(DISPLAY_SERIES);
  /** @type {number[]} */
  const max = new Array(DISPLAY_SERIES);
  for (let s = 0; s < DISPLAY_SERIES; s++) {
    min[s] = nanMin(Number(a.min[s]), Number(b.min[s]));
    max[s] = nanMax(Number(a.max[s]), Number(b.max[s]));
  }
  return { x0: a.x0, x1: b.x1, n: a.n + b.n, min, max };
}

/** @param {number} a @param {number} b */
function nanMin(a, b) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a < b ? a : b;
}

/** @param {number} a @param {number} b */
function nanMax(a, b) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a > b ? a : b;
}
