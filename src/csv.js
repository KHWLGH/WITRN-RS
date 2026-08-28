// @ts-check
/**
 * @file CSV 导入 / 导出。
 */

import { syncChartSeries, updateCharts } from './chart.js';
import {
  clearAndResetStats,
  refreshRecordButton,
  stopRecording,
  updateChartEmptyState,
  updateChartRange,
  updateEnergyDisplay,
  updateRealtimeDisplay,
  updateStats,
  updateStatsDisplay,
} from './data.js';
import { calculateEnergyInRange, mapCsvColumns, parseRelativeTime } from './measurement.js';
import { emptyChartColumns, setChartColumns, state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';
import { ask } from './ui/dialog.js';
import { toast } from './ui/toast.js';

// 文件选择器保留原生实现：Tauri v2 通过对话框选择在运行时授予所选路径的 fs scope，
// 换成应用内实现会直接破坏 writeTextFile / readTextFile 的权限。
const { save, open } = window.__TAURI__.dialog;
const { writeTextFile, readTextFile } = window.__TAURI__.fs;

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * 导出数据为 CSV 文件。
 * @param {boolean} [withTemp=false] - 是否包含温度列
 */
export async function exportCSV(withTemp = false) {
  const cols = state.chartSeries;
  const n = cols.x.length;
  if (n === 0) {
    toast.warning('没有数据可导出');
    return;
  }
  const x = cols.x.buf;
  const voltage = cols.voltage.buf;
  const current = cols.current.buf;
  const power = cols.power.buf;
  const temp = cols.temp.buf;
  const dp = cols.dp.buf;
  const dn = cols.dn.buf;
  const cc1 = cols.cc1.buf;
  const cc2 = cols.cc2.buf;

  /**
   * 格式化时间为 ="HH:mm:ss.ms"（Excel 友好格式）。
   * @param {number} seconds
   * @returns {string}
   */
  const formatExcelTime = (seconds) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const day = Math.floor(safe / 86400);
    const rem = safe - day * 86400;
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    const s = Math.floor(rem % 60);
    const ms = Math.floor((rem % 1) * 1000);
    const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    return day > 0 ? `="${day}.${hms}"` : `="${hms}"`;
  };

  const sampTime = state.settings.sampleRate;
  const startTime = state.lastRecordingStartTime || cols.timestamps.at(0) || Date.now();

  const d = new Date(startTime);
  /** @param {number} n @returns {string} */
  const pad = (n) => String(n).padStart(2, '0');
  const dateTimeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const totalTimeStr = formatExcelTime(x[n - 1] || 0);

  /** 信号线电压列：设备分辨率 0.01 V，缺失（旧数据导入）时留空。 @param {number} v */
  const sig = (v) => (Number.isFinite(v) ? v.toFixed(2) : '');

  /** @type {string[]} */
  const lines = [
    `SUM,${n}`,
    `TotalTime,${totalTimeStr}`,
    `SampTime(ms),${sampTime}`,
    `DateTime,${dateTimeStr}`,
    '',
    withTemp
      ? 'Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),D+(V),D-(V),CC1(V),CC2(V),'
      : 'Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),D+(V),D-(V),CC1(V),CC2(V),',
  ];
  lines.length = 6 + n;
  for (let i = 0; i < n; i++) {
    const timeStr = formatExcelTime(x[i] || 0);
    const v = Number(voltage[i]).toFixed(4);
    const c = Number(current[i]).toFixed(4);
    const p = Number(power[i]).toFixed(4);
    const signals = `${sig(dp[i])},${sig(dn[i])},${sig(cc1[i])},${sig(cc2[i])}`;
    lines[6 + i] = withTemp
      ? `${timeStr},${v},${c},${p},${Number.isFinite(temp[i]) ? temp[i].toFixed(1) : ''},${signals},`
      : `${timeStr},${v},${c},${p},${signals},`;
  }
  const csv = lines.join('\n');

  try {
    const path = await save({
      filters: [{ name: 'CSV File', extensions: ['csv'] }],
      defaultPath: `witrn_data_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
    });

    if (path) {
      await writeTextFile(path, csv);
      toast.success('导出成功');
    }
  } catch (e) {
    console.error(e);
    toast.error(`导出失败: ${e}`);
  }
}

// ─── Import ──────────────────────────────────────────────────────────────────

/** 从 CSV 文件导入数据。 */
export async function importCSV() {
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'CSV File', extensions: ['csv'] }],
    });

    if (!selected) return;

    const content = await readTextFile(/** @type {string} */ (selected));
    const lines = content.split('\n');

    let dataStartIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('Time(D.hh:mm:ss.ms)')) {
        dataStartIndex = i + 1;
        break;
      }
    }

    if (dataStartIndex === -1) {
      throw new Error('Invalid CSV format: Header not found');
    }

    /** @type {number[]} */ let newSeconds = [];
    /** @type {number[]} */ let newTimestamps = [];
    /** @type {number[]} */ let newVoltage = [];
    /** @type {number[]} */ let newCurrent = [];
    /** @type {number[]} */ let newPower = [];
    /** @type {number[]} */ let newTemp = [];
    /** @type {number[]} */ let newDp = [];
    /** @type {number[]} */ let newDn = [];
    /** @type {number[]} */ let newCc1 = [];
    /** @type {number[]} */ let newCc2 = [];

    let newStartTime = Date.now();

    const headerLine = lines[dataStartIndex - 1] || '';
    // 旧格式（官方 / 本应用早期导出）没有温度或信号线列，按表头名定位，缺失列记 NaN
    const colMap = mapCsvColumns(headerLine);

    const dateTimeLine = lines.find((/** @type {string} */ l) => l.startsWith('DateTime,'));
    if (dateTimeLine) {
      const dtStr = dateTimeLine.split(',')[1];
      const dt = new Date(dtStr);
      const parsedTime = dt.getTime();
      if (!Number.isNaN(parsedTime)) newStartTime = parsedTime;
    }

    // 时间列格式 "D.hh:mm:ss.ms"（官方软件带天数前缀）或 "hh:mm:ss.ms"（本应用导出）。
    // 注意不能用 split(':') + parseInt 解析首段——"0.01" 会被 parseInt 截成 0，丢失小时字段，
    // 导致 x 非单调（uPlot 依赖有序 x 做二分切片，乱序会造成空白 / 无法显示）。
    /**
     * 读取按表头定位的可选列（行尾逗号会产生尾部空元素，需双向越界检查）。
     * @param {string[]} parts @param {number} idx
     */
    const optCol = (parts, idx) => {
      if (idx < 0 || idx >= parts.length) return Number.NaN;
      const parsed = parseFloat(parts[idx]);
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    };

    for (let i = dataStartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      if (parts.length < 4) continue;

      const timeStr = parts[0].replace(/[="]/g, '').trim();
      const voltage = parseFloat(parts[1]);
      const currentRaw = parseFloat(parts[2]);
      // 与实时摄入同一规则：方向开启保留符号，关闭取绝对值
      const current = state.settings.signedCurrent ? currentRaw : Math.abs(currentRaw);
      const power = Math.abs(parseFloat(parts[3]));
      const temp = optCol(parts, colMap.tempIdx);

      if (Number.isNaN(voltage) || Number.isNaN(current) || Number.isNaN(power)) continue;

      const seconds = parseRelativeTime(timeStr);
      if (seconds === null) continue;

      newSeconds.push(seconds);
      newTimestamps.push(newStartTime + seconds * 1000);
      newVoltage.push(voltage);
      newCurrent.push(current);
      newPower.push(power);
      newTemp.push(temp);
      newDp.push(optCol(parts, colMap.dpIdx));
      newDn.push(optCol(parts, colMap.dnIdx));
      newCc1.push(optCol(parts, colMap.cc1Idx));
      newCc2.push(optCol(parts, colMap.cc2Idx));
    }

    if (newTimestamps.length === 0) {
      throw new Error('No valid data found in CSV');
    }

    if (state.isRecording || state.chartSeries.timestamps.length > 0) {
      const message = state.isRecording
        ? '当前正在录制，导入 CSV 将停止录制并清除现有记录。\n确定要继续吗？'
        : '当前已有数据，导入 CSV 将清除现有记录。\n确定要继续吗？';
      const confirmed = await ask(message, {
        title: '确认导入',
        kind: 'warning',
      });
      if (!confirmed) return;
    }

    // uPlot 要求 x 非降序（二分查找 / 视窗切片依赖有序数据）；文件行乱序时按时间重排
    let isSorted = true;
    for (let i = 1; i < newSeconds.length; i++) {
      if (newSeconds[i] < newSeconds[i - 1]) {
        isSorted = false;
        break;
      }
    }
    if (!isSorted) {
      const order = newSeconds.map((_, i) => i).sort((a, b) => newSeconds[a] - newSeconds[b]);
      /** @param {number[]} arr @returns {number[]} */
      const reorder = (arr) => order.map((i) => arr[i]);
      newSeconds = reorder(newSeconds);
      newTimestamps = reorder(newTimestamps);
      newVoltage = reorder(newVoltage);
      newCurrent = reorder(newCurrent);
      newPower = reorder(newPower);
      newTemp = reorder(newTemp);
      newDp = reorder(newDp);
      newDn = reorder(newDn);
      newCc1 = reorder(newCc1);
      newCc2 = reorder(newCc2);
    }

    // Commit changes
    if (state.isRecording) stopRecording();
    clearAndResetStats();

    // 文件里的相对时间已经是 x；继续记录用用户当前采样率，不改设置、不下发 HID。
    state.lastRecordingStartTime = newStartTime;

    const cols = emptyChartColumns(newSeconds.length);
    cols.x.set(newSeconds);
    cols.timestamps.set(newTimestamps);
    cols.voltage.set(newVoltage);
    cols.current.set(newCurrent);
    cols.power.set(newPower);
    cols.temp.set(newTemp);
    cols.dp.set(newDp);
    cols.dn.set(newDn);
    cols.cc1.set(newCc1);
    cols.cc2.set(newCc2);
    setChartColumns(cols);

    // Re-calculate stats
    for (let i = 0; i < newVoltage.length; i++) {
      updateStats('voltage', newVoltage[i]);
      updateStats('current', newCurrent[i]);
      updateStats('power', newPower[i]);
      if (Number.isFinite(newTemp[i])) {
        updateStats('temp', newTemp[i]);
      }
    }

    // Calculate energy
    const importedEnergy = calculateEnergyInRange(newSeconds, newCurrent, newPower, 0, newSeconds.length - 1);
    state.energy.wh = importedEnergy.wh;
    state.energy.mah = importedEnergy.mah;
    state.energy.lastX = null;

    const importedHasTemp = newTemp.some((t) => Number.isFinite(t));
    if (importedHasTemp) {
      state.hasTempData = true;
    }

    // Update UI
    updateStatsDisplay();
    updateEnergyDisplay();
    const dataCountEl = document.getElementById('data-count');
    if (dataCountEl) dataCountEl.textContent = String(state.chartSeries.timestamps.length);

    // 序列数组已整体替换，重新绑定数据集并刷新（导航图范围由 uPlot range 函数自动计算）
    syncChartSeries();
    updateChartRange();
    updateCharts();
    updateChartEmptyState();

    updateTempUIVisibility();
    const last = newVoltage.length - 1;
    updateRealtimeDisplay({
      voltage: newVoltage[last],
      current: newCurrent[last],
      power: newPower[last],
      temp: newTemp[last],
      dp: newDp[last],
      dn: newDn[last],
      cc1: newCc1[last],
      cc2: newCc2[last],
    });
    // 导入后已有数据，记录按钮从「开始记录」变为「继续记录」
    refreshRecordButton();

    toast.success(`成功导入 ${newTimestamps.length} 条数据`);
  } catch (e) {
    console.error(e);
    toast.error(`导入失败: ${/** @type {Error} */ (e).message}`);
  }
}
