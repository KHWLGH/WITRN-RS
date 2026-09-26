import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { defaultSettings } from '../src/state.js';
import { normalizeWindowStyle, resolveWindowStyle, WINDOW_STYLE_STORAGE_KEY } from '../src/window-style.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const boot = read('../src/theme-boot.js');
const controlsSource = read('../src/ui/windowcontrols.js');
const styleSource = read('../src/window-style.js');
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('window style normalizes valid preferences and falls back to auto', () => {
  for (const value of ['auto', 'windows', 'macos']) assert.equal(normalizeWindowStyle(value), value);
  for (const value of [undefined, null, '', 'MacOS', 'linux', 'system', 1, true, {}, []]) {
    assert.equal(normalizeWindowStyle(value), 'auto');
  }
  assert.equal(defaultSettings.windowStyle, 'auto');
});

test('all three preferences are available on all three real platforms', () => {
  for (const os of ['windows', 'macos', 'linux']) {
    assert.equal(resolveWindowStyle('auto', os), os === 'macos' ? 'macos' : 'windows');
    assert.equal(resolveWindowStyle('windows', os), 'windows');
    assert.equal(resolveWindowStyle('macos', os), 'macos');
    assert.equal(resolveWindowStyle('bad', os), resolveWindowStyle('auto', os));
  }
  assert.equal(resolveWindowStyle(undefined, undefined), 'windows');
});

function bootContext(os, preference, unavailable = false) {
  const attrs = new Map();
  const mirror = new Map([[WINDOW_STYLE_STORAGE_KEY, preference]]);
  const inputs = new Map(['auto', 'windows', 'macos'].map((value) => [`window-style-${value}`, { checked: false }]));
  const context = {
    navigator: { userAgent: { windows: 'Windows NT', macos: 'Mac OS X', linux: 'Linux' }[os] },
    window: { matchMedia: () => ({ matches: false }) },
    document: {
      documentElement: {
        setAttribute: (name, value) => attrs.set(name, value),
        getAttribute: (name) => attrs.get(name),
      },
      getElementById: (id) => inputs.get(id),
    },
    localStorage: {
      getItem: (key) => {
        if (unavailable) throw new Error('storage unavailable');
        return mirror.get(key);
      },
      setItem: (key, value) => {
        if (unavailable) throw new Error('storage unavailable');
        mirror.set(key, value);
      },
    },
  };
  runInNewContext(boot, context);
  const api = runInNewContext(
    `${styleSource.replace(/^export /gm, '')}
({ applyWindowStyle, echoWindowStyleUI });`,
    context,
  );
  return { attrs, mirror, inputs, api };
}

test('first-paint mirror matches runtime resolution without spoofing data-os', () => {
  for (const os of ['windows', 'macos', 'linux']) {
    for (const preference of ['auto', 'windows', 'macos', 'broken', undefined]) {
      const { attrs, api } = bootContext(os, preference);
      assert.equal(attrs.get('data-window-style'), resolveWindowStyle(preference, os));
      api.applyWindowStyle(preference);
      assert.equal(attrs.get('data-os'), os);
      assert.equal(attrs.get('data-window-style'), resolveWindowStyle(preference, os));
    }
  }
});

test('loaded preference overrides mirror, echoes UI and resets to auto', () => {
  const { attrs, mirror, inputs, api } = bootContext('linux', 'macos');
  api.applyWindowStyle('windows');
  api.echoWindowStyleUI('windows');
  assert.equal(attrs.get('data-window-style'), 'windows');
  assert.equal(mirror.get(WINDOW_STYLE_STORAGE_KEY), 'windows');
  assert.equal(inputs.get('window-style-windows').checked, true);
  assert.equal(inputs.get('window-style-macos').checked, false);
  api.applyWindowStyle('invalid');
  api.echoWindowStyleUI('invalid');
  assert.equal(mirror.get(WINDOW_STYLE_STORAGE_KEY), 'auto');
  assert.equal(inputs.get('window-style-auto').checked, true);
  assert.equal(inputs.get('window-style-windows').checked, false);
  assert.equal(attrs.get('data-os'), 'linux');
});

