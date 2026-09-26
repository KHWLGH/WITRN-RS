/**
 * Hardware acceptance driver -- the half of the release gate that needs a real device attached.
 *
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 target/release/witrn-rs.exe
 *   node scripts/hardware-acceptance.mjs --seconds 620
 *
 * It does not reimplement the app: it drives the running one over the WebView2 CDP endpoint and
 * calls the app's own handlers (`clearChart`, the record toggle, `snapshotCsvColumns` +
 * `formatCsvChunks`), so what the file proves is the shipped code path rather than a harness that
 * merely resembles it. Exporting through the codec instead of the save dialog is what keeps the run
 * unattended; the bytes are the same ones `#btn-export` writes.
 *
 * Two guards exist because both failure modes were hit for real in this repo:
 * - the chart is cleared first, since the export snapshots the live columns and points from an
 *   earlier run would be counted as this window's output (and read as a multi-segment recording);
 * - `seqAtStart` is read *before* the toggle, otherwise the first second of recorded points is
 *   subtracted from the window and the CSV ends up longer than the counter that produced it.
 *
 * `window.__emitProbe` wraps `handleBatch` to count IPC deliveries. That is the only way to see the
 * real batch shape on hardware -- the debug build's `bus-probe` line reports offers/s vs selects/s,
 * this reports emits/s vs points/emit, and the pair is what shows whether coalescing is happening.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { options } from '../bench/common.mjs';

const usage = () => `用法:
  node scripts/hardware-acceptance.mjs [--seconds 620] [--port 9223] [--out-dir bench/results] [--poll-ms 20000]
      [--exe target/release/witrn-rs.exe]

  先用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port> 启动应用，并接上设备。`;

const DEFAULTS = {
  seconds: 620,
  port: '9223',
  outDir: 'bench/results',
  pollMs: 20000,
  /** 被测产物的路径（`target/release/witrn-rs.exe`）。给了就把它的内容哈希进取，回执于是能说清"测的是哪份字节"。 */
  exe: '',
};

