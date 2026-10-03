// @ts-check
/** Host receive clock; never compare received_us with performance.now().
 * @typedef {import('./state.js').DeviceData & {generation:number, seq:number, segment:number, received_us:number, wall_anchor_ms:number, segment_start_us:number, rate_ms:number}} StreamSample
 * @typedef {{generation:number, last_seq:number, error?:string|null}} StreamEnd
 * @typedef {{generation:number, wall_anchor_ms:number}} StreamOpen
 * @typedef {{generation:number, after_seq:number, segment:number, received_us:number, wall_anchor_ms:number, rate_ms:number}} StreamBoundary
 * @typedef {{id:number, generation:number, columns:object, baseSeconds:number, lastX:number|null, first:boolean}} RecordingSegment
 * @typedef {{invoke:(command:string,args?:Record<string,unknown>)=>Promise<any>, getColumns:()=>object, onSample:(sample:StreamSample, segment:RecordingSegment|null)=>void, onBatchStart?: (size:number)=>void, onBatch?:(count:number)=>void, onBatchEnd?: (count:number, timing:{startedAt:number, endedAt:number, durationMs:number, firstReceivedWallMs?:number|null, lastReceivedWallMs?:number|null, lastSeq:(number|null)|undefined})=>void, onError:(error:StreamEnd)=>void, onEnd:(end:StreamEnd)=>void, drainTimeoutMs?:number}} StreamHooks
 */

import { performanceDiagnostics } from './performance-diagnostics.js';

/** No DOM, rAF or timers on the consumption path.
 * Every selected point is processed in seq order; only UI work may coalesce.
 * @param {Partial<StreamHooks>} [options]
 */
