import assert from 'node:assert/strict';
import test from 'node:test';
import { ModuleWorker } from '../bench/module-worker.mjs';
import { encodePdEntries, PD_EXPORT_BYTES, pdCapturePrefix } from '../src/pd-export-core.js';
import { buildPdCaptureFile, parsePdCaptureFile, summarize } from '../src/pd-model.js';

/** 一棵最小但真实形状的解码树（Request 消息 + quick_rdo）。 */
const meta = {
  raw: '10000010',
  bit_loc: [0, 7],
  field: 'PD',
  value: [
    { raw: '111', bit_loc: null, field: 'SOP*', value: 'SOP' },
    {
      raw: '1000010',
      bit_loc: [0, 15],
      field: 'Message Header',
      value: [
        { raw: '0010', bit_loc: [0, 4], field: 'Message Type', value: 'Request' },
        { raw: '0', bit_loc: [8, 8], field: 'Port Power Role', value: 'Sink' },
      ],
    },
    {
      raw: '1',
      bit_loc: [16, 47],
      field: 'Data Objects',
      value: [{ raw: '1', bit_loc: [16, 47], field: 'RDO', value: null, quick_rdo: '9V 2A' }],
    },
  ],
};

const entry = { t: 1_000_000, ...summarize(meta), meta };
const divider = { t: 1_000_001, divider: true };

test('capture file round-trips entries and dividers', () => {
  const file = buildPdCaptureFile([entry, divider]);
  assert.equal(file.app, 'laPower');
  assert.equal(file.kind, 'pd-capture');
  assert.equal(file.version, 2);

  const parsed = parsePdCaptureFile(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0], entry);
  assert.deepEqual(parsed.entries[1], divider);
});

test('summaries are recomputed from meta on import', () => {
  const file = JSON.parse(JSON.stringify(buildPdCaptureFile([entry])));
  file.entries[0].type = '被手改的类型';
  file.entries[0].summary = '被手改的摘要';

  const parsed = parsePdCaptureFile(file);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries[0].type, 'Request');
  assert.equal(parsed.entries[0].summary, '9V 2A');
});

test('rejects wrong kind, version, and shapes', () => {
  assert.equal(parsePdCaptureFile(null).ok, false);
  assert.equal(parsePdCaptureFile([]).ok, false);
  assert.equal(parsePdCaptureFile({ kind: 'other', version: 1, entries: [] }).ok, false);
  assert.equal(parsePdCaptureFile({ kind: 'pd-capture', version: 3, entries: [] }).ok, false);
  assert.equal(parsePdCaptureFile({ kind: 'pd-capture', version: 2, entries: [] }).ok, true);
  assert.equal(parsePdCaptureFile({ kind: 'pd-capture', version: 1, entries: {} }).ok, false);
});

test('rejects malformed entries', () => {
  const base = { kind: 'pd-capture', version: 1 };
  // 缺时间戳
  assert.equal(parsePdCaptureFile({ ...base, entries: [{ meta }] }).ok, false);
  // NaN 时间戳（JSON 里写不出 NaN，但防御手工构造对象）
  assert.equal(parsePdCaptureFile({ ...base, entries: [{ t: Number.NaN, meta }] }).ok, false);
  // meta 缺 field
  assert.equal(
    parsePdCaptureFile({ ...base, entries: [{ t: 1, meta: { raw: '0', bit_loc: null, value: null } }] }).ok,
    false,
  );
  // bit_loc 形状不对
  assert.equal(
    parsePdCaptureFile({ ...base, entries: [{ t: 1, meta: { raw: '0', bit_loc: [1], field: 'x', value: null } }] }).ok,
    false,
  );
  // value 类型非法
  assert.equal(
    parsePdCaptureFile({ ...base, entries: [{ t: 1, meta: { raw: '0', bit_loc: null, field: 'x', value: {} } }] }).ok,
    false,
  );
});

test('rejects trees deeper than the recursion cap', () => {
  /** @type {any} */
  let deep = { raw: '0', bit_loc: null, field: 'leaf', value: null };
  for (let i = 0; i < 40; i++) {
    deep = { raw: '0', bit_loc: null, field: `n${i}`, value: [deep] };
  }
  const parsed = parsePdCaptureFile({ kind: 'pd-capture', version: 1, entries: [{ t: 1, meta: deep }] });
  assert.equal(parsed.ok, false);
});

test('accepts an empty capture', () => {
  const parsed = parsePdCaptureFile(buildPdCaptureFile([]));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries, []);
});