test('unavailable localStorage does not prevent boot or style changes', () => {
  const { attrs, api } = bootContext('macos', 'windows', true);
  assert.equal(attrs.get('data-window-style'), 'macos');
  assert.doesNotThrow(() => api.applyWindowStyle('windows'));
  assert.equal(attrs.get('data-window-style'), 'windows');
  assert.equal(attrs.get('data-os'), 'macos');
});

test('settings controls expose the three styles without platform gating', () => {
  const html = read('../src/index.html');
  assert.match(html, /<div class="settings-row" id="window-style-row">/);
  assert.match(html, /role="radiogroup" aria-labelledby="window-style-label"/);
  for (const value of ['auto', 'windows', 'macos']) {
    const input = html.match(new RegExp(`<input[^>]*id="window-style-${value}"[^>]*>`))?.[0];
    assert.ok(input);
    assert.match(input, /type="radio" name="window-style"/);
    assert.match(input, new RegExp(`value="${value}"`));
    assert.doesNotMatch(input, /hidden|disabled/);
    assert.equal(input.includes('checked'), value === 'auto');
  }
  assert.match(html, /<option value="10">/);
  assert.ok(html.indexOf('theme-boot.js') < html.indexOf('styles/tokens.css'));
});

test('LazyStore load save reset and setting events include windowStyle', () => {
  const settings = read('../src/settings.js');
  const app = read('../src/app.js');
  assert.match(settings, /merged\.windowStyle = normalizeWindowStyle\(merged\.windowStyle\)/);
  assert.match(settings, /windowStyle: normalizeWindowStyle\(state\.settings\.windowStyle\)/);
  for (const name of ['loadSettings', 'resetSettings']) {
    const section = settings.split(`export async function ${name}()`)[1]?.split('export ')[0];
    assert.ok(section);
    assert.match(section, /echoWindowStyleUI\(state\.settings\.windowStyle\)/);
    assert.match(section, /applyWindowStyle\(state\.settings\.windowStyle\)/);
  }
  assert.match(app, /state\.settings\.windowStyle = applyWindowStyle\(choice\);\s*debouncedSaveSettings\(\)/);
  assert.match(app, /applyWindowStyle\(state\.settings\.windowStyle\);\s*initWindowControls\(\)/);
});

