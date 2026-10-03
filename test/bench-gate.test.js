// @ts-check
/**
 * 门禁机制自身的测试。
 *
 * 这里锁的不是应用性能，而是"判定规则会不会说谎"。三条历史教训各对应一组断言：
 *  - 用中位数估计环境漂移会被回退本身污染（两个指标同时慢 5 倍时，中位数就成了 5，
 *    回退被自己归一化掉，实测报出 gate passed）。
 *  - 单次运行的比值不够可靠（同一份代码实测出现过 adjusted x1.20 的一次性误报）。
 *  - 存基线里的输入指纹被手改，比较就失去意义。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeIntervals,
  BASELINE_SCHEMA,
  compareBaseline,
  corroboration,
  MAX_GATEABLE_SPREAD,
  MIN_BLOCK_MS,
  projectBaseline,
  quantiles,
  REGRESSION_RATIO,
  verifyBaseline,
} from '../bench/common.mjs';

const OPS = ['a.op', 'b.op', 'c.op', 'd.op', 'e.op'];
const SIZE = 1_000_000;
const GATED = OPS.flatMap((name) => [`${name}@${SIZE}`]);

/** @param {Record<string, {p50:number,p95:number}>} times */
function projection(times, inputs = { [SIZE]: { samples: 'hash-a', segments: 'hash-s' } }) {
  const ops = {};
  for (const [key, t] of Object.entries(times)) ops[key] = { p50: t.p50, p95: t.p95, repeat: 1 };
  return {
    schema: BASELINE_SCHEMA,
    bench: 'core',
    fixture: { version: 'witrn-f64-v1', seed: 1, segments: 'segments-v1' },
    runs: 20,
    warmup: 5,
    passes: 3,
    sizes: [SIZE],
    inputs,
    ops,
    provenanceCommit: 'deadbeef',
  };
}

/** A cohort where nothing moved: every ratio is 1.00 and every op's own spread is 1.2.
 * `moved` is keyed by full op name, e.g. { 'a.op': 50 }. */
function flat(moved = {}) {
  const base = {};
  const now = {};
  for (const name of OPS) {
    base[`${name}@${SIZE}`] = { p50: 10, p95: 12 };
    now[`${name}@${SIZE}`] = { p50: moved[name] ?? 10, p95: 12 };
  }
  return { base, now };
}

function passes(times, count = 3) {
  const list = [];
  for (let i = 0; i < count; i++) list.push(projection(times));
  return list;
}

test('a regression that hits most of the cohort is still reported, not normalized away', () => {
  // 3 of 5 gated ops at 5x. This is the shape that actually broke a median-based estimator:
  // a single hot helper regressing shows up in every op that calls it, so the majority of the
  // cohort moves together. A median then lands ON the regression and each op divides itself
  // out -- the run reports "gate passed" on its own 5x slowdown.
  const { base, now } = flat({ 'a.op': 50, 'b.op': 50, 'c.op': 50 });
  const verdict = corroboration(projection(base), passes(now), REGRESSION_RATIO);
  assert.equal(verdict.gated, true, verdict.problems.join('\n'));
  assert.ok(verdict.drift < 1.5, `drift must not chase the regressed ops, got x${verdict.drift}`);
  assert.deepEqual(
    verdict.failed.sort(),
    ['a.op@1000000', 'b.op@1000000', 'c.op@1000000'],
    `5x 回退必须判红；实得 failed=${JSON.stringify(verdict.failed)} drift=${verdict.drift}`,
  );
});

test('unchanged code passes, and a one-pass blip does not', () => {
  const { base, now } = flat();
  const clean = corroboration(projection(base), passes(now), REGRESSION_RATIO);
  assert.equal(clean.problems.length, 0);
  assert.deepEqual(clean.failed, []);
  assert.equal(clean.gated, true);

  // Same op breaching in only 1 of 3 passes must be reported, never gated.
  const blip = { ...now, [`e.op@${SIZE}`]: { p50: 14, p95: 16 } };
  const list = [projection(now), projection(now), projection(blip)];
  const verdict = corroboration(projection(base), list, REGRESSION_RATIO);
  assert.deepEqual(verdict.failed, [], '单轮超阈不构成判定');
  assert.deepEqual(verdict.unconfirmed, ['e.op@1000000 (1/3 轮)']);
});

test('an op whose own spread cannot resolve the threshold is never gated', () => {
  const { base, now } = flat({ 'a.op': 50 });
  base[`a.op@${SIZE}`] = { p50: 10, p95: 10 * (MAX_GATEABLE_SPREAD + 0.4) };
  now[`a.op@${SIZE}`] = { p50: 50, p95: 50 * (MAX_GATEABLE_SPREAD + 0.4) };
  const verdict = corroboration(projection(base), passes(now), REGRESSION_RATIO);
  const row = verdict.rows.find((r) => r.key === `a.op@${SIZE}`);
  assert.equal(row.gateable, false);
  assert.equal(row.confirmed, undefined);
  assert.ok(!verdict.failed.includes(`a.op@${SIZE}`), '离散度过大的指标只能报告');
});

