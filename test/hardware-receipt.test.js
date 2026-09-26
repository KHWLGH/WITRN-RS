// @ts-check
/**
 * 硬件验收闸门自身的测试。
 *
 * 发版前那道"真机 100 Hz 跑满 600 秒"的门禁只能由人来跑（托管 runner 上没有 HID 设备），
 * 所以它能被伪造、也能被无心做错。这里的规则是：**证据从导出的 CSV 里算出来，而不是从谁填的
 * 数字里读出来**，因此测试用应用自己的编码器造 CSV，再让校验器去判 —— 校验器和生产写出走同一条
 * 编码路径，两边不会对格式各说各话。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCsv, checkReceipt, parseDiagnostics, SCHEMA, violations } from '../scripts/verify-hardware-receipt.mjs';
import { formatCsvChunks, snapshotCsvColumns } from '../src/csv-codec.js';
import { emptyChartColumns } from '../src/state.js';

const START = 1704067200000;
const KEYS = ['x', 'timestamps', 'voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'];

/** @param {number[]} seconds */
function encodeFrom(seconds) {
  const cols = emptyChartColumns(seconds.length);
  for (const s of seconds) {
    for (const key of KEYS) cols[key].push(key === 'x' ? s : key === 'timestamps' ? START + s * 1000 : 5);
  }
  return [...formatCsvChunks(snapshotCsvColumns(cols, { sampleRate: 10, startTime: START }))].join('');
}

/** @param {number} count @param {number} hz */
const evenSeconds = (count, hz) => Array.from({ length: count }, (_, i) => i / hz);

const STRICT = { hz: 100, minDuration: 1, tolerance: 0.02 };

test('真机形状：100 Hz 满 600 秒的导出文件判定为通过', () => {
  const csv = encodeFrom(evenSeconds(60_000, 100));
  const m = analyzeCsv(csv, { hz: 100, tolerance: 0.02, maxGapFactor: 3 });
  assert.equal(m.rows, 60_000);
  assert.ok(Math.abs(m.observedHz - 100) < 0.01, `observedHz=${m.observedHz}`);
  assert.deepEqual(violations(m, { hz: 100, minDuration: 600, tolerance: 0.02 }), []);
});

test('中间断 5 个采样点会被判成丢点，而不是"少了 5 行也没事"', () => {
  const seconds = evenSeconds(2_000, 100);
  seconds.splice(1_000, 5); // 设备真的断流时就是这个形状：一段连续时间戳直接跳过去
  const m = analyzeCsv(encodeFrom(seconds), { hz: 100, tolerance: 0.02, maxGapFactor: 3 });
  assert.equal(m.gapsOverTolerance, 1, `maxGapMs=${m.maxGapMs} ceiling=${m.gapCeilingMs}`);
  assert.ok(
    violations(m, STRICT).some((v) => v.includes('丢点')),
    violations(m, STRICT).join('\n'),
  );
});

test('时间倒退与重复点各自单独成罪', () => {
  const backwards = evenSeconds(600, 100);
  backwards[300] = backwards[299] - 0.01;
  let m = analyzeCsv(encodeFrom(backwards), { hz: 100, tolerance: 0.02, maxGapFactor: 3 });
  assert.equal(m.monotonicViolations, 1);
  assert.ok(violations(m, STRICT).some((v) => v.includes('时间倒退')));

  const duplicated = evenSeconds(600, 100);
  duplicated[300] = duplicated[299];
  m = analyzeCsv(encodeFrom(duplicated), { hz: 100, tolerance: 0.02, maxGapFactor: 3 });
  assert.equal(m.duplicateTimestamps, 1);
  assert.ok(violations(m, STRICT).some((v) => v.includes('重复采样点')));
});

test('速率不达标与时长不足都会被拦下', () => {
  // 40 Hz 跑 600 秒：行数与时长都"自洽"，但根本不是要求的采样率。
  const slow = analyzeCsv(encodeFrom(evenSeconds(24_000, 40)), { hz: 100, tolerance: 0.02, maxGapFactor: 3 });
  assert.ok(violations(slow, { ...STRICT, minDuration: 1 }).some((v) => v.includes('偏离标称')));
  const short = analyzeCsv(encodeFrom(evenSeconds(300, 100)), { hz: 100, tolerance: 0.02, maxGapFactor: 3 });
  assert.ok(violations(short, { hz: 100, minDuration: 600, tolerance: 0.02 }).some((v) => v.includes('低于要求')));
});

