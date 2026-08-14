// @ts-check
/**
 * @file 主题桥 — 把 CSS 设计令牌暴露给 canvas 侧（uPlot 无法读 CSS 变量）。
 *
 * 通道色 / 图表基建色的唯一定义处是 styles/tokens.css；本模块启动时读入
 * `chartTheme`，chart.js 全部从这里取色，保证图例点 = 复选框色块 = 曲线同源。
 *
 * 换主题（未来亮色）：切换 <html data-theme> 后 MutationObserver 触发
 * refreshTheme() 并回调注册方（chart.js 的 applyChartTheme）。
 */

/** @typedef {typeof chartTheme} ChartTheme */

/** 令牌名 → chartTheme 字段的映射。 */
const TOKEN_MAP = /** @type {const} */ ({
  voltage: '--ch-voltage',
  current: '--ch-current',
  power: '--ch-power',
  temp: '--ch-temp',
  dp: '--ch-dp',
  dn: '--ch-dn',
  cc1: '--ch-cc1',
  cc2: '--ch-cc2',
  tempAxis: '--ch-temp-axis',
  energy: '--ch-energy',
  axisText: '--chart-axis-text',
  grid: '--chart-grid',
  gridVoltage: '--chart-grid-voltage',
  gridMinorX: '--chart-grid-minor-x',
  gridMinorY: '--chart-grid-minor-y',
});

/** 令牌缺失时的兜底值（与 tokens.css 暗色值一致，防止 CSS 加载异常时图表全黑）。 */
const FALLBACK = {
  voltage: '#4a9eff',
  current: '#4dd0a0',
  power: '#ffaa4a',
  temp: '#ff5f5f',
  dp: '#e8c84a',
  dn: '#b98ef5',
  cc1: '#4adade',
  cc2: '#f28ab8',
  tempAxis: '#ff6f6f',
  energy: '#c586c0',
  axisText: '#9a9ab8',
  grid: 'rgba(90, 90, 140, 0.75)',
  gridVoltage: 'rgba(74, 158, 255, 0.22)',
  gridMinorX: 'rgba(80, 80, 130, 0.5)',
  gridMinorY: 'rgba(120, 130, 160, 0.25)',
};

/** 图表用到的全部主题色。模块加载时填充，refreshTheme() 原地更新（引用稳定）。 */
export const chartTheme = { ...FALLBACK };

/** 从当前 CSS 令牌重新读入 chartTheme（原地更新，持有引用者无需重新获取）。 */
export function refreshTheme() {
  // node --test 环境无 DOM（测试只 mock 了 getElementById），保持 FALLBACK 值即可
  if (typeof getComputedStyle !== 'function' || !document.documentElement) return;
  const style = getComputedStyle(document.documentElement);
  for (const key of /** @type {(keyof typeof TOKEN_MAP)[]} */ (Object.keys(TOKEN_MAP))) {
    const value = style.getPropertyValue(TOKEN_MAP[key]).trim();
    chartTheme[key] = value !== '' ? value : FALLBACK[key];
  }
}

/**
 * 注册主题变化回调（监听 <html data-theme> 属性）。回调前已完成 refreshTheme()。
 * @param {() => void} callback
 */
export function onThemeChange(callback) {
  const observer = new MutationObserver(() => {
    refreshTheme();
    callback();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

refreshTheme();
