import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { origin } from './scripted-host.js';
import { serverInProcess, useClock } from './in-process-host.js';

async function start(t: TestContext, { config: storedConfig, reminders: storedReminders }: { config?: unknown; reminders?: unknown[] } = {}) {
  const heartbeats: PushEventParams[] = [];
  const fired: string[] = [];
  const h = await serverInProcess(t, (p) => {
    if (origin(p).source === 'heartbeat') heartbeats.push(p);
    if (origin(p).source === 'reminder') fired.push(origin(p).reminderId as string);
    return {};
  }, {
    reminders: storedReminders ?? [],
    prepare: ({ config }) => { if (storedConfig) writeFileSync(config, JSON.stringify(storedConfig)); },
  });
  const status = () => h.call('heartbeat_status');
  const restartWith = async (next: unknown) => {
    writeFileSync(h.files.config, JSON.stringify(next));
    await h.restart();
  };
  return { h, heartbeats, fired, status, restartWith };
}

test('a 720-hour interval waits for its time, and the status counts down to it', async (t) => {
  useClock(t);
  const { h, heartbeats, status } = await start(t);
  await h.call('heartbeat_configure', { intervalHours: 720 });
  await h.advance(2000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the two seconds after setting it');
  const next = Number(/next in ~(\d+)s/.exec(await status())?.[1]);
  assert.equal(next, 2_591_998, `next in ~${next}s, of 2592000, two seconds on`);
});

test('a stored heartbeat interval is read as heartbeat_configure would have taken it', async (t) => {
  useClock(t);
  const { h, heartbeats, status, restartWith } = await start(t, { config: { intervalSeconds: null, paused: false } });
  const armed = async (elapsed = 0) => {
    const text = await status();
    assert.match(text, /^Heartbeat ACTIVE /);
    const interval = Number(/interval=(\d+)s/.exec(text)?.[1]);
    const next = Number(/next in ~(\d+)s/.exec(text)?.[1]);
    assert.equal(next, interval - elapsed, `next in ~${next}s of ${interval}s, ${elapsed}s on`);
    return interval;
  };
  await h.advance(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting on a stored null');
  const paused = await status();
  assert.match(paused, /^Heartbeat PAUSED \| .*interval=14400s /, 'null, saved for "never", loads paused');
  assert.doesNotMatch(paused, /next in/);
  await h.call('heartbeat_configure', { paused: false });
  assert.equal(await armed(), 14_400, 'resumed, it runs at the default');
  await restartWith({ intervalSeconds: '3600', paused: false });
  assert.equal(await armed(), 14_400, 'text falls back to the default, unpaused');
  await restartWith({ intervalSeconds: 0 });
  await h.advance(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting on a stored 0');
  assert.equal(await armed(1), 60, 'a stored 0 is raised to the 60 s floor');
  await restartWith({ intervalSeconds: 90 });
  assert.equal(await armed(), 90, 'a stored 90 is kept');
  await restartWith({ intervalSeconds: 1e306, paused: false });
  assert.match(await status(), /^Heartbeat PAUSED \| .*interval=14400s /, 'an interval too long to schedule, saved for "never", loads paused');
  await restartWith({ intervalSeconds: 9e12, paused: false });
  assert.match(await status(), /^Heartbeat PAUSED \| .*interval=14400s /, 'and so does a finite one');
});

const reminderRow = (id: string, fireAt: number, everySeconds: number | null) => ({ id, message: id, createdAt: Date.now(), fireAt, everySeconds });
const lineOf = (list: string, id: string) => list.split('\n').find((l) => l.startsWith(`${id} |`)) ?? '';

test('a stored reminder interval is read as reminder_add would have taken it', async (t) => {
  useClock(t);
  const hourOn = Date.now() + 3_600_000;
  const { h } = await start(t, {
    reminders: [
      reminderRow('rem_zero', hourOn, 0),
      reminderRow('rem_negative', hourOn, -5),
      reminderRow('rem_three', hourOn, 3),
      reminderRow('rem_once', hourOn, null),
      reminderRow('rem_hourly', hourOn, 3600),
      reminderRow('rem_fraction', hourOn, 7.5),
    ],
  });
  const list = await h.call('reminder_list');
  assert.match(lineOf(list, 'rem_zero'), /\| one-shot \|/);
  assert.match(lineOf(list, 'rem_negative'), /\| one-shot \|/);
  assert.match(lineOf(list, 'rem_three'), /\| repeats every 5s \|/);
  assert.match(lineOf(list, 'rem_once'), /\| one-shot \|/);
  assert.match(lineOf(list, 'rem_hourly'), /\| repeats every 3600s \|/);
  assert.match(lineOf(list, 'rem_fraction'), /\| repeats every 7\.5s \|/);
});

test('a stored reminder interval of 0 fires once when it falls due, then is gone', async (t) => {
  useClock(t);
  const dueAt = Date.now() - 1000;
  const { h, fired } = await start(t, { reminders: [reminderRow('rem_zero', dueAt, 0)] });
  await h.until(() => fired.length > 0, () => 'rem_zero never fired');
  await h.advance(1000);
  assert.equal(fired.length, 1, `rem_zero fired ${fired.length} times`);
  assert.equal(lineOf(await h.call('reminder_list'), 'rem_zero'), '', 'rem_zero is gone once it has fired');
});
