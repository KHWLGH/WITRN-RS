// @ts-check
/** Pure CSV import computation, shared by the module Worker and benchmarks. */
import { createCsvParser } from './csv-codec.js';
import { calculateEnergyInRange } from './measurement.js';

const STAT_KEYS = /** @type {const} */ (['voltage', 'current', 'power', 'temp']);

/**
 * Fold exact full-history statistics and energy over freshly parsed columns.
 * @param {ReturnType<ReturnType<typeof createCsvParser>['finish']>} imported
 */
function summarize(imported) {
  const cols = imported.columns;
  const n = cols.x.length;
  /** @type {Record<'voltage'|'current'|'power'|'temp', import('./state.js').StatEntry>} */
  const stats = {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  };
  for (const key of STAT_KEYS) {
    const stat = stats[key];
    cols[key].forEachChunk(
      (values) => {
        for (const value of values) {
          if (!Number.isFinite(value)) continue;
          if (value < stat.min) stat.min = value;
          if (value > stat.max) stat.max = value;
          stat.sum += value;
          stat.count++;
        }
      },
      0,
      n,
    );
  }
  const hasTempData = stats.temp.count > 0;
  const energy = calculateEnergyInRange(
    cols.x,
    cols.current,
    cols.power,
    0,
    n - 1,
    cols.recordingSegments,
    imported.intervalMs,
  );
  return { ...imported, stats, energy, hasTempData };
}

/**
 * Incremental import: feed text in any pieces, then finish once.
 * The returned columns own fresh buffers, so only these buffers may be transferred.
 * @param {{signedCurrent?: boolean, fallbackStartTime: number}} options
 */
export function createCsvImport(options) {
  const parser = createCsvParser(options);
  return {
    /** @param {string} text */
    push: (text) => parser.push(text),
    get rows() {
      return parser.rows;
    },
    finish: () => summarize(parser.finish()),
  };
}

/**
 * Parse and validate a whole file, then fold statistics and energy.
 * @param {string} content
 * @param {{signedCurrent?: boolean, fallbackStartTime: number}} options
 */
export function computeCsvImport(content, options) {
  const session = createCsvImport(options);
  session.push(content);
  return session.finish();
}
