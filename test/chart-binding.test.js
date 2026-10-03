import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SeriesBuckets } from '../src/chart-buckets.js';
import { ExactExtremaIndex } from '../src/chart-extrema.js';

/**
 * 主图绑定的不变量：画什么只由可见窗口决定。
 * 交互状态（拖手柄 / 平移 / 滚轮）不得引入第二套条带几何 —— 那正是「拖动时的图像和松手后不一样」的成因。
 *
 * 行为测试只喂到 applyData 之前：uPlot 由一个记录 setData 的替身冒充，替身收到的那批顶点就是
 * 屏幕上画的东西，所以「拖动中那一帧」与「松手后那一帧」能逐元素对比。
 * 结构守卫放在最后：bindDisplayData / flushResizes 是模块私有，有些形状只能从源码钉。
 */

const SAMPLES = 200_000;
const PLOT_WIDTH = 1200;
let preparing = false;

function fakeElement() {
  return {
    clientWidth: PLOT_WIDTH,
    clientHeight: 300,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(key, value) {
      if (key === 'aria-busy') preparing = value === 'true';
    },
    removeAttribute() {},
    addEventListener() {},
    getBoundingClientRect: () => ({ width: PLOT_WIDTH, height: 300, left: 0, top: 0 }),
    querySelector: () => null,
  };
}

/** @type {((time:number)=>void)|null} */
let pendingFrame = null;

globalThis.document = {
  hidden: false,
  documentElement: fakeElement(),
  body: fakeElement(),
  addEventListener() {},
  getElementById: (id) =>
    id === 'navigator-chart' ? { clientWidth: 600, clientHeight: 46 } : id === 'main-chart' ? fakeElement() : null,
  querySelector: () => null,
  createElement: () => fakeElement(),
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', fontSize: '12px' });
globalThis.requestAnimationFrame = (cb) => {
  pendingFrame = cb;
  return 1;
};
globalThis.cancelAnimationFrame = () => {
  pendingFrame = null;
};

const { state } = await import('../src/state.js');
const chart = await import('../src/chart.js');

/** uPlot 替身：只记录最后一次 setData，并拷走当批顶点。 */
function stubChart() {
  return {
    width: PLOT_WIDTH,
    height: 300,
    hooks: {},
    data: null,
    submissions: 0,
    scaleChanges: 0,
    setData(data) {
      this.submissions++;
      this.data = data.map((col) => Array.from(col));
    },
    setScale() {
      this.scaleChanges++;
    },
  };
}

/** 写入 SAMPLES 个点，x 为 20ms 间隔的相对秒。 */
function seed({ powerPeak = false } = {}) {
  state.chartWindow = { mode: 'full', min: 0, max: 0, duration: 0 };
  state.navigatorChart = null;
  state.isRecording = false;
  const cs = state.chartSeries;
  for (const col of [cs.x, cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2]) col.length = 0;
  for (let i = 0; i < SAMPLES; i++) {
    cs.x.push(i * 0.02);
    cs.voltage.push(5 + Math.sin(i / 97) * 0.4);
    cs.current.push(2 + Math.cos(i / 31) * 1.2);
    cs.power.push(powerPeak && i === 4096 ? 100 : 10 + Math.sin(i / 7) * 3);
    cs.temp.push(30 + (i % 13) * 0.1);
    cs.dp.push(3.3);
    cs.dn.push(0.6);
    cs.cc1.push(0);
    cs.cc2.push(0);
  }
  chart.syncChartSeries();
}

/** @param {number} start @param {number} end 下标对，换成 x 秒值后交给范围滑块。 */
function windowOf(start, end) {
  return [state.chartSeries.x.at(start), state.chartSeries.x.at(end)];
}

/** @param {[number, number]} range */
async function commit(range) {
  chart.setChartXWindow(range[0], range[1]);
  chart.updateCharts();
  await settle();
}

async function settle() {
  while (preparing) await new Promise((resolve) => setTimeout(resolve, 2));
}

/** 拖动手柄中的一帧：与 applyRangeValues(preview) 一致，排一帧 rAF、不强制。 */
async function dragFrame(u, range) {
  chart.setChartXWindow(range[0], range[1]);
  chart.scheduleChartUpdate();
  assert.ok(pendingFrame, '拖动帧应排到一帧 rAF');
  const frame = pendingFrame;
  pendingFrame = null;
  frame(0);
  await settle();
  return u.data;
}

/** 绑定顶点里落在 X 窗内的那些 —— 也就是屏幕上真的会画出来的部分。 */
function visible(bound, range) {
  const col = bound[0];
  let n = 0;
  for (let i = 0; i < col.length; i++) if (col[i] >= range[0] && col[i] <= range[1]) n += 1;
  return n;
}

test('the frame drawn while dragging is the frame left on release', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;

  const full = windowOf(0, SAMPLES - 1);
  await commit(full);
  assert.ok(visible(u.data, full) > PLOT_WIDTH / 2, '全量窗口应走窗口级条带');

  const target = windowOf(100_000, 102_000);
  chart.setRangeDragging(true);
  const whileDragging = await dragFrame(u, target);
  const dragPixels = visible(whileDragging, target);
  chart.setRangeDragging(false);
  await commit(target);

  // 旧实现这里只往窗口里画约 24 个顶点（按全量历史分条带），松手后才涨到 2000。
  assert.ok(dragPixels > PLOT_WIDTH / 2, `拖动中落在窗口内的顶点须与松手后同量级，实际 ${dragPixels}`);
  assert.deepEqual(whileDragging, u.data);
});

