import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = process.env.MCPL_HARNESS_SESSION
  ? pathToFileURL(process.env.MCPL_HARNESS_SESSION)
  : new URL('../../mcpl-harness/src/session.ts', import.meta.url);
const { HostSession } = await import(harness.href);
const server = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));
const POLICY = {
  effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
  enabled: ['heartbeat'], disabled: [],
};

test('a call that can\'t do what it asked is an error that says why and what to do', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-texts-'));
  const session = new HostSession({
    command: 'node',
    args: [server, '--stdio'],
    env: { HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'), HEARTBEAT_REMINDERS_FILE: join(dir, 'reminders.json') },
    autoApprove: true,
  });
  t.after(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await session.start();
  const call = async (name, args = {}) => {
    const result = await session.callTool(name, args);
    return { isError: result.isError === true, text: result.content[0].text };
  };
  const ask = "Calling again won't change that; ask whoever runs this host if you need wakes.";
  const blocked = async (reason, remedy) => {
    const { isError, text } = await call('heartbeat_trigger');
    assert.equal(isError, true);
    assert.ok(text.startsWith(`heartbeat_trigger: no heartbeat was sent, because ${reason}. ${remedy} Heartbeat ACTIVE | `), text);
    assert.ok(text.includes(` | delivery=BLOCKED (${reason}) | `), text);
  };

  await t.test('a heartbeat the host won\'t take yet, or at all, is an error naming the reason in plain words', async () => {
    await blocked("the host hasn't finished setting this server up, or its last settings message was malformed",
      'Try again shortly; if it persists, ask whoever runs this host.');
    await session.raw('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] });
    await blocked("the host hasn't granted this server what its wakes need", ask);
    await session.raw('featureSets/update', { ...POLICY, disabled: ['heartbeat'] });
    await blocked('the host has turned heartbeat off for this server', ask);
    await session.raw('featureSets/update', { ...POLICY, enabled: [] });
    await blocked("the host hasn't enabled heartbeat for this server", ask);
    const added = await call('reminder_add', { message: 'x', inHours: 1 });
    assert.equal(added.isError, false, added.text);
    assert.match(added.text, /^Reminder rem_\S+ set: due \S+ \[[^\]]+\] \(~3600s\) \| one-shot \| "x"\. No wake can be delivered now, because the host hasn't enabled heartbeat for this server, so it waits until one can\. If that doesn't change, ask whoever runs this host\.$/);
    await session.raw('featureSets/update', POLICY);
    const { isError, text } = await call('heartbeat_trigger');
    assert.equal(isError, false);
    assert.match(text, /^Heartbeat fired\. Heartbeat ACTIVE \| .* \| delivery=ok \| /);
  });

  await t.test('an id no pending reminder has is an error that says what to do', async () => {
    assert.deepEqual(await call('reminder_cancel', { id: 'rem_gone' }), {
      isError: true,
      text: 'reminder_cancel: nothing was cancelled. No reminder has the id "rem_gone". If it was a one-off that has fired, '
        + "or it was cancelled already, there's nothing more to do. Otherwise, reminder_list shows the pending ids.",
    });
  });

  await t.test('a tool that doesn\'t exist is named, with the tools there are', async () => {
    assert.deepEqual(await call('reminder_snooze', { id: 'rem_x' }), {
      isError: true,
      text: 'There\'s no tool named "reminder_snooze" here, so nothing ran. heartbeat-mcpl\'s tools are "heartbeat_status", '
        + '"heartbeat_configure", "heartbeat_trigger", "reminder_add", "reminder_list" and "reminder_cancel".',
    });
    const nameless = await session.raw('tools/call', { arguments: {} });
    assert.equal(nameless.isError, true);
    assert.match(nameless.content[0].text, /^The call doesn't name a tool, so nothing ran\. /);
  });
});