const main = async () => {
  const opts = options(process.argv.slice(2), DEFAULTS);
  // `options()` only range-checks runs/warmup/duration, so a non-numeric --seconds would reach the
  // loop as NaN, compare false, and export an empty file as if the run had happened.
  if (!Number.isFinite(opts.seconds) || opts.seconds < 60) {
    throw new Error(`--seconds 必须是 ≥60 的数字（发版验收要求一次连续录制 >= 600s）: ${usage()}`);
  }
  if (!Number.isFinite(opts.pollMs) || opts.pollMs < 1000) {
    throw new Error(`--poll-ms 必须是 ≥1000 的数字: ${usage()}`);
  }
  // 被测产物先校验、先哈希，再碰应用：跑完 10 分钟才发现路径写错不可接受，而"测的是哪份字节"
  // 也正是从这一刻起算的。
  let exeSha256;
  if (opts.exe) {
    try {
      exeSha256 = createHash('sha256').update(readFileSync(opts.exe)).digest('hex');
    } catch (error) {
      throw new Error(`--exe ${opts.exe} 读不到（${error.message}）：回执要记录被测产物的哈希，不能省`);
    }
  }
  let endpoint = null;
  try {
    endpoint = await (await fetch(`http://127.0.0.1:${opts.port}/json/list`)).json();
  } catch {
    endpoint = null;
  }
  if (!endpoint)
    throw new Error(`CDP 端口 ${opts.port} 上没有响应；用 --remote-debugging-port 启动应用了吗?${usage()}`);
  const page = endpoint.find((t) => t.type === 'page');
  if (!page) throw new Error(`端口 ${opts.port} 连着，但没有 page 目标（应用窗口没打开?）`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, (msg) => resolve(msg));
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const msg = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (msg.result?.exceptionDetails) {
      throw new Error(`页面侧抛错: ${JSON.stringify(msg.result.exceptionDetails).slice(0, 300)}`);
    }
    return msg.result?.result?.value;
  };
  const say = (object) => console.log(JSON.stringify(object));
  // git 是这台机器上的事实来源，所以宁可让回执缺字段被判红，也不要在没有仓库的地方猜一个值。
  const git = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const streamState = `(async () => {
    const { state } = await import('/state.js');
    const { deviceStream } = await import('/device-stream.js');
    return { connected: !!state.connected, ...deviceStream.diagnostics() };
  })()`;

  say({ rateMs: await evaluate(`Number(document.getElementById('sample-rate').value)`) });
  // `clearChart` also replaces the stream, which is why liveness is established after it.
  await evaluate(`(async () => { (await import('/data.js')).clearChart(); return 'cleared'; })()`);
  await wait(1500);

  // Liveness comes from the stream's own counters, not a UI flag: `ended` turns true when recording
  // stops, and a seq that only moves across generations proves nothing about this run.
  async function ensureLive() {
    for (let attempt = 0; attempt < 12; attempt++) {
      const before = await evaluate(streamState);
      if (before.ended || !before.generation) {
        await evaluate(`document.getElementById('btn-connect').click(); 'connect'`);
        await wait(2500);
        continue;
      }
      await wait(3000);
      const after = await evaluate(streamState);
      if (after.generation === before.generation && after.seq > before.seq && !after.ended && !after.failed) {
        return { ...after, hzWindow: ((after.seq - before.seq) / 3).toFixed(1), attempt };
      }
    }
    return null;
  }
  const live = await ensureLive();
  if (!live) throw new Error('设备流始终没有跑起来：检查连接与采样率设置');
  say({ live });

  const armed = await evaluate(`(async () => {
    const { state } = await import('/state.js');
    const { deviceStream } = await import('/device-stream.js');
    if (!window.__emitProbe) {
      const inner = deviceStream.handleBatch.bind(deviceStream);
      window.__emitProbe = { calls: 0, points: 0 };
      deviceStream.handleBatch = (batch) => {
        window.__emitProbe.calls++;
        window.__emitProbe.points += Array.isArray(batch) ? batch.length : 1;
        return inner(batch);
      };
    }
    const rowsBefore = state.chartSeries.x.length;
    window.__seqAtStart = deviceStream.diagnostics().seq;
    state.__toggleRecording();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      isRecording: state.isRecording,
      rowsBefore,
      seqAtStart: window.__seqAtStart,
      diagnostics: (await import('/device-stream.js')).deviceStream.diagnostics(),
    };
  })()`);
  say(armed);
  if (!armed.isRecording) throw new Error('录制没有真正开始（isRecording 仍为 false）');
  if (armed.rowsBefore > 0) {
    throw new Error(`清空之后图表里仍有 ${armed.rowsBefore} 个点，导出会连它们一起算进本窗口`);
  }

  const started = Date.now();
  // Windows are measured from the recording window's own baseline: seeding the previous seq at 0
  // divides a lifetime counter by one window and prints a rate that never existed.
  let lastSeq = armed.diagnostics.seq;
  let lastAt = started;
  while ((Date.now() - started) / 1000 < opts.seconds) {
    await wait(opts.pollMs);
    const d = await evaluate(`(async () => (await import('/device-stream.js')).deviceStream.diagnostics())()`);
    const windowMs = Date.now() - lastAt;
    say({
      atS: Math.round((Date.now() - started) / 1000),
      seq: d.seq,
      hzWindow: ((d.seq - lastSeq) / (windowMs / 1000)).toFixed(1),
      errors: { stream: d.streamErrors, capacity: d.capacityErrors },
      failed: d.failed,
      lastError: d.lastError,
    });
    lastSeq = d.seq;
    lastAt = Date.now();
    if (d.failed || d.streamErrors || d.capacityErrors) {
      say({ verdict: 'aborted', reason: d.lastError ?? 'stream errors recorded' });
      break;
    }
  }

  await evaluate(`(async () => {
    const { state } = await import('/state.js');
    if (state.isRecording) state.__toggleRecording();
    return { isRecording: state.isRecording };
  })()`);
  const csv = await evaluate(`(async () => {
    const { state } = await import('/state.js');
    const { snapshotCsvColumns, formatCsvChunks } = await import('/csv-codec.js');
    const snapshot = snapshotCsvColumns(state.chartSeries, {
      sampleRate: state.settings.sampleRate,
      startTime: state.lastRecordingStartTime ?? state.chartSeries.timestamps.at(0) ?? Date.now(),
      withTemp: state.isTempConnected,
    });
    let text = '';
    for (const chunk of formatCsvChunks(snapshot)) text += chunk;
    return text;
  })()`);
  const raw = await evaluate(
    `(async () => ({ ...(await import('/device-stream.js')).deviceStream.diagnostics(), probe: window.__emitProbe, seqAtStart: window.__seqAtStart ?? 0 }))()`,
  );
  const provenance = {
    headCommit: git(['rev-parse', 'HEAD']),
    // The whole reason this block exists: a receipt taken while `git status` is dirty certifies
    // bytes that no commit contains, which is exactly how the 2026-09-25 runs started out.
    treeClean: (git(['status', '--porcelain']) ?? 'dirty').length === 0,
  };
  if (exeSha256) provenance.exeSha256 = exeSha256;
  // `seq` has to mean "what this recording window produced", not the stream lifetime: points that
  // arrived before the toggle were legitimately never written, and comparing a lifetime counter
  // against a row count would call that lost samples.
  const final = { ...raw, seq: raw.seq - raw.seqAtStart, lifetimeSeq: raw.seq, provenance };
  mkdirSync(opts.outDir, { recursive: true });
  const csvPath = `${opts.outDir}/acceptance.csv`;
  const diagnosticsPath = `${opts.outDir}/acceptance-diagnostics.json`;
  writeFileSync(csvPath, csv);
  writeFileSync(diagnosticsPath, JSON.stringify(final));
  say({
    written: { csv: csvPath, diagnostics: diagnosticsPath, csvBytes: csv.length, rows: csv.split('\n').length - 1 },
    final,
  });
  const declaredHz = (
    1000 / Number(await evaluate(`(async () => (await import('/state.js')).state.settings.sampleRate)()`))
  ).toFixed(0);
  console.log(
    `\n下一步（--diagnostics 就是 ${diagnosticsPath} 的内容，不要手填数字）:\n` +
      `  npm run verify:hardware -- --csv ${csvPath} --hz ${declaredHz} --min-duration ${Math.floor(opts.seconds - 20)} \\\n` +
      `    --diagnostics "$(node -pe "require('./${diagnosticsPath}').seq && JSON.stringify(require('./${diagnosticsPath}'))")" \\\n` +
      `    --commit "$(git rev-parse HEAD)" --receipt-out ${opts.outDir}/acceptance-receipt.json`,
  );
  socket.close();
};

await main();