test('panning keeps one stripe density from the first drag frame to the settled one', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  await commit(windowOf(0, SAMPLES - 1));

  const from = windowOf(40_000, 90_000);
  const to = windowOf(40_500, 90_500);
  chart.setRangeDragging(true);
  const firstFrame = await dragFrame(u, from);
  const secondFrame = await dragFrame(u, to);
  chart.setRangeDragging(false);
  await commit(to);

  const firstPixels = visible(firstFrame, from);
  const secondPixels = visible(secondFrame, to);
  assert.ok(Math.abs(firstPixels - secondPixels) <= 2, '平移过程中窗口内密度不得跳变');
  assert.ok(secondPixels > PLOT_WIDTH / 2, `平移后的窗口内顶点须仍是满密度，实际 ${secondPixels}`);
  assert.deepEqual(secondFrame, u.data);
});

test('sparse windows bind only visible raw samples and neighbours in both states', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  const sparse = windowOf(10_000, 10_400);

  chart.setRangeDragging(true);
  const whileDragging = await dragFrame(u, sparse);
  chart.setRangeDragging(false);
  await commit(sparse);

  // 窗口窄于 1×宽度时不降采样；uPlot 只接收窗口及两侧裁剪邻点。
  assert.equal(whileDragging[0].length, 403);
  assert.equal(whileDragging[0][0], state.chartSeries.x.at(9_999));
  assert.equal(visible(whileDragging, sparse), 401);
  assert.deepEqual(whileDragging, u.data);
});

test('review detail tracks the actual canvas resolution and matches a short recording of the same window', async () => {
  const savedRatio = globalThis.devicePixelRatio;
  try {
    for (const ratio of [1, 1.5, 2]) {
      seed();
      const u = stubChart();
      u.bbox = { width: PLOT_WIDTH * ratio };
      u.ctx = { canvas: { width: PLOT_WIDTH * ratio } };
      state.mainChart = u;
      // Simulate a system DPI change before the existing canvas has resized.
      globalThis.devicePixelRatio = 3;
      const full = windowOf(0, SAMPLES - 1);
      await commit(full);
      assert.ok(u.data[0].length > PLOT_WIDTH * ratio, 'dense review retains at least screen-resolution extrema');
      const range = windowOf(10_000, 10_000 + Math.floor(PLOT_WIDTH * ratio) - 1);
      chart.setRangeDragging(true);
      const during = await dragFrame(u, range);
      chart.setRangeDragging(false);
      await commit(range);
      assert.deepEqual(u.data, during);
      assert.equal(during[0].length, Math.floor(PLOT_WIDTH * ratio) + 2, 'one sample per canvas pixel remains raw');
      for (let s = 0; s < during.length; s++) {
        const field = ['x', 'voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'][s];
        assert.deepEqual(
          during[s],
          Array.from(state.chartSeries[field].copyRange(9_999, 10_001 + Math.floor(PLOT_WIDTH * ratio))),
        );
        state.chartSeries[field].set(during[s]);
      }
      chart.syncChartSeries();
      await commit(range);
      assert.deepEqual(u.data, during, 'large history and an isolated short record render identical samples');
    }
  } finally {
    globalThis.devicePixelRatio = savedRatio;
  }
});

function appendSample({ voltage = 5, current = 2, power = 10 } = {}) {
  const cs = state.chartSeries;
  cs.x.push(cs.x.at(-1) + 0.02);
  for (const [field, value] of Object.entries({
    voltage,
    current,
    power,
    temp: 30,
    dp: 3.3,
    dn: 0.6,
    cc1: 0,
    cc2: 0,
  })) {
    cs[field].push(value);
  }
}

