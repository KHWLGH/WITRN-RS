import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeIntervals, environment, options, provenance, quantiles, saveJson } from './common.mjs';
import { startUiServer } from './ui-server.mjs';

const config = options(process.argv.slice(2), {
  sizes: [10000, 100000, 1000000],
  runs: 20,
  warmup: 5,
  duration: 10,
  hz: 1000,
  revision: '',
  // Serve the built frontend (frontendDist) instead of src/. Second mode, never a timing gate:
  // its job is to prove the shipped artifact boots with every CSS url() resolving.
  dist: '',
  // 0 keeps the historical 'coalesced' shape: one point per 10ms tick, up to 1024 points in a
  // catch-up burst after a stall. Any other value replays what the Rust emitter actually sends at
  // The selected rate: `emitWindowMs` of points delivered once per window, so the sustained run measures the
  // real IPC cadence instead of a batch shape production never produces.
  emitWindowMs: 0,
  // Serve the app's real CSP instead of the harness's permissive one. Needed for any question of
  // the form "does the shipped policy block this asset?": a blocked icon mask produces no failed
  // request and no console line that loose mode would surface.
  shippedCsp: false,
  output: 'bench/results/ui.json',
});
// Match the native emitter's latency budget by default: 8ms at 1000 SPS, while an
// explicit 100 SPS compatibility run gets the historical 40ms window.
if (config.emitWindowMs === 0) config.emitWindowMs = config.hz >= 500 ? 8 : 40;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } else if (
        message.method === 'Runtime.exceptionThrown' ||
        message.method === 'Log.entryAdded' ||
        message.method === 'Network.loadingFailed'
      )
        this.events.push(message);
    });
  }
  call(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, args = [], timeout = 30000) {
    const result = await this.call(
      'Runtime.evaluate',
      { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true },
      timeout,
    );
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

const before = await provenance();
const startedAt = Date.now();
// Phase markers on stderr. There are seven `Runtime.evaluate` calls before the first number is
// printed, and a bare "CDP timeout: Runtime.evaluate" says nothing about which one hung -- which is
// how a flaky step gets "fixed" by guessing.
const stage = (name) => console.error(JSON.stringify({ stage: name, atMs: Date.now() - startedAt }));
const server = await startUiServer({
  revision: config.revision || null,
  csp: config.shippedCsp ? 'shipped' : 'loose',
  dist: config.dist,
});
const profile = await mkdtemp(join(tmpdir(), 'witrn-bench-'));
let browser;
let cdp;
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
  if (!executable) throw new Error('Local Edge not found; set WITRN_BENCH_BROWSER. No dependencies were downloaded.');
  browser = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: false },
  );
  let port;
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch {
      await wait(50);
    }
  }
  if (!port) throw new Error('Owned Edge instance did not expose its local debugging port');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find((page) => page.type === 'page');
  if (!target) throw new Error('No page in owned Edge instance');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  cdp = new CDP(socket);
  for (const domain of ['Runtime', 'Log', 'Page', 'Network']) await cdp.call(`${domain}.enable`);
  const browserVersion = await cdp.call('Browser.getVersion');
  await cdp.call('Page.navigate', { url: server.url });
  // An occluded Edge window stops being given frames at all, and every timing step below is rAF
  // driven. Asking the owned window to the front is the only way to make the run reproducible
  // without the operator's help.
  await cdp.call('Page.bringToFront');
  // `bringToFront` 只排同一窗口里的标签页次序，救不了被最小化或被别的窗口整片盖住的情形，而这两种
  // 都让 rAF 一帧不给。把窗口本身取回 normal 态并落到左上角，"保持可见"这条前置条件才由脚本自己满足，
  // 而不是靠操作者碰巧没挡住它。
  const targetWindow = await cdp.call('Browser.getWindowForTarget', { targetId: target.id });
  await cdp.call('Browser.setWindowBounds', {
    windowId: targetWindow.windowId,
    bounds: { windowState: 'normal', left: 0, top: 0, width: 1280, height: 800 },
  });
  let ready = false;
  // Per-attempt timeout, not per-run: the probe awaits a dynamic import, and in a backgrounded tab
  // that promise can sit far longer than any single call deserves. One stalled probe used to abort
  // the whole measurement; now only a boot that never finishes inside the total budget fails.
  const bootDeadline = Date.now() + 120000;
  const bootedAt = Date.now();
  while (Date.now() < bootDeadline) {
    try {
      ready = await cdp.evaluate(
        async () => {
          try {
            return !!(await import('/state.js')).state.mainChart;
          } catch {
            return false;
          }
        },
        [],
        5000,
      );
    } catch {
      ready = false;
    }
    if (ready) break;
    await wait(100);
  }
  const bootWaitMs = Date.now() - bootedAt;
  if (!ready) throw new Error(`App did not initialize: ${JSON.stringify(cdp.events)}`);
  stage('metadata');
  const metadata = await cdp.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    userAgent: navigator.userAgent,
    visibility: document.visibilityState,
    cspViolations: window.__CSP_VIOLATIONS ?? null,
    simulatedTauri: window.__BENCH_TAURI__.environment,
  }));
  // A fixed frame count is a fixed wall-clock bet: 120 rAF frames are 0.7s in a foreground tab and
  // over 30s in a throttled one, which is what killed this step with a CDP timeout. Deadline first,
  // count second.
  // Split from the seq cross-check below on purpose: the acceptance surface is state, not timing, so
  // it must not sit behind a step that needs frames the browser may never hand out.
  stage('acceptance-surface');
  const acceptanceSurface = await cdp.evaluate(() => {
    const read = window.__WITRN_STREAM__;
    if (typeof read !== 'function') return { present: false, type: typeof read };
    return { present: true, ...read() };
  });
  assert.equal(acceptanceSurface.present, true, 'window.__WITRN_STREAM__ 不存在：发版回执将没有应用侧证据来源');
  for (const key of ['seq', 'streamErrors', 'capacityErrors', 'generation'])
    assert.ok(Number.isFinite(acceptanceSurface[key]), `diagnostics().${key} 不是数值`);
  stage('calibration');
  const calibrationResponse = await cdp.evaluate(
    async () => {
      const times = [];
      let previous;
      const started = performance.now();
      // Race, not await: `await new Promise(requestAnimationFrame)` inside the loop condition never
      // returns when the tab is starved, so the deadline could not be reached and the whole call died
      // on the CDP timeout instead of reporting "no frames were offered".
      const nextFrame = () =>
        Promise.race([
          new Promise((resolve) => requestAnimationFrame(resolve)),
          new Promise((r) => setTimeout(r, 250, null)),
        ]);
      while (times.length < 120 && performance.now() - started < 10000) {
        const t = await nextFrame();
        if (t === null) continue;
        if (previous !== undefined) times.push(t - previous);
        previous = t;
      }
      return { times, wallMs: performance.now() - started, hitDeadline: times.length < 120 };
    },
    [],
    60000,
  );
  const calibration = calibrationResponse.times;
  const idle = quantiles(calibration);
  if (idle.count < 20)
    throw new Error(
      `标定期内浏览器只给出 ${idle.count} 帧（需要 20 帧）：Edge 窗口被遮挡或标签页被节流，` +
        `rAF 驱动的 sustained 段跑不动。脚本已经把窗口取回 normal 态并置过 front（见上面的 setWindowBounds），` +
        `所以剩下的成因只能是别的窗口整片盖住它或被最小化到别的桌面 —— 请让 bench 窗口真的可见再跑。` +
        `这条与计时精度无关，是前置条件。`,
    );
  const result = {
    schema: 'witrn-ui-v1',
    layer: 'Headful Edge + simulated Tauri; NOT native WebView/HID/GPU presentation',
    config,
    environment: environment(),
    bootWaitMs,
    browserVersion,
    metadata,
    calibration: { ...calibrationResponse, rawMs: calibration, ms: idle },
    provenanceBefore: before,
    cases: [],
    limitations: [
      'No screenshots or external resources',
      'CDP input-to-next-rAF is an update opportunity, not confirmed GPU presentation or draw execution',
      'Long tasks and JS heap are Chromium-only counters',
      'Synthetic state population does not measure HID or native IPC',
      'Power mode and physical refresh rate are not measured',
    ],
  };
  if (config.dist) {
    // The shipped artifact has never been loaded by anything until this mode exists: `bench:ui`
    // served raw src/, and `build-dist.mjs` only asserted that referenced files exist on disk.
    // A mis-rewritten url() in the merged stylesheet is invisible at build time and shows up as a
    // blank icon, because a failed CSS mask produces no exception and no console line.
    result.shippedShape = await cdp.evaluate(async () => {
      const sheets = [...document.styleSheets].map((s) => ({
        href: s.href ?? '(inline)',
        rules: s.cssRules ? s.cssRules.length : -1,
      }));
      const bundle = sheets.find((s) => /app\.bundle\.css$/.test(s.href));
      const text = bundle ? await (await fetch(new URL(bundle.href).pathname)).text() : '';
      const targets = [...new Set([...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]))].filter(
        (u) => !u.startsWith('data:'),
      );
      const broken = [];
      for (const target of targets) {
        const path = new URL(target, location.href).pathname;
        const res = await fetch(path);
        if (!res.ok) broken.push({ path, status: res.status });
      }
      const { state } = await import('/state.js');
      return {
        sheets,
        externalSheets: sheets.filter((s) => /\.css(\?|$)/.test(s.href)).length,
        bundleRules: bundle ? bundle.rules : 0,
        urlTargets: targets.length,
        broken,
        booted: !!state.mainChart,
      };
    }, []);
    assert.equal(
      result.shippedShape.externalSheets,
      1,
      `发货页面应只挂 1 个样式表，实得 ${JSON.stringify(result.shippedShape.sheets)}`,
    );
    assert.ok(result.shippedShape.bundleRules > 100, '合并后的样式表几乎没有规则，CSS 管线产出了空壳');
    assert.deepEqual(result.shippedShape.broken, [], `${config.dist}/ 里有 CSS 引用却取不到的资源`);
    assert.equal(result.shippedShape.booted, true, `${config.dist}/index.html 加载后应用没有启动`);
    console.log(
      JSON.stringify({
        servedFrom: config.dist,
        bundleRules: result.shippedShape.bundleRules,
        cssUrlTargets: result.shippedShape.urlTargets,
        cssUrlBroken: result.shippedShape.broken.length,
      }),
    );
  }
  for (const size of config.sizes) {
    stage(`window-case-${size}`);
    const loaded = await cdp.evaluate(
      async (n) => {
        const { fixture, CHANNELS } = await import('/__bench/fixtures.mjs');
        const { state, emptyChartColumns, setChartColumns } = await import('/state.js');
        const chart = await import('/chart.js');
        const f = fixture(n),
          cols = emptyChartColumns();
        const start = performance.now();
        for (let i = 0; i < n; i++) {
          cols.x.push(f.x[i]);
          cols.timestamps.push(f.timestamps[i]);
          for (let s = 0; s < CHANNELS.length; s++) cols[CHANNELS[s]].push(f.ys[s][i]);
          cols.recordingSegments.push(Number.NaN);
          if (i && i % 10000 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        setChartColumns(cols);
        state.settings.activeView = 'monitor';
        chart.syncChartSeries();
        chart.setChartXWindow(f.x[0], f.x[n - 1]);
        chart.updateCharts();
        while (document.getElementById('main-chart')?.getAttribute('aria-busy') === 'true')
          await new Promise((resolve) => setTimeout(resolve, 2));
        await new Promise(requestAnimationFrame);
        const bounds = state.mainChart.over.getBoundingClientRect();
        return {
          count: cols.x.length,
          loadMs: performance.now() - start,
          plot: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
          heap: performance.memory
            ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize }
            : null,
          lastX: cols.x.at(-1),
        };
      },
      [size],
      120000,
    );
    assert.equal(loaded.count, size);
    const windows = await cdp.evaluate(
      async (runs, warmup, n) => {
        const { setChartXWindow, updateCharts } = await import('/chart.js');
        const { state } = await import('/state.js');
        const prep = [],
          toDraw = [],
          raf = [],
          longTasks = [];
        let last;
        const observer =
          typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
            ? new PerformanceObserver((entries) => {
                for (const e of entries.getEntries()) longTasks.push(e.duration);
              })
            : null;
        observer?.observe({ type: 'longtask', buffered: false });
        for (let run = -warmup; run < runs; run++) {
          const t = await new Promise(requestAnimationFrame);
          if (run >= 0 && last !== undefined) raf.push(t - last);
          last = t;
          const start = performance.now();
          let finish;
          const hook = () => {
            finish = performance.now();
          };
          state.mainChart.hooks.draw.push(hook);
          try {
            const offset = (run + warmup) * 0.01;
            setChartXWindow(offset, (n - 100) / 100 + offset);
            updateCharts();
            const prepared = performance.now();
            while (document.getElementById('main-chart')?.getAttribute('aria-busy') === 'true')
              await new Promise((resolve) => setTimeout(resolve, 2));
            await new Promise(requestAnimationFrame);
            if (run >= 0) {
              prep.push(prepared - start);
              toDraw.push(finish === undefined ? null : finish - start);
            }
          } finally {
            state.mainChart.hooks.draw.splice(state.mainChart.hooks.draw.indexOf(hook), 1);
          }
        }
        if (observer) for (const entry of observer.takeRecords()) longTasks.push(entry.duration);
        observer?.disconnect();
        return {
          rawPreparationMs: prep,
          rawRequestToDrawMs: toDraw,
          rawRafMs: raf,
          longTasks: observer ? longTasks : null,
        };
      },
      [config.runs, config.warmup, size],
      120000,
    );
    const hover = [];
    for (let i = 0; i < config.runs; i++) {
      const start = performance.now();
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: loaded.plot.left + (loaded.plot.width * (i + 1)) / (config.runs + 1),
        y: loaded.plot.top + loaded.plot.height / 2,
      });
      await cdp.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      hover.push(performance.now() - start);
    }
    const errors = cdp.events.filter(
      (event) => event.method === 'Runtime.exceptionThrown' || event.params.entry?.level === 'error',
    );
    const drawWindows = activeIntervals(windows.rawRequestToDrawMs);
    const rafWindows = activeIntervals(windows.rawRafMs);
    result.cases.push({
      size,
      loaded,
      windows,
      hoverRoundTripTwoRafMs: { raw: hover, ms: quantiles(hover) },
      preparationMs: quantiles(windows.rawPreparationMs),
      requestToDrawMs: drawWindows.active,
      rafMs: rafWindows.active,
      rafSuspensions: rafWindows.suspended,
      runtimeErrors: errors,
    });
    console.log(
      JSON.stringify({
        size,
        preparationP50ms: result.cases.at(-1).preparationMs.p50,
        requestToDrawP95ms: result.cases.at(-1).requestToDrawMs.p95,
        errors: errors.length,
      }),
    );
  }
  stage('render-invalidation');
  result.renderInvalidation = await cdp.evaluate(async () => {
    const { state } = await import('/state.js');
    const chart = await import('/chart.js');
    const cols = state.chartSeries;
    const n = cols.x.length;
    const start = Math.floor(n / 4);
    const end = Math.floor(n / 2);
    const min = cols.x.at(start);
    const max = cols.x.at(end);
    const settle = async () => {
      while (document.getElementById('main-chart')?.getAttribute('aria-busy') === 'true')
        await new Promise((resolve) => setTimeout(resolve, 2));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
    chart.setChartXWindow(min, max);
    chart.updateCharts();
    await settle();
    const main = state.mainChart;
    const nav = state.navigatorChart;
    const originalMain = main.setData;
    const originalNav = nav.setData;
    let mainSubmissions = 0;
    let navSubmissions = 0;
    let mainDraws = 0;
    const drawn = () => mainDraws++;
    main.setData = function (...args) {
      mainSubmissions++;
      return originalMain.apply(this, args);
    };
    nav.setData = function (...args) {
      navSubmissions++;
      return originalNav.apply(this, args);
    };
    main.hooks.draw.push(drawn);
    try {
      for (let batch = 0; batch < 20; batch++) {
        for (let point = 0; point < 4; point++) {
          cols.x.push(cols.x.at(-1) + 0.01);
          cols.timestamps.push(cols.timestamps.at(-1) + 10);
          for (const key of ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2']) {
            cols[key].push(cols[key].at(start));
          }
          cols.recordingSegments.push(Number.NaN);
        }
        chart.scheduleChartUpdate();
        await settle();
      }
      return {
        scenario: 'manual column append outside frozen historical window; unchanged channel extrema',
        beforeLength: n,
        afterLength: cols.x.length,
        batches: 20,
        mainSubmissions,
        navSubmissions,
        mainDraws,
      };
    } finally {
      main.setData = originalMain;
      nav.setData = originalNav;
      main.hooks.draw.splice(main.hooks.draw.indexOf(drawn), 1);
      state.chartWindow = { mode: 'full', min: 0, max: 0, duration: 0 };
      chart.setChartXWindow(null, null);
      chart.updateCharts();
      await settle();
    }
  });
  assert.equal(result.renderInvalidation.afterLength, result.renderInvalidation.beforeLength + 80);
  console.log(JSON.stringify({ renderInvalidation: result.renderInvalidation }));
  stage('style-checks');
  result.styleChecks = await cdp.evaluate(async () => {
    const settingsTab = document.getElementById('btn-settings-tab');
    settingsTab.click();
    const radio = document.getElementById('window-style-macos');
    if (!radio) return { supported: false, reason: 'revision has no window style setting' };
    const { state } = await import('/state.js');
    const before = document.querySelectorAll('.window-controls, #titlebar-buttons, .resize-zone').length;
    const styles = [];
    for (let i = 0; i < 30; i++) {
      const value = ['auto', 'windows', 'macos'][i % 3];
      document.getElementById(`window-style-${value}`).click();
      await new Promise(requestAnimationFrame);
      styles.push({
        requested: value,
        saved: state.settings.windowStyle,
        applied: document.documentElement.dataset.windowStyle,
      });
    }
    const after = document.querySelectorAll('.window-controls, #titlebar-buttons, .resize-zone').length;
    document.getElementById('tab-monitor').click();
    return {
      supported: true,
      before,
      after,
      styles,
      sample100: !!document.querySelector('#sample-rate option[value="10"]'),
    };
  });
  if (result.styleChecks.supported) {
    assert.equal(result.styleChecks.after, result.styleChecks.before);
    assert.ok(result.styleChecks.sample100);
    for (const item of result.styleChecks.styles) assert.equal(item.saved, item.requested);
  }
  stage('sustained');
  result.sustained = await cdp.evaluate(
    async (seconds, nativeWindowMs, hz) => {
      const { fixture, canonicalBytes, VERSION, SEED } = await import('/__bench/fixtures.mjs');
      const { state } = await import('/state.js');
      const { initializeDeviceStream, disconnectDevice } = await import('/device.js');
      const { deviceStream } = await import('/device-stream.js');
      const data = await import('/data.js');
      const { calculateEnergyInRange } = await import('/measurement.js');
      const { parseCsv } = await import('/csv-codec.js');
      const { exportCSV } = await import('/csv.js');
      const intervalMs = 1000 / hz;
      const count = Math.round(seconds * hz),
        f = fixture(count, undefined, intervalMs);
      // Mirror addDataPoint's own channel transforms so the expected array is what the
      // pipeline must produce: signed current kept, power abs, device temp raw, D+/D-
      // clamped to [0,60] else NaN. NaN / -0 preserved (not silently zeroed).
      const clampLV = (v) => (Number.isFinite(v) && v >= 0 && v <= 60 ? v : NaN);
      const ys = f.ys;
      const expected = [
        f.x,
        f.timestamps,
        ys[0].slice(),
        ys[1].slice(),
        ys[2].map((v) => Math.abs(v)),
        ys[3].slice(),
        ys[4].map(clampLV),
        ys[5].map(clampLV),
        ys[6].slice(),
        ys[7].slice(),
        new Float64Array(count).fill(1),
      ];
      const hash = async (columns) =>
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalBytes(columns)))]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
      const expectedHash = await hash(expected);
      data.clearAndResetStats();
      await initializeDeviceStream();
      const info = await window.__TAURI__.core.invoke('connect_device_by_path', { path: 'bench://synthetic' });
      deviceStream.open(info);
      state.isConnected = true;
      if (!deviceStream.generation) throw new Error('Synthetic stream did not open');
      state.settings.sampleRate = intervalMs;
      await window.__TAURI__.core.invoke('set_sample_rate', { rate: intervalMs });
      state.settings.signedCurrent = true;
      state.settings.tempSource = 'device';
      state.isTempConnected = true;
      state.autoPauseSettings.enabled = false;
      await data.startRecording();
      if (!state.isRecording) throw new Error('Synthetic recording did not start');
      const frames = new Float64Array(Math.ceil(seconds * 300) + 1000);
      let frameCount = 0,
        previous = null,
        running = true,
        rafId;
      const frame = (t) => {
        if (previous !== null && !document.hidden && frameCount < frames.length) frames[frameCount++] = t - previous;
        previous = t;
        if (running) rafId = requestAnimationFrame(frame);
      };
      rafId = requestAnimationFrame(frame);
      const longTasks = [];
      const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) longTasks.push(entry.duration);
          })
        : null;
      observer?.observe({ type: 'longtask', buffered: false });
      const prepare = new Float64Array(frames.length),
        toDraw = new Float64Array(frames.length);
      let drawCount = 0,
        lastBatch = 0;
      const onDraw = (chart) => {
        const timing = chart.__chartPaintTiming;
        if (!timing || timing.batchId === lastBatch || drawCount >= prepare.length) return;
        lastBatch = timing.batchId;
        prepare[drawCount] = timing.prepareMs;
        toDraw[drawCount++] = timing.requestToDrawMs;
      };
      state.mainChart.hooks.draw.push(onDraw);
      let sent = 0,
        emits = 0,
        maxCatchUpBatch = 0,
        exportTask = null;
      const started = performance.now();
      const row = (i) => ({
        voltage: ys[0][i],
        current: ys[1][i],
        power: ys[2][i],
        temperature: ys[3][i],
        dp: ys[4][i],
        dn: ys[5][i],
        cc1: ys[6][i],
        cc2: ys[7][i],
        received_us: i * intervalMs * 1000,
      });
      try {
        await new Promise((resolve, reject) => {
          const afterFeed = () => {
            if (!exportTask && sent >= count / 2) exportTask = exportCSV();
            if (sent === count) resolve();
          };
          if (nativeWindowMs > 0) {
            // Native replay: `nativeWindowMs` of accumulated points delivered once per window,
            // which is what stream::emit_loop sends at 100Hz after the batch-window fix.
            const perEmit = Math.max(1, Math.round(nativeWindowMs / intervalMs));
            const tick = () => {
              try {
                const end = Math.min(count, sent + perEmit);
                if (end > sent) {
                  const batch = [];
                  for (; sent < end; sent++) batch.push(row(sent));
                  emits += 1;
                  maxCatchUpBatch = Math.max(maxCatchUpBatch, batch.length);
                  window.__BENCH_TAURI__.feed(batch);
                }
                afterFeed();
                if (sent < count) setTimeout(tick, nativeWindowMs);
              } catch (error) {
                reject(error);
              }
            };
            tick();
            return;
          }
          const pump = () => {
            try {
              const due = Math.min(count, Math.floor((performance.now() - started) / 10) + 1);
              const end = Math.min(due, sent + 1024);
              if (end > sent) {
                const batch = [];
                for (; sent < end; sent++) batch.push(row(sent));
                emits += 1;
                maxCatchUpBatch = Math.max(maxCatchUpBatch, batch.length);
                window.__BENCH_TAURI__.feed(batch);
              }
              afterFeed();
              if (sent < count) setTimeout(pump, Math.max(0, started + sent * intervalMs - performance.now()));
            } catch (error) {
              reject(error);
            }
          };
          pump();
        });
        await data.stopRecording();
        await exportTask;
        // Settle a paint if the tab is visible; never block on rAF when backgrounded
        // (hidden tabs stop firing animation frames, which would hang this await).
        await Promise.race([new Promise(requestAnimationFrame), new Promise((r) => setTimeout(r, 200))]);
      } finally {
        running = false;
        cancelAnimationFrame(rafId);
        state.mainChart.hooks.draw.splice(state.mainChart.hooks.draw.indexOf(onDraw), 1);
        if (observer) for (const entry of observer.takeRecords()) longTasks.push(entry.duration);
        observer?.disconnect();
      }
      const elapsedMs = performance.now() - started;
      const keys = [
        'x',
        'timestamps',
        'voltage',
        'current',
        'power',
        'temp',
        'dp',
        'dn',
        'cc1',
        'cc2',
        'recordingSegments',
      ];
      const cols = state.chartSeries,
        actualHash = await hash(keys.map((key) => cols[key].view()));
      if (actualHash !== expectedHash || cols.x.length !== count || deviceStream.lastSeq !== count)
        throw new Error('Paced replay value/count/sequence mismatch');
      const energy = calculateEnergyInRange(
        cols.x.view(),
        cols.current.view(),
        cols.power.view(),
        0,
        count - 1,
        cols.recordingSegments.view(),
      );
      if (!Object.is(energy.wh, state.energy.wh) || !Object.is(energy.mah, state.energy.mah))
        throw new Error('Paced replay integration mismatch');
      const exported = parseCsv(window.__BENCH_TAURI__.exportText(), { fallbackStartTime: 0 }).columns;
      const exportedCount = exported.x.length;
      if (
        (await hash(keys.filter((key) => key !== 'temp').map((key) => exported[key].view()))) !==
        (await hash(keys.filter((key) => key !== 'temp').map((key) => cols[key].view().subarray(0, exportedCount))))
      )
        throw new Error('Concurrent CSV export prefix mismatch');
      const result = {
        fixture: { version: `${VERSION}/native-finite-main-v1`, seed: SEED, inputSha256: expectedHash },
        nominalHz: config.hz,
        sampleIntervalMs: intervalMs,
        seconds,
        elapsedMs,
        sent,
        consumed: cols.x.length,
        lastSeq: deviceStream.lastSeq,
        outputSha256: actualHash,
        maxCatchUpBatch,
        emits,
        emitsPerSecond: emits / seconds,
        meanPointsPerEmit: sent / Math.max(1, emits),
        batchShape: nativeWindowMs > 0 ? 'native' : 'coalesced',
        exportedWhileRecording: exportedCount,
        energy,
        rawRafMs: Array.from(frames.subarray(0, frameCount)),
        rawPreparationMs: Array.from(prepare.subarray(0, drawCount)),
        rawRequestToDrawMs: Array.from(toDraw.subarray(0, drawCount)),
        longTasks: observer ? longTasks : null,
        columnCapacityBytes: keys.reduce((sum, key) => sum + (cols[key].byteLength ?? cols[key].buf.byteLength), 0),
        heap: performance.memory
          ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize }
          : null,
        limitations: [
          'Selected-sample browser replay; no Rust sampler, HID or native IPC',
          'Timer overruns catch up distinct fixture rows, not interpolated or duplicated samples',
          'Probe overhead and process RSS not measured; heap includes retained fixture and probes',
          // uPlot fires hooks.draw *after* its own paint pass, so no post-draw hook can isolate it.
          // Reported as an absent measurement rather than a null column, because a null in a results
          // file reads as "measured: 0". requestToDrawMs = queue + preparation + paint together.
          'uPlot draw execution not separable from requestToDrawMs; preparationMs is the measured app work',
        ],
      };
      await disconnectDevice();
      return result;
    },
    [config.duration, config.emitWindowMs, config.hz],
    config.duration * 1000 + 300000,
  );
  const rafActive = activeIntervals(result.sustained.rawRafMs);
  const drawActive = activeIntervals(result.sustained.rawRequestToDrawMs);
  result.sustained.rafMs = rafActive.active;
  result.sustained.rafSuspensions = rafActive.suspended;
  result.sustained.preparationMs = quantiles(result.sustained.rawPreparationMs);
  result.sustained.requestToDrawMs = drawActive.active;
  result.sustained.drawSuspensions = drawActive.suspended;
  // Suspension gaps are periods the page was never given a frame to miss, so they stay out of
  // this ratio; including them once turned a 10s run into an estimate of thousands of dropped frames.
  //
  // A long interval still has two causes spacing alone cannot separate: the page took too long, or
  // the browser never offered a frame (occluded tab). `preparationMs.max` and `longTasks` bound what
  // the app can account for, so anything past both is starvation. Observed here: 131 intervals in
  // the 50-218ms plateau with zero long tasks and a 3.4ms worst frame.
  const workCeilingMs = idle.count >= 20 ? idle.p50 * 2 + (result.sustained.preparationMs.max ?? 0) : 0;
  const offered = rafActive.activeValues.filter((dt) => dt <= workCeilingMs);
  const starved = rafActive.activeValues.filter((dt) => dt > workCeilingMs);
  const slots = offered.map((dt) => Math.max(1, Math.round(dt / idle.p50)));
  const missedSlots = slots.reduce((sum, n) => sum + n - 1, 0);
  result.sustained.estimatedMissedFrameSlots = offered.length ? missedSlots / (missedSlots + offered.length) : null;
  result.sustained.rafOfferedMs = quantiles(offered);
  result.sustained.timingTrust = {
    cadenceMs: idle.p50,
    calibrationSamples: idle.count,
    workCeilingMs,
    offeredFrames: offered.length,
    starvedFrames: starved.length,
    starvedShare: starved.length / Math.max(1, rafActive.activeValues.length),
    suspendedMs: rafActive.suspended.totalMs,
    longTaskOver50Ms: (result.sustained.longTasks ?? []).filter((d) => d >= 50).length,
    wallRatio: result.sustained.elapsedMs / (config.duration * 1000),
    // Beyond this point the percentiles describe the browser's frame supply, not this app.
    throttled:
      // Too few cadence samples means no trustworthy ceiling, which is the same failure as a
      // starved run: the spacing numbers describe the browser, not this app.
      idle.count < 20 ||
      starved.length > 0.02 * Math.max(1, rafActive.activeValues.length) ||
      result.sustained.elapsedMs > config.duration * 1500,
    note:
      'throttled 为真时 rafMs/requestToDrawMs 只能报告；preparationMs 与 longTasks 不受帧供应影响，仍可信。' +
      '注意 starvedShare 会低估：页面 document.hidden 期间的间隔在页面里就被丢弃了，所以总饥饿程度看 wallRatio。',
  };
  const trust = result.sustained.timingTrust;
  // The premise of the receipt rule `producedSeq === rows` is that the app's counter means the number
  // of points the pipeline handed over. The expected value here is known independently, so this is a
  // real cross-check and not a presence test. Re-read on purpose: the early snapshot above is from
  // before any sample was fed, and comparing that against a post-run counter only proves the freeze.
  // Read the singleton directly for the counter, and read it through the window global as well: the
  // global is the entry point the docs tell a human to type during acceptance, so the release path
  // has to be exercised rather than assumed. (A first version of this check read
  // `window.__WITRN_STREAM` -- one underscore short -- got `undefined`, and I filed that as an
  // unexplained app bug. The presence check passing while the value check failed was the tell:
  // nothing verified the spelling of the accessor people are told to use.)
  const surfaces = await cdp.evaluate(async () => {
    const singleton = (await import('/device-stream.js')).deviceStream.diagnostics();
    const read = typeof window.__WITRN_STREAM__ === 'function' ? window.__WITRN_STREAM__() : null;
    return { singleton, global: read };
  });
  const finalSurface = surfaces.singleton;
  assert.ok(finalSurface, 'deviceStream.diagnostics() 没返回对象');
  assert.ok(surfaces.global, 'window.__WITRN_STREAM__() 不可调用：文档里让人输入的那个入口是坏的');
  assert.deepEqual(surfaces.global, finalSurface, 'DevTools 入口与单例读数不一致，回执里的应用侧数字无法复现');
  result.acceptanceSurface = finalSurface;
  assert.equal(
    finalSurface.seq,
    result.sustained.lastSeq,
    `diagnostics().seq = ${finalSurface.seq} 与流水线报告的 lastSeq = ${result.sustained.lastSeq} 不符`,
  );
  assert.equal(finalSurface.streamErrors, 0, '回放里没有终止错误，diagnostics 不该数出错误');
  console.log(
    JSON.stringify({
      acceptanceSurface: {
        seq: finalSurface.seq,
        streamErrors: finalSurface.streamErrors,
        capacityErrors: finalSurface.capacityErrors,
      },
    }),
  );
  console.log(
    JSON.stringify({
      sustainedSeconds: config.duration,
      consumed: result.sustained.consumed,
      batchShape: result.sustained.batchShape,
      emitsPerSecond: Number(result.sustained.emitsPerSecond.toFixed(1)),
      meanPointsPerEmit: Number(result.sustained.meanPointsPerEmit.toFixed(2)),
      rafP95ms: result.sustained.rafMs.p95,
      // The one spacing number that describes this app: frames it was actually offered.
      rafOfferedP95ms: result.sustained.rafOfferedMs.p95,
      drawP95ms: result.sustained.requestToDrawMs.p95,
      prepP95ms: result.sustained.preparationMs.p95,
      // Printed alongside the percentiles so a run that was starved of frames cannot read as a
      // clean one — and so a throttled run still yields its two trustworthy numbers, prep and emits.
      throttled: trust.throttled,
      starvedPct: Math.round(trust.starvedShare * 100),
      suspendedMs: Math.round(trust.suspendedMs),
      wallRatio: Number(trust.wallRatio.toFixed(2)),
      longTaskOver50Ms: trust.longTaskOver50Ms,
      activeFrames: result.sustained.rafMs.count,
    }),
  );
  result.server = await server.describe();
  result.events = cdp.events;
  result.provenanceAfter = await provenance();
  result.sourceStable =
    before.sourceSha256 === result.provenanceAfter.sourceSha256 && result.server.changedSinceServed.length === 0;
  console.log(
    JSON.stringify({
      output: await saveJson(config.output, result),
      sourceStable: result.sourceStable,
      styleChecks: result.styleChecks.supported,
    }),
  );
  assert.equal(
    result.events.filter((event) => event.method === 'Runtime.exceptionThrown' || event.params.entry?.level === 'error')
      .length,
    0,
    'Runtime errors in actual page',
  );
  // Only meaningful under --shipped-csp: the default harness policy allows data: images and
  // inline styles, so in that mode this list is empty by construction, not by health.
  if (config.shippedCsp) assert.deepEqual(metadata.cspViolations ?? [], [], '发货 CSP 在真实页面上拦下了资源');
} catch (error) {
  console.error(JSON.stringify({ browserEvents: cdp?.events || [] }));
  throw error;
} finally {
  if (cdp) {
    try {
      await cdp.call('Browser.close', {}, 5000);
    } catch {}
    cdp.socket.close();
  } else browser?.kill();
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch((error) =>
    console.error(`Owned profile retained: ${profile}: ${error.message}`),
  );
}
