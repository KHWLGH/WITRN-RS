// @ts-check
import { packPdCaptureEntry } from './pd-model.js';

export const PD_EXPORT_BATCH = 128;
export const PD_EXPORT_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** @param {string} text */
export function* encodePdText(text) {
  const bytes = encoder.encode(text);
  for (let from = 0; from < bytes.length; from += PD_EXPORT_BYTES) yield bytes.slice(from, from + PD_EXPORT_BYTES);
}

/** @param {(import('./pd-model.js').PdEntry|import('./pd-model.js').PdDivider)[]} entries @param {boolean} first */
export function* encodePdEntries(entries, first) {
  // Coalesce ordinary entries: one native write per batch, rather than per message.
  let buffer = new Uint8Array(64 * 1024);
  let used = 0;
  for (const entry of entries) {
    for (const bytes of encodePdText(`${first ? '' : ','}${JSON.stringify(packPdCaptureEntry(entry))}`)) {
      let from = 0;
      while (from < bytes.length) {
        const count = Math.min(buffer.length - used, bytes.length - from);
        buffer.set(bytes.subarray(from, from + count), used);
        used += count;
        from += count;
        if (used === buffer.length) {
          yield buffer;
          buffer = new Uint8Array(64 * 1024);
          used = 0;
        }
      }
    }
    first = false;
  }
  if (used) yield buffer.slice(0, used);
}

/** @param {string} exportedAt */
export function pdCapturePrefix(exportedAt) {
  return `{"app":"laPower","kind":"pd-capture","version":2,"exportedAt":${JSON.stringify(exportedAt)},"entries":[`;
}