for (const [label, start, end] of [
  ['dense', 40_000, 90_000],
  ['sparse', 10_000, 10_400],
]) {
  test(`frozen ${label} windows skip unchanged main data but update the navigator`, async () => {
    seed({ powerPeak: true });
    const u = stubChart();
    const nav = stubChart();
    state.mainChart = u;
    state.navigatorChart = nav;
    const range = windowOf(start, end);
    state.chartWindow = { mode: 'frozen', min: range[0], max: range[1], duration: range[1] - range[0] };
    await commit(range);
    const before = u.data;
    const navCount = nav.submissions;
    appendSample();
    await dragFrame(u, range);
    assert.equal(u.submissions, 1, 'unrelated append must not resubmit the frozen main graph');
    assert.equal(u.scaleChanges, 0, 'unchanged X range must not be submitted either');
    assert.equal(u.data, before);
    assert.equal(nav.submissions, navCount + 1, 'the overview still receives the appended history');
    assert.ok(nav.data[0].length <= 600, 'the dense thumbnail stays within one vertex per CSS pixel');
    assert.equal(Math.max(...nav.data[1]), 100, 'thumbnail reduction retains a one-sample power peak');
    assert.equal(nav.data[0].at(-1), state.chartSeries.x.at(-1), 'the partial tail retains the latest sample');
    assert.equal(state.chartSeries.x.length, SAMPLES + 1, 'render suppression never discards the sample');

    appendSample({ voltage: 60 });
    await dragFrame(u, range);
    assert.equal(u.submissions, 2, 'a new global extreme must refresh Y scales even outside the window');
  });
}

test('a retained sparse binding refreshes before navigating into newly appended data', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  const range = windowOf(100, 200);
  state.chartWindow = { mode: 'frozen', min: range[0], max: range[1], duration: range[1] - range[0] };
  await commit(range);
  assert.equal(u.data[0][0], state.chartSeries.x.at(99));
  assert.equal(u.data[0].at(-1), state.chartSeries.x.at(201));
  appendSample();
  await dragFrame(u, range);
  assert.equal(u.submissions, 1);
  await dragFrame(u, windowOf(SAMPLES - 2, SAMPLES));
  assert.equal(u.submissions, 2);
  assert.equal(u.data[0].length, 4);
  assert.equal(u.data[0].at(-1), state.chartSeries.x.at(-1));
});

test('replacing columns with equal-length data invalidates a frozen projection', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  const range = windowOf(100, 200);
  state.chartWindow = { mode: 'frozen', min: range[0], max: range[1], duration: range[1] - range[0] };
  await commit(range);
  state.chartSeries.voltage.set(Float64Array.from({ length: SAMPLES }, () => 12));
  chart.syncChartSeries();
  await dragFrame(u, range);
  assert.equal(u.submissions, 2);
  assert.equal(u.data[1][100], 12);
});

test('a frozen sparse window refreshes when its first right neighbour arrives', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  const range = windowOf(SAMPLES - 20, SAMPLES - 1);
  range[1] += 0.01;
  state.chartWindow = { mode: 'frozen', min: range[0], max: range[1], duration: range[1] - range[0] };
  await commit(range);
  appendSample();
  await dragFrame(u, range);
  assert.equal(u.submissions, 2, 'the right neighbour changes the clipped line at the window boundary');
  assert.equal(u.data[0].length, 22);
});

test('follow windows still submit every newly extended projection', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  const range = windowOf(SAMPLES - 100, SAMPLES - 1);
  state.chartWindow = { mode: 'follow', min: range[0], max: range[1], duration: range[1] - range[0] };
  await commit(range);
  appendSample();
  await dragFrame(u, windowOf(SAMPLES - 99, SAMPLES));
  assert.equal(u.submissions, 2);
  assert.equal(u.data[0].length, 101);
  assert.equal(u.data[0][0], state.chartSeries.x.at(SAMPLES - 100));
  assert.equal(u.data[0].at(-1), state.chartSeries.x.at(SAMPLES));
});

