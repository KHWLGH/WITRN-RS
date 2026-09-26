import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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

function fakeElement() {
  return {
    clientWidth: PLOT_WIDTH,
    clientHeight: 300,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
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
    setData(data) {
      this.data = data.map((col) => Array.from(col));
    },
    setScale() {},
  };
}

/** 写入 SAMPLES 个点，x 为 20ms 间隔的相对秒。 */
function seed() {
  const cs = state.chartSeries;
  for (const col of [cs.x, cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2]) col.length = 0;
  for (let i = 0; i < SAMPLES; i++) {
    cs.x.push(i * 0.02);
    cs.voltage.push(5 + Math.sin(i / 97) * 0.4);
    cs.current.push(2 + Math.cos(i / 31) * 1.2);
    cs.power.push(10 + Math.sin(i / 7) * 3);
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
function commit(range) {
  chart.setChartXWindow(range[0], range[1]);
  chart.updateCharts();
}

/** 拖动手柄中的一帧：与 applyRangeValues(preview) 一致，排一帧 rAF、不强制。 */
function dragFrame(u, range) {
  chart.setChartXWindow(range[0], range[1]);
  chart.scheduleChartUpdate();
  assert.ok(pendingFrame, '拖动帧应排到一帧 rAF');
  const frame = pendingFrame;
  pendingFrame = null;
  frame(0);
  return u.data;
}

/** 绑定顶点里落在 X 窗内的那些 —— 也就是屏幕上真的会画出来的部分。 */
function visible(bound, range) {
  const col = bound[0];
  let n = 0;
  for (let i = 0; i < col.length; i++) if (col[i] >= range[0] && col[i] <= range[1]) n += 1;
  return n;
}

test('the frame drawn while dragging is the frame left on release', () => {
  seed();
  const u = stubChart();
  state.mainChart = u;

  const full = windowOf(0, SAMPLES - 1);
  commit(full);
  assert.ok(visible(u.data, full) > PLOT_WIDTH, '全量窗口应走窗口级条带');

  const target = windowOf(100_000, 102_000);
  chart.setRangeDragging(true);
  const whileDragging = dragFrame(u, target);
  const dragPixels = visible(whileDragging, target);
  chart.setRangeDragging(false);
  commit(target);

  // 旧实现这里只往窗口里画约 24 个顶点（按全量历史分条带），松手后才涨到 2000。
  assert.ok(dragPixels > PLOT_WIDTH, `拖动中落在窗口内的顶点须与松手后同量级，实际 ${dragPixels}`);
  assert.deepEqual(whileDragging, u.data);
});

test('panning keeps one stripe density from the first drag frame to the settled one', () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  commit(windowOf(0, SAMPLES - 1));

  const from = windowOf(40_000, 90_000);
  const to = windowOf(40_500, 90_500);
  chart.setRangeDragging(true);
  const firstFrame = dragFrame(u, from);
  const secondFrame = dragFrame(u, to);
  chart.setRangeDragging(false);
  commit(to);

  const firstPixels = visible(firstFrame, from);
  const secondPixels = visible(secondFrame, to);
  assert.ok(Math.abs(firstPixels - secondPixels) <= 2, '平移过程中窗口内密度不得跳变');
  assert.ok(secondPixels > PLOT_WIDTH, `平移后的窗口内顶点须仍是满密度，实际 ${secondPixels}`);
  assert.deepEqual(secondFrame, u.data);
});

test('sparse windows keep the zero-copy raw binding in both states', () => {
  seed();
  const u = stubChart();
  state.mainChart = u;
  const sparse = windowOf(10_000, 10_400);

  chart.setRangeDragging(true);
  const whileDragging = dragFrame(u, sparse);
  chart.setRangeDragging(false);
  commit(sparse);

  // 窗口窄于 1×宽度时不降采样：两帧都是全量列的零拷贝视图，X 窗只靠 setScale。
  assert.equal(whileDragging[0].length, SAMPLES);
  assert.equal(visible(whileDragging, sparse), 401);
  assert.deepEqual(whileDragging, u.data);
});

// ─── 结构守卫 ────────────────────────────────────────────────────────────────

const source = readFileSync(new URL('../src/chart.js', import.meta.url), 'utf8');
const bodyOf = (name) => {
  const slice = source.split(`function ${name}(`)[1]?.split('\nfunction ')[0];
  assert.ok(slice, `未找到 ${name}`);
  return slice;
};

test('no second bucket set hides behind the drag preview', () => {
  assert.doesNotMatch(
    source,
    /overviewBuckets|usingDisplayBuckets|'overview'/,
    '预览态一旦有自己的桶，拖动中与松手后就必然画出两条不同密度的曲线',
  );
});

test('applyData does not branch on the interaction state when binding', () => {
  const apply = bodyOf('applyData');
  assert.doesNotMatch(apply, /if \(preview/, 'preview 不得决定主图绑哪批条带');
  assert.equal(apply.match(/\bpreview\b/g)?.length, 2, 'preview 只应出现在声明与导航图 live 判断两处');
});

test('the extrema index is a speed selector with a single build entry', () => {
  const chooser = bodyOf('extremaForStripes');
  assert.equal(chooser.match(/extremaIndex\.sync/g)?.length, 1, '冷建入口只能有一处，否则 warm 判据会被绕过');
  assert.match(chooser, /COLD_BUILD_PPB/, '冷建门槛须显式存在：为窄窗口建全量金字塔是净亏');
  assert.match(chooser, /BLOCK_SIZE/, '条带不超过一个块时 fold 省不下读取，须留在暴力扫路径');
});
