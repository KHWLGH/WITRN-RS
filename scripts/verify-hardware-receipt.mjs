/**
 * Hardware acceptance verifier -- the gate a release is supposed to sit behind.
 *
 * The claim being verified is narrow and physical: "at 100 Hz for N minutes on a real device, the
 * app lost no samples". That claim is *derivable* from the exported CSV, which is why this reads the
 * CSV instead of trusting a number someone typed: 100 Hz for 600 s means 60,000 rows whose
 * `RelativeTime(s)` increases by ~0.01 s with no gap and no duplicate.
 *
 *   node scripts/verify-hardware-receipt.mjs --csv run.csv --hz 100 --min-duration 600
 *   node scripts/verify-hardware-receipt.mjs --receipt receipt.json
 *
 * Deliberately NOT using `src/csv-codec.js`'s `parseCsv` to count rows: the importer skips malformed
 * and short lines on purpose (a user reloading an old file must not break), and a verifier that
 * inherits that tolerance would count 59,000 good rows out of 60,000 rows and call the run clean.
 * Every data line here is parsed or reported.
 *
 * Mode 2 (`--receipt`) can only check that a receipt contradicts itself -- it does not have the CSV.
 * That limit is printed rather than hidden, so nobody reads CI's green as "the hardware ran".
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { options } from '../bench/common.mjs';

const SCHEMA = 'witrn-acceptance-v1';

/** 一次采样缺失留下的空洞下限（以标称周期计）。1.9 而不是 2.0：留出浮点步进的一点点余量。 */
const SINGLE_POINT_HOLE_FACTOR = 1.9;

/**
 * 投递数与行数之间允许的最大差值：停止录制是异步的，最后最多一整批（`stream::BATCH_POINTS` = 64）
 * 会被消费却不落盘。超过这个界限就只能是链路中间丢的。
 */
const BOUNDARY_SLACK_POINTS = 64;

const usage = () => `用法:
  node scripts/verify-hardware-receipt.mjs --csv <导出文件> --diagnostics '<window.__WITRN_STREAM__() 的 JSON>'
      [--hz 100] [--min-duration 600] [--tolerance 0.02] [--max-gap-factor 3] [--commit <sha>] [--receipt-out <path>]
  node scripts/verify-hardware-receipt.mjs --receipt <receipt.json>`;

/** kebab→camel、数值转换与未知参数报错都由 bench/common.mjs 的 options() 负责，这里不再自带一套解析。 */
const DEFAULTS = {
  csv: '',
  receipt: '',
  commit: '',
  receiptOut: '',
  /**
   * Paste of `window.__WITRN_STREAM__()` taken from the running app's DevTools. This is what turns
   * the receipt from "the CSV looks regular" into "nothing was lost on the way to the CSV": the app's
   * own produced-sample count is compared against the row count, and the error counters stop being
   * numbers the tool invents for you.
   */
  diagnostics: '',
  hz: 100,
  minDuration: 600,
  tolerance: 0.02,
  maxGapFactor: 3,
};

/**
 * @param {string} text
 * @param {{hz:number, maxGapFactor:number}} config
 */
