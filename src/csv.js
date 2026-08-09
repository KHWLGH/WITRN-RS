// @ts-check
/**
 * @file CSV 导入 / 导出。
 */

import { syncChartSeries, updateCharts } from './chart.js';
import {
  clearAndResetStats,
  stopRecording,
  updateChartRange,
  updateEnergyDisplay,
  updateStats,
  updateStatsDisplay,
} from './data.js';
import { buildExportRows, calculateEnergy, parseRelativeTime } from './measurement.js';
import { state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';

const { save, open } = window.__TAURI__.dialog;
const { writeTextFile, readTextFile } = window.__TAURI__.fs;

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * 导出数据为 CSV 文件。
 * @param {boolean} [withTemp=false] - 是否包含温度列
 */
export async function exportCSV(withTemp = false) {
  const data = buildExportRows(state.chartData, state.chartSeries);

  if (data.length === 0) {
    alert('没有数据可导出');
    return;
  }

  /**
   * 格式化时间为 ="HH:mm:ss.ms"（Excel 友好格式）。
   * @param {number} seconds
   * @returns {string}
   */
  const formatExcelTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `="${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}"`;
  };

  // Metadata
  const sum = data.length;
  const sampTime = state.settings.sampleRate;
  const startTime = state.lastRecordingStartTime || state.chartData.timestamps[0] || Date.now();

  const d = new Date(startTime);
  /** @param {number} n @returns {string} */
  const pad = (n) => String(n).padStart(2, '0');
  const dateTimeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const lastSec = data[data.length - 1].relSeconds || 0;
  const totalTimeStr = formatExcelTime(lastSec);

  let csv = `SUM,${sum}\n`;
  csv += `TotalTime,${totalTimeStr}\n`;
  csv += `SampTime(ms),${sampTime}\n`;
  csv += `DateTime,${dateTimeStr}\n\n`;

  if (withTemp) {
    csv += 'Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),\n';
  } else {
    csv += 'Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n';
  }

  data.forEach((row) => {
    const timeStr = formatExcelTime(row.relSeconds || 0);
    const v = Number(row.voltage).toFixed(4);
    const c = Number(row.current).toFixed(4);
    const p = Number(row.power).toFixed(4);
    if (withTemp) {
      const t = Number.isFinite(row.temp) ? row.temp.toFixed(1) : '';
      csv += `${timeStr},${v},${c},${p},${t},\n`;
    } else {
      csv += `${timeStr},${v},${c},${p},\n`;
    }
  });

  try {
    const path = await save({
      filters: [{ name: 'CSV File', extensions: ['csv'] }],
      defaultPath: `witrn_data_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
    });

    if (path) {
      await writeTextFile(path, csv);
      alert('导出成功');
    }
  } catch (e) {
    console.error(e);
    alert('导出失败: ' + e);
  }
}

// ─── Import ──────────────────────────────────────────────────────────────────

const { ask } = window.__TAURI__.dialog;

/** 从 CSV 文件导入数据。 */
export async function importCSV() {
  try {
    if (state.isRecording || state.chartData.timestamps.length > 0) {
      const message = state.isRecording
        ? '当前正在录制，导入 CSV 将停止录制并清除现有记录。\n确定要继续吗？'
        : '当前已有数据，导入 CSV 将清除现有记录。\n确定要继续吗？';
      const confirmed = await ask(message, {
        title: '确认导入',
        kind: 'warning',
      });
      if (!confirmed) return;
      if (state.isRecording) stopRecording();
    }

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

    let newSampleRate = state.settings.sampleRate;
    let newStartTime = Date.now();

    const headerLine = lines[dataStartIndex - 1] || '';
    const hasTemp = headerLine.includes('Temp');

    const sampTimeLine = lines.find((/** @type {string} */ l) => l.startsWith('SampTime(ms),'));
    if (sampTimeLine) {
      const rate = Number.parseInt(sampTimeLine.split(',')[1], 10);
      if (Number.isFinite(rate)) {
        // Imported metadata is untrusted; keep it within the same range as the Rust command/settings.
        newSampleRate = Math.min(60_000, Math.max(10, rate));
      }
    }

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
    for (let i = dataStartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      if (parts.length < 4) continue;

      const timeStr = parts[0].replace(/[="]/g, '').trim();
      const voltage = parseFloat(parts[1]);
      const current = Math.abs(parseFloat(parts[2]));
      const power = parseFloat(parts[3]);
      const parsedTemp = hasTemp && parts.length > 4 ? parseFloat(parts[4]) : Number.NaN;
      const temp = Number.isFinite(parsedTemp) ? parsedTemp : Number.NaN;

      if (Number.isNaN(voltage) || Number.isNaN(current) || Number.isNaN(power)) continue;

      const seconds = parseRelativeTime(timeStr);
      if (seconds === null) continue;

      newSeconds.push(seconds);
      newTimestamps.push(newStartTime + seconds * 1000);
      newVoltage.push(voltage);
      newCurrent.push(current);
      newPower.push(power);
      newTemp.push(temp);
    }

    if (newTimestamps.length === 0) {
      throw new Error('No valid data found in CSV');
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
    }

    // Commit changes
    clearAndResetStats();

    state.settings.sampleRate = newSampleRate;
    const rateEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('sample-rate'));
    if (rateEl) rateEl.value = String(newSampleRate);
    state.lastRecordingStartTime = newStartTime;

    state.chartData.timestamps = newTimestamps;
    state.chartData.voltage = newVoltage;
    state.chartData.current = newCurrent;
    state.chartData.power = newPower;
    state.chartData.temp = newTemp;
    // 导出始终从 chartData/chartSeries 这一份数据源按需派生。

    // uPlot 列式序列 — 数值数组需复制，避免与 chartData 共享引用导致后续双重追加
    state.chartSeries = {
      x: newSeconds,
      voltage: newVoltage.slice(),
      current: newCurrent.slice(),
      power: newPower.slice(),
      temp: newTemp.slice(),
    };

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
    const importedEnergy = calculateEnergy(newTimestamps, newCurrent, newPower);
    state.energy.wh = importedEnergy.wh;
    state.energy.mah = importedEnergy.mah;
    state.energy.lastTimestamp = null;

    const importedHasTemp = newTemp.some((t) => Number.isFinite(t));
    if (importedHasTemp) {
      state.hasTempData = true;
    }

    // Update UI
    updateStatsDisplay();
    updateEnergyDisplay();
    const dataCountEl = document.getElementById('data-count');
    if (dataCountEl) dataCountEl.textContent = String(state.chartData.timestamps.length);

    // 序列数组已整体替换，重新绑定数据集并刷新（导航图范围由 uPlot range 函数自动计算）
    syncChartSeries();
    updateChartRange();
    updateCharts();

    updateTempUIVisibility();

    alert(`成功导入 ${newTimestamps.length} 条数据`);
  } catch (e) {
    console.error(e);
    alert('导入失败: ' + /** @type {Error} */ (e).message);
  }
}
