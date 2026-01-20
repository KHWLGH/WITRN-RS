const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { save, open, ask, message } = window.__TAURI__.dialog;
const { writeTextFile, readTextFile } = window.__TAURI__.fs;

// Store instance (lazy loaded)
let settingsStore = null;
let isLoadingSettings = false; // Flag to prevent saving during load

async function getStore() {
  if (!settingsStore) {
    console.log('getStore: Creating new LazyStore...');
    const { LazyStore } = await import('./vendor/plugin-store.js');
    settingsStore = new LazyStore('settings.json', {
      autoSave: 500 // Auto-save with 500ms debounce
    });
    // Explicitly initialize the store to ensure it loads from disk
    await settingsStore.init();
    console.log('getStore: LazyStore created and initialized');
  }
  return settingsStore;
}

async function loadSettings() {
  try {
    isLoadingSettings = true; // Disable auto-save during load
    console.log('loadSettings: Starting to load settings...');
    const store = await getStore();
    console.log('loadSettings: Store obtained:', store);
    const savedSettings = await store.get('appSettings');
    console.log('loadSettings: Saved settings from store:', savedSettings);
    if (savedSettings) {
      // Merge saved settings
      settings = { ...settings, ...savedSettings };
      console.log('loadSettings: Merged settings:', settings);
      
      // Apply to UI
      const rateSelect = document.getElementById('sample-rate');
      if (rateSelect) {
        rateSelect.value = String(settings.sampleRate);
        console.log('loadSettings: Set sample-rate to', settings.sampleRate);
      }
      
      if (document.getElementById('show-voltage')) document.getElementById('show-voltage').checked = settings.showVoltage;
      if (document.getElementById('show-current')) document.getElementById('show-current').checked = settings.showCurrent;
      if (document.getElementById('show-power')) document.getElementById('show-power').checked = settings.showPower;
      if (document.getElementById('show-temp')) document.getElementById('show-temp').checked = settings.showTemp;
      if (document.getElementById('fill-charts')) document.getElementById('fill-charts').checked = settings.fillCharts;
      
      // Temperature service settings
      if (document.getElementById('temp-ip')) document.getElementById('temp-ip').value = settings.tempIp || '127.0.0.1';
      if (document.getElementById('temp-port')) document.getElementById('temp-port').value = settings.tempPort || 1573;

      // Fill settings
      const setFill = (id, val) => { const el = document.getElementById(id); if(el) el.checked = !!val; };
      const setOp = (id, val) => { const el = document.getElementById(id); if(el) el.value = val ?? 15; };
      
      setFill('fill-voltage', settings.fillVoltage);
      setOp('opacity-voltage', settings.opacityVoltage);
      
      setFill('fill-current', settings.fillCurrent);
      setOp('opacity-current', settings.opacityCurrent);
      
      setFill('fill-power', settings.fillPower);
      setOp('opacity-power', settings.opacityPower);
      
      setFill('fill-temp', settings.fillTemp);
      setOp('opacity-temp', settings.opacityTemp);
      
      const statsRangeSelect = document.getElementById('stats-range-select'); // Note: ID might be different, checking code...
      // In code it was statsRangeToggle checkbox?
      // Let's check setupControls again.
      const statsRangeToggle = document.getElementById('stats-range-toggle');
      if (statsRangeToggle) statsRangeToggle.checked = settings.statsRange;

      // Auto Pause
      if (settings.autoPause) {
         autoPauseSettings = { ...autoPauseSettings, ...settings.autoPause };
         console.log('loadSettings: autoPauseSettings after merge:', autoPauseSettings);
         const apToggle = document.getElementById('btn-auto-pause-toggle');
         if (apToggle) {
           apToggle.checked = autoPauseSettings.enabled;
           console.log('loadSettings: Set apToggle.checked to', autoPauseSettings.enabled);
         } else {
           console.log('loadSettings: apToggle element not found!');
         }
         
         const apBasis = document.getElementById('ap-basis');
         if (apBasis) {
           apBasis.value = autoPauseSettings.basis;
           console.log('loadSettings: Set apBasis.value to', autoPauseSettings.basis);
         }
         
         const apCondition = document.getElementById('ap-condition');
         if (apCondition) {
           apCondition.value = autoPauseSettings.condition;
           console.log('loadSettings: Set apCondition.value to', autoPauseSettings.condition);
         }
         
         const apDuration = document.getElementById('ap-duration');
         if (apDuration) {
           apDuration.value = autoPauseSettings.duration;
           console.log('loadSettings: Set apDuration.value to', autoPauseSettings.duration);
         }
      } else {
         console.log('loadSettings: No autoPause in settings');
      }
      
      // Update charts visibility based on loaded settings
      if (window.mainChart) {
         // This will be handled in setupChartToggles or we call it here if chart exists
         // But chart is initialized in initChart() which is called in DOMContentLoaded
         // loadSettings is called in DOMContentLoaded.
         // We should call loadSettings BEFORE initChart or AFTER?
         // If we call it before, settings are ready.
         // setupChartToggles uses settings to set initial state.
      }
      console.log('loadSettings: Settings loaded successfully');
    } else {
      console.log('loadSettings: No saved settings found');
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  } finally {
    isLoadingSettings = false; // Re-enable auto-save
    console.log('loadSettings: Auto-save re-enabled');
  }
}

async function saveSettings() {
  try {
    const store = await getStore();
    // Include autoPauseSettings in settings to save
    const settingsToSave = {
      ...settings,
      autoPause: {
        enabled: autoPauseSettings.enabled,
        basis: autoPauseSettings.basis,
        condition: autoPauseSettings.condition,
        duration: autoPauseSettings.duration
      }
    };
    await store.set('appSettings', settingsToSave);
    await store.save();
    console.log('Settings saved successfully');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

// Debounced save to avoid too frequent writes
let __saveSettingsTimer = null;
function debouncedSaveSettings(delay = 500) {
  if (isLoadingSettings) {
    console.log('debouncedSaveSettings: Skipped (loading in progress)');
    return; // Don't save while loading settings
  }
  if (__saveSettingsTimer) {
    clearTimeout(__saveSettingsTimer);
  }
  __saveSettingsTimer = setTimeout(async () => {
    __saveSettingsTimer = null;
    await saveSettings();
  }, delay);
}

const defaultSettings = {
  rangeStart: 0,
  rangeEnd: 1000,
  sampleRate: 250,
  showVoltage: true,
  showCurrent: true,
  showPower: true,
  showTemp: true,
  statsRange: false,
  tempIp: '127.0.0.1',
  tempPort: 1573
};

const defaultAutoPauseSettings = {
  enabled: false,
  basis: 'none',
  condition: 0,
  duration: 0
};

async function resetSettings() {
  try {
    // Reset to defaults
    settings = { ...defaultSettings };
    autoPauseSettings = { ...defaultAutoPauseSettings, triggerStartTime: null };
    
    // Apply to UI
    const rateSelect = document.getElementById('sample-rate');
    if (rateSelect) rateSelect.value = String(settings.sampleRate);
    
    if (document.getElementById('show-voltage')) document.getElementById('show-voltage').checked = settings.showVoltage;
    if (document.getElementById('show-current')) document.getElementById('show-current').checked = settings.showCurrent;
    if (document.getElementById('show-power')) document.getElementById('show-power').checked = settings.showPower;
    if (document.getElementById('show-temp')) document.getElementById('show-temp').checked = settings.showTemp;
    
    // Temperature service settings
    if (document.getElementById('temp-ip')) document.getElementById('temp-ip').value = settings.tempIp;
    if (document.getElementById('temp-port')) document.getElementById('temp-port').value = settings.tempPort;
    
    const statsRangeToggle = document.getElementById('stats-range-toggle');
    if (statsRangeToggle) statsRangeToggle.checked = settings.statsRange;
    
    const apToggle = document.getElementById('btn-auto-pause-toggle');
    if (apToggle) apToggle.checked = autoPauseSettings.enabled;
    
    const apBasis = document.getElementById('ap-basis');
    if (apBasis) apBasis.value = autoPauseSettings.basis;
    
    const apCondition = document.getElementById('ap-condition');
    if (apCondition) apCondition.value = autoPauseSettings.condition;
    
    const apDuration = document.getElementById('ap-duration');
    if (apDuration) apDuration.value = autoPauseSettings.duration;
    
    // Update chart visibility
    if (mainChart) {
      mainChart.setDatasetVisibility(0, settings.showVoltage);
      mainChart.setDatasetVisibility(1, settings.showCurrent);
      mainChart.setDatasetVisibility(2, settings.showPower);
      // Temperature visibility is handled by updateTempUIVisibility()
      if (mainChart.options && mainChart.options.scales) {
        mainChart.options.scales['y-voltage'].display = settings.showVoltage;
        mainChart.options.scales['y-current'].display = settings.showCurrent;
        mainChart.options.scales['y-power'].display = settings.showPower;
        // Temperature scale visibility is handled by updateTempUIVisibility()
      }
      mainChart.update();
    }
    
    updateStatsDisplay();
    updateTempUIVisibility(); // Update temperature UI based on connection status

    // Clear saved settings from store
    const store = await getStore();
    await store.delete('appSettings');
    await store.save();
    
    console.log('Settings reset to defaults');
  } catch (e) {
    console.error('Failed to reset settings:', e);
  }
}

// Prevent accidental window close (Tauri)
let __isClosingWindow = false;
let __unlistenCloseRequested = null;

function __withTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function setupCloseConfirm() {
  try {
    const getCurrentWindow = window.__TAURI__?.window?.getCurrentWindow;
    if (typeof getCurrentWindow !== 'function') return;

    const appWindow = getCurrentWindow();
    if (!appWindow || typeof appWindow.onCloseRequested !== 'function') return;

    __unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
      // Tauri v2: you may call preventDefault() to take over closing.
      // We *do* prevent by default here, but ensure we always reach a close/exit fallback
      // so the app never gets stuck in an unclosable state.
      try {
        event.preventDefault();
      } catch {
        // If the event doesn't support preventDefault, just continue.
      }

      if (__isClosingWindow) {
        // 如果已经在关闭中，用户多次点击关闭，强制退出
        try {
          await __withTimeout(invoke('exit_app'), 500, null);
        } catch {}
        return;
      }

      let confirmed = true;
      try {
        // 如果对话框偶发卡死/无法显示：超时后“放行退出”，避免永远无法关闭。
        confirmed = await __withTimeout(
          ask('确定要退出吗？', { title: '确认退出', type: 'warning' }),
          5_000,
          true
        );
      } catch {
        confirmed = true;
      }

      if (!confirmed) {
        // 用户取消：保持窗口不关闭
        return;
      }

      __isClosingWindow = true;
      
      // Avoid re-entering this handler by removing it before closing.
      try {
        if (typeof __unlistenCloseRequested === 'function') {
          __unlistenCloseRequested();
        }
      } catch {}
      __unlistenCloseRequested = null;

      // 在关闭前先断开设备连接，避免后台线程阻塞关闭
      try {
        await __withTimeout(invoke('disconnect_device'), 500, null);
      } catch (e) {
        console.warn('disconnect_device failed during close:', e);
      }
      
      try {
        await __withTimeout(invoke('disconnect_temp_service'), 500, null);
      } catch (e) {
        console.warn('disconnect_temp_service failed during close:', e);
      }

      // Save settings before closing, but never block closing indefinitely.
      try {
        await __withTimeout(saveSettings(), 2000, null);
      } catch (e) {
        console.warn('saveSettings failed during close:', e);
      }

      // Close the main window gracefully (preferred), with fallbacks.
      try {
        await __withTimeout(invoke('close_main_window'), 1000, null);
        return;
      } catch (e) {
        console.warn('close_main_window failed, falling back to exit_app:', e);
      }

      try {
        await __withTimeout(invoke('exit_app'), 1000, null);
        return;
      } catch (e) {
        console.warn('exit_app failed, falling back to window.destroy:', e);
      }

      // Last resort: force destroy from JS API if available.
      try {
        if (typeof appWindow.destroy === 'function') {
          await __withTimeout(appWindow.destroy(), 500, null);
        }
      } catch (e) {
        console.warn('appWindow.destroy failed:', e);
      }

      // 最终兜底：如果以上全部失败，强制关闭
      try {
        appWindow.close();
      } catch (e) {
        console.warn('appWindow.close failed:', e);
      }
    });
  } catch (e) {
    console.error('Failed to setup close confirm:', e);
  }
}

// Chart instance
let mainChart = null;
let navigatorChart = null;

let __chartUpdatePending = false;

let __setRangeControlsEnabled = null;

function scheduleChartUpdate() {
  if (__chartUpdatePending) return;
  __chartUpdatePending = true;
  requestAnimationFrame(() => {
    __chartUpdatePending = false;
    
    // Check if we need to rebuild downsampled data
    checkAndRebuildDownsampledData();
    
    const lastX = chartSeries.power.length
      ? (chartSeries.power[chartSeries.power.length - 1]?.x ?? 0)
      : 0;

    if (navigatorChart && navigatorChart.options?.scales?.x) {
      const navPad = Math.max(lastX * 0.005, 0.05);
      navigatorChart.options.scales.x.min = -navPad;
      navigatorChart.options.scales.x.max = lastX + navPad;
    }

    if (mainChart) mainChart.update('none');
    if (navigatorChart) navigatorChart.update('none');
  });
}

// Data storage
let chartData = {
  timestamps: [],
  voltage: [],
  current: [],
  power: [],
  temp: [],
};

// Chart preview series (x/y points). This can be decimated for rendering without affecting chartData.
let chartSeries = {
  voltage: [],
  current: [],
  power: [],
  temp: [],
};

// Downsampled series for rendering (separate from raw chartSeries)
let renderSeries = {
  voltage: [],
  current: [],
  power: [],
  temp: [],
};

// Navigator downsampled series (more aggressive downsampling)
let navigatorSeries = {
  power: [],
};

// Downsampling configuration
const DOWNSAMPLE_CONFIG = {
  mainChartMaxPoints: 2000,      // Max points for main chart
  navigatorMaxPoints: 500,       // Max points for navigator
  rebuildThreshold: 0.15,        // Rebuild when data grows by 15%
  minRebuildInterval: 500,       // Min ms between rebuilds for performance
  lastRebuildCount: 0,           // Track when we last rebuilt
  navLastRebuildCount: 0,        // Track navigator rebuild
  lastRebuildTime: 0,            // Track last rebuild time
  useDirectReference: true,      // Use direct reference when possible (saves memory)
};

/**
 * LTTB (Largest-Triangle-Three-Buckets) downsampling algorithm
 * Optimized for performance with large datasets
 * @param {Array} data - Array of {x, y} points
 * @param {number} threshold - Target number of points
 * @returns {Array} Downsampled array of {x, y} points
 */
function lttbDownsample(data, threshold) {
  const dataLength = data.length;
  if (threshold >= dataLength || threshold <= 2) {
    return data;
  }

  const sampled = new Array(threshold);
  let sampledIndex = 0;

  // Always keep the first point
  sampled[sampledIndex++] = data[0];

  // Bucket size (minus first and last points)
  const bucketSize = (dataLength - 2) / (threshold - 2);

  let a = 0; // Index of the point selected in the previous bucket

  for (let i = 0; i < threshold - 2; i++) {
    // Calculate bucket range
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, dataLength - 1);
    
    // Calculate the average point for the next bucket (for triangle calculation)
    const nextBucketStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, dataLength - 1);
    
    let avgX = 0;
    let avgY = 0;
    let avgCount = nextBucketEnd - nextBucketStart;
    
    if (avgCount > 0) {
      for (let j = nextBucketStart; j < nextBucketEnd; j++) {
        avgX += data[j].x;
        avgY += data[j].y;
      }
      avgX /= avgCount;
      avgY /= avgCount;
    } else {
      // Last bucket - use the last point
      avgX = data[dataLength - 1].x;
      avgY = data[dataLength - 1].y;
    }

    // Find the point in the current bucket that creates the largest triangle
    let maxArea = -1;
    let maxAreaIndex = bucketStart;

    const pointAX = data[a].x;
    const pointAY = data[a].y;

    for (let j = bucketStart; j < bucketEnd; j++) {
      // Calculate triangle area using cross product
      const area = Math.abs(
        (pointAX - avgX) * (data[j].y - pointAY) -
        (pointAX - data[j].x) * (avgY - pointAY)
      );

      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = j;
      }
    }

    sampled[sampledIndex++] = data[maxAreaIndex];
    a = maxAreaIndex; // Update the reference point for the next iteration
  }

  // Always keep the last point
  sampled[sampledIndex] = data[dataLength - 1];

  return sampled;
}