function analyzeCsv(text, { hz, maxGapFactor }) {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => l.startsWith('Time(D.'));
  if (headerIndex < 0) throw new Error('找不到表头（应以 Time(D.hh:mm:ss.ms) 开头）');
  // The exporter writes its own settings into the preamble: `SampTime(ms)` is the sampling interval
  // in milliseconds (the app's `settings.sampleRate`, so 10 == 100 Hz). Reading it makes the rate a
  // property of the file instead of a number the operator typed: a `--hz 100` against a 10 Hz export
  // now fails on the file's own declaration. `SUM` is reported but never gates -- the importer
  // distrusts it for the same reason (re-saved and truncated files exist).
  const preamble = lines.slice(0, headerIndex).join('\n');
  const sampTimeMs = Number(preamble.match(/^SampTime\(ms\),([-\d.]+)/m)?.[1]);
  const declaredRows = Number(preamble.match(/^SUM,([-\d.]+)/m)?.[1]);
  const header = lines[headerIndex].split(',').map((c) => c.trim());
  const relIdx = header.indexOf('RelativeTime(s)');
  const tsIdx = header.indexOf('Timestamp(ms)');
  for (const [name, idx] of [
    ['RelativeTime(s)', relIdx],
    ['Timestamp(ms)', tsIdx],
  ]) {
    if (idx < 0) throw new Error(`表头缺少 ${name} 列，无法判定丢点`);
  }
  const segIdx = header.indexOf('RecordingSegment');

  const dataLines = lines.slice(headerIndex + 1).filter((l) => l.trim() !== '');
  /** @type {string[]} */ const malformed = [];
  /** @type {number[]} */ const rel = [];
  /** @type {number[]} */ const stamps = [];
  /** @type {number[]} */ const segments = [];
  dataLines.forEach((line, n) => {
    const parts = line.split(',');
    const r = Number(parts[relIdx]);
    const t = Number(parts[tsIdx]);
    if (parts.length < 4 || !Number.isFinite(r) || !Number.isFinite(t)) {
      if (malformed.length < 5) malformed.push(`第 ${n + 1} 行: ${line.slice(0, 60)}`);
      return;
    }
    rel.push(r);
    stamps.push(t);
    // An empty cell parses as 0 in JS, which would invent a segment id the app never wrote.
    segments.push(segIdx < 0 ? NaN : parts[segIdx] === '' ? NaN : Number(parts[segIdx]));
  });

  const periodMs = 1000 / hz;
  let monotonicViolations = 0;
  let duplicateTimestamps = 0;
  let maxGapMs = 0;
  let gapsOverTolerance = 0;
  let pauseHoles = 0;
  let singlePointHoles = 0;
  const gapCeiling = periodMs * maxGapFactor;
  const holeCeilingMs = Math.round(periodMs * SINGLE_POINT_HOLE_FACTOR * 100) / 100;
  // `addDataPoint` returns early while nothing is being recorded (manual pause), so a paused stretch
  // legitimately leaves a hole in the file while `deviceStream.seq` keeps advancing. Calling that a
  // dropout would reject a correct run, which is worse than no gate -- so holes that straddle a
  // recording-segment change are counted separately, and the acceptance run itself must be one
  // continuous segment (see `violations`).
  const sameSegment = (a, b) => (Number.isNaN(a) && Number.isNaN(b) ? true : a === b);
  for (let i = 1; i < rel.length; i++) {
    const deltaMs = (rel[i] - rel[i - 1]) * 1000;
    if (deltaMs < 0) monotonicViolations++;
    if (deltaMs === 0) duplicateTimestamps++;
    if (deltaMs > maxGapMs) maxGapMs = deltaMs;
    // A real dropout is far wider than one period; scheduler jitter around 100 Hz is not.
    const crossesSegment = segIdx >= 0 && !sameSegment(segments[i], segments[i - 1]);
    // 丢掉一个点必然留下 ~2x 周期的空洞（`RelativeTime(s)` 是设备自己的连续步进），所以这个判据
    // 比 gapsOverTolerance 锐利得多，也是唯一能把"seq 比 rows 多"区分成丢点 / 边界残差的证据。
    if (deltaMs >= holeCeilingMs && !crossesSegment) singlePointHoles++;
    if (Math.abs(deltaMs - periodMs) > gapCeiling) {
      if (crossesSegment) pauseHoles++;
      else gapsOverTolerance++;
    }
  }
  const durationS = rel.length ? rel.at(-1) - rel[0] : 0;
  const observedHz = durationS > 0 ? (rel.length - 1) / durationS : 0;
  // `durationS` is first-to-last sample, which is one period shorter than the time those samples
  // actually cover. Comparing it against "run it for 600 s" fails a perfect 60,000-row 100 Hz run by
  // 10ms -- a gate that rejects correct input is worse than no gate -- so the rule reads coveredS.
  const coveredS = rel.length ? durationS + periodMs / 1000 : 0;
  const expectedRows = Math.round(coveredS * hz);
  return {
    rows: rel.length,
    dataLines: dataLines.length,
    sampTimeMs: Number.isFinite(sampTimeMs) ? sampTimeMs : null,
    declaredRows: Number.isFinite(declaredRows) ? declaredRows : null,
    durationS: Math.round(durationS * 1000) / 1000,
    coveredS: Math.round(coveredS * 1000) / 1000,
    observedHz: Math.round(observedHz * 1000) / 1000,
    expectedRows,
    missingRows: expectedRows - rel.length,
    maxGapMs: Math.round(maxGapMs * 100) / 100,
    gapCeilingMs: Math.round(gapCeiling * 100) / 100,
    gapsOverTolerance,
    singlePointHoles,
    holeCeilingMs,
    pauseHoles,
    monotonicViolations,
    duplicateTimestamps,
    malformedRows: dataLines.length - rel.length,
    malformedExamples: malformed,
    segments: new Set(segments.filter(Number.isFinite).map((s) => Math.round(s))).size,
    firstRelS: rel[0] ?? null,
    lastRelS: rel.at(-1) ?? null,
    lastStampMs: stamps.at(-1) ?? null,
  };
}

