// Global type declarations for the Tauri v2 runtime API.
// These APIs are injected by 'withGlobalTauri: true' in tauri.conf.json.

declare namespace TauriAPI {
  interface DialogOptions {
    title?: string;
    kind?: 'info' | 'warning' | 'error';
  }
  interface FileDialogOptions extends DialogOptions {
    multiple?: boolean;
    filters?: { name: string; extensions: string[] }[];
    defaultPath?: string;
  }
  interface Core {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<any>;
  }
  interface Event {
    listen(event: string, handler: (event: any) => void): Promise<() => void>;
  }
  interface Dialog {
    save(options?: FileDialogOptions): Promise<string | null>;
    open(options?: FileDialogOptions): Promise<string | string[] | null>;
    ask(message: string, options?: DialogOptions): Promise<boolean>;
    message(message: string, options?: DialogOptions): Promise<void>;
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

// uPlot global (loaded via <script> tag from vendor/uPlot.iife.min.js)
declare const uPlot: any;
