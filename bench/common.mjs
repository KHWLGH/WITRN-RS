import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureBytes } from './fixtures.mjs';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const inputHash = (f) => sha256(fixtureBytes(f));
export function quantiles(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, p99: null, min: null, max: null };
  const a = [...values].sort((x, y) => x - y);
  const q = (p) => a[Math.max(0, Math.ceil(p * a.length) - 1)];
  return { count: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), min: a[0], max: a.at(-1) };
}
/**
 * Separate measured intervals into active ones and suspensions.
 *
 * A headful tab that gets hidden or throttled stops firing rAF entirely, and the gap on resume is
 * seconds to minutes long. That is not a slow frame, it is an unmeasured period, and folding it
 * into the distribution poisons p95/p99/max and inflates any "missed frames" estimate derived from
 * spacing. Observed here: a 135,751ms rAF gap inside a 10-second run.
 *
 * `activeValues` is the surviving array, for callers that need per-interval math; `active` is the
 * quantile summary and has no `.values`.
 */
export function activeIntervals(values, { capMs = 2000 } = {}) {
  const finite = values.filter((v) => Number.isFinite(v) && v >= 0);
  const active = finite.filter((v) => v <= capMs);
  const suspended = finite.filter((v) => v > capMs);
  return {
    active: quantiles(active),
    activeValues: active,
    suspended: {
      count: suspended.length,
      capMs,
      maxMs: suspended.length ? Math.max(...suspended) : 0,
      totalMs: suspended.reduce((n, v) => n + v, 0),
    },
  };
}
export function options(argv, defaults) {
  const result = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i].replace(/^--/, '');
    const [flag, inline] = raw.split('=');
    // CLI flags are kebab-case, config keys camelCase: --verify-baseline -> verifyBaseline.
    const key = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in defaults)) throw new Error(`Unknown option: ${flag}`);
    if (typeof defaults[key] === 'boolean') {
      if (inline !== undefined) throw new Error(`--${flag} is a flag and takes no value`);
      result[key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`Missing ${flag}`);
    result[key] =
      key === 'sizes' ? value.split(',').map(Number) : typeof defaults[key] === 'number' ? Number(value) : value;
  }
  for (const key of ['runs', 'warmup', 'duration'])
    if (key in result && (!Number.isFinite(result[key]) || result[key] < (key === 'warmup' ? 0 : 1)))
      throw new Error(`Invalid ${key}`);
  for (const key of ['runs', 'warmup'])
    if (key in result && !Number.isInteger(result[key])) throw new Error(`Invalid ${key}`);
  if (result.sizes?.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 1_000_000)) throw new Error('Invalid sizes');
  return result;
}
export async function provenance() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
  const files = {};
  for (const directory of ['src', 'src-tauri/src', 'bench']) {
    async function walk(dir) {
      for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = resolve(dir, e.name);
        if (e.isDirectory() && e.name !== 'results') await walk(path);
        else if (e.isFile()) files[relative(ROOT, path).replaceAll('\\', '/')] = sha256(await readFile(path));
      }
    }
    await walk(resolve(ROOT, directory));
  }
  const source = Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith('bench/')));
  return {
    capturedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    worktree: git(['status', '--short']),
    sourceSha256: sha256(JSON.stringify(source)),
    files,
  };
}
export function environment() {
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    execArgv: process.execArgv,
    powerMode: 'not measured',
    clock: 'node:perf_hooks performance.now; milliseconds',
    percentiles: 'nearest-rank; runs are independent invocations within one process, not independent processes',
  };
}
export async function saveJson(path, value) {
  path = resolve(ROOT, path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(resolve(ROOT, path), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`找不到 ${path}；先用 --baseline 生成它`);
    throw e;
  }
}

export const BASELINE_SCHEMA = 'witrn-baseline-v1';
export const REGRESSION_RATIO = 1.15;
/** A gated op needs at least this much time per block, or its ratio is timer jitter. */
export const MIN_BLOCK_MS = 0.2;
/** An op whose own p95/p50 spread is wider than this cannot resolve a 15% shift, so a
 * ratio on it is noise dressed as a verdict. Measured on identical code across three
 * back-to-back runs: the tight ops spread 1.05-1.35, flatten spread 1.78 and produced a
 * false "REGRESSED" at x1.29. Ops above this line are reported, never gated. */
