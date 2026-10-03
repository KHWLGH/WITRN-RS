// @ts-check
import { F64_CHUNK_SIZE } from './state.js';
/**
 * 主图显示用 min/max 桶。全量数据仍在 F64Col；这里只为 uPlot 准备 O(宽度) 顶点。
 */

export const BUCKET_MIN = 64;
export const DISPLAY_SERIES = 8;

/** @typedef {ArrayLike<number>|import('./state.js').F64Col|import('./state.js').F64Snapshot} NumericColumn */

/** @param {NumericColumn} column @param {number} index */
export function columnValue(column, index) {
  return Number('valueAt' in column ? column.valueAt(index) : column[index]);
}

/** A direct view of one storage block (or the full ordinary array). @param {NumericColumn} column @param {number} index @param {number} end */
export function columnSpan(column, index, end) {
  if ('_chunks' in column) {
    const chunk = column._chunks[index >>> 12];
    return {
      values: chunk,
      base: (index >>> 12) * F64_CHUNK_SIZE,
      end: Math.min(end, ((index >>> 12) + 1) * F64_CHUNK_SIZE),
    };
  }
  return { values: column, base: 0, end };
}

/** @param {number} width */
export function bucketCap(width) {
  const w = Number.isFinite(width) && width > 0 ? width : 600;
  return Math.max(BUCKET_MIN, Math.floor(w));
}

/**
 * 窗口条带宽度（每桶样本数）。`rebuild` 与调用方的复用判断必须同源，否则「已经画对了」
 * 会被误判成需要重建 —— 或反过来让两种密度同时存在。
 * @param {number} count @param {number} cap
 */
export function stripePpb(count, cap) {
  const required = Math.max(1, Math.ceil(count / Math.max(BUCKET_MIN, cap | 0)));
  // Keep a live projection's density stable as history grows. A one-step increase
  // would rebuild the entire history every ~cap incoming samples at 1KSPS.
  return 2 ** Math.ceil(Math.log2(required));
}

/**
 * @param {NumericColumn} xs
 * @param {number} length
 * @param {number} xVal
 * @returns {number}
 */
export function nearestIndex(xs, length, xVal) {
  if (length <= 0) return 0;
  if (!Number.isFinite(xVal)) return 0;
  let lo = 0;
  let hi = length - 1;
  const first = Number(columnValue(xs, lo));
  const last = Number(columnValue(xs, hi));
  if (xVal <= first) return lo;
  if (xVal >= last) return hi;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(columnValue(xs, mid)) <= xVal) lo = mid;
    else hi = mid;
  }
  return xVal - Number(columnValue(xs, lo)) <= Number(columnValue(xs, hi)) - xVal ? lo : hi;
}

/**
 * 第一个 x >= target 的下标；全部更小则返回 length。
 * @param {NumericColumn} xs
 * @param {number} length
 * @param {number} target
 */
