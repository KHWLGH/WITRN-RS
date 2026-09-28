import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environment, options, provenance, quantiles, saveJson } from './common.mjs';
import { startUiServer } from './ui-server.mjs';

const config = options(process.argv.slice(2), {
  dist: 'src',
  sizes: [1000000],
  csvRows: 100000,
  hz: 1000,
  runs: 7,
  warmup: 2,
  output: 'bench/results/phase2-browser.json',
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = await startUiServer({ dist: config.dist, csp: 'shipped' });
const profile = await mkdtemp(join(tmpdir(), 'witrn-phase2-'));
const events = [];
let browser;
let socket;
let closeOwnedBrowser;
try {
  const candidates = [
    process.env.WITRN_BENCH_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  let executable;
  for (const path of candidates) {
    try {
      await access(path);
      executable = path;
      break;
    } catch {}
  }
  if (!executable) throw new Error('Edge not found');
  browser = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--headless=new',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  let port;
  for (let i = 0; i < 200; i++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch {
      await wait(50);
    }
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      if (/exceptionThrown|loadingFailed|entryAdded/.test(message.method)) events.push(message);
      return;
    }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  });
  const call = (method, params = {}, timeout = 180000) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error(`CDP timeout ${method}`)), timeout),
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  closeOwnedBrowser = () =>
    socket.readyState === WebSocket.OPEN ? call('Browser.close', {}, 2000) : Promise.resolve();
  const evaluate = async (fn, args = []) => {
    const response = await call('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw new Error(response.exceptionDetails.exception?.description ?? JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  for (const domain of ['Runtime', 'Log', 'Page', 'Network']) await call(`${domain}.enable`);
  const browserVersion = await call('Browser.getVersion');
  await call('Page.navigate', { url: server.url });
  for (let i = 0; i < 200; i++) {
    if (await evaluate(async () => !!(await import('/state.js')).state.mainChart)) break;
    await wait(50);
  }
  const result = {
    config,
    browserVersion,
    environment: environment(),
    provenance: await provenance(),
    cases: [],
    limitations: [
      'Headless Edge with simulated Tauri, shipped CSP; not WebView2/HID or real display FPS.',
      'Timer gaps include event-loop scheduling. Long tasks are browser-reported tasks >=50 ms.',
      'Heap metrics are snapshots, not peak memory.',
    ],
    events,
  };
  for (const n of config.sizes) {
    if (result.cases.length) {
      await call('Page.navigate', { url: `${server.url}?size=${n}` });
      for (let i = 0; i < 200; i++) {
        if (await evaluate(async () => !!(await import('/state.js')).state.mainChart)) break;
        await wait(50);
      }
    }
    const item = await evaluate(
      async (n, runs, warmup, csvRows) => {
        const { fixture, CHANNELS } = await import('/__bench/fixtures.mjs');
        const { state, emptyChartColumns, setChartColumns } = await import('/state.js');
        const chart = await import('/chart.js');
        const data = await import('/data.js');
        const { formatCsvChunks, snapshotCsvColumns } = await import('/csv-codec.js');
        const { importCSV } = await import('/csv.js');
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const settle = async () => {
          const until = performance.now() + 60000;
          while (document.getElementById('main-chart').getAttribute('aria-busy') === 'true') {
            if (performance.now() > until) throw new Error('Chart preparation stalled');
            await delay(2);
          }
          await delay(20);
        };
        const hashColumns = async (arrays) => {
          const hashes = [];
          for (const a of arrays) {
            const blocks = [];
            for (let start = 0; start < a.length; start += 4096) {
              const end = Math.min(a.length, start + 4096);
              const values = a.copyRange
                ? a.copyRange(start, end)
                : a.view
                  ? a.view().subarray(start, end)
                  : a.subarray(start, end);
              blocks.push(...new Uint8Array(await crypto.subtle.digest('SHA-256', values)));
            }
            hashes.push(
              [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(blocks)))]
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(''),
            );
          }
          return hashes;
        };
        const makeColumns = (f) => {
          const cols = emptyChartColumns(1);
          const arrays = {
            x: f.x,
            timestamps: f.timestamps,
            ...Object.fromEntries(CHANNELS.map((k, i) => [k, f.ys[i]])),
            recordingSegments: new Float64Array(f.size).fill(NaN),
          };
          for (const [key, buf] of Object.entries(arrays)) cols[key].set(buf);
          return cols;
        };
        const longTasks = [];
        const observer = new PerformanceObserver((list) =>
          longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration }))),
        );
        observer.observe({ type: 'longtask', buffered: false });
        const measure = async (fn) => {
          await delay(30);
          const gaps = [];
          let last = performance.now();
          const timer = setInterval(() => {
            const now = performance.now();
            gaps.push(now - last);
            last = now;
          }, 0);
          const start = performance.now();
          const value = await fn();
          const elapsedMs = performance.now() - start;
          await delay(12);
          clearInterval(timer);
          return {
            elapsedMs,
            maxTimerGapMs: Math.max(0, ...gaps),
            timerTicks: gaps.length,
            longTasks: longTasks.filter((e) => e.start + e.duration > start && e.start < start + elapsedMs),
            value,
          };
        };
        const f = fixture(n, undefined, 1000 / config.hz);
        const cols = makeColumns(f);
        state.settings.activeView = 'monitor';
        state.settings.statsRange = false;
        state.dataIntervalMs = 1000 / config.hz;
        state.isRecording = false;
        const cases = { chart: [], stats: [], csv: [], pd: [] };
        for (let run = -warmup; run < runs; run++) {
          const sample = await measure(async () => {
            setChartColumns(cols);
            state.chartWindow = { mode: 'full', min: 0, max: f.x[n - 1], duration: f.x[n - 1] };
            chart.syncChartSeries();
            data.updateChartRange();
            chart.updateCharts();
            await settle();
          });
          delete sample.value;
          if (run >= 0) cases.chart.push(sample);
        }
        const chartHash = await hashColumns(state.mainChart.data);
        state.settings.statsRange = true;
        const statsValues = [];
        for (let run = -warmup; run < runs; run++) {
          const start = run + warmup + 1,
            end = n - start - 1;
          state.chartWindow = { mode: 'frozen', min: f.x[start], max: f.x[end], duration: f.x[end] - f.x[start] };
          const sample = await measure(() =>
            data.getRangeStatsAsync ? data.getRangeStatsAsync() : data.getRangeStats(),
          );
          const values = Object.fromEntries(
            Object.entries(sample.value)
              .filter(([key]) => key !== 'columns')
              .map(([key, v]) => [key, typeof v === 'number' ? (Object.is(v, -0) ? '-0' : String(v)) : v]),
          );
          delete sample.value;
          if (run >= 0) {
            cases.stats.push(sample);
            statsValues.push(values);
          }
        }
        state.settings.statsRange = false;
        const csvCols = makeColumns(fixture(csvRows, undefined, 1000 / config.hz));
        const csv = [
          ...formatCsvChunks(
            snapshotCsvColumns(csvCols, { withTemp: true, sampleRate: 1000 / config.hz, startTime: 1704067200000 }),
          ),
        ].join('');
        const expectedHash = await hashColumns(Object.values(csvCols));
        window.__BENCH_TAURI__.setImport(csv);
        for (let run = -warmup; run < runs; run++) {
          setChartColumns(emptyChartColumns(1));
          chart.syncChartSeries();
          state.chartWindow = { mode: 'full', min: 0, max: 0, duration: 0 };
          const sample = await measure(async () => {
            await importCSV();
            await settle();
          });
          delete sample.value;
          if (state.chartSeries.x.length !== csvRows)
            throw new Error(`CSV import failed: ${state.chartSeries.x.length}`);
          if (run >= 0) cases.csv.push(sample);
        }
        const importedHash = await hashColumns(Object.values(state.chartSeries));
        const pd = await import('/views/pd.js');
        const { showView } = await import('/shell.js');
        const pdRows = Math.min(n, 1000000);
        const entries = Array.from({ length: pdRows }, (_, i) => ({
          t: 1704067200000 + i,
          type: i % 3 ? 'Request' : 'Source_Capabilities',
          sop: 'SOP',
          role: 'SRC',
          summary: i % 3 ? 'Position:2 PPS:3.3-21V,3A' : 'Fixed: 5V 9V 12V 15V 20V PPS: 3.3-21V',
        }));
        pd.ingestPdBatch(entries, false);
        showView('pd');
        const settlePd = async () => {
          await delay(0);
          const until = performance.now() + 60000;
          while (document.getElementById('pd-list').getAttribute('aria-busy') === 'true') {
            if (performance.now() > until) throw new Error('PD projection stalled');
            await delay(2);
          }
          await delay(20);
        };
        await settlePd();
        const pdCounters = [];
        const pdViews = [];
        const pdView = () => ({
          height: document.querySelector('.pd-list-spacer')?.style.height,
          transform: document.querySelector('.pd-list-window')?.style.transform,
          rows: [...document.querySelectorAll('.pd-list-window > *')].map((row) => [
            row.dataset.index ?? null,
            row.textContent,
          ]),
        });
        for (let run = -warmup; run < runs; run++) {
          document.getElementById('pd-filter').value = run % 2 ? 'request' : 'fixed';
          const sample = await measure(async () => {
            pd.syncPdView();
            await settlePd();
          });
          delete sample.value;
          if (run >= 0) {
            cases.pd.push(sample);
            pdCounters.push(document.getElementById('pd-counter').textContent);
            pdViews.push(pdView());
          }
        }
        if (pd.getPdBufferLength() !== pdRows) throw new Error('PD source entries changed');
        document.getElementById('pd-filter').value = 'request';
        pd.syncPdView();
        await delay(0);
        pd.ingestPdBatch(
          Array.from({ length: 12 }, (_, i) => ({
            t: 1704067200000 + pdRows + i,
            type: 'Request',
            sop: 'SOP',
            role: 'SRC',
            summary: 'Position:2 PPS:3.3-21V,3A',
          })),
          false,
        );
        await settlePd();
        if (pd.getPdBufferLength() !== pdRows + 12) throw new Error('PD live append lost entries');
        const pdLiveView = pdView();
        const pdLiveTailCorrect = pdLiveView.rows.at(-1)?.[0] === String(pdRows + 11);
        if (data.getRangeStatsAsync && !pdLiveTailCorrect)
          throw new Error(
            `PD live tail was not projected: ${JSON.stringify({ tail: pdLiveView.rows.at(-1), height: pdLiveView.height, top: document.getElementById('pd-list').scrollTop, expected: pdRows + 11 })}`,
          );
        observer.disconnect();
        return {
          size: n,
          csvRows,
          csvChars: csv.length,
          pdRows,
          pdCounters,
          pdViews,
          pdLiveView,
          pdLiveTailCorrect,
          cases,
          chartHash,
          statsValues,
          expectedHash,
          importedHash,
          cspViolations: window.__CSP_VIOLATIONS ?? [],
          visibilityState: document.visibilityState,
        };
      },
      [n, config.runs, config.warmup, config.csvRows],
    );
    assert.deepStrictEqual(item.importedHash, item.expectedHash, 'CSV altered source columns');
    item.heap = await call('Runtime.getHeapUsage');
    item.summary = Object.fromEntries(
      Object.entries(item.cases).map(([name, runs]) => [
        name,
        {
          elapsedMs: quantiles(runs.map((r) => r.elapsedMs)),
          maxTimerGapMs: quantiles(runs.map((r) => r.maxTimerGapMs)),
          longTasks: runs.reduce((n, r) => n + r.longTasks.length, 0),
        },
      ]),
    );
    result.cases.push(item);
    await saveJson(config.output, result);
    console.log(JSON.stringify({ size: n, summary: item.summary }));
  }
  const manifest = await server.describe();
  result.assets = manifest;
  console.log(JSON.stringify({ output: await saveJson(config.output, result) }));
  await call('Browser.close').catch(() => {});
} finally {
  // Edge can relaunch the launcher PID on Windows. Use its owned CDP endpoint
  // on failure too, so abandoned renderers cannot contaminate later timings.
  await closeOwnedBrowser?.().catch(() => {});
  socket?.close();
  browser?.kill();
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
}
