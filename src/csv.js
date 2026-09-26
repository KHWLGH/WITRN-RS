// @ts-check
/**
 * @file CSV 导入 / 导出。
 */

import { syncChartSeries, updateCharts } from './chart.js';
import { formatCsvChunks, parseCsv, snapshotCsvColumns } from './csv-codec.js';
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
import { calculateEnergyInRange } from './measurement.js';
import { setChartColumns, state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';
import { ask } from './ui/dialog.js';
import { toast } from './ui/toast.js';

// 文件选择器保留原生实现：Tauri v2 通过对话框选择在运行时授予所选路径的 fs scope，
// 换成应用内实现会直接破坏 writeTextFile / readTextFile 的权限。
const { save, open } = window.__TAURI__.dialog;
const { writeTextFile, readTextFile } = window.__TAURI__.fs;

/** 真正让出一个任务，而不是仅排入 Promise 微任务。 */
const yieldToMainThread = () => new Promise((resolve) => setTimeout(resolve, 0));

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * 导出数据为 CSV 文件。
 * @param {boolean} [withTemp=false] - 是否包含温度列
 */
export async function exportCSV(withTemp = false) {
  if (state.chartSeries.x.length === 0) {
    toast.warning('没有数据可导出');
    return;
  }

  try {
    const path = await save({
      filters: [{ name: 'CSV File', extensions: ['csv'] }],
      defaultPath: `witrn_data_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
    });
    // 取消不遍历、格式化或复制任何列；对话框期间可能继续录制或换入新数据。
    if (!path) return;
    const cols = state.chartSeries;
    if (cols.x.length === 0) {
      toast.warning('没有数据可导出');
      return;
    }
    const snapshot = snapshotCsvColumns(cols, {
      withTemp,
      sampleRate: state.settings.sampleRate,
      startTime: state.lastRecordingStartTime ?? cols.timestamps.at(0) ?? Date.now(),
    });
    await yieldToMainThread();
    let append = false;
    for (const chunk of formatCsvChunks(snapshot)) {
      // 同一授权路径顺序写，首次覆盖、后续追加；写失败直接退出，不报成功。
      await writeTextFile(path, chunk, { append });
      append = true;
      await yieldToMainThread();
    }
    toast.success('导出成功');
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
    const imported = parseCsv(content, {
      signedCurrent: state.settings.signedCurrent,
      fallbackStartTime: Date.now(),
    });
    const cols = imported.columns;
    const n = cols.x.length;

    if (state.isRecording || state.chartSeries.timestamps.length > 0) {
      const message = state.isRecording
        ? '当前正在录制，导入 CSV 将停止录制并清除现有记录。\n确定要继续吗？'
        : '当前已有数据，导入 CSV 将清除现有记录。\n确定要继续吗？';
      const confirmed = await ask(message, { title: '确认导入', kind: 'warning' });
      if (!confirmed) return;
    }

    const importedEnergy = calculateEnergyInRange(
      cols.x.view(),
      cols.current.view(),
      cols.power.view(),
      0,
      n - 1,
      cols.recordingSegments.view(),
      imported.intervalMs,
    );

    await stopRecording();
    clearAndResetStats();
    state.lastRecordingStartTime = imported.startTime;
    setChartColumns(cols);
    // 空档阈值跟着文件自身的节奏走，不能拿当前设置的采样率去判一份 5 秒档的历史记录。
    state.dataIntervalMs = imported.intervalMs;

    for (let i = 0; i < n; i++) {
      updateStats('voltage', cols.voltage.buf[i]);
      updateStats('current', cols.current.buf[i]);
      updateStats('power', cols.power.buf[i]);
      if (Number.isFinite(cols.temp.buf[i])) updateStats('temp', cols.temp.buf[i]);
    }
    state.energy.wh = importedEnergy.wh;
    state.energy.mah = importedEnergy.mah;
    state.energy.lastX = null;
    if (cols.temp.view().some((t) => Number.isFinite(t))) state.hasTempData = true;

    updateStatsDisplay();
    updateEnergyDisplay();
    const dataCountEl = document.getElementById('data-count');
    if (dataCountEl) dataCountEl.textContent = String(n);

    // 临时 F64 列直接提交，不再从十组普通数组复制；同步图表绑定与范围。
    syncChartSeries();
    updateChartRange();
    updateCharts();
    updateChartEmptyState();
    updateTempUIVisibility();
    const last = n - 1;
    updateRealtimeDisplay({
      voltage: cols.voltage.buf[last],
      current: cols.current.buf[last],
      power: cols.power.buf[last],
      temp: cols.temp.buf[last],
      dp: cols.dp.buf[last],
      dn: cols.dn.buf[last],
      cc1: cols.cc1.buf[last],
      cc2: cols.cc2.buf[last],
    });
    refreshRecordButton();
    toast.success(`成功导入 ${n} 条数据`);
  } catch (e) {
    console.error(e);
    toast.error(`导入失败: ${/** @type {Error} */ (e).message}`);
  }
}
