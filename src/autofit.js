// @ts-check
/**
 * @file 自动适应等比缩放 — 窗口不足基准宽度时整体缩小 UI，替代响应式裁剪。
 *
 * 布局全部为固定 px（设计基准 1280×800），窗口 / DPI 缩放导致可用宽度低于基准时，
 * 旧行为是命令栏横向滚动、状态栏静默截断——功能"看不见"。这里改用 webview 整体
 * 缩放（Tauri set_zoom）：坐标系统一，fixed 弹层 / 菜单 / 拖拽区 / decorum 标题栏
 * 全部一起缩放，无需逐组件适配。
 *
 * 缩放值 = min(1, 逻辑宽度 / 1280)，只缩小不放大。逻辑宽度用不变量
 * `innerWidth × 当前缩放` 还原（CSS 像素被 setZoom 等比压缩，乘回即得物理侧宽度，
 * 与缩放无关），因此不需要任何窗口查询权限——仅需 capability
 * `core:webview:allow-set-webview-zoom`。
 *
 * uPlot 光栅：vendor 包内置 dppx matchMedia 监听会在 devicePixelRatio 变化时
 * 自更新 uPlot.pxRatio；这里再补一次 handleMonitorShown 对齐宿主尺寸。
 */

import { handleMonitorShown } from './chart.js';

/** 设计基准宽度（与 tauri.conf.json 默认窗口宽度一致）。 */
const BASE_WIDTH = 1280;

let currentZoom = 1;

/** 初始化自动适应缩放；webview API 不可用（测试 / 旧运行时）时静默退化为无操作。 */
export function initAutoFit() {
  const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
  if (!webview?.setZoom) return;

  const apply = async () => {
    const logicalWidth = window.innerWidth * currentZoom;
    let next = Math.min(1, logicalWidth / BASE_WIDTH);
    // 量化到 0.02 步进 + 接近满幅时吸附 1.0：避免拖动窗口时高频微调造成的抖动与模糊
    next = Math.round(next * 50) / 50;
    if (next >= 0.97) next = 1;
    if (Math.abs(next - currentZoom) < 0.01) return;

    currentZoom = next;
    try {
      await webview.setZoom(next);
    } catch (e) {
      console.warn('自动适应缩放失败:', e);
      return;
    }
    requestAnimationFrame(handleMonitorShown);
  };

  // setZoom 本身会改变 innerWidth 并触发 resize，但逻辑宽度是定点，
  // 上面的 <0.01 守卫使重入立即收敛，不会振荡。
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  window.addEventListener('resize', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, 120);
  });

  void apply();
}