test('损坏行是失败而不是被静默跳过 —— 这正是没有复用 parseCsv 的原因', () => {
  const broken = encodeFrom(evenSeconds(1_000, 100)) + 'junk,line\n';
  const m = analyzeCsv(broken, { hz: 100, tolerance: 0.02, maxGapFactor: 3 });
  assert.equal(m.malformedRows, 1);
  assert.equal(m.malformedExamples.length, 1, '必须给出可定位的样例');
  assert.ok(violations(m, STRICT).some((v) => v.includes('无法解析')));
});

test('没有 RelativeTime 列的旧导出文件直接拒绝，而不是退化成"看不出丢点"', () => {
  assert.throws(
    () =>
      analyzeCsv('Time(D.hh:mm:ss.ms),Voltage(V),\n01:00:00.000,5,\n', { hz: 100, tolerance: 0.02, maxGapFactor: 3 }),
    /RelativeTime/,
  );
  assert.throws(() => analyzeCsv('完全不是我们的 CSV\n', { hz: 100, tolerance: 0.02, maxGapFactor: 3 }), /表头/);
});

/** @param {Partial<Record<string, any>>} over */
const receipt = (over = {}) => ({
  schema: SCHEMA,
  generatedAt: new Date(0).toISOString(),
  commit: 'f'.repeat(40),
  csvSha256: 'a'.repeat(64),
  nominalHz: 100,
  tolerance: 0.02,
  durationS: 599.99,
  coveredS: 600,
  rows: 60_000,
  observedHz: 100,
  expectedRows: 60_000,
  missingRows: 0,
  producedSeq: 60_000,
  maxGapMs: 10,
  gapsOverTolerance: 0,
  singlePointHoles: 0,
  holeCeilingMs: 19,
  boundaryResiduePoints: 0,
  monotonicViolations: 0,
  duplicateTimestamps: 0,
  malformedRows: 0,
  declared: { streamErrors: 0, capacityErrors: 0 },
  provenance: { headCommit: 'f'.repeat(40), treeClean: true },
  ...over,
});

test('干净回执通过自洽检查', () => {
  assert.deepEqual(checkReceipt(receipt()), []);
});

test('手改的行数会被自己的算术抓住', () => {
  // 声称只跑了 6 秒却要求 60,000 行：expectedRows 与 coveredS×hz 立刻矛盾。
  const problems = checkReceipt(receipt({ durationS: 5.99, coveredS: 6, rows: 60_000, expectedRows: 60_000 }));
  assert.ok(
    problems.some((p) => p.includes('自相矛盾')),
    problems.join('\n'),
  );
  // 单独改动 coveredS 而不跟着 durationS：两个字段互相戳穿。
  assert.ok(
    checkReceipt(receipt({ coveredS: 900 })).some((p) => p.includes('不吻合')),
    'coveredS 必须等于首尾样本跨度加一个采样周期',
  );
  // 只改 rows 不改 missingRows：加法不闭合。
  assert.ok(
    checkReceipt(receipt({ rows: 59_990 })).some((p) => p.includes('≠ expected')),
    'rows + missingRows 必须等于 expectedRows',
  );
});

test('回执漏掉声明字段、或声明里承认有错误，都不放行', () => {
  const { declared, ...rest } = receipt();
  assert.ok(checkReceipt(rest).some((p) => p.includes('回执没有声明')));
  assert.ok(
    checkReceipt(receipt({ declared: { streamErrors: 3, capacityErrors: 0 } })).some((p) =>
      p.includes('streamErrors = 3'),
    ),
  );
  assert.ok(
    checkReceipt(receipt({ declared: { streamErrors: 0, capacityErrors: 1 } })).some((p) =>
      p.includes('capacityErrors = 1'),
    ),
  );
  assert.ok(checkReceipt(receipt({ gapsOverTolerance: 7 })).some((p) => p.includes('gapsOverTolerance')));
  assert.ok(checkReceipt({ ...receipt(), schema: 'witrn-acceptance-v0' }).some((p) => p.includes('schema')));
});

