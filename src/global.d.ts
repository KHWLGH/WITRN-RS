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
    writeTextFile(path: string, contents: string, options?: { append?: boolean }): Promise<void>;
    readTextFile(path: string): Promise<string>;
  }
  interface WindowAPI {
    getCurrentWindow(): any;
  }
  interface WebviewHandle {
    setZoom(scaleFactor: number): Promise<void>;
  }
  interface WebviewAPI {
    getCurrentWebview(): WebviewHandle;
  }
  interface Tauri {
    core: Core;
    event: Event;
    dialog: Dialog;
    fs: Fs;
    window: WindowAPI;
    webview: WebviewAPI;
  }
}

// Registered by src/boot-timing.js (a classic script that loads before the module graph),
// used to stamp page-side milestones onto the cold-start timeline.
interface BootTiming {
  mark(name: string): void;
}

// Registered by src/device.js. Read-only view of the live acquisition, so a hardware acceptance
// run is judged from what the app saw (see docs/DEVELOPMENT.md "发版前置：真机验收凭据").
interface StreamDiagnostics {
  generation: number;
  seq: number;
  enabled: boolean;
  failed: boolean;
  ended: boolean;
  streamErrors: number;
  capacityErrors: number;
  lastError: string | null;
}

interface PerformanceDiagnostics {
  [key: string]: unknown;
}

interface Window {
  __TAURI__: TauriAPI.Tauri;
  __WITRN_BOOT__?: BootTiming;
  __WITRN_STREAM__?: (() => StreamDiagnostics) | null;
  __WITRN_PERF__?: (() => PerformanceDiagnostics) | null;
  __WITRN_PERF_RESET__?: (() => void) | null;
}

// uPlot global (loaded via <script> tag from vendor/uPlot.iife.min.js)
declare const uPlot: any;
