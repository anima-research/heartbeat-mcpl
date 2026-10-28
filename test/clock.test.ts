import test from 'node:test';
import assert from 'node:assert/strict';
import { origin } from './scripted-host.js';
import { EPOCH, serverInProcess, useClock } from './in-process-host.js';

const at = (ms: number) => new Date(EPOCH + ms).toISOString().replace('.000Z', '+00:00 [UTC]');
const text = (p: { payload: unknown }) => (p.payload as { content: Array<{ text?: string }> }).content[0]?.text;

test('a server in the test process keeps every time by the clock the test advances', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}));
  const added = await h.call('reminder_add', { message: 'tick', everySeconds: 5 });
  assert.match(added, new RegExp(String.raw`^Reminder (rem_\S+) set: due ${at(5_000).replace(/[[\]+]/g, '\\$&')} \(~5s\) \| repeats every 5s \| "tick"$`));
  const id = /^Reminder (rem_\S+) set/.exec(added)![1];
  assert.deepEqual(h.stored().map((r) => [r.createdAt, r.fireAt]), [[EPOCH, EPOCH + 5_000]], 'the stored row keeps the mocked times');
  const reminders = () => h.pushes.filter((p) => origin(p).source === 'reminder');
  for (const n of [1, 2, 3]) {
    await h.advance(4_999);
    assert.equal(reminders().length, n - 1, `nothing before ${n * 5} s`);
    await h.advance(1);
    await h.until(() => reminders().length === n, () => `reminder fire ${n} never came`);
    const push = reminders()[n - 1]!;
    assert.equal(push.timestamp, new Date(EPOCH + n * 5_000).toISOString(), `push ${n}'s timestamp`);
    assert.equal(text(push), `[reminder ${id}, repeats every 5s · current time: ${at(n * 5_000)}] tick`);
  }
  assert.ok((await h.call('reminder_list')).includes(`${id} | due ${at(20_000)} (~5s) | repeats every 5s | "tick"`));
  await h.call('reminder_cancel', { id });

  await h.call('heartbeat_configure', { intervalSeconds: 60, message: 'beat' });
  assert.match(await h.call('heartbeat_status'), /next in ~60s/);
  await h.advance(59_999);
  assert.equal(h.pushes.filter((p) => origin(p).source === 'heartbeat').length, 0, 'no heartbeat before 60 s');
  await h.advance(1);
  await h.until(() => h.pushes.some((p) => origin(p).source === 'heartbeat'), () => 'the heartbeat never came');
  const beat = h.pushes.find((p) => origin(p).source === 'heartbeat')!;
  assert.equal(beat.timestamp, new Date(EPOCH + 75_000).toISOString(), "the heartbeat's timestamp");
  assert.equal(text(beat), `[current time: ${at(75_000)}] beat`);
});
