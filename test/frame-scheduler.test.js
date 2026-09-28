import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrameScheduler } from '../src/frame-scheduler.js';

function harness() {
  let nextId = 0;
  const frames = new Map();
  const errors = [];
  const scheduler = createFrameScheduler({
    request(callback) {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancel: (id) => frames.delete(id),
    report: (error) => errors.push(error),
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  return { scheduler, frames, errors, flush };
}

test('coalesces keys and resolves range state before charts regardless of request order', () => {
  const { scheduler, frames, flush } = harness();
  const seen = [];
  let range = 'old';
  scheduler.schedule('chart', () => seen.push(range), 10);
  scheduler.schedule('range', () => seen.push('superseded'));
  scheduler.schedule('range', () => (range = 'latest'));
  assert.equal(frames.size, 1);
  flush();
  assert.deepEqual(seen, ['latest']);
  assert.equal(frames.size, 0);
});

test('canceling a chart does not cancel queued status or card updates', () => {
  const { scheduler, frames, flush } = harness();
  const seen = [];
  scheduler.schedule('chart', () => seen.push('chart'), 10);
  scheduler.schedule('cards', () => seen.push('cards'));
  scheduler.cancel('chart');
  assert.equal(frames.size, 1);
  flush();
  assert.deepEqual(seen, ['cards']);
  scheduler.schedule('cards', () => {});
  scheduler.cancel('cards');
  assert.equal(frames.size, 0);
});

test('updates to pending jobs execute once and new jobs wait for the next frame', () => {
  const { scheduler, frames, flush } = harness();
  const seen = [];
  scheduler.schedule('cards', () => {
    scheduler.schedule('chart', () => seen.push('updated chart'), 10);
    scheduler.schedule('next', () => seen.push('next'));
  });
  scheduler.schedule('chart', () => seen.push('old chart'), 10);
  flush();
  assert.deepEqual(seen, ['updated chart']);
  assert.equal(frames.size, 1);
  flush();
  assert.deepEqual(seen, ['updated chart', 'next']);
  assert.equal(frames.size, 0);
});

test('a failed display job is reported and does not prevent other jobs from running', () => {
  const { scheduler, errors, frames, flush } = harness();
  const error = new Error('display');
  let drawn = false;
  scheduler.schedule('cards', () => {
    throw error;
  });
  scheduler.schedule('chart', () => (drawn = true), 10);
  flush();
  assert.equal(drawn, true);
  assert.deepEqual(errors, [error]);
  assert.equal(frames.size, 0);
});

test('synchronous frame hosts do not retain a completed request', () => {
  const scheduler = createFrameScheduler({
    request: (callback) => {
      callback(0);
      return 1;
    },
  });
  let calls = 0;
  scheduler.schedule('cards', () => calls++);
  scheduler.schedule('cards', () => calls++);
  assert.equal(calls, 2);
});