/**
 * The app-side counters, pasted from the running app's DevTools (`window.__WITRN_STREAM__()`).
 * Without them the receipt can only prove the CSV is internally regular; with them it proves
 * nothing was lost between the device and the file.
 * @param {string} arg inline JSON or a .json path
 */
function parseDiagnostics(arg) {
  if (!arg) return null;
  const diagnostics = JSON.parse(arg.endsWith('.json') ? readFileSync(arg, 'utf8') : arg);
  for (const key of ['seq', 'streamErrors', 'capacityErrors']) {
    if (typeof diagnostics[key] !== 'number' || !Number.isFinite(diagnostics[key])) {
      throw new Error(`诊断信息缺少数值字段 ${key}（在应用 DevTools 里执行 window.__WITRN_STREAM__() 后整段粘贴）`);
    }
  }
  return diagnostics;
}

/** @param {ReturnType<typeof analyzeCsv>} m @param {{hz:number,minDuration:number,tolerance:number}} cfg */
function violations(m, { hz, minDuration, tolerance }) {
  const v = [];
  if (m.malformedRows) v.push(`${m.malformedRows} 行数据无法解析（例：${m.malformedExamples[0] ?? ''}）`);
  if (m.rows < 100) v.push(`只有 ${m.rows} 行，不是一次真机长跑`);
  if (m.coveredS < minDuration * (1 - tolerance)) v.push(`覆盖时长 ${m.coveredS}s 低于要求的 ${minDuration}s`);
  if (Math.abs(m.observedHz - hz) / hz > tolerance)
    v.push(`实测 ${m.observedHz}Hz 偏离标称 ${hz}Hz 超过 ${(tolerance * 100).toFixed(1)}%`);
  if (m.sampTimeMs === null) v.push('文件头里没有 SampTime(ms)，无从核对导出时的采样设置');
  else if (Math.abs(1000 / m.sampTimeMs - hz) / hz > tolerance)
    v.push(`文件自己声明的间隔是 ${m.sampTimeMs}ms（=${(1000 / m.sampTimeMs).toFixed(1)}Hz），与要求的 ${hz}Hz 不符`);
  if (m.missingRows > Math.max(1, m.expectedRows * tolerance))
    v.push(`缺 ${m.missingRows} 行（应约 ${m.expectedRows} 行）`);
  if (m.gapsOverTolerance)
    v.push(`${m.gapsOverTolerance} 处间隔超过 ±${m.gapCeilingMs}ms（最大 ${m.maxGapMs}ms）= 有丢点`);
  // The claim being certified is "one continuous 100 Hz stream". A run with a manual pause does not
  // falsify that claim by losing samples -- it simply is not that measurement, and its `seq` no
  // longer equals the row count, so it has to be rejected explicitly instead of looking like damage.
  if (m.segments > 1)
    v.push(`检测到 ${m.segments} 个录制分段（含手动暂停 ${m.pauseHoles} 处空洞）：验收要求单次连续录制，请重跑`);
  else if (m.pauseHoles) v.push(`${m.pauseHoles} 处跨分段空洞`);
  if (m.monotonicViolations) v.push(`${m.monotonicViolations} 处时间倒退`);
  if (m.duplicateTimestamps) v.push(`${m.duplicateTimestamps} 个重复采样点`);
  // The app-side counters, when supplied. `seq` is how many points the emitter handed over, so a
  // CSV with fewer rows lost something between the device and the file -- invisible to every
  // CSV-only rule above.
  // `deviceStream.seq` 统计的是"应用交出并消费的投递"，而 CSV 只包含**录制窗口内**写下的点：停止
  // 录制是异步的，收尾那几批照样推进 seq 却不再落盘。所以差值本身不是丢点的证据，"差值 + 文件里有
  // 单点空洞"才是 —— 真在链路中间丢一个点，`RelativeTime(s)` 必然留下 ~2x 周期的洞，藏不住。
  // 空洞**不是**丢点的判据 —— 这一条是被真机 4 Hz 跑推翻的：文件里有 7 处 ~1.96x 标称周期的洞，而
  // 应用侧计数说 488 产出 / 486 行（差 2，正是停止录制的异步尾），也就是说数据一件没少。低频下网格
  // 在主机停顿后会重新锚定、合并掉一个网格槽，洞于是合法出现却不构成丢点。它继续被**报告**（交付节拍
  // 有没有被拉长本身值得看），但不再参与判决；能定罪的只有"产出与行数的差超出尾限"这一条。
  const residue = m.producedSeq - m.rows;
  if (residue < 0)
    v.push(`CSV 有 ${m.rows} 行，应用却只产出 ${m.producedSeq} 点：行数不可能多于产出，回执与文件互相矛盾`);
  else if (residue > BOUNDARY_SLACK_POINTS)
    v.push(
      `应用产出 ${m.producedSeq} 点、CSV ${m.rows} 行：差 ${residue} 点，超出异步尾限 ${BOUNDARY_SLACK_POINTS} 点（一整批），至少 ${residue - BOUNDARY_SLACK_POINTS} 点是链路中间丢的`,
    );
  if (Number.isFinite(m.streamErrors) && m.streamErrors > 0) v.push(`应用侧记录了 ${m.streamErrors} 次 stream-error`);
  if (Number.isFinite(m.capacityErrors) && m.capacityErrors > 0)
    v.push(`背压超限 ${m.capacityErrors} 次（采集已停，CSV 看起来却可能是完整的）`);
  return v;
}

