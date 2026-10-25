// Node's timers, mock or real, wait 1 ms when asked to wait longer than
// MAX_TIMEOUT_MS, so a single overlong setTimeout fails the first test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMEOUT_MS, callAt } from '../src/timer.js';

const DAY_MS = 86_400_000;

test('a time past setTimeout\'s limit is reached in steps, neither early nor late', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  callAt(30 * DAY_MS, () => { calls++; });
  t.mock.timers.tick(MAX_TIMEOUT_MS);
  assert.equal(calls, 0, 'not called when the first step ends');
  t.mock.timers.tick(30 * DAY_MS - MAX_TIMEOUT_MS - 1);
  assert.equal(calls, 0, 'not called a millisecond early');
  t.mock.timers.tick(1);
  assert.equal(calls, 1, 'called at its time');
});

test('no step asks setTimeout for longer than it can hold', async () => {
  // Real timers: an overlong step would warn and wait 1 ms, and each wake would
  // ask again, so the process would wake every millisecond without firing.
  const overflows: string[] = [];
  const onWarning = (warning: Error) => { if (warning.name === 'TimeoutOverflowWarning') overflows.push(warning.message); };
  process.on('warning', onWarning);
  const cancel = callAt(Date.now() + 30 * DAY_MS, () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  cancel();
  process.off('warning', onWarning);
  assert.deepEqual(overflows, []);
});

test('a time already passed is called from a timer, not before callAt returns', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let calls = 0;
  callAt(0, () => { calls++; });
  assert.equal(calls, 0, 'not called synchronously');
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
});

test('a time already passed asks setTimeout to wait 0 ms, never a negative time', (t) => {
  // Asked for a negative wait, Node 24 warns (TimeoutNegativeWarning), but only
  // once per process, and Node 22.12.0 doesn't, so a stand-in records the wait.
  const waits: unknown[] = [];
  t.mock.method(globalThis, 'setTimeout', ((_fn: () => void, ms?: number) => {
    waits.push(ms);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  callAt(Date.now() - 10_000, () => {});
  assert.deepEqual(waits, [0]);
});

test('cancelling after a step has passed cancels the step that is pending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const cancel = callAt(30 * DAY_MS, () => { calls++; });
  t.mock.timers.tick(MAX_TIMEOUT_MS + 1);
  cancel();
  t.mock.timers.tick(30 * DAY_MS);
  assert.equal(calls, 0);
});
