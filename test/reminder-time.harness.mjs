import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

// Future clock rules are tzdata's projections, so these rows compute their instants as
// this runtime's tzdata places them. Their dates are far from any clock change, so the offset at
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
      // Node takes its process zone from TZ: one unlike the agent's shows a
      // read in the process zone on a UTC runner too.
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
      ['2024-11-03T01:30:00', /happens twice in America\/New_York.*"2024-11-03T01:30:00-04:00" or "2024-11-03T01:30:00-05:00"/],
      ['2024-03-10T02:30:00', /doesn't exist in America\/New_York/],
      ['2099-07-15T25:00:00Z', /has a time no clock shows/],
      ['2099-07-15T09:60:00-04:00', /has a time no clock shows/],
      ['2099-02-30T09:00:00', /names a day the calendar doesn't have, 2099-02-30\./],
      ['2099-07-15T09:00:00+05:3000', /ends in "\+05:3000", which isn't a UTC offset/],
      ['+275760-09-13T00:00:00-01:00', /outside the times a reminder can hold/],
    ]) {
      await t.test(`reject ${atIso} without changing persisted reminders`, async () => {
        const before = saved();
        const result = await session.callTool('reminder_add', { message: 'ambiguous', atIso });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /^reminder_add: no reminder was set\. "atIso" "/);
        assert.match(result.content[0].text, reason);
        assert.equal(saved(), before);
      });
    }

    for (const [args, reason] of [
      [{ inSeconds: 1e13 }, /"inSeconds" 10000000000000 puts it past \+275760-09-13T00:00:00Z, the last time a reminder can hold\. Give a shorter delay, or an atIso before then\.$/],
      [{ inHours: 1e306 }, /"inHours" 1e\+306 puts it past \+275760-09-13T00:00:00Z, the last time a reminder can hold\. Give a shorter delay, or an atIso before then\.$/],
      [{ inSeconds: 1e306 }, /"inSeconds" 1e\+306 puts it past \+275760-09-13T00:00:00Z, the last time a reminder can hold\. Give a shorter delay, or an atIso before then\.$/],
      [{ everySeconds: 1e13 }, /"everySeconds" 10000000000000 puts its first fire past .* Give a shorter interval\.$/],
      [{ inSeconds: 5, everySeconds: 1e13 }, /"everySeconds" 10000000000000 puts its second fire past .* Give a shorter interval\.$/],
      [{ inSeconds: 1e13, everySeconds: 60 }, /"inSeconds" 10000000000000 puts its first fire past .* Give a shorter delay, or an atIso before then\.$/],
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