// 有界 DOM/窗口 API 桩，只验证行为，不作为浏览器布局或真实原生平台验收。
function controlsContext(os, style = resolveWindowStyle('auto', os)) {
  const observers = [];
  const elements = new Map();
  const calls = [];
  const resizeCallbacks = [];
  let now = 0;
  let maximized = false;
  let fullscreen = false;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.childNodes = [];
      this.style = {};
      this.attrs = new Map();
      this.listeners = new Map();
      this.hovered = false;
      this.classList = {
        contains: (value) => this.className.split(' ').includes(value),
        toggle: (value, enabled) => {
          const values = new Set(this.className.split(' ').filter(Boolean));
          if (enabled) values.add(value);
          else values.delete(value);
          this.className = [...values].join(' ');
        },
      };
    }
    setAttribute(name, value) {
      this.attrs.set(name, value);
      for (const observer of observers) {
        if (observer.target === this && observer.options.attributeFilter?.includes(name)) {
          queueMicrotask(() => observer.callback());
        }
      }
    }
    getAttribute(name) {
      return this.attrs.get(name);
    }
    replaceChildren(...children) {
      this.childNodes = children;
    }
    appendChild(child) {
      this.childNodes.push(child);
    }
    querySelector() {
      return this.childNodes.find((child) => child.classList.contains('fi'));
    }
    matches(selector) {
      return selector === ':hover' && this.hovered;
    }
    closest(selector) {
      const own = `#${this.attrs.get('id')}`;
      return selector
        .split(',')
        .map((part) => part.trim())
        .some((part) => part === own || part === this.tagName.toLowerCase())
        ? this
        : null;
    }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }
    dispatchEvent(event) {
      for (const callback of this.listeners.get(event.type) ?? []) callback(event);
    }
  }
  const root = new Element();
  root.setAttribute('data-os', os);
  root.setAttribute('data-window-style', style);
  const body = new Element();
  const titlebar = new Element();
  const container = new Element();
  const tb = new Element();
  elements.set('titlebar', titlebar);
  elements.set('titlebar-controls', container);
  if (os === 'windows') {
    for (const name of ['minimize', 'maximize', 'close']) {
      const btn = new Element('button');
      btn.className = 'decorum-tb-btn';
      btn.setAttribute('id', `decorum-tb-${name}`);
      btn.addEventListener('click', () => calls.push(name));
      elements.set(`decorum-tb-${name}`, btn);
      tb.appendChild(btn);
    }
  }
  const appWindow = {
    isMaximized: async () => maximized,
    isFullscreen: async () => fullscreen,
    setFullscreen: async (value) => {
      fullscreen = value;
      calls.push('fullscreen');
    },
    toggleMaximize: async () => {
      maximized = !maximized;
      calls.push('maximize');
    },
    onResized: (callback) => {
      resizeCallbacks.push(callback);
      return Promise.resolve(() => {});
    },
    minimize: async () => {
      calls.push('minimize');
    },
    close: async () => {
      calls.push('close');
    },
    startDragging: async () => {
      calls.push('drag');
    },
    startResizeDragging: async (direction) => {
      calls.push(direction);
    },
  };
  const internals = {
    invoke: async (command) => {
      calls.push(command);
      return command;
    },
  };
  const context = {
    window: { __TAURI__: { window: { getCurrentWindow: () => appWindow } }, __TAURI_INTERNALS__: internals },
    document: {
      documentElement: root,
      body,
      getElementById: (id) => elements.get(id),
      createElement: (tag) => new Element(tag),
      querySelector: () => (os === 'windows' ? tb : null),
    },
    Element,
    MouseEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
        observers.push(this);
      }
      disconnect() {
        observers.splice(observers.indexOf(this), 1);
      }
    },
    performance: { now: () => now },
  };
  const init = runInNewContext(
    `${controlsSource.replace('export function', 'function')}
initWindowControls;`,
    context,
  );
  return {
    init,
    root,
    body,
    container,
    titlebar,
    elements,
    calls,
    resizeCallbacks,
    internals,
    observers,
    advance: (ms) => {
      now += ms;
    },
    setFullscreen: (value) => {
      fullscreen = value;
    },
  };
}

test('Mac creates one button set, never resize zones, and uses fullscreen in either skin', async () => {
  const env = controlsContext('macos');
  env.init();
  env.init();
  await flush();
  assert.equal(env.container.childNodes.length, 3);
  assert.equal(env.body.childNodes.length, 0);
  assert.equal(env.resizeCallbacks.length, 1);
  assert.equal(env.titlebar.listeners.get('pointerdown').length, 1);
  const [min, max, close] = env.container.childNodes;
  assert.equal(max.title, '进入全屏');
  env.root.setAttribute('data-window-style', 'windows');
  max.dispatchEvent({ type: 'click' });
  await flush();
  assert.equal(max.title, '退出全屏');
  assert.equal(max.getAttribute('aria-label'), max.title);
  assert.equal(env.root.classList.contains('is-fullscreen'), true);
  max.dispatchEvent({ type: 'click' });
  await flush();
  min.dispatchEvent({ type: 'click' });
  close.dispatchEvent({ type: 'click' });
  await flush();
  assert.equal(max.title, '进入全屏');
  assert.deepEqual(env.calls, ['fullscreen', 'fullscreen', 'minimize', 'close']);
});

test('Linux keeps one resize-zone set and maximizes even in macOS skin', async () => {
  const env = controlsContext('linux');
  env.init();
  env.init();
  await flush();
  assert.equal(env.body.childNodes.length, 8);
  assert.equal(env.container.childNodes.length, 3);
  assert.equal(env.resizeCallbacks.length, 1);
  const zone = env.body.childNodes[0];
  const pointer = { type: 'pointerdown', button: 0, preventDefault() {} };
  zone.dispatchEvent(pointer);
  assert.deepEqual(env.calls, ['North']);
  env.root.setAttribute('data-window-style', 'macos');
  env.container.childNodes[1].dispatchEvent({ type: 'click' });
  await flush();
  assert.equal(env.container.childNodes[1].title, '还原');
  zone.dispatchEvent(pointer);
  assert.deepEqual(env.calls, ['North', 'maximize']);
  env.container.childNodes[1].dispatchEvent({ type: 'click' });
  await flush();
  env.setFullscreen(true);
  env.resizeCallbacks[0]();
  await flush();
  zone.dispatchEvent(pointer);
  assert.equal(env.root.classList.contains('is-fullscreen'), true);
  assert.deepEqual(env.calls, ['North', 'maximize', 'maximize']);
});

