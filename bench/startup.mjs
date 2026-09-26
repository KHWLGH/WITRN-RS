/**
 * Cold-start / first-frame measurement.
 *
 * Launches the built app N times, reads the `boot-timing.json` each run writes next to its own
 * settings, and reports p50/p95 per segment. This is the instrument WP5 exists for: without it,
 * every "faster startup" claim in this repo would be a guess.
 *
 *   node bench/startup.mjs                 # debug build (writes the timing file)
 *   node bench/startup.mjs --exe path ...  # any build that writes the file
 *
 * Segments, all in ms from process start (the Rust `record_process_start()` anchor):
 *   contextMs                 process start -> webview context existed (performance.timeOrigin).
 *                             Everything the page cannot see: embed unpack, webview create,
 *                             navigation start.
 *   setupEnter/titlebarCreated/materialApplied/setupExit
 *                             the Rust `setup()` stages. setup() runs AFTER the window is shown
 *                             today, so these sit past first paint, not before it.
 *   platformProbed / appReady page-side marks, converted into the same timeline.
 *   firstPaint / firstContentfulPaint
 *                             webview paint entries, reported as page-relative and echoed here
 *                             unconverted so the two clocks stay distinguishable.
 *
 * Run 1 is reported separately and excluded from the quantiles: the first launch after a build
 * pays cold file-system and DWM/font caches, which is not what a regression looks like.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { environment, options, provenance, quantiles, ROOT, saveJson, sha256 } from './common.mjs';

const IDENTIFIER = 'com.witrn.witrnrs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How fast is this host, right now, in a unit that does not depend on the app.
 *
 * Cold-start segments turned out to scale ~3x with background load (measured: `context` 407-456ms
 * on a quiet machine, 1414ms while benches and an Edge session were live), which makes the absolute
 * milliseconds unusable as a claim. Hashing a fixed buffer is deterministic CPU work that reacts to
 * throttling and contention the same way, so every segment here is quotable relative to it.
 */
const PROBE_BYTES = Buffer.alloc(32 * 1024 * 1024, 0x5a);
function hostProbeMs() {
  const start = performance.now();
  sha256(PROBE_BYTES);
  return Math.round((performance.now() - start) * 10) / 10;
}

function configDir() {
  if (process.platform === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), IDENTIFIER);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', IDENTIFIER);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), IDENTIFIER);
}

function defaultExe() {
  return process.platform === 'win32'
    ? resolve(ROOT, 'target/debug/witrn-rs.exe')
    : resolve(ROOT, 'target/debug/witrn-rs');
}

async function collect(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  // Wait for the file to stop changing before returning. The page writes once per report, and the
  // resource snapshot moves with each write: comparing an arm counted at paint (72 fetches) with one
  // counted 300ms later (81) measures when we looked, not what ships.
  const settle = async (text) => {
    let best = JSON.parse(text);
    let stableMs = 0;
    while (Date.now() < deadline && stableMs < 400) {
      await wait(50);
      stableMs += 50;
      try {
        const next = await readFile(path, 'utf8');
        if (next !== text) {
          text = next;
          best = JSON.parse(next);
          stableMs = 0;
        }
      } catch {
        // mid-write or the process just died: keep the last complete read
        stableMs = 0;
      }
    }
    return best;
  };
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, 'utf8');
      const parsed = JSON.parse(text);
      // The flush that fires on the first rAF after DOMContentLoaded has no paint entry yet, and
      // `boot-timing.json` is only rewritten when a later mark or paint arrives. Measured: 1 of 5
      // runs had a paint value before the observer existed, so the published firstPaint row was the
      // lucky subset. On timeout the best-effort last report is still returned.
      if (
        parsed.web?.marks?.appReady !== undefined &&
        (parsed.web?.firstPaintMs != null || parsed.web?.firstContentfulPaintMs != null)
      )
        return await settle(text);
      last = parsed;
    } catch {}
    await wait(25);
  }
  return last;
}

async function oneRun(exe, file, timeoutMs) {
  await rm(file, { force: true });
  const child = spawn(exe, [], { detached: false, stdio: 'ignore', windowsHide: true });
  const report = await collect(file, timeoutMs);
  child.kill();
  // Give the app a moment to run its shutdown path so the next launch is not fighting a lock.
  for (let i = 0; i < 40 && (await pidAlive(child.pid)); i++) await wait(50);
  return report;
}

