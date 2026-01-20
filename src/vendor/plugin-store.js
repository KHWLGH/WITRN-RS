// Local copy of @tauri-apps/plugin-store v2.4.1 (ES module)
// Avoids runtime CDN fetches; uses window.__TAURI__ globals provided by Tauri.
const invoke = (...args) => window.__TAURI__?.core?.invoke?.(...args);
const listen = (...args) => window.__TAURI__?.event?.listen?.(...args);

class Store {
  constructor(rid) {
    this.rid = rid;
  }

  static async load(path, options) {
    const rid = await invoke("plugin:store|load", { path, options });
    return new Store(rid);
  }

  static async get(path) {
    const rid = await invoke("plugin:store|get_store", { path });
    return rid ? new Store(rid) : null;
  }

  async set(key, value) {
    await invoke("plugin:store|set", { rid: this.rid, key, value });
  }

  async get(key) {
    const result = await invoke("plugin:store|get", { rid: this.rid, key });
    console.log('Store.get raw result:', result, 'for key:', key);
    // tauri-plugin-store v2 returns [value, exists] not [exists, value]
    const [value, exists] = result;
    console.log('Store.get parsed - exists:', exists, 'value:', value);
    return exists ? value : undefined;
  }

  async has(key) {
    return invoke("plugin:store|has", { rid: this.rid, key });
  }

  async delete(key) {
    return invoke("plugin:store|delete", { rid: this.rid, key });
  }

  async clear() {
    await invoke("plugin:store|clear", { rid: this.rid });
  }

  async reset() {
    await invoke("plugin:store|reset", { rid: this.rid });
  }

  async keys() {
    return invoke("plugin:store|keys", { rid: this.rid });
  }

  async values() {
    return invoke("plugin:store|values", { rid: this.rid });
  }

  async entries() {
    return invoke("plugin:store|entries", { rid: this.rid });
  }

  async length() {
    return invoke("plugin:store|length", { rid: this.rid });
  }

  async reload(options) {
    await invoke("plugin:store|reload", { rid: this.rid, ...options });
  }

  async save() {
    await invoke("plugin:store|save", { rid: this.rid });
  }

  async onKeyChange(key, handler) {
    return listen("store://change", (event) => {
      const payload = event?.payload;
      if (!payload || payload.resourceId !== this.rid || payload.key !== key) return;
      handler(payload.exists ? payload.value : undefined);
    });
  }

  async onChange(handler) {
    return listen("store://change", (event) => {
      const payload = event?.payload;
      if (!payload || payload.resourceId !== this.rid) return;
      handler(payload.key, payload.exists ? payload.value : undefined);
    });
  }

  async close() {
    try {
      await invoke("plugin:store|close", { rid: this.rid });
    } catch (_) {
      // Ignore close failures; resource will be dropped when the window exits.
    }
  }
}

class LazyStore {
  constructor(path, options) {
    this.path = path;
    this.options = options;
    this._store = null;
  }

  get store() {
    if (!this._store) {
      this._store = Store.load(this.path, this.options);
    }
    return this._store;
  }

  async init() {
    await this.store;
  }

  async set(key, value) {
    return (await this.store).set(key, value);
  }

  async get(key) {
    return (await this.store).get(key);
  }

  async has(key) {
    return (await this.store).has(key);
  }

  async delete(key) {
    return (await this.store).delete(key);
  }

  async clear() {
    return (await this.store).clear();
  }

  async reset() {
    return (await this.store).reset();
  }

  async keys() {
    return (await this.store).keys();
  }

  async values() {
    return (await this.store).values();
  }

  async entries() {
    return (await this.store).entries();
  }

  async length() {
    return (await this.store).length();
  }

  async reload(options) {
    return (await this.store).reload(options);
  }

  async save() {
    return (await this.store).save();
  }

  async onKeyChange(key, handler) {
    return (await this.store).onKeyChange(key, handler);
  }

  async onChange(handler) {
    return (await this.store).onChange(handler);
  }

  async close() {
    if (!this._store) return;
    return (await this._store).close();
  }
}

async function load(path, options) {
  return Store.load(path, options);
}

async function getStore(path) {
  return Store.get(path);
}

export { LazyStore, Store, load, getStore };