export function createDeviceStream(options = {}) {
  /** @type {StreamHooks} */
  const hooks = {
    invoke: (command, args) => window.__TAURI__.core.invoke(command, args),
    getColumns: () => null,
    onSample() {},
    onBatch() {},
    onError: (e) => console.error(e.error),
    onEnd() {},
    drainTimeoutMs: 10000,
    ...options,
  };
  let enabled = false;
  let generation = 0;
  let seq = 0;
  let segmentId = 0;
  /** @type {RecordingSegment|null} */
  let segment = null;
  /** @type {StreamEnd|null} */
  let ended = null;
  /** @type {StreamEnd|null} */
  let terminalError = null;
  let failed = false;
  let closing = false;
  /** 已经尝试过几次退出屏障；第一次严格，之后允许走终态出口。 */
  let drainAttempts = 0;
  let columns = hooks.getColumns();
  let replacement = 0;
  let displayBlocked = false;
  /** Terminal `stream-error` payloads, oldest first. Kept so an acceptance run can be judged from
   *  what the app actually saw instead of from a number someone retypes into a form. */
  const terminalErrors = /** @type {StreamEnd[]} */ ([]);
  let controlTail = Promise.resolve();
  let ackTail = Promise.resolve();
  let ackQueued = false;
  let batchCount = 0;
  let batchPoints = 0;
  let lastBatchSize = 0;
  let lastBatchDurationMs = 0;
  let maxBatchDurationMs = 0;
  let lastBatchStartedAt = 0;
  let lastBatchEndedAt = 0;
  /** @type {Set<{generation:number, seq:number, resolve:()=>void, reject:(e:Error)=>void, timer:ReturnType<typeof setTimeout>}>} */
  const waiters = new Set();

  /** @param {string} message */
  function fail(message) {
    if (failed) return;
    failed = true;
    segment = null;
    // Recorded here as well as in handleError: an internal stop (seq gap, bad timestamp) is just as
    // much a terminal error as one arriving over IPC, and the acceptance counters must not depend on
    // which side noticed.
    const error = { generation, last_seq: seq, error: message };
    terminalErrors.push(error);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
    waiters.clear();
    hooks.onError(error);
    // Do not acknowledge a hole; stop the producer but keep the window alive.
    void hooks.invoke('drain_device_stream', { generation }).catch((e) => console.error(e));
  }

  function notify() {
    for (const w of waiters) {
      if (w.generation !== generation || seq >= w.seq) {
        clearTimeout(w.timer);
        waiters.delete(w);
        if (w.generation === generation) w.resolve();
        else w.reject(new Error('stream generation changed'));
      }
    }
  }

  /** @param {number} target @param {number} [gen] */
  function waitForSeq(target, gen = generation) {
    if (failed || gen !== generation) return Promise.reject(new Error('stream is not consumable'));
    if (seq >= target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { generation: gen, seq: target, resolve: () => resolve(undefined), reject, timer: 0 };
      w.timer = setTimeout(() => {
        waiters.delete(w);
        reject(new Error(`stream drain timed out at ${seq}/${target}`));
      }, hooks.drainTimeoutMs ?? 10000);
      waiters.add(w);
    });
  }

  /** @param {()=>Promise<any>} operation */
  function ordered(operation) {
    const result = controlTail.then(operation);
    controlTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function acknowledge() {
    if (ackQueued || !generation || failed) return ackTail;
    ackQueued = true;
    const gen = generation;
    ackTail = ackTail
      .then(async () => {
        ackQueued = false;
        if (gen !== generation || failed) return;
        const consumed = seq;
        await hooks.invoke('ack_device_stream', { generation: gen, seq: consumed });
      })
      .catch((error) => {
        if (gen === generation) fail(`stream acknowledgment failed: ${error}`);
      });
    return ackTail;
  }

  /** @param {StreamOpen} info */
  function open(info) {
    if (!info || !Number.isSafeInteger(info.generation) || info.generation <= generation) return;
    generation = info.generation;
    seq = 0;
    segmentId = 0;
    segment = null;
    ended = null;
    terminalError = null;
    failed = false;
    closing = false;
    drainAttempts = 0;
    columns = hooks.getColumns();
    replacement++;
    displayBlocked = false;
    notify();
  }

  /** Invalidates synchronously. Safe when clear/import callers do not await.
   * A read-thread barrier also fences already queued preview updates. */
  function replace() {
    segment = null;
    columns = hooks.getColumns();
    const ticket = ++replacement;
    displayBlocked = true;
    if (!enabled || !generation || ended) return;
    const gen = generation;
    void ordered(async () => {
      if (gen !== generation || ended) return;
      const boundary = await hooks.invoke('set_recording_segment', { generation: gen, segment: 0, pdEnabled: false });
      await waitForSeq(boundary.after_seq, gen);
      if (ticket === replacement && gen === generation) displayBlocked = false;
    }).catch((e) => {
      if (gen === generation && !ended) fail(`replacement barrier failed: ${e}`);
    });
  }

  /** @param {StreamSample[]} batch */
  function handleBatch(batch) {
    if (!Array.isArray(batch) || failed) return;
    if (columns !== hooks.getColumns()) replace();
    const startedAt = performanceDiagnostics.batchStart(batch.length);
    batchCount += 1;
    lastBatchSize = batch.length;
    lastBatchStartedAt = startedAt;
    hooks.onBatchStart?.(batch.length);
    let accepted = 0;
    let firstReceivedWallMs = null;
    let lastReceivedWallMs = null;
    try {
      for (const sample of batch) {
        if (sample.generation !== generation || ended) continue;
        if (sample.seq <= seq) continue; // duplicate delivery is harmless
        if (sample.seq !== seq + 1) {
          fail(`stream seq gap: expected ${seq + 1}, received ${sample.seq}`);
          return;
        }
        if (
          ![sample.received_us, sample.wall_anchor_ms, sample.segment_start_us, sample.rate_ms].every(Number.isFinite)
        ) {
          fail('invalid stream receive timestamp');
          return;
        }
        const record =
          segment &&
          sample.segment === segment.id &&
          segment.generation === generation &&
          segment.columns === hooks.getColumns()
            ? segment
            : null;
        try {
          if (!displayBlocked) hooks.onSample(sample, record);
        } catch (error) {
          fail(`sample ingestion failed: ${error}`);
          return;
        }
        seq = sample.seq;
        accepted += 1;
        const receivedWallMs = sample.wall_anchor_ms + sample.received_us / 1000;
        if (firstReceivedWallMs == null) firstReceivedWallMs = receivedWallMs;
        lastReceivedWallMs = receivedWallMs;
      }
    } finally {
      const endedAt = performance.now();
      lastBatchEndedAt = endedAt;
      lastBatchDurationMs = endedAt - startedAt;
      maxBatchDurationMs = Math.max(maxBatchDurationMs, lastBatchDurationMs);
      batchPoints += accepted;
      const timing = {
        startedAt,
        endedAt,
        durationMs: lastBatchDurationMs,
        firstReceivedWallMs,
        lastReceivedWallMs,
        lastSeq: accepted ? seq : null,
      };
      performanceDiagnostics.batchEnd(accepted, timing);
      hooks.onBatchEnd?.(accepted, timing);
    }
    if (accepted) hooks.onBatch?.(accepted);
    notify();
    void acknowledge();
  }

  /** 把已经结束的会话记账为结束并通知 UI，但不消费、不 ACK。 */
  function adoptEnd(end) {
    ended = end;
    segment = null;
    closing = false;
    notify();
    hooks.onEnd(end);
  }

  /** @param {StreamEnd} end */
  function handleEnd(end) {
    if (end.generation !== generation || ended) return;
    if (end.last_seq !== seq) {
      fail(`stream ended at ${end.last_seq}, consumed ${seq}`);
      // 连接确实已经断了：不通知 UI 的话底栏会永远停在「已连接」。
      adoptEnd(end);
      return;
    }
    ended = end;
    segment = null;
    closing = false;
    notify();
    void acknowledge();
    const error = end.error ? end : terminalError;
    if (error) hooks.onError(error);
    hooks.onEnd(end);
  }

  /** @param {StreamEnd} error */
  function handleError(error) {
    terminalErrors.push(error);
    // Preserve the retained prefix before stopping the recording UI.
    if (error.generation === generation) terminalError = error;
  }

  /** @param {number} baseSeconds */
  function begin(baseSeconds) {
    if (!generation || ended || failed || closing) return Promise.reject(new Error('no live stream'));
    const next = { id: ++segmentId, generation, columns: hooks.getColumns(), baseSeconds, lastX: null, first: true };
    segment = next;
    return ordered(async () => {
      if (next !== segment || next.generation !== generation || next.columns !== hooks.getColumns()) return null;
      const boundary = await hooks.invoke('set_recording_segment', { generation, segment: next.id, pdEnabled: true });
      await waitForSeq(boundary.after_seq, next.generation);
      return boundary;
    });
  }

  /** Local cancellation is synchronous; manual pause retains the pre-boundary tail.
   * @param {{discard?:boolean, pdEnabled?:boolean}} [options] */
  function pause({ discard = false, pdEnabled = false } = {}) {
    const previous = segment;
    if (discard) segment = null;
    if (!enabled || !generation || ended || closing) return Promise.resolve();
    const gen = generation;
    const result = ordered(async () => {
      if (gen !== generation || ended) return;
      const boundary = await hooks.invoke('set_recording_segment', { generation: gen, segment: 0, pdEnabled });
      await waitForSeq(boundary.after_seq, gen);
      if (segment === previous) segment = null;
    });
    // Also fence internally: a barrier failure must still trip fail(), and callers
    // that don't await (clear/auto-pause) never leave a rejected promise unhandled.
    void result.catch((error) => {
      if (gen === generation && !ended) fail(`pause boundary failed: ${error}`);
    });
    return result;
  }

  async function drain() {
    closing = true;
    const end = await hooks.invoke('drain_device_stream', { generation });
    if (!end) return null;
    drainAttempts += 1;
    if (!failed && drainAttempts === 1) {
      /** @type {unknown} */
      let barrier = null;
      try {
        await waitForSeq(end.last_seq, end.generation);
      } catch (error) {
        barrier = error;
      }
      if (!failed) {
        // 流还活着却没能在期限内消费完：这次仍然算失败，绝不静默放行销毁。
        if (barrier) throw barrier;
        handleEnd(end);
        await acknowledge();
        if (seq >= end.last_seq) {
          // Explicit receipt ACK, including zero-point streams. Never treat emit as consume.
          await hooks.invoke('ack_device_stream', { generation: end.generation, seq: end.last_seq });
          return end;
        }
      }
    }
    // 终态出口：fail() 早已把生产端停掉，屏障守的样本已经不存在了。
    // 这里只退休后端会话，绝不补 ACK —— 空洞仍然是未消费，但退出必须走得通。
    await hooks.invoke('abandon_device_stream', { generation: end.generation }).catch((e) => console.error(e));
    if (!ended) adoptEnd(end);
    return end;
  }

  return {
    get enabled() {
      return enabled;
    },
    get generation() {
      return generation;
    },
    get lastSeq() {
      return seq;
    },
    get ended() {
      return ended !== null;
    },
    enable() {
      enabled = true;
      columns = hooks.getColumns();
    },
    /** @param {Partial<StreamHooks>} next */
    configure(next) {
      Object.assign(hooks, next);
      columns = hooks.getColumns();
    },
    open,
    handleBatch,
    handleEnd,
    handleError,
    begin,
    pause,
    replace,
    drain,
    waitForSeq,
    settle: () => controlTail,
    /**
     * Everything a 100 Hz acceptance run has to be able to prove without a human retyping it:
     * how far the sequence got, and every terminal error seen. `capacityErrors` is separated
     * because "unacknowledged sample capacity exceeded" is a back-pressure failure the CSV alone
     * cannot show -- the run looks complete, and the acquisition is actually dead.
     */
    diagnostics: () => ({
      generation,
      seq,
      enabled,
      failed,
      ended: !!ended,
      streamErrors: terminalErrors.length,
      capacityErrors: terminalErrors.filter((e) => String(e.error ?? '').includes('capacity exceeded')).length,
      lastError: terminalErrors.at(-1)?.error ?? null,
      batchCount,
      batchPoints,
      lastBatchSize,
      lastBatchDurationMs,
      maxBatchDurationMs,
      lastBatchStartedAt,
      lastBatchEndedAt,
    }),
    /** @param {() => Promise<unknown>} [beforeExit] 末包已消费、窗口销毁之前执行（写完落盘尾部） */
    async shutdown(beforeExit) {
      const end = await drain();
      if (beforeExit) await beforeExit();
      await hooks.invoke('shutdown', { generation: end?.generation ?? null, lastSeq: end?.last_seq ?? null });
    },
  };
}

export const deviceStream = createDeviceStream();
