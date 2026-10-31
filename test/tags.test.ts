import test from 'node:test';
import assert from 'node:assert/strict';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { INVALID_PARAMS } from '../src/silent-delivery.js';
import { TAGS, featureSetDecl } from '../src/server.js';
import { origin, serverWithHost } from './scripted-host.js';
import { serverInProcess, useClock } from './in-process-host.js';

const ontology = featureSetDecl.tagOntology!;

test('the initialize result declares the tag ontology, with a rationale on every suggested rule (RFC-001 §5)', async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  const [declared] = h.capabilities.experimental?.mcpl?.featureSets ?? [];
  assert.equal(declared?.name, 'heartbeat');
  assert.deepEqual(declared?.tagOntology, ontology, 'the declaration on the wire is the one the server tags by');
  assert.equal(ontology.open, true);
  const described = Object.keys(ontology.tags ?? {});
  assert.deepEqual(described.sort(), Object.values(TAGS).sort(), 'every tag the server emits is described, and nothing else');
  assert.ok((ontology.suggestedTreatment ?? []).length > 0);
  for (const rule of ontology.suggestedTreatment ?? []) {
    assert.ok(rule.rationale && rule.rationale.length > 20, `rule ${JSON.stringify(rule.tagsAny)} explains itself`);
    for (const tag of [...rule.tagsAny ?? [], ...rule.tagsAll ?? [], ...rule.tagsNone ?? []]) assert.ok(described.includes(tag), `${tag} is described`);
  }
});

test('each kind of wake carries its tags: a tick, a silent tick and its fallback, a one-shot and a recurring reminder', async (t) => {
  useClock(t);
  let refuseSilent = false;
  const h = await serverInProcess(t, (p) => (refuseSilent && p.payload.content.length === 0
    ? { error: [INVALID_PARAMS, 'content has no visible content'] } : {}));
  const tagsOf = (p: PushEventParams) => [...(p.tags ?? [])].sort();

  await h.call('heartbeat_trigger');
  await h.pushCount(1);
  assert.deepEqual(tagsOf(h.pushes[0]!), [TAGS.tick]);

  await h.call('heartbeat_configure', { deliveryMode: 'silent' });
  await h.call('heartbeat_trigger');
  await h.pushCount(2);
  assert.deepEqual(tagsOf(h.pushes[1]!), [TAGS.silent, TAGS.tick].sort());

  refuseSilent = true;
  await h.call('heartbeat_trigger');
  await h.pushCount(4);
  assert.equal(origin(h.pushes[3]!).silentFallback, true);
  assert.deepEqual(tagsOf(h.pushes[3]!), [TAGS.tick], 'the message-mode fallback is a plain tick');

  await h.call('reminder_add', { message: 'ONE', inSeconds: 5 });
  await h.call('reminder_add', { message: 'REC', everySeconds: 5 });
  await h.advance(5500);
  await h.pushCount(6);
  const reminders = h.pushes.filter((p) => origin(p).source === 'reminder');
  const oneShot = reminders.find((p) => origin(p).recurring === false);
  const recurring = reminders.find((p) => origin(p).recurring === true);
  assert.deepEqual(tagsOf(oneShot!), [TAGS.reminder]);
  assert.deepEqual(tagsOf(recurring!), [TAGS.recurring, TAGS.reminder].sort());

  const described = new Set(Object.keys(ontology.tags ?? {}));
  for (const p of h.pushes) for (const tag of p.tags ?? []) assert.ok(described.has(tag), `${tag} is described in the ontology`);
});
