// Exercise the built server through the same HostSession used by reminders.harness.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

// The instant of a New York wall time, as this runtime's tzdata places it. A reminder that is
// saved must be in the future, where clock rules are projections, so these rows compute their
// instants rather than fix them. Their dates are far from any clock change, so the offset at
// the wall time read as UTC is the offset that applies.
const newYork = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });
function inNewYork(wall) {
  const asUtc = Date.parse(`${wall}Z`);
  const name = newYork.formatToParts(new Date(asUtc)).find((part) => part.type === 'timeZoneName').value;
  const [, sign, hours = '0', minutes = '0'] = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  return asUtc - (sign === '-' ? -1 : 1) * (+hours * 60 + +minutes) * 60_000;
}

test('reminder_add uses the agent zone, not the process zone, and refuses ambiguous or invalid times before saving', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-zone-'));
  const reminders = join(dir, 'reminders.json');
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: {
      // A process zone unlike the agent's, so reading wall times in the
      // process zone shows on a UTC runner too.
      TZ: 'Asia/Tokyo',
      AGENT_TIMEZONE: 'America/New_York',
      HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'),
      HEARTBEAT_REMINDERS_FILE: reminders,
    },
    autoApprove: true,
  });
  const saved = () => existsSync(reminders) ? readFileSync(reminders, 'utf8') : '';
  try {
    await session.start();
    await session.raw('featureSets/update', {
      effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
      enabled: ['heartbeat'], disabled: [],
    });

    await t.test('the tool schema names its offset-less zone, the midnight of a date alone, and its DST rule', async () => {
      const { tools } = await session.raw('tools/list', {});
      const description = tools.find((tool) => tool.name === 'reminder_add')
        .inputSchema.properties.atIso.description;
      assert.match(description, /America\/New_York\), and a date alone \(YYYY-MM-DD\) is midnight there;/);
      assert.match(description, /nonexistent or repeated/);
    });

    for (const [atIso, reason] of [
      ['2024-11-03T01:30:00', /occurs twice.*America\/New_York.*-04:00.*-05:00/],
      ['2024-03-10T02:30:00', /does not exist in America\/New_York/],
      ['2099-07-15T25:00:00Z', /valid ISO-8601/],
      ['2099-07-15T09:60:00-04:00', /valid ISO-8601/],
      ['2099-07-15T09:00:00+05:3000', /invalid UTC offset/],
      ['+275760-09-13T00:00:00-01:00', /outside the times a reminder can hold/],
    ]) {
      await t.test(`reject ${atIso} without changing persisted reminders`, async () => {
        const before = saved();
        const result = await session.callTool('reminder_add', { message: 'ambiguous', atIso });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, reason);
        assert.equal(saved(), before);
      });
    }

    // A delay or interval past the last time a reminder can hold used to be
    // saved before the log line threw on it, and from then on reminder_list
    // threw for every reminder.
    for (const [args, reason] of [
      [{ inSeconds: 1e13 }, /"inSeconds" 10000000000000 puts it past \+275760-09-13T00:00:00Z, the last time a reminder can hold\. Give a shorter delay, or an atIso before then\.$/],
      [{ inHours: 1e306 }, /"inHours" 1e\+306 puts it past \+275760-09-13T00:00:00Z, the last time a reminder can hold\. Give a shorter delay, or an atIso before then\.$/],
      [{ inSeconds: 1e306 }, /"inSeconds" 1e\+306 puts it past \+275760-09-13T00:00:00Z, the last time a reminder can hold\. Give a shorter delay, or an atIso before then\.$/],
      [{ everySeconds: 1e13 }, /"everySeconds" 10000000000000 puts its first fire past .* Give a shorter interval\.$/],
      [{ inSeconds: 5, everySeconds: 1e13 }, /"everySeconds" 10000000000000 puts its second fire past .* Give a shorter interval\.$/],
      [{ inSeconds: 1e13, everySeconds: 60 }, /"inSeconds" 10000000000000 puts its first fire past .* Give a shorter delay\.$/],
    ]) {
      await t.test(`refuse ${JSON.stringify(args)} without saving it, and keep listing`, async () => {
        const before = saved();
        const result = await session.callTool('reminder_add', { message: 'too far', ...args });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /^reminder_add: no reminder was set\. /);
        assert.match(result.content[0].text, reason);
        assert.equal(saved(), before);
        assert.notEqual((await session.callTool('reminder_list', {})).isError, true);
      });
    }

    for (const [atIso, expected] of [
      ['2099-01-15T09:00:00', inNewYork('2099-01-15T09:00:00')],
      ['2099-11-01T01:30:00-04:00', Date.parse('2099-11-01T05:30:00Z')],
      ['2099-11-01T01:30:00-05:00', Date.parse('2099-11-01T06:30:00Z')],
      ['2099-07-15', inNewYork('2099-07-15T00:00:00')],
      ['2099-07-15T09:00-04', Date.parse('2099-07-15T13:00:00Z')],
    ]) {
      await t.test(`persist the exact instant for ${atIso}`, async () => {
        const result = await session.callTool('reminder_add', { message: atIso, atIso });
        assert.notEqual(result.isError, true, result.content[0].text);
        const reminder = JSON.parse(saved()).find((row) => row.message === atIso);
        assert.equal(reminder.fireAt, expected);
        await session.callTool('reminder_cancel', { id: reminder.id });
      });
    }
  } finally {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored time a reminder can\'t hold is dropped at load, and a recurring reminder ends before its next time passes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-range-'));
  const reminders = join(dir, 'reminders.json');
  const now = Date.now();
  const row = (id, fireAt, everySeconds) => ({ id, message: id, createdAt: now, fireAt, everySeconds });
  // Times like those reminder_add saved for {inSeconds: 1e13} and, as JSON's
  // null, {inSeconds: 1e306}; one below the range, from a hand edit; a
  // recurring reminder whose next time will be past the last one; and an
  // ordinary one.
  writeFileSync(reminders, JSON.stringify([
    row('rem_far', now + 1e16, null),
    row('rem_null', null, null),
    row('rem_low', -9e15, 60),
    row('rem_last', now + 3000, 1e13),
    row('rem_ok', now + 3_600_000, null),
  ]));
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'), HEARTBEAT_REMINDERS_FILE: reminders },
    autoApprove: true,
  });
  const fired = [];
  session.on('event', (ev) => {
    if (ev.kind === 'push' && ev.data?.origin?.source === 'reminder') fired.push(ev.data.origin.reminderId);
  });
  const listed = async () => {
    const result = await session.callTool('reminder_list', {});
    assert.notEqual(result.isError, true, result.content[0].text);
    return [...result.content[0].text.matchAll(/^(rem_\w+) \|/gm)].map((m) => m[1]);
  };
  try {
    await session.start();
    await session.raw('featureSets/update', {
      effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
      enabled: ['heartbeat'], disabled: [],
    });
    // rem_last is listed unless a slow start has let it fire and end already.
    // The waits below show that it loaded and fired once.
    assert.deepEqual((await listed()).filter((id) => id !== 'rem_last'), ['rem_ok'], 'only the times a reminder can hold load');
    // rem_last fires once, then ends, since its next time is past the last one.
    for (const deadline = Date.now() + 15_000; !fired.includes('rem_last') && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // It ends once the server has read the host's answer, a little after the push.
    for (const deadline = Date.now() + 5_000; (await listed()).includes('rem_last') && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(fired, ['rem_last'], 'the recurring reminder fires its last time');
    assert.deepEqual(await listed(), ['rem_ok']);
    assert.deepEqual(JSON.parse(readFileSync(reminders, 'utf8')).map((r) => r.id), ['rem_ok']);
  } finally {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
