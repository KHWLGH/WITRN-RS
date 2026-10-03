import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCsvParser,
  formatCsvChunks,
  formatCsvRange,
  formatExcelTime,
  formatSpoolHeader,
  formatSpoolHeaderPatch,
  parseCsv,
  parseCsvDateTime,
  SPOOL_PATCH_BYTES,
  snapshotCsvColumns,
} from '../src/csv-codec.js';
import { calculateEnergyInRange, mapCsvColumns, parseRelativeTime } from '../src/measurement.js';
import { emptyChartColumns, F64Col } from '../src/state.js';

const START = new Date(2024, 1, 29, 12, 34, 56, 789).getTime();
const OLD_HEADER = 'Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),';
const KEYS = ['x', 'timestamps', 'voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'];

function makeColumns(rows) {
  const cols = emptyChartColumns(rows.length);
  for (const row of rows) {
    for (const key of KEYS) cols[key].push(row[key] ?? Number.NaN);
  }
  return cols;
}

function encode(cols, options = {}) {
  return [...formatCsvChunks(snapshotCsvColumns(cols, { sampleRate: 250, startTime: START, ...options }))].join('');
}

function decode(text, options = {}) {
  return parseCsv(text, { fallbackStartTime: START, signedCurrent: true, ...options });
}

test('the declared SampTime becomes the imported interval, with the x sequence as fallback', () => {
  // 本应用写出的文件带摘要行，直接采信它声明的间隔
  const declared = makeColumns([
    { x: 0, timestamps: START, voltage: 5, current: 2, power: 10 },
    { x: 5, timestamps: START + 5000, voltage: 5, current: 2, power: 10 },
    { x: 10, timestamps: START + 10000, voltage: 5, current: 2, power: 10 },
  ]);
  const text = [...formatCsvChunks(snapshotCsvColumns(declared, { sampleRate: 5000, startTime: START }))].join('');
  assert.equal(decode(text).intervalMs, 5000);

  // 旧格式没有摘要行：从相对秒反推标称节奏，休眠空档不能把估计值带跑
  const legacy = [
    `${OLD_HEADER}\n00:00:00.000,5,2,10,\n00:00:05.000,5,2,10,\n00:00:10.000,5,2,10,\n00:30:10.000,5,2,10,`,
  ].join('');
  assert.equal(decode(legacy).intervalMs, 5000);

  // 单点文件既没有摘要也没有步长
  const single = `${OLD_HEADER}\n00:00:00.000,5,2,10,`;
  assert.equal(decode(single).intervalMs, null);
});

test('a nonsense declared SampTime is ignored instead of poisoning the threshold', () => {
  const rows = `${OLD_HEADER}\n00:00:00.000,5,2,10,\n00:00:01.000,5,2,10,`;
  const summary = (sampTime) => `SUM,2\nTotalTime,0:00:01\nSampTime(ms),${sampTime}\nDateTime,2024-01-29 12:34:56\n\n`;

  // 0 与超出设备接受域的值都不是可信的标称间隔，必须回落到从 x 反推
  assert.equal(decode(`${summary(0)}${rows}`).intervalMs, 1000);
  assert.equal(decode(`${summary(3600000)}${rows}`).intervalMs, 1000);
  assert.equal(decode(`${summary('abc')}${rows}`).intervalMs, 1000);
  // 可信值直接采信，即使与 x 步长不一致（例如手工编辑过的样本列）
  assert.equal(decode(`${summary(500)}${rows}`).intervalMs, 500);
});

test('mixed sample intervals survive export despite a different settings cadence, including slow samples', async () => {
  const { computeCsvImport } = await import('../src/csv-import-core.js');
  const cols = makeColumns(
    [0, 5, 10, 10.25, 10.5, 15.5].map((x) => ({ x, timestamps: START + x * 1000, voltage: 5, current: 2, power: 10 })),
  );
  cols.sampleIntervals.set([5000, 5000, 5000, 250, 250, 250]);
  cols.recordingSegments.set([1, 1, 1, 1, 1, 2]);
  const text = encode(cols, { sampleRate: 250 });
  assert.match(text, /SampTime\(ms\),5000\n/);
  const result = computeCsvImport(text, { fallbackStartTime: START });
  assert.deepEqual(result.columns.sampleIntervals.view(), cols.sampleIntervals.view());
  assert.deepEqual(
    result.energy,
    calculateEnergyInRange(cols.x, cols.current, cols.power, 0, 5, cols.recordingSegments, 5000, cols.sampleIntervals),
  );
  assert.ok(result.energy.wh > 0);
});