async function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Page marks are relative to the webview's own origin; fold them onto the process timeline. */
function absolute(report) {
  const out = { ...report.stagesMs };
  if (report.contextMs != null) out.context = report.contextMs;
  const web = report.web;
  if (web) {
    for (const [name, ms] of Object.entries(web.marks ?? {})) {
      if (out[name] === undefined) out[name] = Math.round(report.contextMs + ms);
    }
    for (const [key, name] of [
      ['firstPaintMs', 'firstPaint'],
      ['firstContentfulPaintMs', 'firstContentfulPaint'],
    ])
      if (web[key] != null && out[name] === undefined) out[name] = Math.round(report.contextMs + web[key]);
    const r = web.resources;
    if (r) {
      out.resourceCount = r.count;
      out.resourcesFirstMs = Math.round(report.contextMs + r.firstStartMs);
      out.resourcesLastMs = Math.round(report.contextMs + r.lastEndMs);
      // `count` mixes the app's own IPC calls with frontend fetches, so it cannot answer a
      // frontend-shape question; the host split can.
      if (r.byHost) {
        const ipc = r.byHost['ipc.localhost'] ?? 0;
        out.resourceIpc = ipc;
        out.resourceFrontend = r.count - ipc;
        out.resourceHosts = JSON.stringify(r.byHost);
      }
    }
  }
  return out;
}