/**
 * Min-Max downsampling for navigator (preserves peaks)
 * Faster than LTTB for overview display
 * @param {Array} data - Array of {x, y} points  
 * @param {number} buckets - Number of buckets to create
 * @returns {Array} Downsampled array
 */
function minMaxDownsample(data, buckets) {
  const dataLength = data.length;
  if (buckets * 2 >= dataLength || buckets <= 1) {
    return data;
  }

  const result = [];
  const bucketSize = dataLength / buckets;

  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(Math.floor((i + 1) * bucketSize), dataLength);
    
    let minY = Infinity;
    let maxY = -Infinity;
    let minIdx = start;
    let maxIdx = start;

    for (let j = start; j < end; j++) {
      if (data[j].y < minY) {
        minY = data[j].y;
        minIdx = j;
      }
      if (data[j].y > maxY) {
        maxY = data[j].y;
        maxIdx = j;
      }
    }

    // Add points in order of their x position
    if (minIdx <= maxIdx) {
      result.push(data[minIdx]);
      if (minIdx !== maxIdx) result.push(data[maxIdx]);
    } else {
      result.push(data[maxIdx]);
      if (minIdx !== maxIdx) result.push(data[minIdx]);
    }
  }

  return result;
}

/**
 * Rebuild render series from chartSeries using downsampling
 */
function rebuildRenderSeries() {
  const count = chartSeries.voltage.length;
  
  if (count <= DOWNSAMPLE_CONFIG.mainChartMaxPoints) {
    // No need to downsample, use original data
    renderSeries.voltage = chartSeries.voltage;
    renderSeries.current = chartSeries.current;
    renderSeries.power = chartSeries.power;
    renderSeries.temp = chartSeries.temp;
  } else {
    // Apply LTTB downsampling
    renderSeries.voltage = lttbDownsample(chartSeries.voltage, DOWNSAMPLE_CONFIG.mainChartMaxPoints);
    renderSeries.current = lttbDownsample(chartSeries.current, DOWNSAMPLE_CONFIG.mainChartMaxPoints);
    renderSeries.power = lttbDownsample(chartSeries.power, DOWNSAMPLE_CONFIG.mainChartMaxPoints);
    renderSeries.temp = lttbDownsample(chartSeries.temp, DOWNSAMPLE_CONFIG.mainChartMaxPoints);
  }
  
  DOWNSAMPLE_CONFIG.lastRebuildCount = count;
  
  // Update chart dataset references
  if (mainChart) {
    mainChart.data.datasets[0].data = renderSeries.voltage;
    mainChart.data.datasets[1].data = renderSeries.current;
    mainChart.data.datasets[2].data = renderSeries.power;
    mainChart.data.datasets[3].data = renderSeries.temp;
  }
}

