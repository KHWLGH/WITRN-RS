// @ts-check
/**
 * @file 设备信息面板（设置页侧栏）— 连接信息（VID/PID/SN 由 device.js 维护）与设备身份读取。
 *
 * identify_current_device 会停掉 HID 读线程、读取约 2 秒再重连，
 * 因此录制中禁用（避免数据流出现缺口）。
 */

import { state } from '../state.js';
import { toast } from '../ui/toast.js';

const { invoke } = window.__TAURI__.core;

let identifying = false;

/** 依据连接/录制状态刷新"读取设备身份"按钮的可用性。 */
export function refreshDeviceIdentifyState() {
  const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-identify'));
  if (!btn) return;
  const blocked = !state.isConnected || state.isRecording || identifying;
  btn.disabled = blocked;
  btn.title = !state.isConnected ? '请先连接设备' : state.isRecording ? '录制中不可读取（会暂停数据流约 2 秒）' : '';
}

async function identify() {
  if (identifying) return;
  if (state.isRecording) {
    toast.warning('录制中不可读取设备身份（会暂停数据流约 2 秒）');
    return;
  }
  const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-identify'));
  identifying = true;
  if (btn) btn.textContent = '读取中…';
  refreshDeviceIdentifyState();

  try {
    const identity =
      /** @type {{ vendor_id: number, product_id: number, product: string, usb_serial: string, path: string, fingerprint: string }} */ (
        await invoke('identify_current_device')
      );
    /** @param {string} id @param {string} value */
    const fill = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value || '--';
    };
    fill('identity-product', identity.product);
    fill('identity-serial', identity.usb_serial);
    fill('identity-fingerprint', identity.fingerprint);
    const result = document.getElementById('identity-result');
    if (result) result.hidden = false;
  } catch (e) {
    toast.error(`读取设备身份失败: ${e}`);
  } finally {
    identifying = false;
    if (btn) btn.textContent = '读取设备身份';
    refreshDeviceIdentifyState();
  }
}

/** 首次打开设备视图：绑定按钮。 */
export function initDeviceView() {
  document.getElementById('btn-identify')?.addEventListener('click', () => void identify());
  refreshDeviceIdentifyState();
}
