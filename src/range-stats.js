// @ts-check
import { yieldToMainThread } from './cooperative.js';

/**
 * @typedef {{
 *   columns: import('./state.js').ChartSeriesColumns, revision: number,
 *   startIndex: number, endIndex: number, len: number, maxStepS: number,
 *   minV: number, maxV: number, minC: number, maxC: number,
 *   minP: number, maxP: number, minT: number, maxT: number,
 *   sumV: number, countV: number, sumC: number, countC: number,
 *   sumP: number, countP: number, sumT: number, countT: number,
 *   wh: number, mah: number,
 * }} RangeStats
 */

/** @param {import('./state.js').ChartSeriesColumns} columns */
export function rangeStatsRevision(columns) {
  return (
    columns.x.revision +
    columns.voltage.revision +
    columns.current.revision +
    columns.power.revision +
    columns.temp.revision +
    columns.recordingSegments.revision
  );
}

/**
 * Append and buffer growth leave these fixed-length prefix views unchanged.
 * Replacing cells must invalidate the job through isCancelled before its next slice.
 * @param {import('./state.js').ChartSeriesColumns} columns
 * @param {number} startIndex
 * @param {number} endIndex
 * @param {number} maxStepS
 */
export function captureRangeStatsSnapshot(columns, startIndex, endIndex, maxStepS) {
  const len = columns.x.length;
  return {
    columns,
    revision: rangeStatsRevision(columns),
    startIndex,
    endIndex,
    len,
    maxStepS,
    x: columns.x.snapshot(),
    voltage: columns.voltage.snapshot(),
    current: columns.current.snapshot(),
    power: columns.power.snapshot(),
    temp: columns.temp.snapshot(),
    recordingSegments: columns.recordingSegments.snapshot(),
  };
}

/** @typedef {ReturnType<typeof captureRangeStatsSnapshot>} RangeStatsSnapshot */

/** @param {RangeStatsSnapshot} snapshot @param {RangeStats|null} seed @returns {RangeStats} */
function initialStats(snapshot, seed) {
  return {
    minV: Infinity,
    maxV: -Infinity,
    minC: Infinity,
    maxC: -Infinity,
    minP: Infinity,
    maxP: -Infinity,
    minT: Infinity,
    maxT: -Infinity,
    sumV: 0,
    countV: 0,
    sumC: 0,
    countC: 0,
    sumP: 0,
    countP: 0,
    sumT: 0,
    countT: 0,
    wh: 0,
    mah: 0,
    ...seed,
    columns: snapshot.columns,
    revision: snapshot.revision,
    startIndex: snapshot.startIndex,
    endIndex: snapshot.endIndex,
    len: snapshot.len,
    maxStepS: snapshot.maxStepS,
  };
}

/**
 * @param {RangeStats} stats @param {RangeStatsSnapshot} snapshot @param {number} i
 * @param {number} offset @param {Float64Array} xValues @param {Float64Array} voltages
 * @param {Float64Array} currents @param {Float64Array} powers @param {Float64Array} temps
 * @param {Float64Array} segments
 */