/**
 * Rebuild navigator series with more aggressive downsampling
 */
function rebuildNavigatorSeries() {
  const count = chartSeries.power.length;
  
  if (count <= DOWNSAMPLE_CONFIG.navigatorMaxPoints) {
    navigatorSeries.power = chartSeries.power;
  } else {
    // Use minMax for navigator (faster, preserves extremes)
    navigatorSeries.power = minMaxDownsample(chartSeries.power, DOWNSAMPLE_CONFIG.navigatorMaxPoints / 2);
  }
  
  DOWNSAMPLE_CONFIG.navLastRebuildCount = count;
  
  // Update navigator dataset reference
  if (navigatorChart) {
    navigatorChart.data.datasets[0].data = navigatorSeries.power;
  }
}

/**
 * Check if we need to rebuild downsampled data
 * Uses threshold-based approach to avoid rebuilding on every data point
 */
function checkAndRebuildDownsampledData() {
  const count = chartSeries.voltage.length;
  const lastCount = DOWNSAMPLE_CONFIG.lastRebuildCount;
  const navLastCount = DOWNSAMPLE_CONFIG.navLastRebuildCount;
  const now = performance.now();
  
  // If data is small enough, use direct reference (no rebuild needed)
  if (count <= DOWNSAMPLE_CONFIG.mainChartMaxPoints) {
    if (renderSeries.voltage !== chartSeries.voltage) {
      renderSeries.voltage = chartSeries.voltage;
      renderSeries.current = chartSeries.current;
      renderSeries.power = chartSeries.power;
      renderSeries.temp = chartSeries.temp;
      if (mainChart) {
        mainChart.data.datasets[0].data = renderSeries.voltage;
        mainChart.data.datasets[1].data = renderSeries.current;
        mainChart.data.datasets[2].data = renderSeries.power;
        mainChart.data.datasets[3].data = renderSeries.temp;
      }
    }
    DOWNSAMPLE_CONFIG.lastRebuildCount = count;
  } else {
    // Large data - check if rebuild is needed
    const timeSinceLastRebuild = now - DOWNSAMPLE_CONFIG.lastRebuildTime;
    const growthRatio = lastCount > 0 ? (count - lastCount) / lastCount : 1;
    
    const mainNeedsRebuild = lastCount === 0 || 
      (growthRatio > DOWNSAMPLE_CONFIG.rebuildThreshold && 
       timeSinceLastRebuild >= DOWNSAMPLE_CONFIG.minRebuildInterval);
    
    if (mainNeedsRebuild) {
      rebuildRenderSeries();
      DOWNSAMPLE_CONFIG.lastRebuildTime = now;
    } else if (renderSeries.voltage.length > 0) {
      // Keep tail aligned so the chart end follows newest point (avoid trailing gap)
      const lastVoltage = chartSeries.voltage[count - 1];
      const lastCurrent = chartSeries.current[count - 1];
      const lastPower = chartSeries.power[count - 1];
      const lastTemp = chartSeries.temp[count - 1];
      renderSeries.voltage[renderSeries.voltage.length - 1] = lastVoltage;
      renderSeries.current[renderSeries.current.length - 1] = lastCurrent;
      renderSeries.power[renderSeries.power.length - 1] = lastPower;
      if (lastTemp && renderSeries.temp.length > 0) {
        renderSeries.temp[renderSeries.temp.length - 1] = lastTemp;
      }
    }
  }
  
  // Navigator rebuild check (similar logic)
  if (count <= DOWNSAMPLE_CONFIG.navigatorMaxPoints) {
    if (navigatorSeries.power !== chartSeries.power) {
      navigatorSeries.power = chartSeries.power;
      if (navigatorChart) {
        navigatorChart.data.datasets[0].data = navigatorSeries.power;
      }
    }
    DOWNSAMPLE_CONFIG.navLastRebuildCount = count;
  } else {
    const navGrowthRatio = navLastCount > 0 ? (count - navLastCount) / navLastCount : 1;
    const navNeedsRebuild = navLastCount === 0 ||
      navGrowthRatio > DOWNSAMPLE_CONFIG.rebuildThreshold;
    
    if (navNeedsRebuild) {
      rebuildNavigatorSeries();
    } else if (navigatorSeries.power.length > 0) {
      // Align navigator tail as well
      navigatorSeries.power[navigatorSeries.power.length - 1] = chartSeries.power[count - 1];
    }
  }
}

// Statistics
let stats = {
  voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
};

// Energy accumulation
let energy = {
  wh: 0,
  mah: 0,
  lastTimestamp: null
};

// Recording data
let recordedData = [];
let isRecording = false;
let recordingStartTime = null; // milliseconds since epoch when recording started
let lastRecordingStartTime = null; // Persisted start time for CSV export
// When true, only collect chart points, stats, energy and recordedData while recording
let collectWhenRecordingOnly = true;

// Connection state
let isConnected = false;
let deviceList = []; // 存储枚举到的设备列表
let selectedDevicePath = null; // 当前选中的设备路径

// Settings
let settings = {
  rangeStart: 0,
  rangeEnd: 1000,
  // sampleRate is stored in milliseconds; the select displays 'times per second'
  sampleRate: 250,
  showVoltage: true,
  showCurrent: true,
  showPower: true,
  showTemp: true,
  // Fill settings per channel
  fillVoltage: true,
  opacityVoltage: 15,
  fillCurrent: true,
  opacityCurrent: 15,
  fillPower: true,
  opacityPower: 15,
  fillTemp: true,
  opacityTemp: 15,
  statsRange: false,
  tempIp: '127.0.0.1',
  tempPort: 1573
};


// Temperature service connection
let tempSocket = null;
let isTempConnected = false;
let currentTemp = null;
let tempBuffer = '';
let hasTempData = false; // Track if we have any temperature data (from service or imported)

// Auto Pause Settings
let autoPauseSettings = {
  enabled: false,
  basis: 'none', // 'none', 'current', 'power'
  condition: 0,
  duration: 0, // seconds
  triggerStartTime: null // timestamp when condition was first met
};