export function firstIndexAtOrAfter(xs, length, target) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columnValue(xs, mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * 第一个 x > target 的下标（exclusive end）。
 * @param {NumericColumn} xs
 * @param {number} length
 * @param {number} target
 */
export function firstIndexAfter(xs, length, target) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columnValue(xs, mid) > target) hi = mid;
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
  _flatDirty = 0;
  /** @type {{ x: Float64Array, ys: Float64Array[] }|null} */
  _flatView = null;

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
    this._flatDirty = 0;
  }

  /**
   * @param {number} srcStart
   * @param {number} srcEndWanted
   */
  canAppend(srcStart, srcEndWanted) {
    return this.srcStart === srcStart && this.srcEnd >= srcStart && this.srcEnd <= srcEndWanted;
  }

  /**
   * @param {number} x
   * @param {number[]} values
   */
  pushSample(x, values) {
    this.pushSampleInternal(x, values, true);
  }

  /** Append without pairwise merging; used by a live projection with fixed density. @param {number} x @param {number[]} values */
  pushSampleFixed(x, values) {
    this.pushSampleInternal(x, values, false);
  }

  /** @param {number} x @param {number[]} values @param {boolean} merge */
  pushSampleInternal(x, values, merge) {
    const lastIndex = this.list.length - 1;
    const last = this.list[lastIndex];
    this._flatDirty = Math.min(this._flatDirty, last && last.n < this.ppb ? lastIndex : this.list.length);
    if (last && last.n < this.ppb) {
      last.x1 = x;
      last.n += 1;
      foldValues(last, values);
    } else {
      this.list.push(makeBucket(x, values));
      if (merge) this.mergeDown();
    }
    this.srcEnd += 1;
  }

  mergeDown() {
    while (this.list.length > this.cap) this.coarsenTo(this.ppb * 2);
  }

  /** Coarsen a fixed prefix without rereading samples; the final partial bucket stays appendable. @param {number} ppb */
  coarsenTo(ppb) {
    if (!Number.isFinite(ppb) || ppb < this.ppb || Math.log2(ppb / this.ppb) % 1 !== 0) {
      throw new RangeError('Bucket density must be a power-of-two multiple of the current density');
    }
    while (this.ppb < ppb) {
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
      this._flatDirty = 0;
    }
  }

  /**
   * 单遍按条带折叠，不给每个样本分配中间数组。
   * @param {NumericColumn} xs
   * @param {NumericColumn[]} series
   * @param {number} start
   * @param {number} end
   * @param {number} cap
   * @param {import('./chart-extrema.js').ExactExtremaIndex|null} [extrema=null]
   */
  rebuild(xs, series, start, end, cap, extrema = null) {
    const step = this.beginRebuild(xs, series, start, end, cap, extrema);
    while (!step(Infinity)) {
      /* synchronous public API */
    }
  }

  /**
   * Build privately in bounded chunks, including partial stripes. Callers must
   * publish this instance only after step() returns true.
   * @param {NumericColumn} xs @param {NumericColumn[]} series
   * @param {number} start @param {number} end @param {number} cap
   * @param {import('./chart-extrema.js').ExactExtremaIndex|null} [extrema=null]
   * @returns {(maxSamples?: number) => boolean}
   */
  beginRebuild(xs, series, start, end, cap, extrema = null) {
    this.reset(start);
    if (end <= start) {
      this.cap = Math.max(BUCKET_MIN, cap | 0);
      return () => true;
    }
    const n = end - start;
    const ppb = stripePpb(n, cap);
    const plainColumns = !('_chunks' in xs) && series.every((col) => !col || !('_chunks' in col));
    this.ppb = ppb;
    let i = start;
    /** @type {DisplayBucket|null} */
    let bucket = null;
    let stripeEnd = start;
    return (maxSamples = 4096) => {
      let remaining = Math.max(1, maxSamples);
      while (i < end && remaining > 0) {
        if (!bucket) {
          stripeEnd = Math.min(i + ppb, end);
          bucket = makeBucketFromIndex(xs, series, i++);
          remaining--;
        }
        const through = Math.min(stripeEnd, i + remaining);
        if (extrema) {
          extrema.fold(bucket, series, i, through);
          bucket.n += through - i;
          bucket.x1 = Number(columnValue(xs, through - 1));
        } else {
          if (plainColumns) {
            for (let j = i; j < through; j++) foldIndex(bucket, xs, series, j);
          } else {
            foldRange(bucket, xs, series, i, through);
          }
        }
        remaining -= through - i;
        i = through;
        if (i === stripeEnd) {
          this.list.push(bucket);
          bucket = null;
        }
      }
      this.srcEnd = i;
      // 条带数本来就贴着密度上限，此时 cap 保持等于它就意味着「录制中再落一个样本」
      // 会 mergeDown 把整表分辨率腰斩 —— 画面会在没人操作时自己变稀。留一倍余量，
      // 分辨率的合法变化由调用方比较 stripePpb 后整体重建决定，不靠这里降级。
      if (i === end) this.cap = Math.max(BUCKET_MIN, this.list.length * 2);
      return i === end;
    };
  }

  /**
   * @param {NumericColumn} xs
   * @param {NumericColumn[]} series
   * @param {number} end
   */
  appendThrough(xs, series, end) {
    this.appendThroughMode(xs, series, end, false);
  }

  /** Append a live tail while preserving the existing samples-per-bucket density. @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} end */
  appendThroughFixed(xs, series, end) {
    this.appendThroughMode(xs, series, end, true);
  }

  /** @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} end @param {boolean} fixedDensity */
  appendThroughMode(xs, series, end, fixedDensity) {
    const values = new Array(DISPLAY_SERIES);
    for (let i = this.srcEnd; i < end; ) {
      const xSpan = columnSpan(xs, i, end);
      const spans = series.map((col) => (col ? columnSpan(col, i, end) : null));
      const through = Math.min(xSpan.end, ...spans.map((span) => span?.end ?? end));
      for (; i < through; i++) {
        for (let s = 0; s < DISPLAY_SERIES; s++) {
          const span = spans[s];
          values[s] = span ? Number(span.values[i - span.base]) : Number.NaN;
        }
        if (fixedDensity) this.pushSampleFixed(Number(xSpan.values[i - xSpan.base]), values);
        else this.pushSample(Number(xSpan.values[i - xSpan.base]), values);
      }
    }
  }

  /** @returns {{ x: Float64Array, ys: Float64Array[] }} */
  flatten() {
    const n = this.list.length * 2;
    if (!this._flatX || !this._flatYs || this._flatCap < n) {
      this._flatCap = Math.max(n, this._flatCap * 2 || 64);
      this._flatX = new Float64Array(this._flatCap);
      this._flatYs = Array.from({ length: DISPLAY_SERIES }, () => new Float64Array(this._flatCap));
      this._flatDirty = 0;
      this._flatView = null;
    }
    const x = this._flatX;
    const ys = this._flatYs;
    for (let i = this._flatDirty; i < this.list.length; i++) {
      const b = this.list[i];
      const k = i * 2;
      const xm = (b.x0 + b.x1) / 2;
      x[k] = xm;
      x[k + 1] = xm;
      for (let s = 0; s < DISPLAY_SERIES; s++) {
        ys[s][k] = Number(b.min[s]);
        ys[s][k + 1] = Number(b.max[s]);
      }
    }
    this._flatDirty = this.list.length;
    if (!this._flatView || this._flatView.x.length !== n) {
      this._flatView = { x: x.subarray(0, n), ys: ys.map((col) => col.subarray(0, n)) };
    }
    return this._flatView;
  }
}