test('回执必须说得出它测的是哪份代码：脏工作树不放行', () => {
  // 真实发生过的情形：exe 里带着几十个未提交的改动，回执上的 commit 却是这些改动不存在时的 HEAD，
  // 于是"验收通过的代码"与"仓库里的代码"根本是两份东西。
  const dirty = checkReceipt(receipt({ provenance: { headCommit: 'f'.repeat(40), treeClean: false } }));
  assert.ok(
    dirty.some((p) => p.includes('未提交的代码')),
    dirty.join('\n'),
  );
  const missing = checkReceipt(receipt({ provenance: undefined }));
  assert.ok(
    missing.some((p) => p.includes('缺 provenance')),
    missing.join('\n'),
  );
  const mismatched = checkReceipt({ ...receipt(), commit: 'b'.repeat(40) });
  assert.ok(
    mismatched.some((p) => p.includes('不是同一份代码')),
    mismatched.join('\n'),
  );
  const badHash = checkReceipt(
    receipt({ provenance: { headCommit: 'f'.repeat(40), treeClean: true, exeSha256: 'not-a-hash' } }),
  );
  assert.ok(
    badHash.some((p) => p.includes('不是一个 sha256')),
    badHash.join('\n'),
  );
  // 反向：干净且对得上，必须一条都不报。
  assert.deepEqual(
    checkReceipt(receipt({ provenance: { headCommit: 'a'.repeat(40), treeClean: true }, commit: 'a'.repeat(40) })),
    [],
  );
});

test('空洞是事实不是判据：4 Hz 真机把它推翻后，定罪只靠产出与行数的差', () => {
  // 这条判据原本是"文件里有 ≥1.9x 空洞 = 少写了采样点"。真机 4 Hz 跑给出 7 处 ~1.96x 的洞，而应用侧
  // 计数说 488 产出 / 486 行（差 2，正是停止录制的异步尾）—— 数据一件没少。洞是网格在主机停顿后重新
  // 锚定、合并掉一个槽的结果。所以洞继续报告，判决交给"超出异步尾限的差值"。
  const seconds = evenSeconds(1_000, 100).filter((_, index) => index !== 500);
  const m = { ...analyzeCsv(encodeFrom(seconds), { hz: 100, maxGapFactor: 3 }), producedSeq: 999 };
  assert.equal(m.singlePointHoles, 1, '一处 20ms 洞必须被报告出来');
  assert.equal(m.gapsOverTolerance, 0, '±3x 的粗判据看不见单点级的节拍变化');
  assert.deepEqual(violations(m, STRICT), [], `空洞不再定罪：${violations(m, STRICT).join(' | ')}`);
  // 差值超过一整批（64 点）才是链路中间丢的，并且要报出至少丢了几点。
  const lost = { ...m, producedSeq: m.rows + 100 };
  assert.ok(
    violations(lost, STRICT).some((v) => v.includes('链路中间丢的') && v.includes('36')),
    violations(lost, STRICT).join('\n'),
  );
});

test('投递数多于行数：尾限之内是边界残差，超出尾限才是丢点', () => {
  // 停止录制是异步的：收尾那几批照样推进 seq，却不再落盘。所以这个差值本身不是证据。
  const clean = {
    ...analyzeCsv(encodeFrom(evenSeconds(1_000, 100)), { hz: 100, maxGapFactor: 3 }),
    producedSeq: 1_030,
  };
  assert.equal(clean.singlePointHoles, 0);
  assert.deepEqual(
    violations(clean, STRICT).filter(
      (v) => v.includes('点') && v.includes('producedSeq') === false && v.includes('空洞'),
    ),
    [],
    `干净的长跑不该因为边界残差被判红：${violations(clean, STRICT).join(' | ')}`,
  );
  assert.equal(clean.boundaryResiduePoints ?? clean.producedSeq - clean.rows, 30);
  // 比例级缺失由"行数 vs 跨度"的算术定罪，不需要靠空洞。
  const dropped = {
    ...analyzeCsv(encodeFrom(evenSeconds(1_000, 100).filter((_, i) => i % 7 !== 3)), {
      hz: 100,
      maxGapFactor: 3,
    }),
    producedSeq: 857,
  };
  assert.ok(dropped.missingRows > 20, `对照组必须真的缺了 >2%：${dropped.missingRows}`);
  assert.equal(dropped.producedSeq, dropped.rows, '这条路径上产出与行数吻合，缺失只由跨度算术现形');
  assert.ok(
    violations(dropped, STRICT).some((v) => v.includes('缺 ')),
    violations(dropped, STRICT).join('\n'),
  );
});