/**
 * Re-check a receipt that was produced from a CSV we can no longer see. This can only find
 * self-contradiction -- which is worth having, because it is what stops a hand-typed or hand-edited
 * receipt from passing -- but it is not a substitute for mode 1.
 * @param {any} r
 */
function checkReceipt(r) {
  const required = [
    'schema',
    'generatedAt',
    'csvSha256',
    'nominalHz',
    'durationS',
    'coveredS',
    'rows',
    'observedHz',
    'expectedRows',
    'missingRows',
    'maxGapMs',
    'singlePointHoles',
    'gapsOverTolerance',
    'monotonicViolations',
    'duplicateTimestamps',
    'malformedRows',
    'producedSeq',
    'declared',
  ];
  const problems = required.filter((k) => r[k] === undefined).map((k) => `回执缺字段 ${k}`);
  for (const k of required.filter((k) => typeof r[k] === 'number')) {
    if (!Number.isFinite(r[k])) problems.push(`字段 ${k} 不是有限数`);
  }
  if (r.schema !== SCHEMA) problems.push(`schema 应为 ${SCHEMA}，实得 ${r.schema}`);
  const implied = Math.round(r.coveredS * r.nominalHz);
  if (Math.abs(implied - r.expectedRows) > Math.max(2, implied * (r.tolerance ?? 0.02))) {
    problems.push(`coveredS ${r.coveredS}s × ${r.nominalHz}Hz 与 expectedRows ${r.expectedRows} 自相矛盾`);
  }
  if (Math.abs(r.coveredS - (r.durationS + 1 / r.nominalHz)) > 1e-3) {
    problems.push(`coveredS ${r.coveredS} 与 durationS ${r.durationS} 不吻合（应为首尾样本加一个采样周期）`);
  }
  if (r.rows + r.missingRows !== r.expectedRows)
    problems.push(`rows ${r.rows} + missing ${r.missingRows} ≠ expected ${r.expectedRows}`);
  for (const label of ['gapsOverTolerance', 'monotonicViolations', 'duplicateTimestamps', 'malformedRows']) {
    if (r[label]) problems.push(`${label} = ${r[label]}`);
  }
  // 空洞不参与判决（理由见 violations() 里那段 4 Hz 实测），但 `singlePointHoles` 仍是必填字段：
  // "交付节拍被拉长过"是读回执的人必须看见的事实，只是它不构成丢点。
  const residue = r.producedSeq - r.rows;
  if (residue < 0) problems.push(`CSV 行数 ${r.rows} 多于应用产出点数 ${r.producedSeq}：回执自相矛盾`);
  if (residue > BOUNDARY_SLACK_POINTS)
    problems.push(
      `产出与行数差 ${residue} 点，超出异步尾限 ${BOUNDARY_SLACK_POINTS} 点（一整批）：不是边界残差，是链路中间丢了点`,
    );
  if (Number.isFinite(r.boundaryResiduePoints) && r.boundaryResiduePoints !== Math.max(0, residue))
    problems.push(
      `回执声明的边界残差 ${r.boundaryResiduePoints} 与 producedSeq ${r.producedSeq} − rows ${r.rows} 不符`,
    );
  problems.push(...provenanceProblems(r.provenance ?? r.diagnostics?.provenance, r.commit ?? ''));
  const declared = r.declared ?? {};
  for (const key of ['streamErrors', 'capacityErrors']) {
    if (typeof declared[key] !== 'number')
      problems.push(`回执没有声明 ${key}（应来自应用里的 window.__WITRN_STREAM__()）`);
    else if (declared[key] !== 0) problems.push(`${key} = ${declared[key]}`);
  }
  return problems;
}