/**
 * @param {NumericColumn} xs
 * @param {NumericColumn[]} series
 * @param {number} i
 */
function makeBucketFromIndex(xs, series, i) {
  /** @type {number[]} */
  const values = new Array(DISPLAY_SERIES);
  for (let s = 0; s < DISPLAY_SERIES; s++) {
    const col = series[s];
    values[s] = col ? Number(columnValue(col, i)) : Number.NaN;
  }
  return makeBucket(Number(columnValue(xs, i)), values);
}

/** @param {DisplayBucket} bucket @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} i */
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

/**
 * @param {DisplayBucket} bucket
 * @param {NumericColumn} xs
 * @param {NumericColumn[]} series
 * @param {number} start @param {number} end
 */
function foldRange(bucket, xs, series, start, end) {
  if (!('_chunks' in xs) && series.every((col) => !col || !('_chunks' in col))) {
    for (let i = start; i < end; i++) {
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
    return;
  }
  for (let i = start; i < end; ) {
    const xSpan = columnSpan(xs, i, end);
    const spans = series.map((col) => (col ? columnSpan(col, i, end) : null));
    const through = Math.min(xSpan.end, ...spans.map((span) => span?.end ?? end));
    for (; i < through; i++) {
      bucket.x1 = Number(xSpan.values[i - xSpan.base]);
      bucket.n += 1;
      for (let s = 0; s < DISPLAY_SERIES; s++) {
        const span = spans[s];
        const v = span ? Number(span.values[i - span.base]) : Number.NaN;
        if (!Number.isFinite(v)) continue;
        const curMin = bucket.min[s];
        const curMax = bucket.max[s];
        if (curMin === undefined || !Number.isFinite(curMin) || v < curMin) bucket.min[s] = v;
        if (curMax === undefined || !Number.isFinite(curMax) || v > curMax) bucket.max[s] = v;
      }
    }
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
  return a <= b ? a : b;
}

/** @param {number} a @param {number} b */
function nanMax(a, b) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a >= b ? a : b;
}
