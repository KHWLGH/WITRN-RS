(() => {
  const events = new Map(),
    files = new Map(),
    settings = new Map();
  settings.set('appSettings', { signedCurrent: true, tempSource: 'device', sampleRate: 10 });
  let selectedFile = null,
    gen = 0,
    streamGeneration = 0;
  let nextFileHandle = 0;
  const openFiles = new Map();
  let stream = null;
  let sampleRateMs = 10;
  const calls = Object.create(null);
  const device = {
    path: 'bench://synthetic',
    display_name: 'BENCH simulated device (no HID)',
    vid: 0,
    pid: 0,
    serial_number: 'BENCH',
    model_name: 'simulated',
    interface_number: 0,
    usage_page: 0,
  };
  async function listen(name, fn) {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name).add(fn);
    return () => events.get(name).delete(fn);
  }
  function emit(name, payload) {
    for (const fn of events.get(name) || []) fn({ event: name, payload });
  }
  async function invoke(cmd, args = {}, options = {}) {
    calls[cmd] = (calls[cmd] || 0) + 1;
    if (cmd.startsWith('plugin:store|')) {
      switch (cmd.split('|')[1]) {
        case 'load':
        case 'get_store':
          return 1;
        case 'get':
          return [settings.get(args.key), settings.has(args.key)];
        case 'set':
          settings.set(args.key, structuredClone(args.value));
          return;
        case 'has':
          return settings.has(args.key);
        case 'delete':
          return settings.delete(args.key);
        case 'clear':
        case 'reset':
          settings.clear();
          return;
        case 'keys':
          return [...settings.keys()];
        case 'values':
          return [...settings.values()];
        case 'entries':
          return [...settings];
        case 'length':
          return settings.size;
        case 'save':
        case 'reload':
        case 'close':
          return;
      }
    }
    if (cmd === 'get_runtime_platform') return 'windows';
    if (cmd === 'enumerate_devices') return [device];
    if (cmd === 'get_current_device_info') return device;
    if (cmd === 'connect_device_by_path') {
      if (args.path !== device.path) throw new Error('Non-bench device blocked');
      stream = {
        generation: ++streamGeneration,
        wall_anchor_ms: 1704067200000,
        last_seq: 0,
        received_us: 0,
        segment: 0,
        segment_start_us: 0,
        ended: false,
      };
      const info = { generation: stream.generation, wall_anchor_ms: stream.wall_anchor_ms };
      emit('device-stream-open', info);
      return info;
    }
    if (cmd === 'set_recording_segment') {
      if (!stream || stream.ended || args.generation !== stream.generation) throw new Error('No simulated stream');
      stream.segment = args.segment;
      stream.segment_start_us = stream.received_us;
      return {
        generation: stream.generation,
        after_seq: stream.last_seq,
        segment: stream.segment,
        received_us: stream.received_us,
        wall_anchor_ms: stream.wall_anchor_ms,
        rate_ms: sampleRateMs,
      };
    }
    if (cmd === 'ack_device_stream') {
      if (!stream || args.generation !== stream.generation || args.seq > stream.last_seq)
        throw new Error('Invalid simulated ACK');
      return;
    }
    if (cmd === 'drain_device_stream') {
      if (!stream) return null;
      const end = { generation: stream.generation, last_seq: stream.last_seq };
      if (!stream.ended) {
        stream.ended = true;
        emit('device-stream-end', end);
      }
      return end;
    }
    if (cmd === 'pd_log_after') return [];
    if (cmd === 'pd_log_clear') return ++gen;
    if (cmd === 'csv_export_pick') {
      const path = 'bench://export.csv';
      files.set(path, '');
      const handle = ++nextFileHandle;
      openFiles.set(handle, { path, offset: 0, kind: 'write' });
      return { handle, name: 'export.csv', path, size: 0 };
    }
    if (cmd === 'csv_import_pick') {
      if (!selectedFile) return null;
      const text = files.get(selectedFile) ?? '';
      const handle = ++nextFileHandle;
      openFiles.set(handle, { path: selectedFile, offset: 0, kind: 'read' });
      return {
        handle,
        name: selectedFile.split('/').at(-1),
        path: selectedFile,
        size: new TextEncoder().encode(text).byteLength,
      };
    }
    if (cmd === 'spool_open') {
      const path = `bench://spool-${++nextFileHandle}.partial.csv`;
      files.set(path, '');
      const handle = nextFileHandle;
      openFiles.set(handle, { path, offset: 0, kind: 'write' });
      return { handle, name: path.split('/').at(-1), path, size: 0 };
    }
    if (cmd === 'spool_recovery_list') return [];
    if (cmd === 'spool_recovery_open' || cmd === 'spool_recovery_delete') return null;
    if (cmd === 'csv_read_chunk') {
      const entry = openFiles.get(args.handle);
      if (!entry) throw new Error('unknown read handle');
      const bytes = new TextEncoder()
        .encode(files.get(entry.path) ?? '')
        .slice(entry.offset, entry.offset + 4 * 1024 * 1024);
      entry.offset += bytes.byteLength;
      return bytes.buffer;
    }
    if (cmd === 'csv_read_close') {
      openFiles.delete(args.handle);
      return;
    }
    if (cmd === 'csv_write_chunk') {
      const handle = Number(options?.headers?.['x-handle']);
      const entry = openFiles.get(handle);
      if (!entry) throw new Error('unknown write handle');
      files.set(entry.path, (files.get(entry.path) ?? '') + new TextDecoder().decode(args));
      return;
    }
    if (cmd === 'csv_write_patch') {
      const handle = Number(options?.headers?.['x-handle']);
      const offset = Number(options?.headers?.['x-offset']);
      const entry = openFiles.get(handle);
      if (!entry) throw new Error('unknown write handle');
      const current = files.get(entry.path) ?? '';
      const patch = new TextDecoder().decode(args);
      files.set(entry.path, current.slice(0, offset) + patch + current.slice(offset + patch.length));
      return;
    }
    if (cmd === 'csv_write_sync') return;
    if (cmd === 'csv_write_close') {
      const entry = openFiles.get(args.handle);
      openFiles.delete(args.handle);
      if (args.options?.abort && entry) files.delete(entry.path);
      return;
    }
    if (cmd === 'set_sample_rate') {
      sampleRateMs = Number(args.rate) || sampleRateMs;
      return;
    }
    if (['set_sample_rate', 'disconnect_device', 'set_pd_capture_enabled', 'shutdown'].includes(cmd)) return;
    throw new Error(`Unimplemented simulated Tauri command: ${cmd}`);
  }
  function feed(samples) {
    if (!stream || stream.ended) throw new Error('No simulated stream');
    const batch = samples.map((sample) => {
      stream.received_us = sample.received_us;
      return {
        ...sample,
        generation: stream.generation,
        seq: ++stream.last_seq,
        segment: stream.segment,
        segment_start_us: stream.segment_start_us,
        wall_anchor_ms: stream.wall_anchor_ms,
        rate_ms: 10,
      };
    });
    emit('device-data-batch', batch);
  }
  const noop = async () => {};
  let maximized = false,
    fullscreen = false;
  const appWindow = {
    label: 'main',
    onCloseRequested: (fn) => listen('close', fn),
    onResized: (fn) => listen('resize', fn),
    onFocusChanged: (fn) => listen('focus', fn),
    onThemeChanged: (fn) => listen('theme', fn),
    isMaximized: async () => maximized,
    isFullscreen: async () => fullscreen,
    isMinimized: async () => false,
    isFocused: async () => true,
    scaleFactor: async () => devicePixelRatio,
    innerSize: async () => ({ width: innerWidth, height: innerHeight }),
    setZoom: noop,
    minimize: noop,
    maximize: async () => {
      maximized = true;
    },
    unmaximize: async () => {
      maximized = false;
    },
    toggleMaximize: async () => {
      maximized = !maximized;
      emit('resize');
    },
    setFullscreen: async (value) => {
      fullscreen = value;
      emit('resize');
    },
    startDragging: noop,
    startResizeDragging: noop,
    close: noop,
  };
  class LazyStore {
    async get(k) {
      return settings.get(k);
    }
    async set(k, v) {
      settings.set(k, v);
    }
    async save() {}
  }
  const checkPath = (path) => {
    if (typeof path !== 'string' || !path.startsWith('bench://')) throw new Error('Real filesystem access blocked');
  };
  const fs = {
    readTextFile: async (path) => {
      checkPath(path);
      if (!files.has(path)) throw new Error('Unknown virtual file');
      return files.get(path);
    },
    writeTextFile: async (path, text, options = {}) => {
      checkPath(path);
      files.set(path, (options.append ? files.get(path) || '' : '') + String(text));
    },
    open: async (path) => {
      checkPath(path);
      return {
        write: async (bytes) => {
          files.set(path, (files.get(path) || '') + new TextDecoder().decode(bytes));
          return bytes.length;
        },
        close: noop,
      };
    },
  };
  window.__TAURI__ = {
    core: { invoke },
    event: { listen, emit: async (name, payload) => emit(name, payload) },
    window: { getCurrentWindow: () => appWindow },
    webview: { getCurrentWebview: () => ({ setZoom: noop }) },
    store: { LazyStore },
    app: { getVersion: async () => '0.2.1-bench-simulated' },
    dialog: { open: async () => selectedFile, save: async () => 'bench://export.csv', ask: async () => true },
    fs,
  };
  window.__BENCH_TAURI__ = {
    environment: 'simulated Tauri / Edge; no native WebView, HID, Snap or window material',
    calls,
    emit,
    feed,
    listeners: () => Object.fromEntries([...events].map(([k, v]) => [k, v.size])),
    setImport: (text) => {
      selectedFile = 'bench://fixture.csv';
      files.set(selectedFile, text);
    },
    exportText: () => files.get('bench://export.csv'),
    clearExport: () => files.delete('bench://export.csv'),
  };
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const buttons = document.createElement('div');
      buttons.setAttribute('data-tauri-decorum-tb', '');
      for (const [action, handler] of [
        ['minimize', appWindow.minimize],
        ['maximize', appWindow.toggleMaximize],
        ['close', appWindow.close],
      ]) {
        const button = document.createElement('button');
        button.id = `decorum-tb-${action}`;
        button.className = 'decorum-tb-btn';
        button.addEventListener('click', handler);
        buttons.appendChild(button);
      }
      document.body.appendChild(buttons);
    },
    { once: true },
  );
})();
