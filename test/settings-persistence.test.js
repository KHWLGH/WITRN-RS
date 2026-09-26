import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 设置持久化的失败路径。
 *
 * 关键点：store 的读写失败今天只落 console.error，用户看到的却是「已保存」，
 * 于是重启后设置全部回滚而没人知道。这里把「失败必须被说出来」钉成契约。
 */

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map();
/** @param {string} id */
function el(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      title: '',
      style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      appendChild() {},
      addEventListener() {},
      querySelector: () => null,
    });
  }
  return elements.get(id);
}
globalThis.document = {
  getElementById: el,
  documentElement: {
    style: { setProperty() {} },
    setAttribute() {},
    getAttribute: () => null,
    classList: { toggle() {} },
  },
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => el(`__created:${Math.random()}`),
  dispatchEvent: () => true,
};
globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 0;
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { state } = await import('../src/state.js');
const { getStore, saveSettings, resetSettings } = await import('../src/settings.js');
const { toast } = await import('../src/ui/toast.js');

/** @type {{command:string, args:Record<string,unknown>}[]} */
let calls = [];
/** @type {Map<string, (args:any)=>any>} */
let failures = new Map();
/** @type {any[]} */
let errorToasts = [];

function installStoreStub() {
  calls = [];
  failures = new Map();
  errorToasts = [];
  toast.error = (message) => errorToasts.push(String(message));
  toast.success = () => {};
  toast.warning = () => {};
  let rid = 0;
  const saved = new Map();
  globalThis.window.__TAURI__.core.invoke = async (command, args = {}) => {
    calls.push({ command, args });
    const failWith = failures.get(command);
    if (failWith) return failWith(args);
    if (command === 'plugin:store|load') return ++rid;
    if (command === 'plugin:store|get') {
      const has = saved.has(String(args.key));
      return [has ? saved.get(String(args.key)) : null, has];
    }
    if (command === 'plugin:store|set') saved.set(String(args.key), args.value);
    if (command === 'plugin:store|delete') saved.delete(String(args.key));
    return null;
  };
}

function resetSettingsState() {
  state.isConnected = false;
  state.isRecording = false;
  state.settings.sampleRate = 250;
}

const LOAD = 'plugin:store|load';
const SAVE = 'plugin:store|save';

test('a rejected store load is retried instead of poisoning persistence', async () => {
  installStoreStub();
  failures.set(LOAD, () => {
    throw new Error('store path unavailable');
  });
  resetSettingsState();

  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(await saveSettings(), false, '加载失败必须报告为未持久化');
    failures.delete(LOAD);
    assert.equal(await saveSettings(), true, '恢复后必须重新尝试建 store');
  } finally {
    console.error = log;
  }
  const wrote = calls.filter((c) => c.command === 'plugin:store|set').length;
  assert.equal(wrote, 1, '一次成功写入');
});

test('a write failure is told to the user exactly once per fault period', async () => {
  installStoreStub();
  resetSettingsState();
  failures.set(SAVE, () => {
    throw new Error('EPERM');
  });

  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(await saveSettings(), false);
    assert.equal(await saveSettings(), false);
    assert.equal(await saveSettings(), false);
    assert.equal(errorToasts.length, 1, '防抖保存会反复触发，刷屏就是新 bug');
    assert.match(errorToasts[0], /写入|不会被保存/);

    failures.delete(SAVE);
    assert.equal(await saveSettings(), true);
    errorToasts.length = 0;
    failures.set(SAVE, () => {
      throw new Error('EPERM');
    });
    assert.equal(await saveSettings(), false);
    assert.equal(errorToasts.length, 1, '恢复过一次之后再次失败要重新提示');
  } finally {
    console.error = log;
  }
});

test('resetSettings reports whether the reset actually persisted', async () => {
  installStoreStub();
  resetSettingsState();

  const log = console.error;
  console.error = () => {};
  try {
    // 先跑一次干净的保存，结束上一个用例留下的故障期
    assert.equal(await saveSettings(), true);
    failures.set(SAVE, () => {
      throw new Error('locked by OneDrive');
    });
    assert.equal(await resetSettings(), false, 'UI 回到默认但没落盘，不能算成功');
    assert.equal(state.settings.sampleRate, 250, '默认值仍应落到内存里');
    assert.match(errorToasts.join('\n'), /写入|不会被保存/);
  } finally {
    console.error = log;
  }
});

test('a healthy store produces no failure toasts', async () => {
  installStoreStub();
  resetSettingsState();
  assert.equal(await saveSettings(), true);
  assert.equal(await getStore(), await getStore(), '单例仍然复用');
  assert.deepEqual(errorToasts, [], '干净路径不该出现任何错误提示');
});