test('Windows keeps decorum nodes/events; macOS skin cancels the Snap timer before it fires', async () => {
  const env = controlsContext('windows');
  const max = env.elements.get('decorum-tb-maximize');
  const click = max.listeners.get('click')[0];
  // 建模 decorum 注入脚本：mouseenter 武装 620ms timer，mouseleave 里 clearTimeout。
  let armed = false;
  max.addEventListener('mouseenter', () => {
    armed = true;
  });
  max.addEventListener('mouseleave', () => {
    armed = false;
  });
  env.init();
  const invoke = env.internals.invoke;
  env.init();
  await flush();
  // __TAURI_INTERNALS__.invoke 是只读属性，守卫不得再 monkey-patch 它。
  assert.equal(env.internals.invoke, invoke);
  assert.equal(env.container.childNodes.length, 0);
  assert.equal(env.body.childNodes.length, 0);
  assert.equal(env.resizeCallbacks.length, 1);
  assert.equal(env.elements.get('decorum-tb-maximize'), max);
  assert.equal(max.className, 'decorum-tb-btn');
  assert.equal(max.listeners.get('click')[0], click);
  // guardDecorumSnap 曾在此抛 TypeError 并中断初始化，图标替换整段被跳过。
  assert.equal(max.title, '最大化');
  assert.equal(max.childNodes[0]?.classList.contains('fi'), true);

  // Windows 皮肤：不干预，插件 timer 照常武装。
  max.dispatchEvent({ type: 'mouseenter' });
  assert.equal(armed, true);
  max.dispatchEvent({ type: 'mouseleave' });
  assert.equal(armed, false);

  // macOS 皮肤：同节点上我们晚于插件注册，同步补发 mouseleave 即可掐掉本次 timer。
  env.root.setAttribute('data-window-style', 'macos');
  max.dispatchEvent({ type: 'mouseenter' });
  assert.equal(armed, false);
  // paint() 会在每次变更后重跑，守卫只能挂一次。
  assert.equal(max.listeners.get('mouseenter').length, 2);

  assert.equal(await env.internals.invoke('unrelated-command'), 'unrelated-command');
  max.dispatchEvent({ type: 'click' });
  assert.equal(env.calls.at(-1), 'maximize');
});

test('macOS skin at boot cancels the Snap timer without relying on a style mutation', async () => {
  // theme-boot.js 在 initWindowControls() 之前就写好了属性，MutationObserver 一次也不会触发。
  const env = controlsContext('windows', 'macos');
  const max = env.elements.get('decorum-tb-maximize');
  let armed = false;
  max.addEventListener('mouseenter', () => {
    armed = true;
  });
  max.addEventListener('mouseleave', () => {
    armed = false;
  });
  env.init();
  await flush();
  max.dispatchEvent({ type: 'mouseenter' });
  assert.equal(armed, false);
});

test('fullscreen permissions stay explicit and hot zones hide in fullscreen/maximized states', () => {
  const permissions = JSON.parse(read('../src-tauri/capabilities/default.json')).permissions;
  assert.ok(permissions.includes('core:window:allow-is-fullscreen'));
  assert.ok(permissions.includes('core:window:allow-set-fullscreen'));
  assert.ok(!permissions.includes('core:window:allow-set-decorations'));
  const css = read('../src/styles/app.css');
  assert.match(css, /:root\.is-maximized \.resize-zone,\s*:root\.is-fullscreen \.resize-zone/);
  assert.match(css, /\[data-window-style="macos"\]/);
  assert.match(css, /:focus-visible/);
});