test('回执里把边界残差改小便被自己的算术抓住', () => {
  const problems = checkReceipt(receipt({ producedSeq: 60_030, boundaryResiduePoints: 0 }));
  assert.ok(
    problems.some((p) => p.includes('边界残差')),
    problems.join('\n'),
  );
  assert.ok(
    checkReceipt(receipt({ rows: 57_000, producedSeq: 60_000, expectedRows: 60_000, missingRows: 0 })).some((p) =>
      p.includes('≠ expected'),
    ),
    'rows+missing≠expected 这条算术闭合仍然在位',
  );
});

test('手动暂停不冒充丢点，但会让这次运行不再是"连续录制"，两者都要报', () => {
  // 暂停期间 addDataPoint 直接 return，文件里留下合法空洞，而 deviceStream.seq 继续走。
  // 若把它当成丢点，一次正确的运行会被判红。
  const seconds = [...evenSeconds(1_000, 100), ...evenSeconds(1_000, 100).map((s) => s + 13)];
  const cols = emptyChartColumns(seconds.length);
  seconds.forEach((s, i) => {
    for (const key of KEYS) cols[key].push(key === 'x' ? s : key === 'timestamps' ? START + s * 1000 : 5);
    cols.recordingSegments.push(i < 1_000 ? 1 : 2);
  });
  const csv = [...formatCsvChunks(snapshotCsvColumns(cols, { sampleRate: 10, startTime: START }))].join('');
  const m = analyzeCsv(csv, { hz: 100, maxGapFactor: 3 });
  assert.equal(m.segments, 2);
  assert.equal(m.pauseHoles, 1, '跨分段的空洞要单独归类');
  assert.equal(m.gapsOverTolerance, 0, '跨分段空洞不得算成丢点');
  const v = violations(m, STRICT);
  assert.ok(
    v.some((x) => x.includes('单次连续录制')),
    v.join('\n'),
  );

  // 反向保障：同样的空洞若发生在同一段内，仍然是丢点 —— 分段不是万能免罪符。
  const inside = analyzeCsv(encodeFrom([...evenSeconds(1_000, 100), ...evenSeconds(1_000, 100).map((s) => s + 13)]), {
    hz: 100,
    maxGapFactor: 3,
  });
  assert.equal(inside.gapsOverTolerance, 1);
});

test('文件自己声明的采样间隔要和 --hz 对得上，否则不接受判定', () => {
  // 导出的头里有 `SampTime(ms)`（= 应用里的 settings.sampleRate，单位是毫秒）。
  // 没有这条，"这是不是一次 100 Hz 验收"取决于操作者手打的 --hz；有了它，速率是文件的属性。
  const cols = emptyChartColumns(1_000);
  for (let i = 0; i < 1_000; i++) {
    const s = i * 0.1; // 10 Hz 的真实节奏
    for (const key of KEYS) cols[key].push(key === 'x' ? s : key === 'timestamps' ? START + s * 1000 : 5);
  }
  const tenHzFile = [...formatCsvChunks(snapshotCsvColumns(cols, { sampleRate: 100, startTime: START }))].join('');
  const m = analyzeCsv(tenHzFile, { hz: 100, maxGapFactor: 3 });
  assert.equal(m.sampTimeMs, 100);
  const v = violations(m, { hz: 100, minDuration: 1, tolerance: 0.02 });
  assert.ok(
    v.some((x) => x.includes('与要求的 100Hz 不符')),
    v.join('\n'),
  );
  // 反过来：把 --hz 说对（10 Hz 的文件 + SampTime 100ms）时这条不再报。
  assert.ok(
    !violations(m, { hz: 10, minDuration: 1, tolerance: 0.02 }).some((x) => x.includes('SampTime')),
    '声明与 --hz 一致时不该再报速率不符',
  );
});

test('诊断信息缺字段就拒绝，而不是当成 0', () => {
  assert.equal(parseDiagnostics(''), null);
  assert.throws(() => parseDiagnostics('{"seq":10}'), /streamErrors/);
  assert.throws(() => parseDiagnostics('{"seq":10,"streamErrors":null,"capacityErrors":0}'), /streamErrors/);
  assert.deepEqual(parseDiagnostics('{"seq":10,"streamErrors":0,"capacityErrors":0}').seq, 10);
});
