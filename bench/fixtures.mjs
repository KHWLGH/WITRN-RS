export const VERSION = 'witrn-f64-v1';
export const SEED = 0x6d2b79f5;
export const SIZES = [10_000, 100_000, 1_000_000];
export const CHANNELS = ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'];
export const EPOCH_MS = 1704067200000;

// xorshift32: only specified 32-bit integer operations; no transcendental math.
export function prng(seed = SEED) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}
export function fixture(size, seed = SEED, intervalMs = 10) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 5_000_000) throw new RangeError('size must be 1..5000000');
  const next = prng(seed);
  const x = new Float64Array(size);
  const timestamps = new Float64Array(size);
  const ys = CHANNELS.map(() => new Float64Array(size));
  for (let i = 0; i < size; i++) {
    x[i] = (i * intervalMs) / 1000;
    timestamps[i] = EPOCH_MS + i * intervalMs;
    for (let s = 0; s < 8; s++) {
      let v = ((next() & 65535) - 32768) / 4096 + (s === 0 ? 12 : s === 3 ? 24 : 0);
      if (i % 8191 === 4095) v += (s % 2 ? -1 : 1) * 1024;
      if ((i + s * 13) % 257 === 256) v = Number.NaN;
      if (i === 1) v = -0;
      if (i === 2) v = 0;
      ys[s][i] = v;
    }
  }
  return { version: VERSION, seed: seed >>> 0, size, x, timestamps, ys };
}
// Explicit little-endian serialization; NaN has the canonical quiet-NaN payload.
export function canonicalBytes(columns) {
  const bytes = new Uint8Array(columns.reduce((n, c) => n + c.length * 8, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const col of columns)
    for (const value of col) {
      if (Number.isNaN(value)) {
        view.setUint32(offset, 0, true);
        view.setUint32(offset + 4, 0x7ff80000, true);
      } else view.setFloat64(offset, value, true);
      offset += 8;
    }
  return bytes;
}
export function fixtureBytes(f) {
  return canonicalBytes([f.x, f.timestamps, ...f.ys]);
}
// Transport edge cases are separate from the sorted chart input. Not a native replay.
export function boundaryFixture() {
  return {
    times: [0, 0.01, 0.01, 0.005, 3.01, 3.02, NaN, 3.04],
    current: [1, -2, 3, 4, 5, NaN, 7, 8],
    power: [2, -4, 6, 8, 10, 12, 14, 16],
    labels: ['start', '100Hz', 'duplicate', 'out-of-order', 'pause-gap', 'missing', 'invalid-time', 'tail'],
  };
}
// Mirrors the recordingSegments column: a session id per point, NaN where never recorded.
// src/data.js:608 relies on a NaN id NOT being a boundary, so the tail must stay NaN.
export const SEGMENTS_VERSION = 'segments-v1';
export function segmentsFixture(size, { pauses = 64, nanTailRatio = 0.02 } = {}) {
  const segments = new Float64Array(size);
  const every = Math.max(1, Math.floor(size / pauses));
  for (let i = 0; i < size; i++) segments[i] = Math.floor(i / every);
  segments.fill(NaN, size - Math.max(1, Math.floor(size * nanTailRatio)));
  return segments;
}