test('all finite Number digits round-trip in every measurement channel, including signed zero', () => {
  const values = [
    5.123456789012345,
    -1.2345678901234567,
    1 + Number.EPSILON,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    1e-300,
    -1e300,
    Number.MAX_SAFE_INTEGER,
    0,
    -0,
  ];
  const cols = makeColumns(
    values.map((v, i) => ({
      x: i / 7,
      timestamps: START + i * 0.125,
      voltage: v,
      current: v,
      power: Math.abs(v),
      temp: v,
      dp: v,
      dn: v,
      cc1: v,
      cc2: v,
    })),
  );
  const parsed = decode(encode(cols, { withTemp: true })).columns;
  for (const key of KEYS) assert.deepEqual(parsed[key].view(), cols[key].view(), key);
});

test('precise relative seconds and original wall-clock ms remain independent across pauses and clock rollback', () => {
  const cols = makeColumns([
    { x: 3723.50000000003, timestamps: START, voltage: 5, current: -2, power: 10 },
    { x: 3723.75000000003, timestamps: START + 3_600_000.125, voltage: 5, current: 2, power: 10 },
    { x: 3724.00000000003, timestamps: START - 123.5, voltage: 5, current: -2, power: 10 },
  ]);
  const text = encode(cols);
  const parsed = decode(text).columns;
  assert.deepEqual(parsed.x.view(), cols.x.view());
  assert.deepEqual(parsed.timestamps.view(), cols.timestamps.view());
  const displayTime = text.split('\n')[6].split(',')[0];
  assert.notEqual(parseRelativeTime(displayTime), cols.x.at(0));
  assert.deepEqual(
    calculateEnergyInRange(parsed.x.view(), parsed.current.view(), parsed.power.view(), 0, 2),
    calculateEnergyInRange(cols.x.view(), cols.current.view(), cols.power.view(), 0, 2),
  );
});

test('export keeps legacy prefix columns and appends exact time columns only at the end', () => {
  const cols = makeColumns([{ x: 0, timestamps: START, voltage: 5, current: 2, power: 10 }]);
  for (const withTemp of [false, true]) {
    const header = encode(cols, { withTemp }).split('\n')[5];
    const prefix = `${OLD_HEADER}${withTemp ? 'Temp(°C),' : ''}D+(V),D-(V),CC1(V),CC2(V),`;
    assert.equal(header, `${prefix}RelativeTime(s),Timestamp(ms),SampleInterval(ms),`);
    assert.deepEqual(mapCsvColumns(header), mapCsvColumns(prefix));
    assert.equal(header.includes('RecordingSegment'), false);
  }
});

test('precise CSV retains missing rows and infinities without inventing zeros', () => {
  const cols = makeColumns([
    { x: 0, timestamps: START, voltage: 5, current: 2, power: 10, temp: Infinity, dp: NaN, dn: -Infinity },
    { x: 1, timestamps: START + 1000, voltage: NaN, current: Infinity, power: -Infinity },
  ]);
  const text = encode(cols, { withTemp: true });
  assert.doesNotMatch(text, /NaN|undefined/);
  const imported = decode(text).columns;
  assert.equal(imported.x.length, 2);
  for (const key of KEYS) assert.deepStrictEqual(imported[key].view(), cols[key].view());
});

test('snapshot holds chunk references and fixed logical lengths through append', () => {
  const cols = makeColumns([
    { x: 0, timestamps: START, voltage: 5, current: 2, power: 10 },
    { x: 1, timestamps: START + 1000, voltage: 6, current: 2, power: 12 },
  ]);
  const snapshot = snapshotCsvColumns(cols, { sampleRate: 250, startTime: START });
  for (const key of KEYS) {
    const buffer = snapshot.columns[key].chunks().next().value.values.buffer;
    assert.equal(buffer, cols[key].buf.buffer);
    assert.equal(snapshot.columns[key].length, 2);
    cols[key].push(99);
    assert.equal(snapshot.columns[key].chunks().next().value.values.buffer, buffer);
    assert.equal(snapshot.columns[key].valueAt(2), undefined);
  }
  const imported = decode([...formatCsvChunks(snapshot)].join('')).columns;
  assert.equal(imported.x.length, 2);
  assert.deepEqual([...imported.voltage.view()], [5, 6]);
});

