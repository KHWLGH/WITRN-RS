import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceStream } from '../src/device-stream.js';
import { streamSampleTime } from '../src/measurement.js';

function sample(seq, segment = 1, generation = 1) {
  return {
    generation,
    seq,
    segment,
    received_us: seq * 10000,
    segment_start_us: 10000,
    wall_anchor_ms: 1704067200000,
    rate_ms: 10,
    voltage: 12,
    current: -1,
    power: -12,
  };
}

function harness(options = {}) {
  const result = {
    columns: {},
    samples: [],
    errors: [],
    ends: [],
    calls: [],
    boundary: 0,
    end: { generation: 1, last_seq: 0 },
  };
  result.stream = createDeviceStream({
    getColumns: () => result.columns,
    onSample: (value, segment) => result.samples.push({ value, segment }),
    onError: (error) => result.errors.push(error),
    onEnd: (end) => result.ends.push(end),
    invoke: async (command, args) => {
      result.calls.push({ command, args });
      if (command === 'set_recording_segment')
        return {
          generation: args.generation,
          after_seq: result.boundary,
          segment: args.segment,
          received_us: result.boundary * 10000,
          wall_anchor_ms: 1704067200000,
          rate_ms: 10,
        };
      if (command === 'drain_device_stream') return result.end;
    },
    ...options,
  });
  result.stream.enable();
  result.stream.open({ generation: 1, wall_anchor_ms: 1704067200000 });
  return result;
}

/** @param {ReturnType<typeof harness>} h */
function forceTerminalFailure(h) {
  h.end = { generation: 1, last_seq: 3, error: 'stream seq gap' };
}

// ─── 终态错误之后仍要能退出 ───────────────────────────────────────────────────
// 一旦 fail() 落定，生产端已经被 drain 停掉：屏障守的样本其实已经不存在了。
// 此时若还坚持「消费完才准销毁」，断开 / 重连 / 退出会永久全部失败，只能杀进程。

test('a terminal failure still reaches shutdown', async () => {
  const h = harness();
  await h.stream.begin(0);
  forceTerminalFailure(h);
  h.stream.handleBatch([sample(1), sample(3)]);

  await h.stream.drain();
  await h.stream.shutdown();

  const commands = h.calls.map((c) => c.command);
  assert.equal(commands.at(-1), 'shutdown', '终态失败不能把退出流程永久卡住');
  assert.deepStrictEqual(h.calls.at(-1).args, { generation: 1, lastSeq: 3 });
  assert.ok(commands.includes('abandon_device_stream'), '必须显式退休这个会话');
});

test('a terminal failure never acknowledges the hole', async () => {
  const h = harness();
  await h.stream.begin(0);
  forceTerminalFailure(h);
  h.stream.handleBatch([sample(1), sample(3)]);
  await h.stream.drain();
  await h.stream.shutdown();

  assert.equal(
    h.calls.some((c) => c.command === 'ack_device_stream'),
    false,
    '逃生口只退休会话，不能把丢掉的样本标成已消费',
  );
  assert.equal(
    h.calls.some((c) => c.command === 'shutdown' && c.args.force),
    false,
    'shutdown 的载荷形状必须保持不变，放宽只能发生在 abandon 一侧',
  );
});

test('an end past the consumed point retires the session instead of hanging', async () => {
  const h = harness();
  await h.stream.begin(0);
  h.stream.handleBatch([sample(1)]);
  h.stream.handleEnd({ generation: 1, last_seq: 5, error: 'dropped' });

  assert.equal(h.ends.length, 1, '连接已经结束就必须通知 UI');
  assert.equal(h.stream.ended, true);
});

test('a stalled drain escapes on the retry instead of blocking exit forever', async () => {
  const h = harness({ drainTimeoutMs: 20 });
  await h.stream.begin(0);
  h.end = { generation: 1, last_seq: 2 };
  h.stream.handleBatch([sample(1)]);

  await assert.rejects(h.stream.drain(), /timed out/);
  await h.stream.drain();
  await h.stream.shutdown();

  const commands = h.calls.map((c) => c.command);
  assert.equal(commands.at(-1), 'shutdown', '第二次尝试必须能走完退出');
});

test('a new generation clears the terminal failure and keeps the strict path', async () => {
  const h = harness();
  await h.stream.begin(0);
  forceTerminalFailure(h);
  h.stream.handleBatch([sample(1), sample(3)]);
  await h.stream.drain();
  await h.stream.shutdown();

  h.stream.open({ generation: 2, wall_anchor_ms: 1704067200000 });
  h.end = { generation: 2, last_seq: 1 };
  h.calls.length = 0;
  const draining = h.stream.drain();
  await Promise.resolve();
  h.stream.handleBatch([sample(1, 1, 2)]);
  assert.deepStrictEqual(await draining, { generation: 2, last_seq: 1 });

  const commands = h.calls.map((c) => c.command);
  assert.ok(commands.includes('ack_device_stream'), '健康路径必须照旧消费并 ACK');
  assert.equal(
    commands.includes('abandon_device_stream'),
    false,
    '健康路径不能顺手走终态逃生口',
  );
});

test('each selected sample is consumed once, in sequence, without animation frames', async () => {
  const h = harness();
  await h.stream.begin(0);
  h.stream.handleBatch([sample(1), sample(2), sample(2), sample(3)]);
  await Promise.resolve();
  assert.deepStrictEqual(
    h.samples.map((s) => s.value.seq),
    [1, 2, 3],
  );
  assert.ok(h.samples.every((s) => s.segment?.id === 1));
  assert.equal(h.stream.lastSeq, 3);
  assert.equal(h.errors.length, 0);
});

