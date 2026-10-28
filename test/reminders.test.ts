import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, origin } from './scripted-host.js';
import { serverInProcess, useClock } from './in-process-host.js';

const HEADER = /^\[reminder (rem_[^,\s]+)(?:, set [^·]+|, repeats every \d+s)? · current time: [^\]]+\]\] /;

test('the reminder scheduler, end to end: no wake before policy, one-shot, recurring and cancel, and a restart', async (t) => {
  useClock(t);
  const fires: Array<{ text: string; body: string | null; headerId: string | null; id: unknown }> = [];
  const h = await serverInProcess(t, (p) => {
    if (origin(p).source === 'reminder') {
      const text = (p.payload.content[0] as { text?: string } | undefined)?.text ?? '';
      const m = text.match(HEADER);
      fires.push({ text, body: m ? text.slice(m[0].length) : null, headerId: m?.[1] ?? null, id: origin(p).reminderId });
    }
    return {};
  }, { policy: false });
  const count = (body: string) => fires.filter((f) => f.body === body).length;

  const pre = await h.request('tools/call', { name: 'heartbeat_trigger', arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> };
  const preText = pre.content[0]?.text ?? '';
  assert.ok(pre.isError === true && preText.startsWith("heartbeat_trigger: no heartbeat was sent, because the host hasn't finished setting this server up"),
    `trigger before policy reports non-delivery as an error (${preText.slice(0, 80)}…)`);
  assert.ok(/\| delivery=BLOCKED \(the host hasn't finished setting this server up, or its last settings message was malformed\) \|/.test(preText),
    'its status names the reason in plain words');
  const receipt = await h.request('featureSets/update', POLICY) as { accepted?: unknown; mode?: unknown; unavailableFeatures?: unknown };
  assert.ok(receipt.accepted === true, `receipt accepted (${JSON.stringify(receipt)})`);
  assert.ok(receipt.mode === 'full', `mode=full with the full grant (${String(receipt.mode)})`);
  assert.ok(Array.isArray(receipt.unavailableFeatures) && receipt.unavailableFeatures.length === 0, 'nothing reported unavailable');
  assert.ok(/Heartbeat fired/.test(await h.call('heartbeat_trigger')), 'trigger after policy delivers the wake');
  await h.until(() => h.pushes.some((p) => origin(p).source === 'heartbeat'), () => 'the triggered heartbeat never reached the host');

  await h.call('reminder_add', { message: 'ONE', inSeconds: 5 });
  await h.advance(4000);
  assert.ok(count('ONE') === 0, 'no premature fire before due');
  await h.advance(3500);
  assert.ok(count('ONE') === 1, 'fired exactly once at due');
  const one = fires.find((f) => f.body === 'ONE');
  assert.ok(!!one && one.headerId === one.id, `the text names its reminder and the time (${one?.text ?? 'no fire'})`);
  assert.ok(!!one && /^\[reminder \S+, set /.test(one.text), 'a one-shot says when it was set');

  const addText = await h.call('reminder_add', { message: 'REC', everySeconds: 5 });
  const recId = (addText.match(/Reminder (rem_\S+) set/) ?? [])[1];
  assert.ok(!!recId, `reminder_add returned an id (${recId ?? 'none'})`);
  for (const step of [5000, 5000, 2000]) await h.advance(step);
  const afterTwoIntervals = count('REC');
  assert.equal(afterTwoIntervals, 2, `recurring fired on cadence (${afterTwoIntervals} fires in 12s)`);
  assert.ok(fires.some((f) => f.body === 'REC' && f.text.startsWith(`[reminder ${recId}, repeats every 5s · current time: `)),
    'a recurring fire names its interval');
  await h.call('reminder_cancel', { id: recId });
  const atCancel = count('REC');
  await h.advance(7000);
  assert.ok(count('REC') === atCancel, `cancel silenced the recurring reminder (stayed at ${atCancel})`);

  await h.call('reminder_add', { message: 'SURV', inSeconds: 8 });
  assert.ok(count('SURV') === 0, 'not yet fired before restart');
  await h.advance(1500);
  await h.restart();
  // A restart is a fresh connection, so the grant starts empty again (§5.3).
  const receiptAfterRestart = await h.request('featureSets/update', POLICY) as { accepted?: unknown };
  assert.ok(receiptAfterRestart.accepted === true, 'policy re-established after restart');
  assert.ok(count('SURV') === 0, 'still not fired right after restart');
  await h.advance(9000);
  assert.ok(count('SURV') === 1, 'reminder fired once after restart (survived from disk)');
  assert.equal(count('ONE'), 1, 'the one-shot never fired again');
});