test('CSV round-trips every channel and segment across chunk boundaries', () => {
  const cols = emptyChartColumns();
  const keys = [...KEYS, 'recordingSegments'];
  for (let i = 0; i < 4101; i++) {
    for (const [channel, key] of keys.entries()) {
      const value =
        i === 4095 && key !== 'x' && key !== 'timestamps'
          ? -0
          : i === 4096 && key !== 'x' && key !== 'timestamps'
            ? NaN
            : key === 'x'
              ? i * 0.25
              : key === 'timestamps'
                ? START + i * 250
                : key === 'recordingSegments'
                  ? Math.floor(i / 1000) + 1
                  : i + channel / 11;
      cols[key].push(value);
    }
  }
  const snapshot = snapshotCsvColumns(cols, { sampleRate: 250, startTime: START, withTemp: true });
  for (const key of keys) cols[key].push(999);
  const parsed = decode([...formatCsvChunks(snapshot)].join('')).columns;
  for (const key of keys) {
    assert.equal(parsed[key].length, 4101, key);
    for (const i of [0, 4094, 4095, 4096, 4097, 4100]) {
      assert.ok(
        Object.is(parsed[key].valueAt(i), snapshot.columns[key]?.valueAt(i) ?? snapshot.recordingSegments.valueAt(i)),
        `${key}[${i}]`,
      );
    }
  }
});

test('short optional columns cannot expose unused zero-filled buffer capacity', () => {
  const cols = makeColumns([
    { x: 0, timestamps: START, voltage: 5, current: 2, power: 10, temp: 20, dp: 3 },
    { x: 1, timestamps: START + 1000, voltage: 5, current: 2, power: 10 },
  ]);
  cols.temp.length = 1;
  cols.dp.length = 1;
  cols.temp.buf[1] = 0;
  cols.dp.buf[1] = 0;
  const imported = decode(encode(cols, { withTemp: true })).columns;
  assert.ok(Number.isNaN(imported.temp.at(1)));
  assert.ok(Number.isNaN(imported.dp.at(1)));
});

test('legacy headers, day prefixes and signed-current settings follow measurement rules', () => {
  const text = `DateTime,2024-02-29 12:34:56\n${OLD_HEADER}\n="0.01:02:03.500",5,-2,-10,\n1.00:00:00.250,6,3,-18,`;
  const signed = decode(text);
  assert.deepEqual([...signed.columns.x.view()], [3723.5, 86400.25]);
  assert.deepEqual([...signed.columns.current.view()], [-2, 3]);
  assert.deepEqual([...signed.columns.power.view()], [10, 18]);
  const start = new Date(2024, 1, 29, 12, 34, 56).getTime();
  assert.equal(signed.startTime, start);
  assert.equal(signed.columns.timestamps.at(0), start + 3723500);
  for (const key of ['temp', 'dp', 'dn', 'cc1', 'cc2']) assert.ok(Number.isNaN(signed.columns[key].at(0)));
  assert.equal(signed.recordingSegments, null);
  assert.deepEqual([...decode(text, { signedCurrent: false }).columns.current.view()], [2, 3]);
});

test('old temperature-only and reordered optional signal headers remain supported', () => {
  const oldTemp = decode(`${OLD_HEADER}Temp(°C),\n00:00:00,5,-2,-10,23.123456789,`);
  assert.equal(oldTemp.columns.temp.at(0), 23.123456789);
  assert.ok(Number.isNaN(oldTemp.columns.dp.at(0)));
  const signals = decode(`${OLD_HEADER}CC2(V),Temp(°C),D-(V),CC1(V),D+(V),\n00:00:00,5,2,10,4,21,2,3,1,`);
  for (const [key, value] of [
    ['temp', 21],
    ['dp', 1],
    ['dn', 2],
    ['cc1', 3],
    ['cc2', 4],
  ]) {
    assert.equal(signals.columns[key].at(0), value);
  }
});

