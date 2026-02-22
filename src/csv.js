// @ts-check
/**
 * @file CSV 导入 / 导出。
 */

import { state, DOWNSAMPLE_CONFIG } from './state.js';
import { formatRelativeHMS } from './utils.js';
import { rebuildRenderSeries, rebuildNavigatorSeries } from './chart.js';
import { updateStats, updateStatsDisplay, updateEnergyDisplay, updateChartRange, clearAndResetStats } from './data.js';
import { updateTempUIVisibility } from './temperature.js';

const { save, open } = window.__TAURI__.dialog;
const { writeTextFile, readTextFile } = window.__TAURI__.fs;

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * 导出数据为 CSV 文件。
 * @param {boolean} [withTemp=false] - 是否包含温度列
 */
export async function exportCSV(withTemp = false) {
  const data = state.recordedData.length > 0
    ? state.recordedData
    : state.chartData.timestamps.map((ts, i) => {
        const baseline = state.chartData.timestamps[0] || ts || 0;
        const relSec = baseline ? ((ts - baseline) / 1000) : 0;
        const rel = formatRelativeHMS(relSec);
        return {
          timestamp: rel,
          voltage: state.chartData.voltage[i],
          current: state.chartData.current[i],
          power: state.chartData.power[i],
          temp: state.chartData.temp[i] || 0,
          relSeconds: relSec,
        };
      });

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
  const startTime = (state.recordedData.length > 0 && state.lastRecordingStartTime)
    ? state.lastRecordingStartTime
    : (state.chartData.timestamps[0] || Date.now());

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
      const t = Number(row.temp || 0).toFixed(1);
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
    if (state.chartData.timestamps.length > 0) {
      const confirmed = await ask('当前已有数据，导入CSV将清除现有记录。\n确定要继续吗？', {
        title: '确认导入',
        type: 'warning',
      });
      if (!confirmed) return;
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

    /** @type {number[]} */ const newSeconds = [];
    /** @type {number[]} */ const newTimestamps = [];
    /** @type {number[]} */ const newVoltage = [];
    /** @type {number[]} */ const newCurrent = [];
    /** @type {number[]} */ const newPower = [];
    /** @type {number[]} */ const newTemp = [];
    /** @type {import('./state.js').RecordedRow[]} */ const newRecordedData = [];

    let newSampleRate = state.settings.sampleRate;
    let newStartTime = Date.now();

    const headerLine = lines[dataStartIndex - 1] || '';
    const hasTemp = headerLine.includes('Temp');

    const sampTimeLine = lines.find((/** @type {string} */ l) => l.startsWith('SampTime(ms),'));
    if (sampTimeLine) {
      const rate = parseInt(sampTimeLine.split(',')[1]);
      if (!isNaN(rate)) newSampleRate = rate;
    }

    const dateTimeLine = lines.find((/** @type {string} */ l) => l.startsWith('DateTime,'));
    if (dateTimeLine) {
      const dtStr = dateTimeLine.split(',')[1];
      const dt = new Date(dtStr);
      if (!isNaN(dt.getTime())) newStartTime = dt.getTime();
    }

    for (let i = dataStartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      if (parts.length < 4) continue;

      const timeStr = parts[0].replace(/="/g, '').replace(/"/g, '');
      const voltage = parseFloat(parts[1]);
      const current = Math.abs(parseFloat(parts[2]));
      const power = parseFloat(parts[3]);
      const temp = hasTemp && parts.length > 4 ? parseFloat(parts[4]) || 0 : 0;

      if (isNaN(voltage) || isNaN(current) || isNaN(power)) continue;

      const timeParts = timeStr.split(':');
      let seconds = 0;
      if (timeParts.length === 3) {
        seconds += parseInt(timeParts[0]) * 3600;
        seconds += parseInt(timeParts[1]) * 60;
        seconds += parseFloat(timeParts[2]);
      }

      const timestamp = newStartTime + (seconds * 1000);

      newSeconds.push(seconds);
      newTimestamps.push(timestamp);
      newVoltage.push(voltage);
      newCurrent.push(current);
      newPower.push(power);
      newTemp.push(temp);

      newRecordedData.push({
        timestamp: formatRelativeHMS(seconds),
        voltage,
        current,
        power,
        temp,
        relSeconds: seconds,
      });
    }

    if (newTimestamps.length === 0) {
      throw new Error('No valid data found in CSV');
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
    state.recordedData = newRecordedData;

    state.chartSeries.voltage = newVoltage.map((v, i) => ({ x: newSeconds[i], y: v }));
    state.chartSeries.current = newCurrent.map((v, i) => ({ x: newSeconds[i], y: v }));
    state.chartSeries.power = newPower.map((v, i) => ({ x: newSeconds[i], y: v }));
    state.chartSeries.temp = newTemp.map((v, i) => ({ x: newSeconds[i], y: v }));

    // Re-calculate stats
    for (let i = 0; i < newVoltage.length; i++) {
      updateStats('voltage', newVoltage[i]);
      updateStats('current', newCurrent[i]);
      updateStats('power', newPower[i]);
      if (newTemp[i] !== 0) {
        updateStats('temp', newTemp[i]);
      }
    }

    // Calculate energy
    state.energy.wh = 0;
    state.energy.mah = 0;
    state.energy.lastTimestamp = null;

    for (let i = 1; i < newTimestamps.length; i++) {
      const dt = (newTimestamps[i] - newTimestamps[i - 1]) / 3600000;
      const currentAbs = Math.abs(newCurrent[i]);
      const powerAbs = Math.abs(newPower[i]);
      state.energy.wh += powerAbs * dt;
      state.energy.mah += currentAbs * 1000 * dt;
    }

    const importedHasTemp = newTemp.some((t) => t !== 0);
    if (importedHasTemp) {
      state.hasTempData = true;
    }

    // Update UI
    updateStatsDisplay();
    updateEnergyDisplay();
    const dataCountEl = document.getElementById('data-count');
    if (dataCountEl) dataCountEl.textContent = String(state.chartData.timestamps.length);

    // Rebuild downsampled data
    DOWNSAMPLE_CONFIG.lastRebuildCount = 0;
    DOWNSAMPLE_CONFIG.navLastRebuildCount = 0;
    rebuildRenderSeries();
    rebuildNavigatorSeries();

    if (state.mainChart) {
      state.mainChart.data.datasets[0].data = state.renderSeries.voltage;
      state.mainChart.data.datasets[1].data = state.renderSeries.current;
      state.mainChart.data.datasets[2].data = state.renderSeries.power;
      state.mainChart.data.datasets[3].data = state.renderSeries.temp;

      updateChartRange();
      state.mainChart.update();
    }

    if (state.navigatorChart) {
      const lastX = state.chartSeries.power.length
        ? (state.chartSeries.power[state.chartSeries.power.length - 1]?.x ?? 0)
        : 0;

      if (state.navigatorChart.options?.scales?.x) {
        const navPad = Math.max(lastX * 0.005, 0.05);
        state.navigatorChart.options.scales.x.min = -navPad;
        state.navigatorChart.options.scales.x.max = lastX + navPad;
      }

      state.navigatorChart.data.datasets[0].data = state.navigatorSeries.power;
      state.navigatorChart.update();
    }

    updateTempUIVisibility();

    alert(`成功导入 ${newTimestamps.length} 条数据`);
  } catch (e) {
    console.error(e);
    alert('导入失败: ' + /** @type {Error} */ (e).message);
  }
}