test('a cohort too small to estimate drift refuses to issue a verdict', () => {
  const { base, now } = flat({ 'a.op': 50 });
  const trimmed = (o) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('d.op') && !k.startsWith('e.op')));
  const verdict = corroboration(projection(trimmed(base)), passes(trimmed(now)), REGRESSION_RATIO);
  assert.equal(verdict.gated, false, `只剩 ${OPS.length - 2} 个可门禁指标时不得判定`);
  assert.ok(
    verdict.problems.some((p) => p.includes('无法估计环境漂移')),
    verdict.problems.join('\n'),
  );
});

test('projectBaseline rejects a measurement too fast to gate on', () => {
  const pass = {
    config: { runs: 20, warmup: 5, passes: 3, sizes: [SIZE] },
    fixture: { version: 'witrn-f64-v1', seed: 1, segments: 'segments-v1' },
    cases: [
      {
        size: SIZE,
        correctness: { inputSha256: 'hash-a', segmentsSha256: 'hash-s' },
        metrics: OPS.map((name) => ({
          name,
          repeat: 1,
          ms: { p50: 0.01, p95: 0.02 },
          blockMs: { p50: MIN_BLOCK_MS / 2 },
        })),
      },
    ],
  };
  assert.throws(
    () => projectBaseline({ bench: 'core', pass, gated: GATED, provenanceCommit: 'x' }),
    /低于 .* 门禁下限/,
  );
  // Structure-only verification must also work with no timing measurements at all.
  const structure = projectBaseline({
    bench: 'core',
    pass: {
      ...pass,
      cases: pass.cases.map((c) => ({ ...c, metrics: c.metrics.map(({ name, repeat }) => ({ name, repeat })) })),
    },
    gated: GATED,
    timings: false,
  });
  assert.deepEqual(structure.ops, Object.fromEntries(GATED.map((key) => [key, { repeat: 1 }])));
});

test('projectBaseline refuses to silently drop a gated metric', () => {
  const pass = {
    config: { runs: 20, warmup: 5, passes: 3, sizes: [SIZE] },
    fixture: { version: 'witrn-f64-v1', seed: 1, segments: 'segments-v1' },
    cases: [
      {
        size: SIZE,
        correctness: { inputSha256: 'hash-a', segmentsSha256: 'hash-s' },
        metrics: OPS.slice(0, -1).map((name) => ({
          name,
          repeat: 1,
          ms: { p50: 10, p95: 12 },
          blockMs: { p50: 10 },
        })),
      },
    ],
  };
  assert.throws(() => projectBaseline({ bench: 'core', pass, gated: GATED, provenanceCommit: 'x' }), /没测到/);
});

test('a tampered input fingerprint invalidates the comparison', () => {
  const { base, now } = flat();
  const baseline = projection(base);
  const current = projection(now, { [SIZE]: { samples: 'hash-a', segments: 'TAMPERED' } });
  const { problems } = compareBaseline(baseline, current);
  assert.ok(
    problems.some((p) => p.includes('输入指纹与基线不同')),
    problems.join('\n'),
  );
  const verify = verifyBaseline(baseline, current);
  assert.ok(verify.problems.length > 0, '--verify-baseline 必须对手改指纹报警');
});

test('verifyBaseline checks structure and ignores normal timing jitter', () => {
  const { base, now } = flat();
  now[`c.op@${SIZE}`] = { p50: 10.4, p95: 12.9 };
  const verify = verifyBaseline(projection(base), projection(now));
  assert.deepEqual(verify.problems, [], '数值抖动不是错误');
  assert.match(verify.text, /结构一致/);
  const structure = projection(now);
  structure.ops = Object.fromEntries(Object.entries(structure.ops).map(([key, { repeat }]) => [key, { repeat }]));
  assert.deepEqual(verifyBaseline(projection(base), structure).problems, [], '结构检查不要求计时数据');
  structure.passes = 1;
  assert.ok(verifyBaseline(projection(base), structure).problems.some((p) => p.startsWith('passes:')));
  structure.passes = 3;
  structure.ops[`a.op@${SIZE}`].repeat = 2;
  assert.ok(verifyBaseline(projection(base), structure).problems.some((p) => p.includes('repeat:')));
});

test('an rAF suspension is reported, not folded into the tail', () => {
  // The shape actually observed: eleven ~6ms frames, then a hidden-tab gap 4 orders of magnitude
  // longer, then frames resume. Before the filter this poisoned max (135,751ms inside a 10s run)
  // and pushed p95 to 3x its true value, and the missed-frame estimate counted it as thousands of
  // dropped frames. If the filter is removed, `active.max` becomes the gap and both assertions red.
  const values = [...Array(11).fill(6.1), 135_751, 5.8];
  const { active, activeValues, suspended } = activeIntervals(values);
  assert.equal(suspended.count, 1);
  assert.equal(suspended.maxMs, 135_751);
  assert.equal(active.count, 12);
  assert.equal(active.max, 6.1, '挂起不得进入分位分布');
  assert.equal(quantiles(values).max, 135_751, 'naive quantiles 是这个 bug 的对照组');
  assert.deepEqual(activeValues, values.slice(0, 11).concat(5.8), 'per-interval 只能用过滤后的数组');
});

test('intervals that are not measurements never reach a ratio', () => {
  const { active, suspended } = activeIntervals([NaN, -1, Infinity, 8, null, undefined, 9]);
  assert.equal(active.count, 2, '非有限值与负数必须被丢弃，而不是排序时污染 min');
  assert.equal(suspended.count, 0, '一个不是测量的数不能算成一次挂起');
});