test('BOM, CRLF, blank cells and invalid rows preserve NaN and parseFloat legacy semantics', () => {
  const header = `${OLD_HEADER}Temp(°C),D+(V),D-(V),CC1(V),CC2(V),`;
  const text = `\uFEFF${header}\r\n\r\n="00:00:00",5V,-2A,-10W,,NaN,Infinity,-Infinity,0,\r\n00:00:01,,2,10,\r\n00:00:02,5,NaN,10,\r\n00:00:03,5,2,NaN,\r\nbad,5,2,10,\r\n00:00:04,Infinity,-Infinity,-Infinity,\r\n`;
  const cols = decode(text).columns;
  assert.equal(cols.x.length, 2);
  assert.equal(cols.voltage.at(0), 5);
  assert.equal(cols.current.at(0), -2);
  assert.equal(cols.power.at(0), 10);
  for (const key of ['temp', 'dp', 'dn', 'cc1']) assert.ok(Number.isNaN(cols[key].at(0)));
  assert.equal(cols.cc2.at(0), 0);
  // 主通道旧规则仅过滤 NaN，不在导入改成新的范围 / 有限性策略。
  assert.equal(cols.voltage.at(1), Infinity);
  assert.equal(cols.current.at(1), -Infinity);
  assert.equal(cols.power.at(1), Infinity);
  assert.equal(cols.timestamps.at(0), START);
});

test('DateTime explicitly parses local components, leap days, milliseconds and years below 100', () => {
  assert.equal(parseCsvDateTime('2024-02-29 12:34:56.789'), START);
  assert.equal(parseCsvDateTime('2024/2/29 12:34:56.7'), new Date(2024, 1, 29, 12, 34, 56, 700).getTime());
  const early = new Date(0);
  early.setFullYear(99, 0, 2);
  early.setHours(3, 4, 5, 0);
  assert.equal(parseCsvDateTime('0099-01-02 03:04:05'), early.getTime());
  for (const invalid of [
    '2023-02-29 12:00:00',
    '2024-13-01 00:00:00',
    '2024-01-00 00:00:00',
    '2024-01-01 24:00:00',
    '2024-01-01 00:60:00',
    '2024-01-01 00:00:60',
    'not-a-date',
  ]) {
    assert.equal(parseCsvDateTime(invalid), null, invalid);
  }
  const originalDate = globalThis.Date;
  try {
    globalThis.Date = class extends originalDate {
      constructor(value) {
        assert.notEqual(typeof value, 'string', 'must not use nonstandard Date string parsing');
        super(value);
      }
    };
    assert.equal(parseCsvDateTime('2024-02-29 12:34:56.789'), START);
  } finally {
    globalThis.Date = originalDate;
  }
});

test('DateTime metadata with BOM/CRLF or after data is read without trusting SUM for allocation', () => {
  const text = `\uFEFFSUM,9007199254740991\r\n${OLD_HEADER}\r\n00:00:00,5,2,10,\r\nDateTime,2024/2/29 12:34:56.789\r\n`;
  const parsed = decode(text);
  assert.equal(parsed.startTime, START);
  assert.equal(parsed.columns.timestamps.at(0), START);
  assert.equal(parsed.columns.x._chunks.length, 1);
  assert.equal(decode(`DateTime,bad\n${OLD_HEADER}\n00:00:00,5,2,10,`).startTime, START);
});

test('out-of-order input stably reorders every column and the optional real segment IDs', () => {
  const header = `${OLD_HEADER}Temp(°C),D+(V),D-(V),CC1(V),CC2(V),RelativeTime(s),Timestamp(ms),RecordingSegment,`;
  const rows = [
    '00:00:02,20,-2,-40,21,22,23,24,25,2,2002,7,',
    '00:00:01,10,-1,-10,11,12,13,14,15,1,1001,3,',
    '00:00:01,30,3,90,31,32,33,34,35,1,1003,,',
    '00:00:00,0,0,0,1,2,3,4,5,0,1000,0,',
  ];
  const parsed = decode(`${header}\n${rows.join('\n')}`);
  assert.deepEqual([...parsed.columns.x.view()], [0, 1, 1, 2]);
  assert.deepEqual([...parsed.columns.voltage.view()], [0, 10, 30, 20]);
  assert.deepEqual([...parsed.columns.current.view()], [0, -1, 3, -2]);
  assert.deepEqual([...parsed.columns.power.view()], [0, -10, 90, -40]);
  assert.deepEqual([...parsed.columns.timestamps.view()], [1000, 1001, 1003, 2002]);
  for (const [key, offset] of [
    ['temp', 1],
    ['dp', 2],
    ['dn', 3],
    ['cc1', 4],
    ['cc2', 5],
  ]) {
    assert.deepEqual([...parsed.columns[key].view()], [offset, 10 + offset, 30 + offset, 20 + offset]);
  }
  assert.deepEqual([...parsed.recordingSegments.view()], [0, 3, NaN, 7]);
  const again = decode(encode(parsed.columns, { withTemp: true, recordingSegments: parsed.recordingSegments }));
  assert.deepEqual(again.recordingSegments.view(), parsed.recordingSegments.view());
});