/**
 * 「这份回执测的是哪份代码」——数据链路再干净，测的若是未提交的字节，就不能当发版凭据。
 * 2026-09-25 那两次 620 秒长跑正是这种情况：exe 里有 66 个未跟踪/未提交的改动，而回执上写的
 * commit 是它们还不存在时的 HEAD。所以这里默认拒绝，放行条件是工作树干净且哈希对得上。
 */
function provenanceProblems(provenance, commit) {
  const p = provenance ?? {};
  const v = [];
  if (typeof p.headCommit !== 'string' || !/^[0-9a-f]{40}$/.test(p.headCommit))
    v.push(
      '缺 provenance.headCommit（40 位 sha）：回执说不出自己测的是哪份代码。请用 scripts/hardware-acceptance.mjs 产出的 acceptance-diagnostics.json。',
    );
  if (p.treeClean !== true)
    v.push(`采集时工作树不干净（treeClean=${JSON.stringify(p.treeClean)}）：测的是未提交的代码，不能作为发版凭据`);
  if (p.exeSha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(p.exeSha256)))
    v.push(`provenance.exeSha256 不是一个 sha256：${String(p.exeSha256).slice(0, 16)}…`);
  if (commit && typeof p.headCommit === 'string' && p.headCommit !== commit)
    v.push(`provenance.headCommit ${p.headCommit} 与 --commit ${commit} 不是同一份代码`);
  return v;
}

const main = () => {
  const opts = options(process.argv.slice(2), DEFAULTS);

  if (opts.receipt) {
    const raw = opts.receipt.endsWith('.json') ? readFileSync(opts.receipt, 'utf8') : opts.receipt;
    const r = JSON.parse(raw);
    const problems = checkReceipt(r);
    console.log(
      JSON.stringify({
        mode: 'receipt',
        commit: r.commit ?? null,
        csvSha256: r.csvSha256 ?? null,
        problems,
        note: '这一模式看不到 CSV，只能查自相矛盾；真正的证据在 CSV 本身与 csvSha256 上。',
      }),
    );
    if (problems.length) {
      console.error('::error::硬件验收回执不合格：' + problems.join('；'));
      process.exitCode = 1;
    }
    return;
  }

  if (!opts.csv) throw new Error(usage());
  // No fallback, and no invented zeros: a receipt whose app-side counters are missing can only claim
  // the file is regular, which is a different (weaker) statement than the one a release rests on.
  const diagnostics = parseDiagnostics(opts.diagnostics);
  if (!diagnostics) {
    console.error(
      `::error::缺 --diagnostics：没有应用侧的 seq/error 计数，就无法证明数据一路无丢失。请在采集结束后于 DevTools 执行 window.__WITRN_STREAM__() 并把结果整段粘贴过来。`,
    );
    process.exitCode = 1;
    return;
  }
  const bytes = readFileSync(opts.csv);
  const text = bytes.toString('utf8');
  const analysed = analyzeCsv(text, opts);
  const m = {
    ...analysed,
    producedSeq: diagnostics.seq,
    // 应用交出、文件里没有的点数。只有当文件里没有单点空洞时，它才 innocent：那部分是停止录制的
    // 异步收尾期间被消费的投递。单独列出来，是为了让"30 点"这种数字有人看见，而不是被塞进一句
    // 自相矛盾的报错里然后被人当噪声。
    boundaryResiduePoints: Math.max(0, diagnostics.seq - analysed.rows),
    streamErrors: diagnostics.streamErrors,
    capacityErrors: diagnostics.capacityErrors,
    provenance: diagnostics.provenance,
  };
  const v = violations(m, opts).concat(provenanceProblems(diagnostics.provenance, opts.commit));
  const receipt = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    commit: opts.commit || null,
    csvSha256: createHash('sha256').update(bytes).digest('hex'),
    csvBytes: bytes.length,
    nominalHz: opts.hz,
    tolerance: opts.tolerance,
    ...m,
    declared: { streamErrors: diagnostics.streamErrors, capacityErrors: diagnostics.capacityErrors },
    diagnostics,
    passed: v.length === 0,
    violations: v,
  };
  console.log(JSON.stringify(receipt, null, 2));
  if (opts.receiptOut) {
    writeFileSync(opts.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
    console.error(`回执已写入 ${opts.receiptOut}`);
  }
  if (!receipt.passed) {
    console.error('::error::硬件验收未通过：\n  - ' + v.join('\n  - '));
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { analyzeCsv, violations, checkReceipt, parseDiagnostics, SCHEMA };