function formatRelativeHMS(seconds) {
  // Show relative time as HH:mm:ss.s (keep 1 decimal on seconds)
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  const totalTenths = Math.max(0, Math.round(safeSeconds * 10));

  const hours = Math.floor(totalTenths / 36000);
  const minutes = Math.floor((totalTenths % 36000) / 600);
  const secondsTenths = totalTenths % 600;
  const secs = Math.floor(secondsTenths / 10);
  const tenths = secondsTenths % 10;

  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}.${tenths}`;
}

function labelToSeconds(label) {
  const text = String(label ?? '').trim().replace(/s$/i, '');
  const value = parseFloat(text);
  return Number.isFinite(value) ? value : 0;
}

function hexToRgba(hex, opacityPercent) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
}

// Initialize chart
function initChart() {
  const ctx = document.getElementById('main-chart').getContext('2d');
  // Use system fonts (with Microsoft YaHei first for Windows Chinese support) for UI elements,
  // and maintain a monospace stack for aligned numbers where appropriate.
  const chartFontFamily = "'Microsoft YaHei UI', 'Microsoft YaHei', 'SimHei', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif";
  const monoFontFamily = "'JetBrains Mono', 'Consolas', 'Monaco', monospace";
  
  const colors = {
    voltage: '#4a9eff',
    current: '#4aff9f',
    power: '#ffaa4a',
    temp: '#ff4a4a'
  };

  mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: '电压',
          data: renderSeries.voltage,
          borderColor: colors.voltage,
          backgroundColor: hexToRgba(colors.voltage, settings.opacityVoltage),
          yAxisID: 'y-voltage',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: settings.fillVoltage,
          hidden: !settings.showVoltage
        },
        {
          label: '电流',
          data: renderSeries.current,
          borderColor: colors.current,
          backgroundColor: hexToRgba(colors.current, settings.opacityCurrent),
          yAxisID: 'y-current',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: settings.fillCurrent,
          hidden: !settings.showCurrent
        },
        {
          label: '功率',
          data: renderSeries.power,
          borderColor: colors.power,
          backgroundColor: hexToRgba(colors.power, settings.opacityPower),
          yAxisID: 'y-power',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: settings.fillPower,
          hidden: !settings.showPower
        },
        {
          label: '温度',
          data: renderSeries.temp,
          borderColor: colors.temp,
          backgroundColor: hexToRgba(colors.temp, settings.opacityTemp),
          yAxisID: 'y-temp',
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          fill: settings.fillTemp,
          hidden: !settings.showTemp
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      animation: {
        duration: 0
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          onClick: () => {},
          labels: {
            color: '#a0a0b0',
            usePointStyle: true,
            font: {
              family: chartFontFamily
            },
            padding: 15,
            generateLabels: (chart) => {
              const original = Chart.defaults.plugins.legend.labels.generateLabels;
              return original(chart).filter((item) => chart.isDatasetVisible(item.datasetIndex));
            }
          }
        },
        decimation: {
          enabled: false // Using custom downsampling for better performance
        },
        tooltip: {
          backgroundColor: 'rgba(30, 30, 50, 0.95)',
          titleColor: '#e8e8f0',
          bodyColor: '#a0a0b0',
          titleFont: {
            family: monoFontFamily
          },
          bodyFont: {
            family: monoFontFamily
          },
          borderColor: '#2a2a4a',
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            title: function(items) {
              if (!items || items.length === 0) return '';
              const seconds = Number(items[0].parsed?.x ?? 0);
              return formatRelativeHMS(seconds);
            },
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                // Unified: 3 decimal places
                label += context.parsed.y.toFixed(3);
                const units = [' V', ' A', ' W', ' °C'];
                if (context.datasetIndex >= 0 && context.datasetIndex < units.length) {
                  label += units[context.datasetIndex];
                }
              }
              return label;
            }
          }
        },
        zoom: {
          // Zoom & pan disabled per user request
          zoom: {
            wheel: {
              enabled: false,
            },
            pinch: {
              enabled: false
            },
            mode: 'xy',
          },
          pan: {
            enabled: false,
            mode: 'xy',
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          bounds: 'data',
          offset: false,
          grace: 0,
          grid: {
            color: 'rgba(42, 42, 74, 0.5)',
            drawBorder: false
          },
          ticks: {
            color: '#6a6a7a',
            font: {
              family: monoFontFamily
            },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
            callback: function(value) { return formatRelativeHMS(Number(value)); }
          }
        },
        'y-voltage': {
          type: 'linear',
          display: settings.showVoltage,
          position: 'left',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: {
            display: true,
            text: '电压 (V)',
            color: '#4a9eff',
            font: { family: chartFontFamily }
          },
          grid: {
            color: 'rgba(74, 158, 255, 0.1)',
            drawBorder: false
          },
          ticks: {
            color: '#4a9eff',
            font: {
              family: monoFontFamily
            },
            // count: 11, // removed for adaptive scaling
            callback: function(value) {
              const absVal = Math.abs(value);
              // Optimizing for small values: display more decimals if < 1
              if (absVal > 0 && absVal < 0.001) return parseFloat(value.toFixed(6));
              if (absVal > 0 && absVal < 0.1) return parseFloat(value.toFixed(5));
              if (absVal > 0 && absVal < 1) return parseFloat(value.toFixed(4));
              return parseFloat(value.toFixed(3));
            }
          }
        },
        'y-current': {
          type: 'linear',
          display: settings.showCurrent,
          position: 'left',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: {
            display: true,
            text: '电流 (A)',
            color: '#4aff9f',
            font: { family: chartFontFamily }
          },
          grid: {
            display: false // Hide grid to ensure standard look without overlap
          },
          ticks: {
            color: '#4aff9f',
            font: {
              family: monoFontFamily
            },
            // count: 11,
            callback: function(value) {
              const absVal = Math.abs(value);
              if (absVal > 0 && absVal < 0.001) return parseFloat(value.toFixed(6));
              if (absVal > 0 && absVal < 0.1) return parseFloat(value.toFixed(5));
              if (absVal > 0 && absVal < 1) return parseFloat(value.toFixed(4));
              return parseFloat(value.toFixed(3));
            }
          }
        },
        'y-power': {
          type: 'linear',
          display: settings.showPower,
          position: 'right',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: {
            display: true,
            text: '功率 (W)',
            color: '#ffaa4a',
            font: { family: chartFontFamily }
          },
          grid: {
            display: false
          },
          ticks: {
            color: '#ffaa4a',
            font: {
              family: monoFontFamily
            },
            // count: 11,
            callback: function(value) {
              const absVal = Math.abs(value);
              if (absVal > 0 && absVal < 0.001) return parseFloat(value.toFixed(6));
              if (absVal > 0 && absVal < 0.1) return parseFloat(value.toFixed(5));
              if (absVal > 0 && absVal < 1) return parseFloat(value.toFixed(4));
              return parseFloat(value.toFixed(3));
            }
          }
        },
        'y-temp': {
          type: 'linear',
          display: settings.showTemp,
          position: 'right',
          min: 0,
          beginAtZero: true,
          grace: '5%',
          title: {
            display: true,
            text: '温度 (°C)',
            color: '#ff4a4a',
            font: { family: chartFontFamily }
          },
          grid: {
            display: false
          },
          ticks: {
            color: '#ff4a4a',
            font: {
              family: monoFontFamily
            },
            // count: 11,
            callback: function(value) {
              return parseFloat(value.toFixed(3));
            }
          }
        }
      }
    }
  });

  initNavigatorChart();
}

function initNavigatorChart() {
  const ctx = document.getElementById('navigator-chart').getContext('2d');
  
  navigatorChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          data: navigatorSeries.power,
          borderColor: '#ffaa4a',
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      },
      scales: {
        x: {
          type: 'linear',
          display: false,
          bounds: 'data',
          offset: false,
          grace: 0,
        },
        y: { 
          display: false,
          type: 'linear',
          beginAtZero: true,
          grace: '5%'
        }
      },
      layout: {
        padding: 0
      }
    }
  });
}

// Update chart data
function addDataPoint(data) {
  const now = new Date();
  
  // compute absolute values for display and recording
  const currentAbs = Math.abs(data.current);
  const powerAbs = Math.abs(data.power);
  
  // Get current temperature from temperature service
  const tempValue = currentTemp !== null ? currentTemp : 0;

  // If configured to only collect while recording, and not recording, only update realtime display
  if (collectWhenRecordingOnly && !isRecording) {
    updateRealtimeDisplay({ ...data, current: currentAbs, power: powerAbs, temp: tempValue });
    // Update stats display for visual but do not modify recorded stats/counts
    document.getElementById('data-count').textContent = chartData.timestamps.length;
    return;
  }

  const nowMs = now.getTime();
  const baselineMs = chartData.timestamps.length ? chartData.timestamps[0] : nowMs;
  const relSeconds = (nowMs - baselineMs) / 1000;

  // Keep full-resolution data (for export / stats / recording)
  chartData.timestamps.push(nowMs);
  chartData.voltage.push(data.voltage);
  chartData.current.push(currentAbs);
  chartData.power.push(powerAbs);
  chartData.temp.push(tempValue);

  // Build x/y series for chart rendering (can be decimated by Chart.js plugin)
  chartSeries.voltage.push({ x: relSeconds, y: data.voltage });
  chartSeries.current.push({ x: relSeconds, y: currentAbs });
  chartSeries.power.push({ x: relSeconds, y: powerAbs });
  chartSeries.temp.push({ x: relSeconds, y: tempValue });
  
  // Update chart range
  updateChartRange();
  
  // Update statistics
  updateStats('voltage', data.voltage);
  updateStats('current', currentAbs);
  updateStats('power', powerAbs);
  // Only update temperature stats when recording
  if (isTempConnected && tempValue !== 0 && isRecording) {
    updateStats('temp', tempValue);
  }
  
  // Update energy (only when collecting data to chart)
  if (energy.lastTimestamp !== null) {
    const dt = (now.getTime() - energy.lastTimestamp) / 3600000; // hours
    energy.wh += powerAbs * dt;
    energy.mah += currentAbs * 1000 * dt;
  }
  energy.lastTimestamp = now.getTime();
  
  // Update UI (show absolute values)
  updateRealtimeDisplay({ ...data, current: currentAbs, power: powerAbs, temp: tempValue });
  updateStatsDisplay();
  updateEnergyDisplay();
  
  // Update data count
  document.getElementById('data-count').textContent = chartData.timestamps.length;
  
  // Auto Pause Logic
  if (isRecording && autoPauseSettings.enabled && autoPauseSettings.basis !== 'none') {
    let value;
    if (autoPauseSettings.basis === 'voltage') {
      value = data.voltage;
    } else if (autoPauseSettings.basis === 'current') {
      value = currentAbs;
    } else {
      value = powerAbs;
    }
    
    // Condition: Pause if value <= condition
    if (value <= autoPauseSettings.condition) {
      if (!autoPauseSettings.triggerStartTime) {
        autoPauseSettings.triggerStartTime = Date.now();
      } else {
        const elapsed = (Date.now() - autoPauseSettings.triggerStartTime) / 1000;
        if (elapsed >= autoPauseSettings.duration) {
          stopRecording();
          autoPauseSettings.triggerStartTime = null;
          // Optional: Notify user
          console.info('Auto paused due to trigger condition');
        }
      }
    } else {
      autoPauseSettings.triggerStartTime = null;
    }
  }

  // Recording
  // Recording -> saved separately (use relative time in seconds and absolute values)
  if (isRecording && document.getElementById('record-status').textContent === '记录中...') {
    const relSec = recordingStartTime ? ((now.getTime() - recordingStartTime) / 1000) : 0;
    const rel = formatRelativeHMS(relSec);
    recordedData.push({
      timestamp: rel,
      voltage: data.voltage,
      current: currentAbs,
      power: powerAbs,
      temp: tempValue,
      relSeconds: relSec
    });
  }
  
  // Update chart
  scheduleChartUpdate();
}

function updateSliderFill() {
  const start = settings.rangeStart / 10; // 0-100%
  const end = settings.rangeEnd / 10; // 0-100%
  const fill = document.getElementById('slider-fill');
  fill.style.left = `${start}%`;
  fill.style.width = `${end - start}%`;

  const handleStart = document.getElementById('range-handle-start');
  const handleEnd = document.getElementById('range-handle-end');
  if (handleStart) handleStart.style.left = `${start}%`;
  if (handleEnd) handleEnd.style.left = `${end}%`;
}

function updateChartRange() {
  const totalPoints = chartData.timestamps.length;
  if (totalPoints === 0) {
    document.getElementById('range-start-time').textContent = '--';
    document.getElementById('range-end-time').textContent = '--';
    document.getElementById('range-duration').textContent = '无数据';
    return;
  }

  // Calculate indices based on slider values (0-1000)
  let startIndex = Math.floor(totalPoints * settings.rangeStart / 1000);
  let endIndex = Math.floor(totalPoints * settings.rangeEnd / 1000);
  
  // Ensure valid range
  if (startIndex < 0) startIndex = 0;
  if (endIndex >= totalPoints) endIndex = totalPoints - 1;
  if (startIndex > endIndex) startIndex = endIndex;

  const baselineMs = chartData.timestamps[0];
  const startSeconds = baselineMs ? ((chartData.timestamps[startIndex] - baselineMs) / 1000) : 0;
  let endSeconds = baselineMs ? ((chartData.timestamps[endIndex] - baselineMs) / 1000) : 0;

  // When dragging到尾部时，使用当前渲染序列的末尾坐标，避免尾端留白
  const tailSeries = renderSeries.voltage?.length ? renderSeries.voltage : chartSeries.voltage;
  if (endIndex === totalPoints - 1 && tailSeries.length) {
    const lastX = tailSeries[tailSeries.length - 1]?.x;
    if (typeof lastX === 'number' && Number.isFinite(lastX)) {
      endSeconds = lastX;
    }
  }

  const rangeSeconds = Math.max(0, endSeconds - startSeconds);
  const padSeconds = Math.max(rangeSeconds * 0.005, 0.05);
  const paddedStart = Math.max(0, startSeconds - padSeconds);
  const paddedEnd = endSeconds + padSeconds;

  mainChart.options.scales.x.min = paddedStart;
  mainChart.options.scales.x.max = paddedEnd;
  document.getElementById('range-start-time').textContent = formatRelativeHMS(startSeconds);
  document.getElementById('range-end-time').textContent = formatRelativeHMS(endSeconds);
  
  const points = endIndex - startIndex + 1;
  const durationSec = Math.max(0, endSeconds - startSeconds);
  const durationText = formatRelativeHMS(durationSec);
  document.getElementById('range-duration').textContent = `时长: ${durationText} (${points}点)`;
}

function updateStats(field, value) {
  const stat = stats[field];
  if (!stat || !Number.isFinite(value)) return;

  if (value < stat.min) stat.min = value;
  if (value > stat.max) stat.max = value;
  stat.sum += value;
  stat.count += 1;
}

function updateRealtimeDisplay(data) {
  document.getElementById('rt-voltage').textContent = data.voltage.toFixed(4);
  document.getElementById('rt-current').textContent = data.current.toFixed(4);
  document.getElementById('rt-power').textContent = data.power.toFixed(4);
  // Update temperature display if connected
  if (isTempConnected && data.temp !== undefined) {
    document.getElementById('rt-temp').textContent = data.temp.toFixed(1);
  }
}

function getVisibleDataRange() {
  const totalPoints = chartData.timestamps.length;
  if (totalPoints === 0) return { startIndex: 0, endIndex: 0 };

  let startIndex = Math.floor(totalPoints * settings.rangeStart / 1000);
  let endIndex = Math.floor(totalPoints * settings.rangeEnd / 1000);
  
  if (startIndex < 0) startIndex = 0;
  if (endIndex >= totalPoints) endIndex = totalPoints - 1;
  if (startIndex > endIndex) startIndex = endIndex;
  
  return { startIndex, endIndex };
}

function updateStatsDisplay() {
  let displayStats = stats;
  let powerAvg = stats.power.count > 0 ? (stats.power.sum / stats.power.count) : null;
  let tempAvg = stats.temp.count > 0 ? (stats.temp.sum / stats.temp.count) : null;
  let displayPowerAvg = powerAvg;
  let displayTempAvg = tempAvg;

  if (settings.statsRange && chartData.timestamps.length > 0) {
    const { startIndex, endIndex } = getVisibleDataRange();
    
    let minV = Infinity, maxV = -Infinity;
    let minC = Infinity, maxC = -Infinity;
    let minP = Infinity, maxP = -Infinity;
    let minT = Infinity, maxT = -Infinity;
    let sumP = 0, countP = 0;
    let sumT = 0, countT = 0;

    for (let i = startIndex; i <= endIndex; i++) {
      const v = chartData.voltage[i];
      const c = chartData.current[i];
      const p = chartData.power[i];
      const t = chartData.temp[i];

      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
      sumP += p;
      countP += 1;
      if (t !== 0 && t < minT) minT = t;
      if (t !== 0 && t > maxT) maxT = t;
      if (t !== 0) {
        sumT += t;
        countT += 1;
      }
    }

    displayStats = {
      voltage: { min: minV, max: maxV },
      current: { min: minC, max: maxC },
      power: { min: minP, max: maxP },
      temp: { min: minT, max: maxT }
    };

    powerAvg = countP > 0 ? (sumP / countP) : null;
    tempAvg = countT > 0 ? (sumT / countT) : null;
    displayPowerAvg = powerAvg;
    displayTempAvg = tempAvg;
  }

  document.getElementById('min-voltage').textContent = displayStats.voltage.min === Infinity ? '--' : displayStats.voltage.min.toFixed(3);
  document.getElementById('max-voltage').textContent = displayStats.voltage.max === -Infinity ? '--' : displayStats.voltage.max.toFixed(3);
  document.getElementById('min-current').textContent = displayStats.current.min === Infinity ? '--' : displayStats.current.min.toFixed(3);
  document.getElementById('max-current').textContent = displayStats.current.max === -Infinity ? '--' : displayStats.current.max.toFixed(3);
  document.getElementById('min-power').textContent = displayStats.power.min === Infinity ? '--' : displayStats.power.min.toFixed(3);
  document.getElementById('max-power').textContent = displayStats.power.max === -Infinity ? '--' : displayStats.power.max.toFixed(3);
  const avgPowerEl = document.getElementById('avg-power');
  if (avgPowerEl) {
    avgPowerEl.textContent = displayPowerAvg !== null ? displayPowerAvg.toFixed(3) : '--';
  }
  
  // Update temperature stats
  const tempStats = displayStats.temp || stats.temp;
  document.getElementById('min-temp').textContent = tempStats.min === Infinity ? '--' : tempStats.min.toFixed(1);
  document.getElementById('max-temp').textContent = tempStats.max === -Infinity ? '--' : tempStats.max.toFixed(1);
  const avgTempEl = document.getElementById('avg-temp');
  if (avgTempEl) {
    avgTempEl.textContent = displayTempAvg !== null ? displayTempAvg.toFixed(1) : '--';
  }
}

function updateEnergyDisplay() {
  document.getElementById('rt-energy').textContent = energy.wh.toFixed(4);
  document.getElementById('rt-capacity').textContent = energy.mah.toFixed(2);
}

// Reset functions
function resetStats() {
  stats = {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  };
  updateStatsDisplay();
}

function resetEnergy() {
  energy = { wh: 0, mah: 0, lastTimestamp: null };
  updateEnergyDisplay();
}

// resetStatsAndEnergy is no longer used (merged into clearAndResetStats)

function clearChart() {
  chartData = { timestamps: [], voltage: [], current: [], power: [], temp: [] };
  chartSeries = { voltage: [], current: [], power: [], temp: [] };
  renderSeries = { voltage: [], current: [], power: [], temp: [] };
  navigatorSeries = { power: [] };
  DOWNSAMPLE_CONFIG.lastRebuildCount = 0;
  DOWNSAMPLE_CONFIG.navLastRebuildCount = 0;
  lastRecordingStartTime = null;
  recordedData = [];
  
  // Reset temperature data flag if not connected to temp service
  if (!isTempConnected) {
    hasTempData = false;
    updateTempUIVisibility();
  }
  
  mainChart.data.datasets[0].data = renderSeries.voltage;
  mainChart.data.datasets[1].data = renderSeries.current;
  mainChart.data.datasets[2].data = renderSeries.power;
  mainChart.data.datasets[3].data = renderSeries.temp;
  mainChart.update('none');
  
  if (navigatorChart) {
    navigatorChart.data.datasets[0].data = navigatorSeries.power;
    navigatorChart.update('none');
  }
  
  document.getElementById('data-count').textContent = '0';
}

// Connection functions
async function refreshDeviceList() {
  try {
    deviceList = await invoke('enumerate_devices');
    const select = document.getElementById('device-select');
    
    // 清空现有选项
    select.innerHTML = '';
    
    if (deviceList.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '-- 未检测到设备 --';
      select.appendChild(option);
      selectedDevicePath = null;
    } else {
      deviceList.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.path;
        option.textContent = device.display_name;
        option.dataset.vid = device.vid;
        option.dataset.pid = device.pid;
        option.dataset.sn = device.serial_number || '';
        option.dataset.model = device.model_name;
        select.appendChild(option);
      });
      
      // 默认选中第一个设备
      if (deviceList.length > 0) {
        select.selectedIndex = 0;
        onDeviceSelect();
      }
    }
    
    return deviceList;
  } catch (e) {
    console.error('枚举设备失败:', e);
    const select = document.getElementById('device-select');
    select.innerHTML = '<option value="">-- 枚举设备失败 --</option>';
    return [];
  }
}

function onDeviceSelect() {
  const select = document.getElementById('device-select');
  const selectedOption = select.options[select.selectedIndex];
  
  if (selectedOption && selectedOption.value) {
    selectedDevicePath = selectedOption.value;
    const vid = selectedOption.dataset.vid;
    const pid = selectedOption.dataset.pid;
    const sn = selectedOption.dataset.sn || '--';
    
    document.getElementById('device-vid').value = `0x${vid.toString(16).toUpperCase().padStart(4, '0')}`;
    document.getElementById('device-pid').value = `0x${pid.toString(16).toUpperCase().padStart(4, '0')}`;
    document.getElementById('device-sn').value = sn || '--';
  } else {
    selectedDevicePath = null;
    document.getElementById('device-vid').value = '--';
    document.getElementById('device-pid').value = '--';
    document.getElementById('device-sn').value = '--';
  }
}

async function connectDevice() {
  try {
    let result;
    
    if (selectedDevicePath) {
      // 使用选中的设备路径连接
      result = await invoke('connect_device_by_path', { path: selectedDevicePath });
    } else {
      // 回退到VID/PID方式
      const vidStr = document.getElementById('device-vid').value;
      const pidStr = document.getElementById('device-pid').value;
      const vid = parseInt(vidStr);
      const pid = parseInt(pidStr);
      
      if (isNaN(vid) || isNaN(pid)) {
        alert('请先选择一个设备或输入有效的VID/PID');
        return;
      }
      
      result = await invoke('connect_device', { vid, pid });
    }
    
    // 获取连接后的设备信息
    const deviceInfo = await invoke('get_current_device_info');
    if (deviceInfo) {
      document.getElementById('device-vid').value = `0x${deviceInfo.vid.toString(16).toUpperCase().padStart(4, '0')}`;
      document.getElementById('device-pid').value = `0x${deviceInfo.pid.toString(16).toUpperCase().padStart(4, '0')}`;
      document.getElementById('device-sn').value = deviceInfo.serial_number || '--';
      document.getElementById('device-name-text').textContent = deviceInfo.model_name;
    }
    
    setConnected(true);

    // Apply current sample rate immediately on first connect to avoid low default rate
    try {
      await invoke('set_sample_rate', { rate: settings.sampleRate });
    } catch (err) {
      console.error('Failed to apply sample rate on connect:', err);
    }
  } catch (e) {
    alert('连接失败: ' + e);
  }
}

async function disconnectDevice() {
  try {
    await invoke('disconnect_device');
    setConnected(false);
    document.getElementById('device-name-text').textContent = '--';
  } catch (e) {
    alert('断开失败: ' + e);
  }
}

function setConnected(connected) {
  isConnected = connected;
  document.getElementById('connection-status').classList.toggle('connected', connected);
  document.getElementById('connection-text').textContent = connected ? '已连接' : '未连接';
  document.getElementById('btn-connect').disabled = connected;
  document.getElementById('btn-disconnect').disabled = !connected;
  document.getElementById('btn-start-record').disabled = !connected;
  document.getElementById('device-select').disabled = connected;
  document.getElementById('btn-refresh-devices').disabled = connected;
  // If device disconnected while recording, stop recording immediately
  if (!connected && isRecording) {
    stopRecording();
  }
}

// Recording functions
function startRecording() {
  // Require explicit connection and no existing recording session
  if (!isConnected) {
    console.warn('Attempted to start recording while not connected');
    return;
  }
  if (isRecording) {
    return;
  }

  isRecording = true;
  recordingStartTime = Date.now();
  lastRecordingStartTime = recordingStartTime;
  console.info('Recording started');
  recordedData = [];
  document.getElementById('record-status').textContent = '记录中...';
  document.getElementById('btn-start-record').disabled = true;
  document.getElementById('btn-stop-record').disabled = false;

  if (typeof __setRangeControlsEnabled === 'function') {
    __setRangeControlsEnabled(false);
  }
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  recordingStartTime = null;
  document.getElementById('record-status').textContent = '停止';
  document.getElementById('btn-start-record').disabled = !isConnected;
  document.getElementById('btn-stop-record').disabled = true;

  if (typeof __setRangeControlsEnabled === 'function') {
    __setRangeControlsEnabled(true);
  }
}

function clearAndResetStats() {
  clearChart();
  resetStats();
  resetEnergy();
}

async function exportCSV(withTemp = false) {
  const data = recordedData.length > 0 ? recordedData : chartData.timestamps.map((ts, i) => {
    // compute relative time from first timestamp
    const baseline = chartData.timestamps[0] || ts || 0;
    const relSec = baseline ? ((ts - baseline) / 1000) : 0;
    const rel = formatRelativeHMS(relSec);
    return {
      timestamp: rel,
      voltage: chartData.voltage[i],
      current: chartData.current[i],
      power: chartData.power[i],
      temp: chartData.temp[i] || 0,
      relSeconds: relSec
    };
  });
  
  if (data.length === 0) {
    alert('没有数据可导出');
    return;
  }

  // Helper to format time as ="HH:mm:ss.ms"
  const formatExcelTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `="${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}"`;
  };

  // Metadata
  const sum = data.length;
  const sampTime = settings.sampleRate;
  // Use recorded start time if available, otherwise first timestamp of chart
  const startTime = (recordedData.length > 0 && lastRecordingStartTime) ? lastRecordingStartTime : (chartData.timestamps[0] || Date.now());
  
  // Format DateTime as YYYY-MM-DD HH:mm:ss
  const d = new Date(startTime);
  const pad = (n) => String(n).padStart(2, '0');
  const dateTimeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  
  // Calculate TotalTime
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
  
  data.forEach(row => {
    const timeStr = formatExcelTime(row.relSeconds || 0);
    // Ensure 4 decimal places for values
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
      filters: [{
        name: 'CSV File',
        extensions: ['csv']
      }],
      defaultPath: `witrn_data_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
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