test('sequence gaps terminate instead of acknowledging lost samples', async () => {
  const h = harness();
  await h.stream.begin(0);
  h.stream.handleBatch([sample(1), sample(3), sample(4)]);
  await Promise.resolve();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].error, /seq gap/);
  assert.deepStrictEqual(
    h.samples.map((s) => s.value.seq),
    [1],
  );
  assert.equal(
    h.calls.some((c) => c.command === 'ack_device_stream'),
    false,
  );
});

test('manual pause consumes its barrier tail then excludes preview samples', async () => {
  const h = harness();
  await h.stream.begin(0);
  h.stream.handleBatch([sample(1)]);
  h.boundary = 3;
  const paused = h.stream.pause();
  await Promise.resolve();
  h.stream.handleBatch([sample(2), sample(3), sample(4, 0)]);
  await paused;
  assert.deepStrictEqual(
    h.samples.map((s) => s.segment?.id || 0),
    [1, 1, 1, 0],
  );
});

test('auto-pause synchronously excludes the remainder of the same batch', async () => {
  const h = harness();
  await h.stream.begin(0);
  h.stream.configure({
    onSample(value, segment) {
      h.samples.push({ value, segment });
      if (value.seq === 2) void h.stream.pause({ discard: true });
    },
  });
  h.stream.handleBatch([sample(1), sample(2), sample(3), sample(4)]);
  await h.stream.settle();
  assert.deepStrictEqual(
    h.samples.map((s) => s.segment?.id || 0),
    [1, 1, 0, 0],
  );
  assert.equal(h.stream.lastSeq, 4);
});

test('clear and replacement cannot ingest old segment samples into new columns', async () => {
  const h = harness();
  await h.stream.begin(0);
  h.stream.handleBatch([sample(1)]);
  h.columns = {};
  h.boundary = 3;
  h.stream.replace();
  h.stream.handleBatch([sample(2), sample(3)]);
  await h.stream.settle();
  h.stream.handleBatch([sample(4, 0)]);
  assert.deepStrictEqual(
    h.samples.map((s) => s.value.seq),
    [1, 4],
  );
  assert.equal(h.samples.at(-1).segment, null);
});

test('old connection batches never enter a new generation', async () => {
  const h = harness();
  h.stream.handleBatch([sample(1, 0)]);
  h.stream.open({ generation: 2, wall_anchor_ms: 1704067201000 });
  h.stream.handleBatch([sample(2, 0, 1), sample(1, 0, 2)]);
  assert.deepStrictEqual(
    h.samples.map((s) => [s.value.generation, s.value.seq]),
    [
      [1, 1],
      [2, 1],
    ],
  );
});

test('native overload consumes retained prefix before reporting termination', async () => {
  const h = harness();
  await h.stream.begin(0);
  const end = { generation: 1, last_seq: 3, error: 'queue capacity exceeded' };
  h.stream.handleError(end);
  assert.equal(h.errors.length, 0);
  h.stream.handleBatch([sample(1), sample(2), sample(3)]);
  h.stream.handleEnd(end);
  assert.equal(h.samples.length, 3);
  assert.equal(h.errors.length, 1);
  assert.equal(h.ends.length, 1);
});

test('shutdown waits for last sequence and sends explicit receipt before destroy', async () => {
  const h = harness();
  await h.stream.begin(0);
  h.end = { generation: 1, last_seq: 2 };
  const closing = h.stream.shutdown();
  await Promise.resolve();
  assert.equal(
    h.calls.some((c) => c.command === 'shutdown'),
    false,
  );
  h.stream.handleBatch([sample(1), sample(2)]);
  await closing;
  const commands = h.calls.map((c) => c.command);
  assert.equal(commands.at(-1), 'shutdown');
  assert.equal(h.calls.at(-2).args.seq, 2);
  assert.deepStrictEqual(h.calls.at(-1).args, { generation: 1, lastSeq: 2 });
});

test('host receive clock keeps real gaps and is independent of IPC arrival', () => {
  const point = sample(2);
  assert.deepStrictEqual(streamSampleTime(point, 5), { seconds: 5.01, wallMs: 1704067200020 });
  point.received_us = 5000020;
  assert.deepStrictEqual(streamSampleTime(point, 5), { seconds: 5 + 4.99002, wallMs: 1704067205000.02 });
});

test('diagnostics 是真机验收的读数来源：逐条计数，背压单独归类', async () => {
  const h = harness();
  const fresh = h.stream.diagnostics();
  assert.deepEqual(
    { streamErrors: fresh.streamErrors, capacityErrors: fresh.capacityErrors, seq: fresh.seq },
    { streamErrors: 0, capacityErrors: 0, seq: 0 },
    '没跑过就该报零，而不是报 null/undefined 让人误以为已通过',
  );
  await h.stream.begin(0);
  h.stream.handleBatch([sample(1), sample(3)]); // seq 空洞 -> 一条 stream-error
  await Promise.resolve();
  h.stream.handleError({
    generation: 99,
    last_seq: 3,
    error: 'unacknowledged sample capacity exceeded; acquisition stopped',
  });
  await Promise.resolve();
  const d = h.stream.diagnostics();
  assert.equal(d.streamErrors, 2);
  assert.equal(d.capacityErrors, 1, '背压超限必须能从总数里分出来：CSV 看起来完整而采集其实已停');
  assert.equal(d.seq, 1);
  // 刻意的取舍：连陈旧 generation 的错误也计入。中途重连过的运行应当重测，而不是让闸门替你放行。
  assert.match(String(d.lastError), /capacity exceeded/);
});
