// @ts-check
/**
 * @file 视图注册表 — 多 Tab 工作区的切换核心。
 *
 * 所有视图的 DOM 常驻 index.html（`<section class="view" id="view-{id}">`），
 * 用 hidden 属性切换；监控视图始终挂载，uPlot 实例跨切换存活。
 * `init()` 在视图首次显示时执行一次（懒加载监听器/动态内容）；
 * `onShow`/`onHide` 每次切换都触发（监控用它做图表尺寸补偿）。
 * 活动视图持久化到 settings.activeView，启动时恢复。
 */

import { debouncedSaveSettings } from './settings.js';
import { state } from './state.js';

/** @typedef {{ id: string, icon: string, label: string, init?: () => void, onShow?: () => void, onHide?: () => void }} ViewSpec */

/** @type {Map<string, ViewSpec>} */
const views = new Map();
/** @type {Set<string>} */
const inited = new Set();
/** @type {((id: string) => void)|null} */
let selectionCallback = null;
let activeId = 'monitor';

/** @param {ViewSpec} spec */
export function registerView(spec) {
  views.set(spec.id, spec);
}

/** @returns {ViewSpec[]} */
export function getViews() {
  return [...views.values()];
}

/** @returns {string} */
export function getActiveView() {
  return activeId;
}

/**
 * 注册选中态回调（Tab 条 / 设置齿轮据此刷新高亮）。
 * @param {(id: string) => void} callback
 */
export function onSelectionChange(callback) {
  selectionCallback = callback;
}

/**
 * 切换到指定视图。
 * @param {string} id
 */
export function showView(id) {
  if (!views.has(id)) return;
  if (id === activeId) {
    selectionCallback?.(id);
    return;
  }

  const prev = views.get(activeId);
  const next = /** @type {ViewSpec} */ (views.get(id));

  document.getElementById(`view-${activeId}`)?.setAttribute('hidden', '');
  prev?.onHide?.();

  // 先写下活动视图，onShow（监控尺寸补偿 / 图表补绘）才能读到新 id。
  activeId = id;
  state.settings.activeView = id;

  document.getElementById(`view-${id}`)?.removeAttribute('hidden');
  if (!inited.has(id)) {
    next.init?.();
    inited.add(id);
  }
  next.onShow?.();

  selectionCallback?.(id);
  debouncedSaveSettings();
}

/**
 * 启动时恢复上次的活动视图（不存在则留在监控）。
 * @param {string} id
 */
export function restoreView(id) {
  // 监控是默认可见视图；标记为已初始化（图表等由启动序列直接建好）
  inited.add('monitor');
  selectionCallback?.(activeId);
  if (id !== activeId && views.has(id)) showView(id);
}