test('continuous shrink and bidirectional pan paint warm windows without rebuilding the indexed prefix', async () => {
  for (const recording of [false, true]) {
    seed({ powerPeak: true });
    const u = stubChart();
    state.mainChart = u;
    await commit(windowOf(0, SAMPLES - 1));
    state.isRecording = recording;
    chart.setRangeDragging(true);
    const originalReset = ExactExtremaIndex.prototype.reset;
    const originalSync = ExactExtremaIndex.prototype.syncStep;
    const originalPerformance = globalThis.performance;
    let resets = 0;
    let extensions = 0;
    ExactExtremaIndex.prototype.reset = function () {
      resets++;
      return originalReset.call(this);
    };
    ExactExtremaIndex.prototype.syncStep = function (...args) {
      extensions++;
      return originalSync.apply(this, args);
    };
    // Cost/slicing has separate tests; make this a deterministic no-yield query test.
    globalThis.performance = { now: () => 1000 };
    const ranges = [
      [0, 180000],
      [0, 150000],
      [40000, 90000],
      [45000, 95000],
      [40000, 90000],
      [30000, 80000],
      [50001, 82768],
      [50001, 82769],
      [50001, 50100],
    ];
    try {
      for (const [start, end] of ranges) {
        const before = u.submissions;
        const range = windowOf(start, end);
        chart.setChartXWindow(...range);
        chart.scheduleChartUpdate('interaction');
        const frame = pendingFrame;
        pendingFrame = null;
        assert.ok(frame);
        frame(1000);
        assert.equal(preparing, false, 'a completed indexed query submits in the requesting frame');
        assert.equal(u.submissions, before + 1, 'moving inputs must not starve the curve');
        if (end - start + 1 > PLOT_WIDTH) {
          const expected = new SeriesBuckets();
          const cs = state.chartSeries;
          expected.rebuild(
            cs.x,
            [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2],
            start,
            end + 1,
            PLOT_WIDTH,
          );
          const flat = expected.flatten();
          assert.deepEqual(
            u.data,
            [flat.x, ...flat.ys].map((col) => Array.from(col)),
          );
        }
      }
      assert.equal(resets, 0, 'a viewport shrink cannot truncate the source index');
      assert.equal(extensions, 0, 'fully indexed viewports never rescan the prefix');
    } finally {
      globalThis.performance = originalPerformance;
      ExactExtremaIndex.prototype.reset = originalReset;
      ExactExtremaIndex.prototype.syncStep = originalSync;
      chart.setRangeDragging(false);
    }
    const lastFrame = u.data;
    await commit(windowOf(...ranges.at(-1)));
    assert.deepEqual(u.data, lastFrame, 'release retains the final window geometry');
  }
});

// ─── 结构守卫 ────────────────────────────────────────────────────────────────

const source = readFileSync(new URL('../src/chart.js', import.meta.url), 'utf8');
const bodyOf = (name) => {
  const slice = source.split(`function ${name}(`)[1]?.split('\nfunction ')[0];
  assert.ok(slice, `未找到 ${name}`);
  return slice;
};

test('no second bucket set hides behind the drag preview', async () => {
  assert.doesNotMatch(
    source,
    /overviewBuckets|usingDisplayBuckets|'overview'/,
    '预览态一旦有自己的桶，拖动中与松手后就必然画出两条不同密度的曲线',
  );
});

test('applyData does not branch on the interaction state when binding', async () => {
  const apply = bodyOf('applyData');
  assert.doesNotMatch(apply, /if \(preview/, 'preview 不得决定主图绑哪批条带');
  assert.equal(apply.match(/\bpreview\b/g)?.length, 2, 'preview 只应出现在声明与导航图 live 判断两处');
});

test('the extrema index is a speed selector with a single build entry', async () => {
  const chooser = bodyOf('extremaForStripes');
  assert.equal(chooser.match(/extremaIndex\.sync/g)?.length, 1, '冷建入口只能有一处，否则 warm 判据会被绕过');
  assert.match(chooser, /COLD_BUILD_PPB/, '冷建门槛须显式存在：为窄窗口建全量金字塔是净亏');
  assert.match(chooser, /BLOCK_SIZE/, '条带不超过一个块时 fold 省不下读取，须留在暴力扫路径');
});

test('full-history budget reductions merge the prefix and retain raw extrema without rebuilding', async () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  await commit(windowOf(0, SAMPLES - 1));
  const before = u.data[0].length;
  const original = SeriesBuckets.prototype.beginRebuild;
  let rebuilds = 0;
  SeriesBuckets.prototype.beginRebuild = function (...args) {
    rebuilds++;
    return original.apply(this, args);
  };
  try {
    u.bbox = { width: 600 };
    appendSample({ voltage: 60 });
    await commit(windowOf(0, SAMPLES));
    assert.equal(rebuilds, 0, 'full-history coarsening must not scan the retained prefix');
    assert.ok(u.data[0].length < before);
    assert.equal(Math.max(...u.data[1]), 60);
  } finally {
    SeriesBuckets.prototype.beginRebuild = original;
  }
  const expected = new SeriesBuckets();
  const cs = state.chartSeries;
  expected.rebuild(
    cs.x,
    [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2],
    0,
    SAMPLES + 1,
    600,
  );
  const flat = expected.flatten();
  assert.deepEqual(
    u.data,
    [flat.x, ...flat.ys].map((col) => Array.from(col)),
  );
});