test('segments are optional and unknown values are never synthesized, including short columns', () => {
  const cols = makeColumns([
    { x: 0, timestamps: START, voltage: 5, current: 2, power: 10 },
    { x: 1, timestamps: START + 1000, voltage: 5, current: 2, power: 10 },
  ]);
  const segments = new F64Col(8);
  segments.push(0);
  const parsed = decode(encode(cols, { recordingSegments: segments }));
  assert.deepEqual([...parsed.recordingSegments.view()], [0, NaN]);
  assert.equal(decode(encode(cols)).recordingSegments, null);
});

test('missing or malformed exact fields fall back to legacy time, while valid zero remains zero', () => {
  const header = `${OLD_HEADER}RelativeTime(s),Timestamp(ms),RecordingSegment,`;
  const parsed = decode(`${header}\n00:00:02,5,2,10,,,NaN,\n00:00:03,5,2,10,1oops,Infinity,,\n00:00:04,5,2,10,0,0,0,`);
  assert.deepEqual([...parsed.columns.x.view()], [0, 2, 3]);
  assert.deepEqual([...parsed.columns.timestamps.view()], [0, START + 2000, START + 3000]);
  assert.deepEqual([...parsed.recordingSegments.view()], [0, NaN, NaN]);
});

test('day display and legacy time parsing agree without relying on the exact extension', () => {
  assert.equal(formatExcelTime(86400 + 3723.5), '="1.01:02:03.500"');
  assert.equal(parseRelativeTime(formatExcelTime(86400 + 3723.5)), 90123.5);
  assert.equal(formatExcelTime(NaN), '="00:00:00.000"');
});

test('chunk formatting bounds row batches and never drops or duplicates the tail', () => {
  const cols = makeColumns(
    Array.from({ length: 7 }, (_, i) => ({ x: i, timestamps: START + i * 1000, voltage: i, current: 2, power: 10 })),
  );
  const snapshot = snapshotCsvColumns(cols, { sampleRate: 250, startTime: START });
  const chunks = [...formatCsvChunks(snapshot, 2)];
  assert.equal(chunks.length, 5);
  assert.deepEqual(
    chunks.slice(1).map((chunk) => chunk.trimEnd().split('\n').length),
    [2, 2, 2, 1],
  );
  assert.deepEqual(decode(chunks.join('')).columns.voltage.view(), cols.voltage.view());
  for (const size of [0, -1, 1.5, Infinity]) assert.throws(() => [...formatCsvChunks(snapshot, size)], RangeError);
});

test('invalid files fail before exposing any partial imported columns', () => {
  assert.throws(() => decode('garbage'), /Header not found/);
  assert.throws(() => decode(`${OLD_HEADER}\n00:00:00,NaN,2,10,`), /No valid data/);
  assert.throws(() => decode(OLD_HEADER), /No valid data/);
});

/** Every column of a parse result as plain arrays, for exact comparison. */
function columnsOf(parsed) {
  return Object.fromEntries(
    [...KEYS, 'recordingSegments'].map((key) => [
      key,
      Array.from(parsed.columns[key].view(), (v) => (Object.is(v, -0) ? '-0' : v)),
    ]),
  );
}

test('streaming parse equals the whole-text parse at every split position', () => {
  const precise = encode(
    makeColumns([
      { x: 0, timestamps: START, voltage: 5, current: -2, power: 10, temp: 25, dp: 0.6, dn: 0.6, cc1: 1.65, cc2: 0 },
      { x: 0.25, timestamps: START + 250, voltage: 5.01, current: -2.1, power: 10.5 },
      { x: 0.5, timestamps: START + 500, voltage: 9, current: 3, power: 27 },
    ]),
    { withTemp: true },
  );
  const legacy = `\uFEFFSUM,2\r\n${OLD_HEADER}\r\n00:00:00,5,2,10,\r\n00:00:01,6,-2,12,\r\nDateTime,2024/2/29 12:34:56.789\r\n`;
  for (const text of [precise, legacy, precise.replaceAll('\n', '\r\n')]) {
    const whole = decode(text);
    for (let split = 0; split <= text.length; split++) {
      const parser = createCsvParser({ fallbackStartTime: START, signedCurrent: true });
      parser.push(text.slice(0, split));
      parser.push(text.slice(split));
      const streamed = parser.finish();
      assert.deepEqual(columnsOf(streamed), columnsOf(whole), `split at ${split}`);
      assert.equal(streamed.startTime, whole.startTime);
      assert.equal(streamed.intervalMs, whole.intervalMs);
    }
  }
});