test('v2 capture round-trips last bus samples', () => {
  const compact = {
    t: 42,
    sop: 'SOP',
    type: 'GoodCRC',
    role: 'SNK',
    summary: '',
    vbus: 5.097,
    ibus: 0.044,
    bytes: [0xfe, 0x03, 224, 0x41, 0x00],
  };
  const parsed = parsePdCaptureFile({
    app: 'WITRN-RS',
    kind: 'pd-capture',
    version: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    entries: [compact],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries[0].vbus, 5.097);
  assert.equal(parsed.entries[0].ibus, 0.044);

  const exported = buildPdCaptureFile(parsed.entries);
  assert.equal(exported.entries[0].vbus, 5.097);
  assert.equal(exported.entries[0].ibus, 0.044);
});

test('v2 compact entries round-trip without a decode tree', () => {
  const compact = {
    t: 42,
    sop: 'SOP',
    type: 'GoodCRC',
    role: 'SNK',
    summary: '',
    bytes: [0xfe, 0x03, 224, 0x41, 0x00],
  };
  const file = {
    app: 'WITRN-RS',
    kind: 'pd-capture',
    version: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    entries: [compact],
  };
  const parsed = parsePdCaptureFile(file);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries[0], compact);
});

test('v1 files still import and recompute summaries from meta', () => {
  const v1 = {
    app: 'WITRN-RS',
    kind: 'pd-capture',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    entries: [{ t: 1, type: '被手改的类型', summary: 'x', meta }],
  };
  const parsed = parsePdCaptureFile(v1);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries[0].type, 'Request');
  assert.equal(parsed.entries[0].summary, '9V 2A');
});

test('v2 does not truncate large captures', () => {
  const entries = [];
  for (let i = 0; i < 3000; i++) entries.push({ t: i, sop: 'SOP', type: 'GoodCRC', role: 'SNK', summary: '' });
  const parsed = parsePdCaptureFile({ kind: 'pd-capture', version: 2, entries });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 3000);
});

test('streamed PD JSON matches the v2 contract, including v1 metadata and split UTF-8', () => {
  const entries = [
    { t: 1, divider: true },
    {
      t: 2,
      sop: 'SOP',
      type: 'GoodCRC',
      role: 'Source',
      summary: '旧报文',
      meta: { raw: '0', field: '字段', value: '中文'.repeat(600000) },
    },
  ];
  const chunks = [...encodePdEntries(entries, true)];
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((bytes) => bytes.byteLength <= PD_EXPORT_BYTES));
  const text = Buffer.concat(chunks).toString('utf8');
  assert.deepEqual(
    JSON.parse(`${pdCapturePrefix('2026-10-03T00:00:00Z')}${text}]}`).entries,
    buildPdCaptureFile(entries).entries,
  );
});

test('real PD Worker exports a fixed snapshot with bounded backpressure and cleans up failed exports', async () => {
  const { cancelPdExport, exportPdFile } = await import('../src/pd-export.js');
  const previousWorker = globalThis.Worker;
  const previousWindow = globalThis.window;
  globalThis.Worker = ModuleWorker;
  const entries = Array.from({ length: 100000 }, (_, t) => ({
    t,
    sop: 'SOP',
    type: 'GoodCRC',
    role: 'Source',
    summary: '捕获报文',
    bytes: [1, 2, 3],
  }));
  const original = entries.slice();
  const chunks = [];
  let closes = [];
  let fail = false;
  let picks = 0;
  let holdWrite = false;
  let releaseWrite = null;
  globalThis.window = {
    __TAURI__: {
      core: {
        async invoke(command, args) {
          if (command === 'pd_export_pick') {
            picks++;
            return { handle: 1, name: 'capture.json', path: 'D:/capture.json', size: 0 };
          }
          if (command === 'csv_write_chunk') {
            if (fail) throw new Error('disk full');
            if (holdWrite)
              await new Promise((resolve) => {
                releaseWrite = resolve;
              });
            assert.ok(args.byteLength <= PD_EXPORT_BYTES);
            chunks.push(Buffer.from(args));
            // Clearing and appending after the snapshot cannot change this file.
            entries.length = 0;
            entries.push({ t: -1, divider: true });
          }
          if (command === 'csv_write_close') closes.push(args.options);
          return null;
        },
      },
    },
  };
  try {
    const first = exportPdFile(() => entries);
    assert.equal(
      exportPdFile(() => entries),
      first,
      'reentrant export shares the active task',
    );
    assert.equal(await first, 100000);
    assert.equal(picks, 1);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')).entries, buildPdCaptureFile(original).entries);
    const worker = ModuleWorker.instances.at(-1);
    assert.ok(worker.messages.filter((m) => m.type === 'entries').every((m) => m.entries <= 128));
    assert.ok(worker.closed);
    assert.deepEqual(closes, [{ sync: true }]);
    fail = true;
    closes = [];
    await assert.rejects(
      exportPdFile(() => entries),
      /disk full/,
    );
    assert.deepEqual(closes, [{ abort: true }]);
    assert.ok(ModuleWorker.instances.at(-1).closed);
    fail = false;
    holdWrite = true;
    closes = [];
    const cancelled = exportPdFile(() => entries);
    while (!releaseWrite) await new Promise((resolve) => setTimeout(resolve, 1));
    const cleanup = cancelPdExport();
    releaseWrite();
    await cleanup;
    await assert.rejects(cancelled, /pdExportCancelled/);
    assert.deepEqual(closes, [{ abort: true }], 'exit cancellation awaits incomplete-file cleanup');
    assert.ok(ModuleWorker.instances.at(-1).closed);
  } finally {
    globalThis.Worker = previousWorker;
    globalThis.window = previousWindow;
  }
});
