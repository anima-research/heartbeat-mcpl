import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

test('every argument is applied, or the call is refused and changes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-arguments-'));
  const config = join(dir, 'config.json');
  const reminders = join(dir, 'reminders.json');
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: config, HEARTBEAT_REMINDERS_FILE: reminders, AGENT_TIMEZONE: 'UTC' },
    autoApprove: true,
  });
  t.after(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await session.start();
  await session.raw('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
    enabled: ['heartbeat'], disabled: [],
  });
  const call = async (name, args) => {
    const result = await session.callTool(name, args);
    return { isError: result.isError === true, text: result.content[0].text };
  };
  const stored = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const saved = () => (existsSync(reminders) ? JSON.parse(readFileSync(reminders, 'utf8')) : []);
  const listed = async (id) => (await call('reminder_list', {})).text.split('\n').find((line) => line.startsWith(`${id} |`));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fired = [];
  session.on('event', (ev) => {
    if (ev.kind === 'push' && ev.data?.origin?.source === 'reminder') fired.push(ev.data.origin.reminderId);
  });
  const add = async (args, delayMs) => {
    const before = Date.now();
    const result = await call('reminder_add', { message: 'x', ...args });
    const after = Date.now();
    assert.equal(result.isError, false, result.text);
    const id = /^Reminder (rem_\S+) set/.exec(result.text)?.[1];
    const row = saved().find((r) => r.id === id);
    assert.ok(row.fireAt >= before + delayMs && row.fireAt <= after + delayMs,
      `${JSON.stringify(args)} first fires ${row.fireAt - before} ms after the call began, for a delay of ${delayMs} ms`);
    return row;
  };

  await t.test('a call with one argument it can\'t read is refused whole', async () => {
    const before = stored(config);
    const { isError, text } = await call('heartbeat_configure', { paused: true, intervalMinutes: '30' });
    assert.equal(isError, true);
    assert.equal(text, 'heartbeat_configure: nothing was changed. "intervalMinutes" is the string "30"; give it as a number: 30.');
    assert.equal(stored(config), before);
    assert.match((await call('heartbeat_status', {})).text, /^Heartbeat ACTIVE/);
  });

  await t.test('interval units add up, and the total is saved', async () => {
    const { isError, text } = await call('heartbeat_configure', { intervalHours: 1, intervalMinutes: 30 });
    assert.equal(isError, false, text);
    assert.match(text, /interval=5400s/);
    assert.equal(JSON.parse(stored(config)).intervalSeconds, 5400);
  });

  await t.test('an interval under the floor is refused, not raised to it; one at the floor is applied', async () => {
    for (const [seconds, shown, kept] of [[10, '10', '10'], [59.5, '59\\.5', '59\\.5'], [59.9994, '59\\.9994', '59\\.999']]) {
      const { isError, text } = await call('heartbeat_configure', { intervalSeconds: seconds });
      assert.equal(isError, true);
      assert.match(text, new RegExp(`"intervalSeconds" ${shown} is ${kept} s, under the heartbeat's 60-second floor; `
        + 'give 60 seconds or more, or leave the interval out and pause the heartbeat with "paused": true\\.$'));
      assert.match((await call('heartbeat_status', {})).text, /interval=5400s/);
    }
    assert.match((await call('heartbeat_configure', { intervalSeconds: 60 })).text, /^Updated\. .*interval=60s/);
    assert.match((await call('heartbeat_configure', { intervalSeconds: 59.9996 })).text, /^Updated\. .*interval=60s/);
    assert.match((await call('heartbeat_configure', { intervalHours: 1.5 })).text, /^Updated\. .*interval=5400s/);
  });

  await t.test('a blank message or a negative interval is refused, changing nothing', async () => {
    const before = stored(config);
    for (const [args, reason] of [
      [{ message: '  ' }, /"message" is blank/],
      [{ intervalMinutes: -5 }, /"intervalMinutes" -5 is negative; give 0 or more\./],
      [{ intervalHours: 1e306 }, /"intervalHours" 1e\+306 puts the next heartbeat past \+275760-09-13T00:00:00Z, the last time it can be set for; give a shorter interval, or leave the interval out and pause the heartbeat with "paused": true\.$/],
      [{ intervalSeconds: 9e12 }, /^heartbeat_configure: nothing was changed\. "intervalSeconds" 9000000000000 puts the next heartbeat past \+275760-09-13T00:00:00Z/],
    ]) {
      const { isError, text } = await call('heartbeat_configure', args);
      assert.equal(isError, true, text);
      assert.match(text, reason);
    }
    assert.equal(stored(config), before);
  });

  await t.test('the heartbeat interval may reach the last time a Date holds, and not past it', async () => {
    // 8.64e15 ms, +275760-09-13T00:00:00Z, is the last time a Date holds.
    const room = Math.floor((8.64e15 - Date.now()) / 1000);
    const within = await call('heartbeat_configure', { intervalSeconds: room - 3600 });
    assert.equal(within.isError, false, within.text);
    assert.match(within.text, new RegExp(`^Updated\\. .*interval=${room - 3600}s`));
    const past = await call('heartbeat_configure', { intervalSeconds: room + 3600 });
    assert.equal(past.isError, true, past.text);
    assert.match(past.text, /puts the next heartbeat past \+275760-09-13T00:00:00Z, the last time it can be set for/);
    assert.match((await call('heartbeat_configure', { intervalHours: 1.5 })).text, /^Updated\. .*interval=5400s/);
  });

  await t.test('a key like nothing here is ignored and named; sent alone, it is refused', async () => {
    const applied = await call('heartbeat_configure', { paused: true, reason: 'quieter' });
    assert.equal(applied.isError, false, applied.text);
    assert.match(applied.text, /^Updated\. Heartbeat PAUSED .* heartbeat_configure ignored "reason", which it doesn't take; it takes "intervalSeconds"/);
    const alone = await call('heartbeat_configure', { reason: 'quieter' });
    assert.equal(alone.isError, true);
    assert.match(alone.text, /^heartbeat_configure: nothing was changed\. It doesn't take "reason"; it takes /);
    const refused = await call('heartbeat_configure', { intervalSeconds: 30, reason: 'quieter' });
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /^heartbeat_configure: nothing was changed\. "intervalSeconds" 30 is 30 s, under the heartbeat's 60-second floor; .* It also doesn't take "reason"; it takes "intervalSeconds", /);
    const before = stored(config);
    const part = await call('heartbeat_configure', { paused: false, mode: 'silent' });
    assert.equal(part.isError, true, part.text);
    assert.equal(part.text, 'heartbeat_configure: nothing was changed. "mode" isn\'t an argument heartbeat_configure takes; the closest is "deliveryMode".');
    assert.equal(stored(config), before);
    const extra = await call('heartbeat_configure', { paused: false, pausedReason: 'testing' });
    assert.equal(extra.isError, false, extra.text);
    assert.match(extra.text, /^Updated\. Heartbeat ACTIVE .* heartbeat_configure ignored "pausedReason", which it doesn't take; it takes "intervalSeconds"/);
    const held = stored(config);
    const inPlace = await call('heartbeat_configure', { heartbeatIntervalMinutes: 30, paused: true });
    assert.equal(inPlace.isError, true, inPlace.text);
    assert.equal(inPlace.text, 'heartbeat_configure: nothing was changed. "heartbeatIntervalMinutes" isn\'t an argument heartbeat_configure takes; the closest is "intervalMinutes".');
    const reasonAlone = await call('heartbeat_configure', { pausedReason: 'testing' });
    assert.equal(reasonAlone.isError, true, reasonAlone.text);
    assert.equal(reasonAlone.text, 'heartbeat_configure: nothing was changed. "pausedReason" isn\'t an argument heartbeat_configure takes; the closest is "paused".');
    const twoNames = await call('heartbeat_configure', { paused: true, pausedMessage: 'back soon' });
    assert.equal(twoNames.isError, true, twoNames.text);
    assert.equal(twoNames.text, 'heartbeat_configure: nothing was changed. "pausedMessage" isn\'t an argument heartbeat_configure takes; the closest is "message".');
    const interval = await call('heartbeat_configure', { interval: 30 });
    assert.equal(interval.isError, true, interval.text);
    assert.equal(interval.text, 'heartbeat_configure: nothing was changed. "interval" isn\'t an argument heartbeat_configure takes; '
      + 'the closest is "intervalHours", "intervalSeconds" or "intervalMinutes".');
    assert.equal(stored(config), held);
  });

  await t.test('another tool\'s argument is refused where it would do nothing', async () => {
    const { isError, text } = await call('reminder_list', { id: 'rem_x' });
    assert.equal(isError, true);
    assert.equal(text, 'reminder_list: nothing was listed. "id" is reminder_cancel\'s argument, not reminder_list\'s; reminder_list takes no arguments.');
    const shared = await call('reminder_cancel', { id: 'rem_x', message: 'x' });
    assert.equal(shared.isError, true);
    assert.equal(shared.text, 'reminder_cancel: nothing was cancelled. "message" is heartbeat_configure\'s and reminder_add\'s argument, '
      + 'not reminder_cancel\'s; reminder_cancel takes "id".');
    const cased = await call('reminder_cancel', { id: 'rem_x', Message: 'x' });
    assert.equal(cased.isError, true);
    assert.match(cased.text, /"Message" is close to "message", heartbeat_configure's and reminder_add's argument, not one reminder_cancel takes/);
  });

  await t.test('delay units add up, a one-off delay under 5 s is kept as given, and 0 fires at once', async () => {
    await add({ inHours: 1, inMinutes: 30 }, 5_400_000);
    const soon = await add({ inSeconds: 4 }, 4000);
    assert.equal((await call('reminder_cancel', { id: soon.id })).isError, false);
    const firedByCancel = fired.length;
    const zero = await call('reminder_add', { message: 'x', inSeconds: 0 });
    assert.equal(zero.isError, false, zero.text);
    const zeroId = /^Reminder (rem_\S+) set/.exec(zero.text)?.[1];
    for (const deadline = Date.now() + 10_000; !fired.includes(zeroId) && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(fired.filter((id) => id !== soon.id), [zeroId], 'the reminder with no delay fires, and only it');
    assert.equal(fired.slice(firedByCancel).includes(soon.id), false, 'the cancelled reminder never fires after its cancel');
    for (const deadline = Date.now() + 5_000; await listed(zeroId) !== undefined; await sleep(50)) {
      assert.ok(Date.now() < deadline, 'it is gone once the host has taken its push');
    }
    assert.equal(saved().some((r) => r.id === zeroId), false, 'from the file too');
  });

  await t.test('a fraction of a second is kept to the millisecond, in the first fire and each advance', async () => {
    const later = await add({ inSeconds: 8.001 }, 8001);
    // 8.001 * 1000 is 8000.999999999999, which rounds to 8001 when added to a time of an epoch's size.
    assert.equal(later.fireAt, later.createdAt + 8001, 'a first fire 8.001 s on');
    assert.equal((await call('reminder_cancel', { id: later.id })).isError, false);
    const repeating = await call('reminder_add', { message: 'x', inSeconds: 0, everySeconds: 8.001 });
    assert.equal(repeating.isError, false, repeating.text);
    const id = /^Reminder (rem_\S+) set/.exec(repeating.text)?.[1];
    for (const deadline = Date.now() + 5_000; !/\(~[1-9]\d*s\)/.test(await listed(id) ?? ''); await sleep(50)) {
      assert.ok(Date.now() < deadline, 'it fired, and advanced once the host took it');
    }
    const row = saved().find((r) => r.id === id);
    assert.equal(row.fireAt, row.createdAt + 8001, 'a period of 8.001 s on');
    assert.equal((await call('reminder_cancel', { id })).isError, false);
  });

  await t.test('a repeating reminder at its floor is set, and a fraction is kept', async () => {
    for (const [seconds, kept] of [[5, 5], [7.5, 7.5], [4.9996, 5]]) {
      const row = await add({ everySeconds: seconds }, kept * 1000);
      assert.equal(row.everySeconds, kept);
      assert.equal((await call('reminder_cancel', { id: row.id })).isError, false);
    }
  });

  await t.test('atIso with an interval sets the first fire and the period', async () => {
    const { isError, text } = await call('reminder_add', { message: 'DAILY', atIso: '2099-07-15T09:00Z', everyHours: 24 });
    assert.equal(isError, false, text);
    const row = saved().find((r) => r.message === 'DAILY');
    assert.equal(row.fireAt, Date.parse('2099-07-15T09:00:00Z'));
    assert.equal(row.everySeconds, 86_400);
  });

  await t.test('contradictions, intervals under the floor and wrong types are each refused, saving nothing', async () => {
    const before = stored(reminders);
    for (const [name, args, reason] of [
      ['reminder_add', { message: 'x', atIso: '2099-07-15T09:00Z', inMinutes: 5 }, /"atIso" and "inMinutes" both set when it first fires; give one of them\./],
      ['reminder_add', { message: 'x', atIso: '2099-07-15T09:00Z', inMinutes: -5 }, /"inMinutes" -5 is negative; give 0 or more\. "atIso" and "inMinutes" both set when it first fires; give one of them\./],
      ['reminder_add', { message: '  ', inSeconds: 1e13 }, /"message" is blank; .* "inSeconds" 10000000000000 puts it past \+275760-09-13T00:00:00Z/],
      ['reminder_add', { message: 'x', everySeconds: 2 }, /"everySeconds" 2 is 2 s, under the 5-second floor for a repeating reminder; give 5 seconds or more, or leave the interval out and give a delay or atIso for a one-off\.$/],
      ['reminder_add', { message: 'x', everySeconds: 4.9 }, /"everySeconds" 4\.9 is 4\.9 s, under the 5-second floor for a repeating reminder/],
      ['reminder_add', { message: 'x', everySeconds: 4.9994 }, /"everySeconds" 4\.9994 is 4\.999 s, under the 5-second floor for a repeating reminder/],
      ['reminder_add', { message: 'x', inMinutes: '5' }, /"inMinutes" is the string "5"; give it as a number: 5\./],
      ['reminder_add', { message: 'x', inMinutes: -5, everySeconds: 10 }, /"inMinutes" -5 is negative; give 0 or more\./],
      ['reminder_add', { message: 'x', inSeconds: 5, every: 60 }, /"every" isn't an argument reminder_add takes; the closest is "everyHours", "everySeconds" or "everyMinutes"\./],
      ['reminder_add', { message: '  ', inMinutes: 5 }, /"message" is blank/],
      ['reminder_add', { message: 'x' }, /No time was given: give a delay in inSeconds, inMinutes or inHours, a time in atIso, or an interval/],
      ['reminder_cancel', { id: 5 }, /^reminder_cancel: nothing was cancelled\. "id" is the number 5/],
      ['reminder_cancel', {}, /^reminder_cancel: nothing was cancelled\. "id" is missing: the id of the reminder to cancel, as reminder_add returned it and reminder_list shows it; it starts with rem_\.$/],
      ['reminder_cancel', { id: '  ' }, /"id" is blank/],
    ]) {
      const { isError, text } = await call(name, args);
      assert.equal(isError, true, text);
      assert.match(text, reason);
    }
    const unread = await call('reminder_add', { message: 'x', atIso: 'not a time', everySeconds: 1e13 });
    assert.equal(unread.isError, true, unread.text);
    assert.match(unread.text, /"atIso" "not a time" isn't a time this tool reads\./);
    assert.doesNotMatch(unread.text, /first fire/);
    const negative = await call('reminder_add', { message: 'x', inMinutes: -5, everySeconds: 1e13 });
    assert.equal(negative.isError, true, negative.text);
    assert.match(negative.text, /"inMinutes" -5 is negative; give 0 or more\./);
    assert.doesNotMatch(negative.text, /first fire/);
    assert.equal(stored(reminders), before);
  });
});
