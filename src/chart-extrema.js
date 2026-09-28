// @ts-check
import { columnSpan } from './chart-buckets.js';

/** @typedef {import('./chart-buckets.js').NumericColumn} NumericColumn */

/** 金字塔叶子覆盖的样本数；条带窄于它时 fold 的 head/tail 暴力扫就等于整条，省不下读取。 */
export const BLOCK_SIZE = 32;
const CHANNELS = 8;
const STRIDE = CHANNELS * 2;

export class ExactExtremaIndex {
  /** @type {Float64Array[]} */
  levels = [];
  blocks = 0;

  reset() {
    this.levels = [];
    this.blocks = 0;
  }

  get byteLength() {
    return this.levels.reduce((bytes, level) => bytes + level.byteLength, 0);
  }

  /** @param {number} level @param {number} nodes */
  ensure(level, nodes) {
    let values = this.levels[level];
    if (!values || values.length < nodes * STRIDE) {
      const next = new Float64Array(Math.max(nodes * STRIDE, values ? values.length * 2 : STRIDE * 64));
      if (values) next.set(values);
      this.levels[level] = values = next;
    }
    return values;
  }

  /** @param {NumericColumn[]} series @param {number} length */
  sync(series, length) {
    this.syncStep(series, length, Infinity);
  }

  /**
   * Publish only complete leaves and ancestors. Queries may safely mix this prefix
   * with the unindexed raw tail between calls.
   * @param {NumericColumn[]} series @param {number} length
   * @param {number} [maxBlocks=128]
   * @returns {boolean} Whether the requested prefix is complete.
   */
  syncStep(series, length, maxBlocks = 128) {
    const complete = Math.floor(length / BLOCK_SIZE);
    if (complete < this.blocks) this.reset();
    if (complete === this.blocks) return true;
    if (this.levels.length === 0) {
      // Cold builds know their target: reserve all levels once instead of doing
      // large parent-buffer copies halfway through a cooperative slice.
      for (let level = 0, nodes = complete; nodes > 0; level++, nodes = Math.floor(nodes / 2))
        this.ensure(level, nodes);
    }
    const through = Math.min(complete, this.blocks + Math.max(1, Math.floor(maxBlocks)));
    // Reserve the known target once; repeated doubling would copy the entire
    // indexed prefix inside a later slice and retain needless spare capacity.
    const leaves = this.ensure(0, complete);
    for (let block = this.blocks; block < through; block++) {
      const start = block * BLOCK_SIZE;
      const offset = block * STRIDE;
      for (let s = 0; s < CHANNELS; s++) {
        const col = series[s];
        let min = Number.NaN;
        let max = Number.NaN;
        if (!col) {
          leaves[offset + s] = min;
          leaves[offset + CHANNELS + s] = max;
          continue;
        }
        const span = columnSpan(col, start, start + BLOCK_SIZE);
        for (let i = start; i < start + BLOCK_SIZE; i++) {
          const v = Number(span.values[i - span.base]);
          if (!Number.isFinite(v)) continue;
          if (!Number.isFinite(min) || v < min) min = v;
          if (!Number.isFinite(max) || v > max) max = v;
        }
        leaves[offset + s] = min;
        leaves[offset + CHANNELS + s] = max;
      }
      let node = block;
      for (let level = 1; node % 2 === 1; level++) {
        const child = this.levels[level - 1];
        const left = (node - 1) * STRIDE;
        const right = node * STRIDE;
        node = Math.floor(node / 2);
        const parent = this.ensure(level, node + 1);
        const target = node * STRIDE;
        for (let s = 0; s < CHANNELS; s++) {
          const aMin = child[left + s];
          const bMin = child[right + s];
          const aMax = child[left + CHANNELS + s];
          const bMax = child[right + CHANNELS + s];
          parent[target + s] = !Number.isFinite(aMin) || bMin < aMin ? bMin : aMin;
          parent[target + CHANNELS + s] = !Number.isFinite(aMax) || bMax > aMax ? bMax : aMax;
        }
      }
    }
    this.blocks = through;
    return this.blocks === complete;
  }

  /**
   * @param {{min: number[], max: number[]}} result
   * @param {NumericColumn[]} series
   * @param {number} start
   * @param {number} end
   */
  fold(result, series, start, end) {
    const firstBlock = Math.ceil(start / BLOCK_SIZE);
    const lastBlock = Math.min(Math.floor(end / BLOCK_SIZE), this.blocks);
    const headEnd = Math.min(end, firstBlock * BLOCK_SIZE);
    this.foldRaw(result, series, start, headEnd);
    let block = firstBlock;
    while (block < lastBlock) {
      let level = 0;
      let span = 1;
      while (block % (span * 2) === 0 && block + span * 2 <= lastBlock) {
        span *= 2;
        level++;
      }
      const values = this.levels[level];
      const offset = (block / span) * STRIDE;
      for (let s = 0; s < CHANNELS; s++) {
        const min = values[offset + s];
        const max = values[offset + CHANNELS + s];
        if (Number.isFinite(min) && (!Number.isFinite(result.min[s]) || min < result.min[s])) result.min[s] = min;
        if (Number.isFinite(max) && (!Number.isFinite(result.max[s]) || max > result.max[s])) result.max[s] = max;
      }
      block += span;
    }
    this.foldRaw(result, series, Math.max(headEnd, block * BLOCK_SIZE), end);
  }

  /**
   * @param {{min: number[], max: number[]}} result
   * @param {NumericColumn[]} series
   * @param {number} start
   * @param {number} end
   */
  foldRaw(result, series, start, end) {
    for (let s = 0; s < CHANNELS; s++) {
      const col = series[s];
      let min = result.min[s];
      let max = result.max[s];
      if (col)
        for (let i = start; i < end; ) {
          const span = columnSpan(col, i, end);
          for (; i < span.end; i++) {
            const v = Number(span.values[i - span.base]);
            if (!Number.isFinite(v)) continue;
            if (!Number.isFinite(min) || v < min) min = v;
            if (!Number.isFinite(max) || v > max) max = v;
          }
        }
      result.min[s] = min;
      result.max[s] = max;
    }
  }
}