async function importCSV() {
  try {
    if (chartData.timestamps.length > 0) {
      const confirmed = await ask('当前已有数据，导入CSV将清除现有记录。\n确定要继续吗？', {
        title: '确认导入',
        type: 'warning'
      });
      if (!confirmed) return;
    }

    const selected = await open({
      multiple: false,
      filters: [{
        name: 'CSV File',
        extensions: ['csv']
      }]
    });

    if (!selected) return;

    const content = await readTextFile(selected);
    const lines = content.split('\n');
    
    // Basic validation and parsing
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

    // Temporary storage
    const newSeconds = [];
    const newTimestamps = [];
    const newVoltage = [];
    const newCurrent = [];
    const newPower = [];
    const newTemp = [];
    const newRecordedData = [];
    
    let newSampleRate = settings.sampleRate;
    let newStartTime = Date.now();
    
    // Check if header includes temperature
    const headerLine = lines[dataStartIndex - 1] || '';
    const hasTemp = headerLine.includes('Temp');

    // Parse sample rate if available
    const sampTimeLine = lines.find(l => l.startsWith('SampTime(ms),'));
    if (sampTimeLine) {
      const rate = parseInt(sampTimeLine.split(',')[1]);
      if (!isNaN(rate)) newSampleRate = rate;
    }

    // Parse start time if available
    const dateTimeLine = lines.find(l => l.startsWith('DateTime,'));
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

      // Time format: ="00:00:00.000" or just 00:00:00.000
      let timeStr = parts[0].replace(/="/g, '').replace(/"/g, '');
      const voltage = parseFloat(parts[1]);
      const current = Math.abs(parseFloat(parts[2])); // Force absolute value for current
      const power = parseFloat(parts[3]);
      const temp = hasTemp && parts.length > 4 ? parseFloat(parts[4]) || 0 : 0;

      if (isNaN(voltage) || isNaN(current) || isNaN(power)) continue;

      // Parse time string to seconds for relative time
      const timeParts = timeStr.split(':');
      let seconds = 0;
      if (timeParts.length === 3) {
        seconds += parseInt(timeParts[0]) * 3600;
        seconds += parseInt(timeParts[1]) * 60;
        seconds += parseFloat(timeParts[2]);
      }

      const timestamp = newStartTime + (seconds * 1000);
      
      // Fix: Use consistent label format (X.XXXs)
      newSeconds.push(seconds);
      newTimestamps.push(timestamp);
      newVoltage.push(voltage);
      newCurrent.push(current);
      newPower.push(power);
      newTemp.push(temp);

      // Populate recordedData so it can be re-exported
      newRecordedData.push({
        timestamp: formatRelativeHMS(seconds),
        voltage: voltage,
        current: current,
        power: power,
        temp: temp,
        relSeconds: seconds
      });
    }

    if (newTimestamps.length === 0) {
      throw new Error('No valid data found in CSV');
    }

    // Commit changes
    clearAndResetStats();
    
    settings.sampleRate = newSampleRate;
    document.getElementById('sample-rate').value = newSampleRate;
    lastRecordingStartTime = newStartTime;

    chartData.timestamps = newTimestamps;
    chartData.voltage = newVoltage;
    chartData.current = newCurrent;
    chartData.power = newPower;
    chartData.temp = newTemp;
    recordedData = newRecordedData;

    chartSeries.voltage = newVoltage.map((v, i) => ({ x: newSeconds[i], y: v }));
    chartSeries.current = newCurrent.map((v, i) => ({ x: newSeconds[i], y: v }));
    chartSeries.power = newPower.map((v, i) => ({ x: newSeconds[i], y: v }));
    chartSeries.temp = newTemp.map((v, i) => ({ x: newSeconds[i], y: v }));

    // Re-calculate stats
    for (let i = 0; i < newVoltage.length; i++) {
      updateStats('voltage', newVoltage[i]);
      updateStats('current', newCurrent[i]);
      updateStats('power', newPower[i]);
      if (newTemp[i] !== 0) {
        updateStats('temp', newTemp[i]);
      }
    }

    // Calculate energy from imported data
    energy.wh = 0;
    energy.mah = 0;
    energy.lastTimestamp = null;

    for (let i = 1; i < newTimestamps.length; i++) {
      const dt = (newTimestamps[i] - newTimestamps[i-1]) / 3600000; // hours
      const currentAbs = Math.abs(newCurrent[i]);
      const powerAbs = Math.abs(newPower[i]);
      
      energy.wh += powerAbs * dt;
      energy.mah += currentAbs * 1000 * dt;
    }
    
    // Check if imported data has temperature
    const importedHasTemp = newTemp.some(t => t !== 0);
    if (importedHasTemp) {
      hasTempData = true;
    }

    // Update UI
    updateStatsDisplay();
    updateEnergyDisplay();
    document.getElementById('data-count').textContent = chartData.timestamps.length;
    
    // Rebuild downsampled data for imported data
    DOWNSAMPLE_CONFIG.lastRebuildCount = 0;
    DOWNSAMPLE_CONFIG.navLastRebuildCount = 0;
    rebuildRenderSeries();
    rebuildNavigatorSeries();
    
    // Update chart
    mainChart.data.datasets[0].data = renderSeries.voltage;
    mainChart.data.datasets[1].data = renderSeries.current;
    mainChart.data.datasets[2].data = renderSeries.power;
    mainChart.data.datasets[3].data = renderSeries.temp;
    
    updateChartRange();
    mainChart.update();
    
    if (navigatorChart) {
      const lastX = chartSeries.power.length
        ? (chartSeries.power[chartSeries.power.length - 1]?.x ?? 0)
        : 0;

      if (navigatorChart.options?.scales?.x) {
        const navPad = Math.max(lastX * 0.005, 0.05);
        navigatorChart.options.scales.x.min = -navPad;
        navigatorChart.options.scales.x.max = lastX + navPad;
      }

      navigatorChart.data.datasets[0].data = navigatorSeries.power;
      navigatorChart.update();
    }
    
    // Update temperature UI visibility
    updateTempUIVisibility();

    alert(`成功导入 ${newTimestamps.length} 条数据`);

  } catch (e) {
    console.error(e);
    alert('导入失败: ' + e.message);
  }
}



