import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const POLICY = {
  effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
  enabled: ['heartbeat'], disabled: [],
};

async function start(t, { config: storedConfig, reminders: storedReminders } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-intervals-'));
  const config = join(dir, 'config.json');
  const reminders = join(dir, 'reminders.json');
  if (storedConfig) writeFileSync(config, JSON.stringify(storedConfig));
  if (storedReminders) writeFileSync(reminders, JSON.stringify(storedReminders));
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: config, HEARTBEAT_REMINDERS_FILE: reminders },
    autoApprove: true,
  });
  t.after(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const heartbeats = [];
  const fired = [];
  session.on('event', (ev) => {
    if (ev.kind !== 'push') return;
    if (ev.data?.origin?.source === 'heartbeat') heartbeats.push(ev.data);
    if (ev.data?.origin?.source === 'reminder') fired.push(ev.data.origin.reminderId);
  });
  await session.start();
  await session.raw('featureSets/update', POLICY);
  const status = async () => (await session.callTool('heartbeat_status', {})).content[0].text;
  const restartWith = async (next) => {
    writeFileSync(config, JSON.stringify(next));
    await session.restart();
    await session.raw('featureSets/update', POLICY);
  };
  return { session, heartbeats, fired, status, restartWith };
}

test('a 720-hour interval waits for its time, and the status counts down to it', async (t) => {
  const { session, heartbeats, status } = await start(t);
  await session.callTool('heartbeat_configure', { intervalHours: 720 });
  await sleep(2000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the two seconds after setting it');
  const next = Number(/next in ~(\d+)s/.exec(await status())?.[1]);
  assert.ok(next > 2_591_000 && next <= 2_592_000, `next in ~${next}s, of 2592000`);
});

test('a stored heartbeat interval is read as heartbeat_configure would have taken it', async (t) => {
  const { session, heartbeats, status, restartWith } = await start(t, { config: { intervalSeconds: null, paused: false } });
  const armed = async () => {
    const text = await status();
    assert.match(text, /^Heartbeat ACTIVE /);
    const interval = Number(/interval=(\d+)s/.exec(text)?.[1]);
    const next = Number(/next in ~(\d+)s/.exec(text)?.[1]);
    assert.ok(next > interval - 10 && next <= interval, `next in ~${next}s of ${interval}s`);
    return interval;
  };
  await sleep(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting on a stored null');
  const paused = await status();
  assert.match(paused, /^Heartbeat PAUSED \| .*interval=14400s /, 'null, saved for "never", loads paused');
  assert.doesNotMatch(paused, /next in/);
  await session.callTool('heartbeat_configure', { paused: false });
  assert.equal(await armed(), 14_400, 'resumed, it runs at the default');
  await restartWith({ intervalSeconds: '3600', paused: false });
  assert.equal(await armed(), 14_400, 'text falls back to the default, unpaused');
  await restartWith({ intervalSeconds: 0 });
  await sleep(1000);
  assert.equal(heartbeats.length, 0, 'no heartbeat in the second after starting on a stored 0');
  assert.equal(await armed(), 60, 'a stored 0 is raised to the 60 s floor');
  await restartWith({ intervalSeconds: 90 });
  assert.equal(await armed(), 90, 'a stored 90 is kept');
  await restartWith({ intervalSeconds: 1e306, paused: false });
  assert.match(await status(), /^Heartbeat PAUSED \| .*interval=14400s /, 'an interval too long to schedule, saved for "never", loads paused');
  await restartWith({ intervalSeconds: 9e12, paused: false });
  assert.match(await status(), /^Heartbeat PAUSED \| .*interval=14400s /, 'and so does a finite one');
});

const reminderRow = (id, fireAt, everySeconds) => ({ id, message: id, createdAt: Date.now(), fireAt, everySeconds });
const listed = async (session) => (await session.callTool('reminder_list', {})).content[0].text;
const lineOf = (list, id) => list.split('\n').find((l) => l.startsWith(`${id} |`)) ?? '';

test('a stored reminder interval is read as reminder_add would have taken it', async (t) => {
  const hourOn = Date.now() + 3_600_000;
  const { session } = await start(t, {
    reminders: [
      reminderRow('rem_zero', hourOn, 0),
      reminderRow('rem_negative', hourOn, -5),
      reminderRow('rem_three', hourOn, 3),
      reminderRow('rem_once', hourOn, null),
      reminderRow('rem_hourly', hourOn, 3600),
      reminderRow('rem_fraction', hourOn, 7.5),
    ],
  });
  const list = await listed(session);
  assert.match(lineOf(list, 'rem_zero'), /\| one-shot \|/);
  assert.match(lineOf(list, 'rem_negative'), /\| one-shot \|/);
  assert.match(lineOf(list, 'rem_three'), /\| repeats every 5s \|/);
  assert.match(lineOf(list, 'rem_once'), /\| one-shot \|/);
  assert.match(lineOf(list, 'rem_hourly'), /\| repeats every 3600s \|/);
  assert.match(lineOf(list, 'rem_fraction'), /\| repeats every 7\.5s \|/);
});

test('a stored reminder interval of 0 fires once when it falls due, then is gone', async (t) => {
  const dueAt = Date.now() - 1000;
  const { session, fired } = await start(t, { reminders: [reminderRow('rem_zero', dueAt, 0)] });
  for (const deadline = Math.max(dueAt, Date.now()) + 10_000; fired.length === 0 && Date.now() < deadline;) await sleep(50);
  await sleep(1000);
  assert.equal(fired.length, 1, `rem_zero fired ${fired.length} times`);
  assert.equal(lineOf(await listed(session), 'rem_zero'), '', 'rem_zero is gone once it has fired');
});
