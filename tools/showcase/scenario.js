// Development fixtures only. Sample values depend on virtual time and a fixed seed.
export const EPOCH = Date.UTC(2026, 9, 4, 4, 0, 0);
export const DURATION_MS = 120_000;
export const SEED = 0x6d2b79f5;
export const PD_HANDSHAKES = [
  { at: 1000, position: 1 },
  { at: 12000, position: 2 },
  { at: 35000, position: 3 },
  { at: 60000, position: 4 },
  { at: 85000, position: 5 },
];
export const DEVICES = [
  {
    path: 'showcase:k2',
    vid: 0x0716,
    pid: 0x5060,
    model_name: 'WITRN K2',
    display_name: 'WITRN K2 (USB 4-4)',
    serial_number: '20230727',
    usb_port: '4-4',
    manufacturer: 'WITRN',
    product: 'K2',
    interface_number: 0,
    usage_page: 0xff00,
    family: 'witrn',
    controls: false,
    max_rate_hz: 100,
  },
  {
    path: 'showcase:km003c',
    vid: 0x5fc9,
    pid: 0x0063,
    model_name: 'POWER-Z KM003C',
    display_name: 'POWER-Z KM003C (USB 4-5)',
    serial_number: 'KM003C-DEMO-001',
    usb_port: '4-5',
    manufacturer: 'ChargerLAB',
    product: 'KM003C',
    interface_number: 0,
    usage_page: 0,
    family: 'km003c',
    controls: true,
    max_rate_hz: 1000,
  },
];
export const PDOS = [
  ...[5, 9, 12, 15, 20].map((volts, i) => ({
    position: i + 1,
    kind: 'fixed',
    volt_min_mv: volts * 1000,
    volt_max_mv: volts * 1000,
    cur_ma: volts === 20 ? 3250 : 3000,
    label: `${volts}V`,
    programmable: false,
  })),
  { position: 6, kind: 'pps', volt_min_mv: 3300, volt_max_mv: 21000, cur_ma: 3000, label: 'PPS', programmable: true },
];
export const PROTOCOLS = [
  { id: 'pd', label: 'PD 3.0' },
  { id: 'qc', label: 'QC 2.0' },
  { id: 'qc3', label: 'QC 3.0' },
  { id: 'afc', label: 'AFC' },
  { id: 'fcp', label: 'FCP' },
  { id: 'apple', label: 'Apple 2.4A' },
];

export function meterAt(ms, targetVoltage = null) {
  const t = ms / 1000;
  const stage = t < 12 ? 5 : t < 35 ? 9 : t < 60 ? 12 : t < 85 ? 15 : 20;
  const ripple = Math.sin(t * 5.7) * 0.012 + Math.sin(t * 1.3) * 0.008;
  const hash = Math.imul(Math.floor(ms / 10) ^ SEED, 0x45d9f3b) >>> 0;
  const noise = (hash / 0xffffffff - 0.5) * 0.04;
  const voltage = (targetVoltage ?? stage) + ripple;
  const current =
    (t < 8 ? 0.32 : t < 35 ? 1.35 : t < 60 ? 1.85 : t < 85 ? 2.2 : 2.75) + noise + Math.sin(t * 0.7) * 0.045;
  return {
    voltage,
    current,
    power: voltage * current,
    temperature: 25 + 11 * (1 - Math.exp(-t / 68)),
    dp: t < 12 ? 0.6 : 2.7 + noise / 3,
    dn: t < 12 ? 0.08 : 2.7 - noise / 3,
    cc1: 1.62 + Math.sin(t * 0.35) * 0.025,
    cc2: 0.32 + noise / 4,
  };
}