// Setup chart visibility toggles
function setupChartToggles() {
  const fields = ['voltage', 'current', 'power', 'temp'];
  fields.forEach((field, index) => {
    const checkbox = document.getElementById(`show-${field}`);
    if (!checkbox) return;
    const key = `show${field.charAt(0).toUpperCase() + field.slice(1)}`;

    // Ensure settings and chart visibility reflect the checkbox initial state
    settings[key] = checkbox.checked;
    if (mainChart && typeof mainChart.setDatasetVisibility === 'function') {
      // For temp, only show if we have temp data
      const shouldShow = field === 'temp' ? (checkbox.checked && (isTempConnected || hasTempData)) : checkbox.checked;
      mainChart.setDatasetVisibility(index, shouldShow);
    } else if (mainChart && mainChart.data && mainChart.data.datasets[index]) {
      mainChart.data.datasets[index].hidden = !checkbox.checked;
    }
    if (mainChart && mainChart.options && mainChart.options.scales) {
      const shouldShow = field === 'temp' ? (checkbox.checked && (isTempConnected || hasTempData)) : checkbox.checked;
      mainChart.options.scales[`y-${field}`].display = shouldShow;
    }

    checkbox.addEventListener('change', () => {
      settings[key] = checkbox.checked;
      
      // For temp, only affect visibility if we have temp data
      if (field === 'temp') {
        updateTempUIVisibility();
        debouncedSaveSettings();
        return;
      }
      
      if (mainChart && typeof mainChart.setDatasetVisibility === 'function') {
        mainChart.setDatasetVisibility(index, checkbox.checked);
      } else if (mainChart && mainChart.data && mainChart.data.datasets[index]) {
        mainChart.data.datasets[index].hidden = !checkbox.checked;
      }
      if (mainChart && mainChart.options && mainChart.options.scales) {
        mainChart.options.scales[`y-${field}`].display = checkbox.checked;
      }
      mainChart.update();
      debouncedSaveSettings();
    });
  });

  // Fill chart toggle
  // Removed global toggle, using individual toggles

  const fillControls = [
    { id: 'fill-voltage', opId: 'opacity-voltage', key: 'Voltage' },
    { id: 'fill-current', opId: 'opacity-current', key: 'Current' },
    { id: 'fill-power', opId: 'opacity-power', key: 'Power' },
    { id: 'fill-temp', opId: 'opacity-temp', key: 'Temp' }
  ];

  fillControls.forEach((ctrl, index) => {
    const checkbox = document.getElementById(ctrl.id);
    const input = document.getElementById(ctrl.opId);
    
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        const fill = e.target.checked;
        settings[`fill${ctrl.key}`] = fill;
        if (mainChart && mainChart.data.datasets[index]) {
          mainChart.data.datasets[index].fill = fill;
          mainChart.update('none');
        }
        debouncedSaveSettings();
      });
    }

    if (input) {
      input.addEventListener('input', (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val)) val = 15;
        if (val < 0) val = 0;
        if (val > 100) val = 100;
        
        settings[`opacity${ctrl.key}`] = val;
        
        if (mainChart && mainChart.data.datasets[index]) {
          const hex = mainChart.data.datasets[index].borderColor;
          mainChart.data.datasets[index].backgroundColor = hexToRgba(hex, val);
          mainChart.update('none');
        }
        debouncedSaveSettings();
      });
    }
  });


  if (mainChart) mainChart.update();
}

