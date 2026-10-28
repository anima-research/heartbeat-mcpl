import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, origin } from './scripted-host.js';
import { serverInProcess, useClock } from './in-process-host.js';

const MCP_ONLY = 'host is MCP-only (no experimental.mcpl); push events are not part of MCP (§3.2)';
const PRE_05 = 'host sent featureSets/update only as a Notification, which cannot establish ready state (§6.7), '
  + 'so no wake is delivered on this connection';
const NOT_READY = 'no valid featureSets/update Request in force (none yet, or the last was malformed); '
  + 'capability-dependent behavior is unavailable until one arrives (§5.3)';
const ASK = "Calling again won't change that; ask whoever runs this host if you need wakes.";
const never = (why: string) => ({
  one: `No wake can be delivered on this host, because ${why}, so it won't fire here. ${ASK}`,
  listed: `No wake can be delivered on this host, because ${why}, so no reminder will fire here. ${ASK}`,
});
const MCP_ONLY_TEXT = never("the host doesn't support the push events wakes need");
const PRE_05_TEXT = never("the host set this server up in an older form that can't turn wakes on");
const NOT_READY_LISTED = "No wake can be delivered now, because the host hasn't finished setting this server up, or its last "
  + "settings message was malformed. A reminder that falls due waits until one can. If that doesn't change, ask whoever runs this host.";
const NOT_READY_ONE = "No wake can be delivered now, because the host hasn't finished setting this server up, or its last "
  + "settings message was malformed, so it waits until one can. If that doesn't change, ask whoever runs this host.";
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('on an MCP-only host, a stored reminder is counted in the log at start, and replies say none will fire there', async (t) => {
  useClock(t);
  const now = Date.now();
  const h = await serverInProcess(t, () => ({}), {
    mcpl: false,
    reminders: [{ id: 'rem_old', message: 'old', createdAt: now - 60_000, fireAt: now - 1000, everySeconds: null }],
  });
  await h.logged(`none of the 1 reminder(s) will fire on this host: ${MCP_ONLY}`);
  const added = await h.call('reminder_add', { message: 'stretch', inMinutes: 5 });
  assert.match(added, new RegExp(String.raw`^Reminder rem_\S+ set: due \S+ \[[^\]]+\] \(~300s\) \| one-shot \| "stretch"\. `
    + `${escaped(MCP_ONLY_TEXT.one)}$`));
  await h.logged(`none of the 2 reminder(s) will fire on this host: ${MCP_ONLY}`);
  const list = await h.call('reminder_list');
  assert.match(list, /^rem_old \| due .* \(overdue\) \| one-shot \| "old"$/m);
  assert.ok(list.endsWith(`\n${MCP_ONLY_TEXT.listed}`), list);
  const trigger = await h.request('tools/call', { name: 'heartbeat_trigger', arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(trigger.isError, true);
  assert.match(trigger.content[0]!.text, new RegExp(`^${escaped(`heartbeat_trigger: no heartbeat was sent, because the host doesn't `
    + `support the push events wakes need. ${ASK} `)}`
    + String.raw`Heartbeat ACTIVE \| mode=message \| interval=14400s \(4\.00h\) \| reminders=2 \| delivery=BLOCKED \(`));
  const suppressed = `[heartbeat-mcpl] suppressed heartbeat push/event — ${MCP_ONLY}`;
  await h.logged('DROPPED heartbeat (manual)');
  assert.equal(h.stderr().split('\n').filter((line) => line === suppressed).length, 1, h.stderr());
  await h.call('heartbeat_configure', { deliveryMode: 'silent' });
  await h.call('heartbeat_trigger');
  await h.logged('DROPPED heartbeat (manual, silent)');
  assert.equal(h.stderr().split('\n').filter((line) => line === suppressed).length, 2, h.stderr());
  assert.equal(h.pushes.length, 0);
});

test('a pre-0.5 host, whose policy comes only as a Notification, hears that none will fire there, until a Request comes', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { policy: false });
  h.notify('featureSets/update', POLICY);
  const added = await h.call('reminder_add', { message: 'soon', inSeconds: 1 });
  assert.ok(added.endsWith(`"soon". ${PRE_05_TEXT.one}`), added);
  await h.logged(`none of the 1 reminder(s) will fire on this host: ${PRE_05}`);
  assert.ok((await h.call('reminder_list')).endsWith(`\n${PRE_05_TEXT.listed}`));
  await h.advance(1_000);
  assert.equal(h.pushes.length, 0, 'due, it is held while no wake can be delivered');
  await h.request('featureSets/update', POLICY);
  await h.pushCount(1);
  assert.equal(origin(h.pushes[0]!).reminderId, /Reminder (rem_\S+) set/.exec(added)?.[1]);
});

test('once wakes are allowed a reply has no held note, and a malformed Request holds reminders again, saying so', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}));
  const added = await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.match(added, /^Reminder rem_\S+ set: due \S+ \[[^\]]+\] \(~3600s\) \| one-shot \| "later"$/);
  await assert.rejects(h.request('featureSets/update', { ...POLICY, enabled: 'heartbeat' }), { code: -32602 });
  await h.logged(`none of the 1 reminder(s) fires until a wake can be delivered: ${NOT_READY}`);
  const list = await h.call('reminder_list');
  assert.ok(list.endsWith(`\n${NOT_READY_LISTED}`), list);
});

test('a Notification after a malformed Request is a 0.5 host\'s update: a reminder waits, and fires once a valid Request comes', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { policy: false });
  await assert.rejects(h.request('featureSets/update', { ...POLICY, enabled: 'heartbeat' }), { code: -32602 });
  h.notify('featureSets/update', POLICY);
  const added = await h.call('reminder_add', { message: 'soon', atIso: new Date(Date.now() + 1000).toISOString() });
  assert.ok(added.endsWith(`"soon". ${NOT_READY_ONE}`), added);
  assert.ok((await h.call('reminder_list')).endsWith(`\n${NOT_READY_LISTED}`));
  await h.logged(`none of the 1 reminder(s) fires until a wake can be delivered: ${NOT_READY}`);
  assert.doesNotMatch(h.stderr(), /WARNING: initial policy has still not arrived as a Request/);
  await h.advance(1_000);
  assert.equal(h.pushes.length, 0, 'due, it is held while no wake can be delivered');
  await h.request('featureSets/update', POLICY);
  await h.pushCount(1);
  assert.equal(origin(h.pushes[0]!).reminderId, /Reminder (rem_\S+) set/.exec(added)?.[1]);
});
