import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 结构守卫，不是行为测试。app.js 在模块顶层就引用 window，chart.js 的 flushResizes /
 * observeResize 又是模块私有，桩出整套 uPlot + ResizeObserver 的成本远超被测的那几行顺序。
 * 这里只钉住 __layoutResizing 的释放契约：它是图表定尺的唯一闸门，顺序写反就会永久不再定尺。
 */

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** initMonitorSplitter 函数体。体内只有箭头函数，下一个顶层 function 就是 setupShell。 */
function splitterBody() {
  const body = read('../src/app.js').split('function initMonitorSplitter()')[1]?.split('\nfunction ')[0];
  assert.ok(body, '未找到 initMonitorSplitter');
  return body;
}

test('splitter releases __layoutResizing before committing the width', () => {
  const body = splitterBody();
  // 允许中间夹行注释，但不允许夹任何会抛的语句。
  assert.match(
    body,
    /if \(!state\.__layoutResizing\) return;\s*(?:\/\/[^\n]*\n\s*)*state\.__layoutResizing = false;/,
    '标志须紧随守卫清掉；排在 applyRealtimePanelWidth 之后就给图表永久卡死留了口子',
  );
  assert.equal(body.match(/state\.__layoutResizing = false/g)?.length, 1, '清除点只能有一个，否则释放路径不再幂等');
});

test('splitter binds every pointer-release path that can drop capture', () => {
  const body = splitterBody();
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.match(
      body,
      new RegExp(`addEventListener\\('${type}',\\s*endDrag\\)`),
      `${type} 未绑定 endDrag：捕获被其他手柄抢走时浏览器只发 lostpointercapture`,
    );
  }
});

/** initSplitter 函数体（PD 页的读数分栏）。 */
function pdSplitterBody() {
  const body = read('../src/views/pd.js').split('function initSplitter()')[1]?.split('\nfunction ')[0];
  assert.ok(body, '未找到 initSplitter');
  return body;
}

test('PD splitter releases its pointer the same way, and only while it holds capture', () => {
  const body = pdSplitterBody();
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.match(
      body,
      new RegExp(`addEventListener\\('${type}',\\s*endDrag\\)`),
      `${type} 未绑定 endDrag：漏掉它 pointer 永不归零，之后裸移动鼠标会继续改写分栏`,
    );
  }
  assert.match(body, /pointermove[\s\S]{0,160}hasPointerCapture\(e\.pointerId\)/, 'pointermove 须以捕获仍在手上为前提');
});