// Setup other controls
function setupControls() {
  const rangeStart = document.getElementById('range-start');
  const rangeEnd = document.getElementById('range-end');
  const handleStart = document.getElementById('range-handle-start');
  const handleEnd = document.getElementById('range-handle-end');
  const sliderContainer = document.querySelector('.dual-slider-container');

  __setRangeControlsEnabled = (enabled) => {
    if (rangeStart) rangeStart.disabled = !enabled;
    if (rangeEnd) rangeEnd.disabled = !enabled;

    if (handleStart) {
      handleStart.tabIndex = enabled ? 0 : -1;
      if (!enabled) handleStart.blur();
    }
    if (handleEnd) {
      handleEnd.tabIndex = enabled ? 0 : -1;
      if (!enabled) handleEnd.blur();
    }

    if (sliderContainer) {
      sliderContainer.classList.toggle('disabled', !enabled);
    }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function applyRangeValues(nextStart, nextEnd, leader) {
    if (isRecording) return;
    let start = clamp(parseInt(nextStart), 0, 1000);
    let end = clamp(parseInt(nextEnd), 0, 1000);

    // Enforce start <= end
    if (start > end) {
      if (leader === 'start') {
        start = end;
      } else {
        end = start;
      }
    }

    rangeStart.value = String(start);
    rangeEnd.value = String(end);
    settings.rangeStart = start;
    settings.rangeEnd = end;

    updateSliderFill();
    updateChartRange();
    if (settings.statsRange) {
      updateStatsDisplay();
    }
    mainChart.update();
  }

  function onSliderChange(leader) {
    applyRangeValues(rangeStart.value, rangeEnd.value, leader);
  }

  rangeStart.addEventListener('input', () => onSliderChange('start'));
  rangeEnd.addEventListener('input', () => onSliderChange('end'));

  function valueFromPointerEvent(event) {
    if (!sliderContainer) return 0;
    const rect = sliderContainer.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    return clamp(Math.round(ratio * 1000), 0, 1000);
  }

  function setupHandleInteractions(handle, which) {
    if (!handle) return;

    handle.addEventListener('pointerdown', (event) => {
      if (isRecording) return;
      event.preventDefault();
      handle.focus();
      handle.setPointerCapture(event.pointerId);

      const newValue = valueFromPointerEvent(event);
      if (which === 'start') {
        applyRangeValues(newValue, rangeEnd.value, 'start');
      } else {
        applyRangeValues(rangeStart.value, newValue, 'end');
      }
    });

    handle.addEventListener('pointermove', (event) => {
      if (isRecording) return;
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const newValue = valueFromPointerEvent(event);
      if (which === 'start') {
        applyRangeValues(newValue, rangeEnd.value, 'start');
      } else {
        applyRangeValues(rangeStart.value, newValue, 'end');
      }
    });

    handle.addEventListener('keydown', (event) => {
      if (isRecording) return;
      const key = event.key;
      const isLeft = key === 'ArrowLeft';
      const isRight = key === 'ArrowRight';
      const isHome = key === 'Home';
      const isEnd = key === 'End';
      if (!isLeft && !isRight && !isHome && !isEnd) return;

      event.preventDefault();

      const baseStep = event.shiftKey ? 10 : (event.ctrlKey ? 50 : 1);
      const current = which === 'start' ? parseInt(rangeStart.value) : parseInt(rangeEnd.value);
      let next = current;

      if (isHome) next = 0;
      else if (isEnd) next = 1000;
      else if (isLeft) next = current - baseStep;
      else if (isRight) next = current + baseStep;

      next = clamp(next, 0, 1000);
      if (which === 'start') {
        applyRangeValues(next, rangeEnd.value, 'start');
      } else {
        applyRangeValues(rangeStart.value, next, 'end');
      }
    });
  }

  setupHandleInteractions(handleStart, 'start');
  setupHandleInteractions(handleEnd, 'end');
  
  // Initial fill update
  updateSliderFill();

  // Ensure initial enabled state
  if (typeof __setRangeControlsEnabled === 'function') {
    __setRangeControlsEnabled(!isRecording);
  }
  
  document.getElementById('sample-rate').addEventListener('change', async (e) => {
    settings.sampleRate = parseInt(e.target.value);
    updateChartRange();
    mainChart.update();
    if (isConnected) {
      try {
        await invoke('set_sample_rate', { rate: settings.sampleRate });
      } catch (e) {
        console.error('Failed to set sample rate:', e);
      }
    }
    debouncedSaveSettings();
  });
  
  document.getElementById('btn-connect').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); connectDevice(); });
  document.getElementById('btn-disconnect').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); disconnectDevice(); });
  document.getElementById('btn-refresh-devices').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); refreshDeviceList(); });
  document.getElementById('device-select').addEventListener('change', onDeviceSelect);
  document.getElementById('btn-start-record').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); startRecording(); });
  document.getElementById('btn-stop-record').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); stopRecording(); });

  const statsRangeToggle = document.getElementById('stats-range-toggle');
  if (statsRangeToggle) {
    statsRangeToggle.addEventListener('change', (e) => {
      settings.statsRange = e.target.checked;
      updateStatsDisplay();
      debouncedSaveSettings();
    });
  }
  
  // Export dropdown menu
  const exportBtn = document.getElementById('btn-export');
  const exportDropdown = document.getElementById('export-dropdown');
  const exportNoTemp = document.getElementById('export-no-temp');
  const exportWithTemp = document.getElementById('export-with-temp');
  
  if (exportBtn && exportDropdown) {
    // Fix: Use fixed positioning to penetrate toolbar overflow
    const updatePosition = () => {
      if (exportDropdown.classList.contains('show')) {
        const rect = exportBtn.getBoundingClientRect();
        exportDropdown.style.top = `${rect.bottom + 2}px`;
        exportDropdown.style.left = `${rect.left}px`;
      }
    };

    const toggleDropdown = (show) => {
      if (show) {
        exportDropdown.style.position = 'fixed';
        exportDropdown.style.width = 'auto';
        exportDropdown.style.minWidth = '120px';
        exportDropdown.classList.add('show');
        updatePosition();
      } else {
        exportDropdown.classList.remove('show');
      }
    };

    exportBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isShown = exportDropdown.classList.contains('show');
      toggleDropdown(!isShown);
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!exportBtn.contains(e.target) && !exportDropdown.contains(e.target)) {
        toggleDropdown(false);
      }
    });

    // Update position on resize/scroll to keep menu attached
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    
    if (exportNoTemp) {
      exportNoTemp.addEventListener('click', () => {
        toggleDropdown(false);
        exportCSV(false);
      });
    }
    
    if (exportWithTemp) {
      exportWithTemp.addEventListener('click', () => {
        toggleDropdown(false);
        exportCSV(true);
      });
    }
  }
  
  document.getElementById('btn-import').addEventListener('click', importCSV);
  document.getElementById('btn-reset-settings').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const yes = await ask('确定要重置所有配置为默认值吗？', { title: '确认重置配置', type: 'warning' });
    if (yes) {
      await resetSettings();
    }
  });
  document.getElementById('btn-clear-chart').addEventListener('click', async (e) => { 
    e.preventDefault(); 
    e.stopPropagation(); 
    const yes = await ask('确定要清空图表并重置所有统计数据吗？', { title: '确认重置', type: 'warning' });
    if (yes) {
      clearAndResetStats(); 
    }
  });
  
  // Temperature service controls
  document.getElementById('btn-temp-connect').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    connectTempService();
  });
  
  document.getElementById('btn-temp-disconnect').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    disconnectTempService();
  });
  
  // Save temperature service settings when changed
  document.getElementById('temp-ip').addEventListener('change', (e) => {
    settings.tempIp = e.target.value;
    debouncedSaveSettings();
  });
  
  document.getElementById('temp-port').addEventListener('change', (e) => {
    settings.tempPort = parseInt(e.target.value) || 1573;
    debouncedSaveSettings();
  });

  // Auto Pause Controls
  const apToggle = document.getElementById('btn-auto-pause-toggle');
  const apBasis = document.getElementById('ap-basis');
  const apCondition = document.getElementById('ap-condition');
  const apDuration = document.getElementById('ap-duration');

  const apUnit = document.getElementById('ap-unit');

  function updateApUnit() {
    const basis = apBasis.value;
    if (basis === 'voltage') apUnit.textContent = 'V';
    else if (basis === 'current') apUnit.textContent = 'A';
    else if (basis === 'power') apUnit.textContent = 'W';
    else apUnit.textContent = '';
  }

  apToggle.addEventListener('change', () => {
    autoPauseSettings.enabled = apToggle.checked;
    // Reset trigger state when toggling
    autoPauseSettings.triggerStartTime = null;
    debouncedSaveSettings();
  });

  apBasis.addEventListener('change', (e) => {
    autoPauseSettings.basis = e.target.value;
    autoPauseSettings.triggerStartTime = null;
    updateApUnit();
    debouncedSaveSettings();
  });
  
  // Initialize unit
  updateApUnit();

  apCondition.addEventListener('change', (e) => {
    autoPauseSettings.condition = parseFloat(e.target.value) || 0;
    autoPauseSettings.triggerStartTime = null;
    debouncedSaveSettings();
  });

  apDuration.addEventListener('change', (e) => {
    autoPauseSettings.duration = parseFloat(e.target.value) || 0;
    autoPauseSettings.triggerStartTime = null;
    debouncedSaveSettings();
  });

  // Initialize settings from DOM
  autoPauseSettings.basis = apBasis.value;
  autoPauseSettings.condition = parseFloat(apCondition.value) || 0;
  autoPauseSettings.duration = parseFloat(apDuration.value) || 0;

  // Removed reset-zoom button and binding since zoom functionality is disabled
  // btn-reset-energy removed; no binding needed
}