export const MAX_GATEABLE_SPREAD = 1.5;
/** Below this many gateable ops there is no cohort left to estimate drift from at all. */
export const MIN_COHORT = 4;

const r6 = (n) => Number(n.toPrecision(6));
const median = (values) => {
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

/**
 * A tracked baseline is a projection, not a bench result. Everything that legitimately
 * differs every run (wall clock, host, per-file hashes, raw samples) is dropped so the
 * file can live in git and be reviewed as a diff; raw results stay in bench/results/.
 *
 * The numbers are machine-relative: they only mean something against a run on the same
 * host with the same --runs/--warmup. Cross-host or cross-process absolute p50 drifts by
 * multiples here, which is why --compare gates a ratio and WP8's CI gate pairs against a
 * git revision in one interleaved process instead.
 */
export function projectBaseline({ bench, pass, gated, provenanceCommit }) {
  const inputs = {};
  const ops = {};
  for (const c of pass.cases) {
    inputs[c.size] = { samples: c.correctness.inputSha256 };
    if (c.correctness.segmentsSha256) inputs[c.size].segments = c.correctness.segmentsSha256;
    for (const m of c.metrics) {
      if (!gated.includes(`${m.name}@${c.size}`)) continue;
      if (m.blockMs.p50 < MIN_BLOCK_MS)
        throw new Error(
          `${m.name}@${c.size}: 单次测量块只有 ${m.blockMs.p50}ms，低于 ${MIN_BLOCK_MS}ms 门禁下限 —— 给它加 repeat 或别再门禁它`,
        );
      ops[`${m.name}@${c.size}`] = { p50: r6(m.ms.p50), p95: r6(m.ms.p95), repeat: m.repeat };
    }
  }
  const missing = gated.filter((key) => !(key in ops));
  if (missing.length)
    throw new Error(`以下门禁指标本次没测到：${missing.join(', ')}（--sizes 必须覆盖门禁所需的规模）`);
  return {
    schema: BASELINE_SCHEMA,
    bench,
    fixture: { ...pass.fixture },
    runs: pass.config.runs,
    warmup: pass.config.warmup,
    passes: pass.config.passes,
    sizes: pass.config.sizes,
    inputs,
    ops,
    provenanceCommit,
  };
}

/** Central value across passes, so a single fluky pass cannot define the stored baseline. */
export function mergeProjections(list) {
  if (list.length === 1) return list[0];
  const ops = {};
  for (const key of Object.keys(list[0].ops))
    ops[key] = {
      p50: r6(median(list.map((p) => p.ops[key].p50))),
      p95: r6(median(list.map((p) => p.ops[key].p95))),
      repeat: list[0].ops[key].repeat,
    };
  return { ...list[0], ops };
}

export function compareBaseline(baseline, current) {
  const problems = [];
  for (const field of ['schema', 'bench'])
    if (baseline[field] !== current[field])
      problems.push(`${field} 不一致：基线 ${baseline[field]} / 本次 ${current[field]}`);
  for (const field of ['runs', 'warmup', 'passes'])
    if (baseline[field] !== current[field])
      problems.push(
        `--${field} 与基线不同（${baseline[field]} vs ${current[field]}），百分位不可比。用同参数重跑，或有意换基线时用 --baseline 覆盖。`,
      );
  if (baseline.fixture?.version !== current.fixture?.version)
    problems.push(`fixture.version 变了（${baseline.fixture?.version} vs ${current.fixture?.version}）`);
  for (const [size, base] of Object.entries(baseline.inputs ?? {})) {
    const now = current.inputs[size];
    if (!now) {
      problems.push(`本次没跑 size=${size}（基线里有）。要么补 --sizes ${size}，要么重生成基线。`);
      continue;
    }
    for (const kind of Object.keys(base))
      if (base[kind] !== now[kind])
        problems.push(`size=${size} 的 ${kind} 输入指纹与基线不同 —— 基线描述的不是这份输入，用 --baseline 重生成`);
  }
  const rows = [];
  for (const [key, base] of Object.entries(baseline.ops ?? {})) {
    const now = current.ops[key];
    if (!now) {
      problems.push(`${key} 在基线里有、本次没测到`);
      continue;
    }
    if (now.repeat !== base.repeat) {
      problems.push(`${key} 的 repeat 变了（${base.repeat} vs ${now.repeat}），p50 不同源不可比`);
      continue;
    }
    if (!(base.p50 > 0) || !(now.p50 > 0)) {
      problems.push(`${key} 的 p50 有 0 值（基线 ${base.p50} / 本次 ${now.p50}），比值无意义`);
      continue;
    }
    const spread = Math.max(base.p95 / base.p50, now.p95 / now.p50);
    rows.push({
      key,
      base,
      now,
      spread,
      p50Ratio: now.p50 / base.p50,
      p95Ratio: now.p95 / base.p95,
      gateable: spread <= MAX_GATEABLE_SPREAD,
    });
  }
  for (const key of Object.keys(current.ops ?? {}))
    if (!(key in (baseline.ops ?? {}))) rows.push({ key, note: '新指标，尚无基线（--baseline 后纳入门禁）' });
  // A stored absolute baseline cannot carry a verdict on its own: measured on this host, three
  // back-to-back runs of UNCHANGED code put every gated op at 1.12-1.50x and rising, because
  // the baseline was captured during a faster machine window. What survives that is the
  // relative shape -- a real code change moves the ops it touches and leaves the rest alone,
  // while thermal/power drift moves all of them together. So the SMALLEST ratio in the cohort
  // is treated as the machine's state for this run, and only the deviation above it is a
  // finding. Median was tried first and is unsound: an injection that slowed the two energy
  // ops 5x made those ops most of the cohort, pushed the median to x4.32 and the run reported
  // "gate passed" on its own regression.
  const cohort = rows.filter((r) => r.gateable);
  const drift = cohort.length >= MIN_COHORT ? Math.min(...cohort.map((r) => r.p50Ratio)) : 1;
  if (cohort.length < MIN_COHORT)
    problems.push(
      `可门禁指标只有 ${cohort.length} 个（少于 ${MIN_COHORT}），无法估计环境漂移 —— 本轮只报告数值，不做判定。`,
    );
  for (const r of cohort) r.adjusted = r.p50Ratio / drift;
  return { rows, problems, drift, gated: cohort.length >= MIN_COHORT };
}

const fmt = (n) => (n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toExponential(2));

/** Renders the comparison. Rows carry `confirmed` (breached the threshold in every pass). */
export function renderComparison({ rows, problems, drift, gated }) {
  const width = Math.max(6, ...rows.map((r) => r.key.length));
  const head = (label) => label.padStart(12);
  const out = [
    `  ${'metric'.padEnd(width)}${head('base p50')}${head('p50')}${'x'.padStart(8)}${head('base p95')}${head('p95')}${'x'.padStart(8)}${head('p95/p50')}${'x/漂移'.padStart(9)}  超阈轮次`,
    `  本轮环境漂移（可门禁指标里最小的 base/本次比值）= x${drift.toFixed(2)}；判定看 x/漂移，且要求每一轮都超阈`,
  ];
  const failed = [];
  for (const r of rows) {
    if (r.note) {
      out.push(`  ${r.key.padEnd(width)}  ${r.note}`);
      continue;
    }
    const bad = gated && r.gateable && r.confirmed;
    if (bad) failed.push(r.key);
    out.push(
      `  ${r.key.padEnd(width)}${fmt(r.base.p50).padStart(12)}${fmt(r.now.p50).padStart(12)}` +
        `${r.p50Ratio.toFixed(2).padStart(8)}${fmt(r.base.p95).padStart(12)}${fmt(r.now.p95).padStart(12)}` +
        `${r.p95Ratio.toFixed(2).padStart(8)}${r.spread.toFixed(2).padStart(12)}` +
        `${(r.adjusted ?? 1).toFixed(2).padStart(9)}` +
        `   ${r.breaches ?? 0}/${r.passes ?? 1}` +
        `${bad ? '  REGRESSED' : r.gateable ? '' : '  report-only: spread > ' + MAX_GATEABLE_SPREAD}`,
    );
  }
  for (const p of problems) out.push(`  ! ${p}`);
  return { text: out.join('\n'), failed };
}

/**
 * Compares every pass against the baseline and only treats an op as regressed when it
 * breached in all of them. Measured on unchanged code, a single pass produced a false
 * "REGRESSED" on integrateEnergy.nullSegments@100000 (adjusted x1.20) that the very next
 * run did not reproduce; requiring corroboration costs one extra pass and removes that class
 * of verdict without raising the threshold, so a real 15-20% shift is still detectable.
 */
export function corroboration(baseline, projections, threshold) {
  const merged = compareBaseline(baseline, mergeProjections(projections));
  const perPass = projections.map((p) => compareBaseline(baseline, p));
  const passes = projections.length;
  for (const r of merged.rows) {
    r.passes = passes;
    if (!r.gateable) continue;
    r.breaches = perPass.filter(
      (c) => c.gated && c.rows.some((x) => x.key === r.key && x.gateable && x.adjusted > threshold),
    ).length;
    r.confirmed = r.breaches === passes;
  }
  const failed = merged.rows.filter((r) => r.confirmed).map((r) => r.key);
  const unconfirmed = merged.rows
    .filter((r) => r.breaches > 0 && !r.confirmed)
    .map((r) => `${r.key} (${r.breaches}/${passes} 轮)`);
  return { ...merged, failed, unconfirmed, passes };
}

/**
 * Structural check that a committed baseline still describes this bench, so CI can catch a
 * tampered or stale one without pretending timings are reproducible. Numbers are deliberately
 * NOT compared: same code, same machine, two runs already differ by ~10% cross-process. What
 * must not silently move is the input fingerprint, the fixture/op set and the repeat factors,
 * because those decide whether a later --compare ratio means anything at all.
 */
export function verifyBaseline(baseline, current) {
  const problems = [];
  for (const field of ['schema', 'bench', 'runs', 'warmup'])
    if (baseline[field] !== current[field]) problems.push(`${field}: 基线 ${baseline[field]} / 本次 ${current[field]}`);
  for (const field of ['version', 'seed', 'segments'])
    if (baseline.fixture?.[field] !== current.fixture?.[field])
      problems.push(`fixture.${field}: 基线 ${baseline.fixture?.[field]} / 本次 ${current.fixture?.[field]}`);
  const baseKeys = Object.keys(baseline.inputs ?? {})
    .sort()
    .join(',');
  const curKeys = Object.keys(current.inputs ?? {})
    .sort()
    .join(',');
  if (baseKeys !== curKeys) problems.push(`sizes 不一致：基线 [${baseKeys}] / 本次 [${curKeys}]`);
  for (const [size, base] of Object.entries(baseline.inputs ?? {}))
    for (const [kind, hash] of Object.entries(base))
      if (current.inputs[size]?.[kind] !== hash) problems.push(`size=${size} ${kind} 输入指纹与基线不同`);
  const baseOps = Object.keys(baseline.ops ?? {});
  for (const key of Object.keys(current.ops ?? {}))
    if (!baseOps.includes(key)) problems.push(`${key} 是基线里没有的指标`);
  for (const key of baseOps) {
    const now = current.ops[key];
    if (!now) problems.push(`${key} 在基线里有、本次没测到`);
    else if (now.repeat !== baseline.ops[key].repeat)
      problems.push(`${key} repeat: ${baseline.ops[key].repeat} / ${now.repeat}`);
  }
  const moved = baseOps.filter((key) => JSON.stringify(baseline.ops[key]) !== JSON.stringify(current.ops[key])).length;
  return {
    text:
      problems.map((p) => `  ! ${p}`).join('\n') ||
      `  结构一致：${baseOps.length} 项门禁指标、${Object.keys(baseline.inputs ?? {}).length} 个规模、输入指纹全部对得上（${moved}/${baseOps.length} 项数值有正常抖动，要判回退用 --compare）`,
    problems,
  };
}