test('a byte-at-a-time feed still parses, and runaway lines are refused', () => {
  const text = encode(makeColumns([{ x: 0, timestamps: START, voltage: 5, current: 1, power: 5 }]));
  const parser = createCsvParser({ fallbackStartTime: START });
  for (const ch of text) parser.push(ch);
  assert.equal(parser.rows, 1);
  assert.equal(parser.finish().columns.voltage.at(0), 5);
  assert.throws(() => createCsvParser({ fallbackStartTime: START }).push('x'.repeat((1 << 20) + 1)), /行过长/);
});

test('range formatting concatenates to exactly the chunked body', () => {
  const cols = emptyChartColumns();
  for (let i = 0; i < 10; i++) for (const key of KEYS) cols[key].push(key === 'x' ? i / 4 : i + 0.5);
  const snapshot = snapshotCsvColumns(cols, { sampleRate: 250, startTime: START });
  const [header, ...body] = [...formatCsvChunks(snapshot, 4)];
  assert.ok(header.endsWith('RelativeTime(s),Timestamp(ms),SampleInterval(ms),\n'));
  assert.equal(
    [formatCsvRange(snapshot, 0, 3), formatCsvRange(snapshot, 3, 7), formatCsvRange(snapshot, 7, 99)].join(''),
    body.join(''),
  );
  assert.equal(formatCsvRange(snapshot, 5, 5), '');
});

test('the spool header has a fixed-width patchable prefix and imports like an export', () => {
  const small = formatSpoolHeaderPatch({ length: 0, lastX: Number.NaN, sampleRate: 1 });
  const large = formatSpoolHeaderPatch({ length: 123_456_789, lastX: 40 * 86400 + 3661.5, sampleRate: 60000 });
  assert.equal(small.length, SPOOL_PATCH_BYTES);
  assert.equal(large.length, SPOOL_PATCH_BYTES);
  assert.match(large, /^SUM,000123456789\nTotalTime,="0040\.01:01:01\.500"\nSampTime\(ms\),060000\n$/);

  const cols = makeColumns([
    { x: 0, timestamps: START, voltage: 5, current: 1, power: 5, temp: 30 },
    { x: 0.001, timestamps: START + 1, voltage: 5, current: 1.5, power: 7.5 },
  ]);
  cols.recordingSegments.push(1);
  cols.recordingSegments.push(1);
  const snapshot = snapshotCsvColumns(cols, {
    sampleRate: 1,
    startTime: START,
    withTemp: true,
    recordingSegments: cols.recordingSegments,
  });
  const header = formatSpoolHeader({ length: 0, lastX: Number.NaN, sampleRate: 1, startTime: START });
  assert.ok(header.startsWith(small), 'the patchable prefix is the header start');
  const text = header + formatCsvRange(snapshot, 0, 2);
  const parsed = decode(text);
  assert.equal(parsed.intervalMs, 1, 'a 1 ms declared interval is trusted');
  // DateTime is written to the second, exactly as exports do; exact times live in Timestamp(ms).
  assert.equal(parsed.startTime, Math.floor(START / 1000) * 1000);
  assert.equal(parsed.columns.timestamps.at(1), START + 1);
  assert.deepEqual([...parsed.columns.current.view()], [1, 1.5]);
  assert.equal(parsed.columns.temp.at(0), 30);
  assert.deepEqual([...parsed.recordingSegments.view()], [1, 1]);
});

test('a truncated last row of a precise file is dropped, a complete one is kept', () => {
  const cols = makeColumns([
    { x: 0, timestamps: START, voltage: 5, current: 1, power: 5 },
    { x: 1, timestamps: START + 1000, voltage: 6, current: 1, power: 6 },
  ]);
  const text = encode(cols);
  const cut = text.slice(0, text.length - 4);
  assert.equal(decode(cut).columns.x.length, 1, 'the half-written row never becomes data');
  assert.equal(decode(text.trimEnd()).columns.x.length, 2, 'no trailing newline is fine when the row is complete');
  // Rows edited to drop the trailing comma keep every row, including the last one.
  const edited = text.replace(/,\n/g, '\n').trimEnd();
  assert.equal(decode(edited).columns.x.length, 2);
});