// Setup Tauri event listener
async function setupEventListener() {
  await listen('device-data', (event) => {
    addDataPoint(event.payload);
  });
  
  await listen('device-disconnected', async () => {
    if (isConnected) {
      await disconnectDevice();
      await message('设备连接已断开', { title: '连接断开', type: 'warning' });
    }
  });
  
  // Listen for temperature data
  await listen('temp-data', (event) => {
    currentTemp = event.payload;
    // Update temperature display
    if (isTempConnected) {
      document.getElementById('rt-temp').textContent = currentTemp.toFixed(1);
      // Stats are now updated in addDataPoint to synchronize with recording/sampling
    }
  });
  
  // Listen for temperature disconnect event
  await listen('temp-disconnected', () => {
    setTempConnected(false);
    console.info('Temperature service disconnected');
  });
}

// Temperature service functions
async function connectTempService() {
  const ip = document.getElementById('temp-ip').value || '127.0.0.1';
  const port = parseInt(document.getElementById('temp-port').value) || 1573;
  
  try {
    await invoke('connect_temp_service', { ip, port });
    setTempConnected(true);
    settings.tempIp = ip;
    settings.tempPort = port;
  } catch (e) {
    alert('温度服务连接失败: ' + e);
  }
}

async function disconnectTempService() {
  try {
    await invoke('disconnect_temp_service');
    setTempConnected(false);
  } catch (e) {
    alert('断开温度服务失败: ' + e);
  }
}

function setTempConnected(connected) {
  isTempConnected = connected;
  document.getElementById('temp-connection-status').classList.toggle('connected', connected);
  document.getElementById('temp-connection-text').textContent = connected ? '已连接' : '未连接';
  document.getElementById('btn-temp-connect').disabled = connected;
  document.getElementById('btn-temp-disconnect').disabled = !connected;
  document.getElementById('temp-ip').disabled = connected;
  document.getElementById('temp-port').disabled = connected;
  
  if (connected) {
    hasTempData = true;
  }
  
  if (!connected) {
    currentTemp = null;
    document.getElementById('rt-temp').textContent = '--';
  }
  
  // Update temperature UI visibility
  updateTempUIVisibility();
}

// Update temperature-related UI visibility based on whether we have temp data
function updateTempUIVisibility() {
  const showTemp = isTempConnected || hasTempData;
  
  // Show/hide temperature card
  const tempCard = document.getElementById('temp-card');
  if (tempCard) {
    tempCard.style.display = showTemp ? 'flex' : 'none';
  }
  
  // Show/hide export with temp option
  const exportWithTemp = document.getElementById('export-with-temp');
  if (exportWithTemp) {
    exportWithTemp.classList.toggle('hidden', !showTemp);
  }

  // Show/hide temperature checkbox in channel selection
  const showTempContainer = document.getElementById('show-temp-container');
  if (showTempContainer) {
    showTempContainer.style.display = showTemp ? 'inline-block' : 'none';
  }
  
  // Show/hide temperature fill controls
  const fillTempContainer = document.getElementById('fill-temp-container');
  if (fillTempContainer) {
    fillTempContainer.style.display = showTemp ? 'flex' : 'none';
  }
  
  // Show/hide temperature chart dataset
  if (mainChart && mainChart.data && mainChart.data.datasets[3]) {
    const tempVisible = showTemp && settings.showTemp;
    mainChart.setDatasetVisibility(3, tempVisible);
    if (mainChart.options && mainChart.options.scales && mainChart.options.scales['y-temp']) {
      mainChart.options.scales['y-temp'].display = tempVisible;
    }
    mainChart.update('none');
  }
}

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
  // 禁用右键菜单，防止误操作
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  console.log('=== DOMContentLoaded START ===');
  
  // Direct store test using raw invoke
  try {
    console.log('Testing store with raw invoke...');
    const rid = await invoke("plugin:store|load", { path: "settings.json", options: {} });
    console.log('Store loaded, rid:', rid);
    const result = await invoke("plugin:store|get", { rid: rid, key: "appSettings" });
    console.log('Raw store get result:', result);
  } catch (e) {
    console.error('Raw store test failed:', e);
  }

  await setupCloseConfirm();
  await loadSettings();
  initChart();
  setupChartToggles();
  setupControls();
  // Ensure clean recording state on load
  isRecording = false;
  recordedData = [];
  await setupEventListener();
  // 启动时自动扫描设备
  await refreshDeviceList();
  
  // Initialize temperature UI visibility (hidden by default)
  updateTempUIVisibility();
  
  console.log('=== DOMContentLoaded END ===');
});