function foldPoint(stats, snapshot, i, offset, xValues, voltages, currents, powers, temps, segments) {
  const v = voltages[offset];
  const c = currents[offset];
  const p = powers[offset];
  const t = temps[offset];
  if (Number.isFinite(v)) {
    if (v < stats.minV) stats.minV = v;
    if (v > stats.maxV) stats.maxV = v;
    stats.sumV += v;
    stats.countV += 1;
  }
  if (Number.isFinite(c)) {
    if (c < stats.minC) stats.minC = c;
    if (c > stats.maxC) stats.maxC = c;
    stats.sumC += c;
    stats.countC += 1;
  }
  if (Number.isFinite(p)) {
    if (p < stats.minP) stats.minP = p;
    if (p > stats.maxP) stats.maxP = p;
    stats.sumP += p;
    stats.countP += 1;
  }
  if (Number.isFinite(t)) {
    if (t < stats.minT) stats.minT = t;
    if (t > stats.maxT) stats.maxT = t;
    stats.sumT += t;
    stats.countT += 1;
  }
  if (i <= stats.startIndex) return;
  const previousSegment = offset ? segments[offset - 1] : snapshot.recordingSegments.valueAt(i - 1);
  if (Number.isFinite(segments[offset]) && segments[offset] !== previousSegment) return;
  const previousX = offset ? xValues[offset - 1] : snapshot.x.valueAt(i - 1);
  const dt = (xValues[offset] - previousX) / 3600;
  const currentAbs = Math.abs(c);
  const powerAbs = Math.abs(p);
  if (
    dt < 0 ||
    dt > snapshot.maxStepS / 3600 ||
    !Number.isFinite(dt) ||
    !Number.isFinite(currentAbs) ||
    !Number.isFinite(powerAbs)
  )
    return;
  stats.wh += powerAbs * dt;
  stats.mah += currentAbs * 1000 * dt;
}

/** @param {RangeStats} stats @param {RangeStatsSnapshot} snapshot @param {number} from @param {number} end */
function foldBlock(stats, snapshot, from, end) {
  let i = from;
  while (i <= end) {
    const chunkStart = Math.floor(i / 4096) * 4096;
    const chunkEnd = Math.min(end + 1, chunkStart + 4096);
    const read = (/** @type {import('./state.js').F64ColSnapshot} */ column) => {
      const chunk = column.chunks(chunkStart, chunkEnd).next().value;
      if (!chunk) throw new RangeError('Range stats index out of bounds');
      return chunk.values;
    };
    const xs = read(snapshot.x);
    const voltages = read(snapshot.voltage);
    const currents = read(snapshot.current);
    const powers = read(snapshot.power);
    const temps = read(snapshot.temp);
    const segments = read(snapshot.recordingSegments);
    for (; i < chunkEnd; i++)
      foldPoint(stats, snapshot, i, i - chunkStart, xs, voltages, currents, powers, temps, segments);
  }
}

/**
 * @typedef {{seed?: RangeStats|null, foldStart?: number}} FoldOptions
 * @param {RangeStatsSnapshot} snapshot
 * @param {FoldOptions} [options]
 */
export function computeRangeStatsSync(snapshot, { seed = null, foldStart = snapshot.startIndex } = {}) {
  const stats = initialStats(snapshot, seed);
  foldBlock(stats, snapshot, foldStart, snapshot.endIndex);
  return stats;
}

/**
 * Yield a macrotask, so timers, rendering and user input can run between slices.
 * @returns {Promise<void>}
 */
/**
 * Keep the same sample order and arithmetic as the synchronous fold.
 * @param {RangeStatsSnapshot} snapshot
 * @param {FoldOptions & {
 *   sliceMs?: number, checkEvery?: number, now?: () => number,
 *   yieldTask?: () => Promise<void>, isCancelled?: () => boolean,
 * }} [options]
 * @returns {Promise<RangeStats|null>}
 */
export async function computeRangeStatsAsync(
  snapshot,
  {
    seed = null,
    foldStart = snapshot.startIndex,
    sliceMs = 1.5,
    checkEvery = 512,
    now = () => performance.now(),
    yieldTask = yieldToMainThread,
    isCancelled = () => false,
  } = {},
) {
  const stats = initialStats(snapshot, seed);
  const block = Math.max(1, Math.floor(checkEvery));
  let i = foldStart;
  while (i <= snapshot.endIndex) {
    if (isCancelled()) return null;
    const deadline = now() + sliceMs;
    do {
      const end = Math.min(i + block - 1, snapshot.endIndex);
      foldBlock(stats, snapshot, i, end);
      i = end + 1;
    } while (i <= snapshot.endIndex && now() < deadline && !isCancelled());
    if (isCancelled()) return null;
    if (i <= snapshot.endIndex) await yieldTask();
  }
  return isCancelled() ? null : stats;
}
