// Global type declarations for the Tauri v2 runtime API.
// These APIs are injected by 'withGlobalTauri: true' in tauri.conf.json.

declare namespace TauriAPI {
  interface Core {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<any>;
  }
  interface Event {
    listen(event: string, handler: (event: any) => void): Promise<() => void>;
  }
  interface Dialog {
    save(options?: any): Promise<string | null>;
    open(options?: any): Promise<string | string[] | null>;
    ask(message: string, options?: any): Promise<boolean>;
    message(message: string, options?: any): Promise<void>;
  }
  interface Fs {
    writeTextFile(path: string, contents: string): Promise<void>;
    readTextFile(path: string): Promise<string>;
  }
  interface WindowAPI {
    getCurrentWindow(): any;
  }
  interface Tauri {
    core: Core;
    event: Event;
    dialog: Dialog;
    fs: Fs;
    window: WindowAPI;
  }
}

interface Window {
  __TAURI__: TauriAPI.Tauri;
}

// Chart.js global (loaded via <script> tag)
declare const Chart: any;