async function main() {
  const config = options(process.argv.slice(2), {
    runs: 10,
    exe: defaultExe(),
    // A second binary to alternate launches against. Absolute milliseconds are not comparable
    // across batches (measured: the same binary's `context` read 482 / 723 / 720 / 1414ms), so the
    // only defensible way to compare two frontend shapes is to interleave their launches inside one
    // batch and compare each pair. Order also flips per pair, so neither arm owns the "first launch
    // of the pair" position.
    exeB: '',
    timeout: 15000,
    output: 'bench/results/startup.json',
  });
  const dir = configDir();
  const file = join(dir, 'boot-timing.json');
  if (!existsSync(config.exe)) throw new Error(`找不到 ${config.exe}；先 cargo build（debug 才会写 boot-timing.json）`);
  if (config.exeB && !existsSync(config.exeB)) throw new Error(`找不到 --exe-b ${config.exeB}`);
  if (config.exeB && config.runs % 2) throw new Error('配对比照需要偶数次 --runs（每对 a、b 各一次）');
  if (!existsSync(dir)) console.error(`配置目录还不存在（${dir}）；第一次启动后会生成`);

  const before = await provenance();
  const result = {
    schema: 'witrn-startup-v1',
    layer: 'native cold start of the built binary; NOT the headful-Edge bench',
    environment: environment(),
    config,
    exe: { path: config.exe, bytes: (await stat(config.exe)).size },
    configDir: dir,
    provenanceBefore: before,
    runs: [],
    limitations: [
      'debug build only: release sets windows_subsystem="windows" and gates the timing write off',
      'first run is reported but excluded from quantiles (cold FS / DWM / font caches)',
      'window is created visible today, so setup stages land after first paint by design',
      'defender / installer scanning and laptop thermal state move every number here',
      'absolute ms are host-scaled: read them next to hostProbeMs (32MiB sha256), which is measured per run',
    ],
  };
  const arms = config.exeB
    ? [
        { name: 'a', exe: config.exe },
        { name: 'b', exe: config.exeB },
      ]
    : null;
  // Precompute the launch order: a,b then b,a then a,b ... so every arm spends half its pairs first.
  const plan = [];
  if (arms) {
    for (let pair = 0; pair < config.runs / 2; pair++) {
      const order = pair % 2 ? [arms[1], arms[0]] : [arms[0], arms[1]];
      order.forEach((arm, pos) => {
        plan.push({ arm, pair, pos });
      });
    }
  } else {
    for (let i = 0; i < config.runs; i++) plan.push({ arm: null, pair: i, pos: 0 });
  }
  for (const { arm, pair, pos } of plan) {
    const report = await oneRun(arm ? arm.exe : config.exe, file, config.timeout);
    // Sampled after the launch, so it describes the host state the launch just ran in without
    // stealing CPU from the thing being measured.
    const probeMs = hostProbeMs();
    if (!report) {
      console.error(`run: 没有读到 ${file} —— 应用未启动，或写入被 gate 掉了`);
      continue;
    }
    const run = { ...absolute(report), hostProbeMs: probeMs };
    if (arm) {
      run.arm = arm.name;
      run.pair = pair;
      run.pairPos = pos;
    }
    result.runs.push(run);
    console.error(
      JSON.stringify({ arm: arm?.name ?? 'single', pair, contextMs: report.contextMs ?? null, hostProbeMs: probeMs }),
    );
  }
  // Drop each arm's own first launch: that is the cold FS / DWM / font-cache sample. With two
  // binaries a global slice(1) would drop arm a's warm run and keep arm b's cold one.
  const firstOfArm = new Set();
  const timed = result.runs.filter((r) => {
    const key = r.arm ?? 'single';
    if (firstOfArm.has(key)) return true;
    firstOfArm.add(key);
    return false;
  });
  const probes = quantiles(timed.map((r) => r.hostProbeMs).filter((v) => Number.isFinite(v)));
  result.hostProbe = {
    ...probes,
    drift: probes.p50 ? Math.round((probes.p95 / probes.p50) * 100) / 100 : null,
    unitBytes: PROBE_BYTES.length,
  };
  const keys = [...new Set(result.runs.flatMap(Object.keys))].filter(
    (k) => k !== 'arm' && k !== 'pair' && k !== 'resourceHosts',
  );
  const segmentsOf = (rows) =>
    Object.fromEntries(keys.map((key) => [key, quantiles(rows.map((r) => r[key]).filter((v) => Number.isFinite(v)))]));
  result.segments = segmentsOf(timed);
  if (arms) {
    result.arms = {
      a: segmentsOf(timed.filter((r) => r.arm === 'a')),
      b: segmentsOf(timed.filter((r) => r.arm === 'b')),
    };
    const grouped = new Map();
    for (const r of timed) {
      const bucket = grouped.get(r.pair) ?? {};
      bucket[r.arm] = r;
      grouped.set(r.pair, bucket);
    }
    const pairs = [...grouped.values()].filter((m) => m.a && m.b);
    // The paired ratio is the whole point: host drift hits both members of a pair within ~3 seconds
    // of each other, so it cancels; batch-to-batch absolute milliseconds do not.
    result.ab = Object.fromEntries(
      keys
        .map((key) => {
          const ratios = pairs
            .map(({ a, b }) => (a[key] > 0 && b[key] > 0 ? b[key] / a[key] : null))
            .filter((v) => v !== null);
          if (!ratios.length) return null;
          const q = quantiles(ratios);
          return [
            key,
            {
              bOverA: { p50: Math.round(q.p50 * 1000) / 1000, p95: Math.round(q.p95 * 1000) / 1000 },
              bFasterPairs: ratios.filter((v) => v < 1).length,
              pairs: ratios.length,
            },
          ];
        })
        .filter(Boolean),
    );
  }
  result.provenanceAfter = await provenance();
  result.sourceStable = before.sourceSha256 === result.provenanceAfter.sourceSha256;

  // Marginal cost of an embedded-asset fetch, which is the number the frontend-shape decisions turn
  // on. Reported next to hostProbeMs and never divided by it: two batches of the same binary measured
  // hostProbe 17.3ms vs 81.7ms (a 4.7x CPU-throughput swing) while `context` stayed 723 vs 720ms, so
  // cold start does not co-scale with CPU work and normalizing by the probe would invent precision.
  const span = result.segments.resourcesLastMs?.p50,
    first = result.segments.resourcesFirstMs?.p50;
  // Frontend-only requests: `resourceCount` includes the app's own IPC calls, which are unrelated
  // to how the page is shaped.
  const fetches = result.segments.resourceFrontend?.p50 ?? result.segments.resourceCount?.p50;
  if (!arms && span != null && first != null && fetches > 0) {
    result.derived = {
      fetches,
      msPerFetch: Math.round(((span - first) / fetches) * 100) / 100,
      hostProbeMs: probes.p50 ?? null,
      note: 'msPerFetch 只在同一批次内可比；hostProbeMs 是该批次的主机状态标记，不是除数',
    };
  }

  await saveJson(config.output, result);

  const width = Math.max(...keys.map((k) => k.length), 6);
  const row = (cells) => console.log(cells.join(''));
  const pad = (text, n) => String(text).padStart(n);
  if (arms) {
    row(['segment'.padEnd(width), pad('a p50', 9), pad('b p50', 9), pad('b/a p50', 10), pad('b快/对', 9)]);
    for (const key of keys) {
      const a = result.arms.a[key];
      const b = result.arms.b[key];
      const ab = result.ab[key];
      if (!a?.count || !b?.count) {
        row([key.padEnd(width) + pad('—', 9) + pad('—', 9) + pad('—', 10) + pad('0', 9)]);
        continue;
      }
      row([
        key.padEnd(width) +
          pad(a.p50.toFixed(0), 9) +
          pad(b.p50.toFixed(0), 9) +
          pad(ab ? ab.bOverA.p50.toFixed(3) : '—', 10) +
          pad(ab ? `${ab.bFasterPairs}/${ab.pairs}` : '—', 9),
      ]);
    }
  } else {
    row(['segment'.padEnd(width), pad('p50', 9), pad('p95', 9), pad('n', 5)]);
    for (const key of keys) {
      const s = result.segments[key];
      if (!s.count) {
        row([key.padEnd(width) + pad('—', 9) + pad('—', 9) + pad('0', 5)]);
        continue;
      }
      row([key.padEnd(width) + pad(s.p50.toFixed(0), 9) + pad(s.p95.toFixed(0), 9) + pad(s.count, 5)]);
    }
  }
  console.log(`  (${result.runs.length}/${config.runs} 次启动取到数据；每个臂各自的首次已排除)`);
  if (result.derived)
    console.log(
      `  每次前端取回 ≈${result.derived.msPerFetch}ms（前端请求 ${result.derived.fetches} 次，不含 IPC）；` +
        `本批 hostProbe p50 = ${result.hostProbe.p50}ms（只作主机标记，不作除数）`,
    );
  if (result.hostProbe.drift > 1.3)
    console.log(
      `  ! 主机状态在本轮内漂移 x${result.hostProbe.drift}（p95/p50 of hostProbeMs）—— 上面的 ms 只能当量级看`,
    );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

export { absolute, configDir, main };
