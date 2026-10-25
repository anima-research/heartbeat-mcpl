import test from 'node:test';
import assert from 'node:assert/strict';
import { heldNote, wakeBlocked } from '../src/wake-blocked.js';
import type { FeatureSetState } from '../src/mcpl05.js';

const state = (s: FeatureSetState) => () => s;
const ask = "Calling again won't change that; ask whoever runs this host if you need wakes.";

test('a wake can be delivered once the host has granted what it needs', () => {
  assert.equal(wakeBlocked(true, false, true, state({ active: true, missing: [] }), 'heartbeat'), null);
});

test('each reason a wake is blocked reads in plain words, with what to do', () => {
  const cases: Array<[boolean, boolean, boolean, FeatureSetState, string, string, string, boolean]> = [
    [false, false, false, { active: false, missing: [] },
      "the host doesn't support the push events wakes need", ask,
      'host is MCP-only (no experimental.mcpl); push events are not part of MCP (§3.2)', true],
    [true, true, false, { active: false, missing: [] },
      "the host set this server up in an older form that can't turn wakes on", ask,
      'host sent featureSets/update only as a Notification, which cannot establish ready state (§6.7), '
        + 'so no wake is delivered on this connection', true],
    [true, false, false, { active: false, missing: [] },
      "the host hasn't finished setting this server up, or its last settings message was malformed",
      'Try again shortly; if it persists, ask whoever runs this host.',
      'no valid featureSets/update Request in force (none yet, or the last was malformed); '
        + 'capability-dependent behavior is unavailable until one arrives (§5.3)', false],
    [true, false, true, { active: false, missing: ['pushEvents'], reason: 'capability_denied' },
      "the host hasn't granted this server what its wakes need", ask,
      'capability not granted: pushEvents (§5.4 — absence is denial)', false],
    [true, false, true, { active: false, missing: [], reason: 'host_disabled' },
      'the host has turned heartbeat off for this server', ask, 'feature set "heartbeat" is host_disabled', false],
    [true, false, true, { active: false, missing: [], reason: 'not_enabled' },
      "the host hasn't enabled heartbeat for this server", ask, 'feature set "heartbeat" is not_enabled', false],
    [true, false, true, { active: false, missing: [], reason: 'invalid_uses' },
      "this server's own heartbeat declaration is malformed",
      "Calling again won't change that; ask whoever runs this host to report it to heartbeat-mcpl's maintainers.",
      'feature set "heartbeat" is invalid_uses', true],
  ];
  for (const [mcpl, notified, ready, s, reason, remedy, log, final] of cases) {
    assert.deepEqual(wakeBlocked(mcpl, notified, ready, state(s), 'heartbeat'), { log, reason, remedy, final }, log);
  }
});

test('the feature-set state is read only once the host has sent its policy', () => {
  let read = 0;
  const counted = () => { read++; return { active: true, missing: [] }; };
  wakeBlocked(false, false, true, counted, 'heartbeat');
  wakeBlocked(true, true, false, counted, 'heartbeat');
  wakeBlocked(true, false, false, counted, 'heartbeat');
  assert.equal(read, 0);
});

test('each kind of block gives a held reminder its own note, in the listing and for the one just set', () => {
  const later = " If that doesn't change, ask whoever runs this host.";
  const cases: Array<[boolean, boolean, boolean, FeatureSetState, string, string]> = [
    [true, false, false, { active: false, missing: [] },
      "No wake can be delivered now, because the host hasn't finished setting this server up, or its last settings message was "
        + `malformed. A reminder that falls due waits until one can.${later}`,
      "No wake can be delivered now, because the host hasn't finished setting this server up, or its last settings message was "
        + `malformed, so it waits until one can.${later}`],
    [true, false, true, { active: false, missing: ['pushEvents'], reason: 'capability_denied' },
      `No wake can be delivered now, because the host hasn't granted this server what its wakes need. A reminder that falls due waits until one can.${later}`,
      `No wake can be delivered now, because the host hasn't granted this server what its wakes need, so it waits until one can.${later}`],
    [true, false, true, { active: false, missing: [], reason: 'host_disabled' },
      `No wake can be delivered now, because the host has turned heartbeat off for this server. A reminder that falls due waits until one can.${later}`,
      `No wake can be delivered now, because the host has turned heartbeat off for this server, so it waits until one can.${later}`],
    [true, false, true, { active: false, missing: [], reason: 'not_enabled' },
      `No wake can be delivered now, because the host hasn't enabled heartbeat for this server. A reminder that falls due waits until one can.${later}`,
      `No wake can be delivered now, because the host hasn't enabled heartbeat for this server, so it waits until one can.${later}`],
    [false, false, false, { active: false, missing: [] },
      `No wake can be delivered on this host, because the host doesn't support the push events wakes need, so no reminder will fire here. ${ask}`,
      `No wake can be delivered on this host, because the host doesn't support the push events wakes need, so it won't fire here. ${ask}`],
    [true, true, false, { active: false, missing: [] },
      `No wake can be delivered on this host, because the host set this server up in an older form that can't turn wakes on, so no reminder will fire here. ${ask}`,
      `No wake can be delivered on this host, because the host set this server up in an older form that can't turn wakes on, so it won't fire here. ${ask}`],
    [true, false, true, { active: false, missing: [], reason: 'invalid_uses' },
      "No wake can be delivered on this host, because this server's own heartbeat declaration is malformed, so no reminder will fire here. "
        + "Calling again won't change that; ask whoever runs this host to report it to heartbeat-mcpl's maintainers.",
      "No wake can be delivered on this host, because this server's own heartbeat declaration is malformed, so it won't fire here. "
        + "Calling again won't change that; ask whoever runs this host to report it to heartbeat-mcpl's maintainers."],
  ];
  for (const [mcpl, notified, ready, s, listed, one] of cases) {
    const blocked = wakeBlocked(mcpl, notified, ready, state(s), 'heartbeat')!;
    assert.equal(heldNote(blocked, false), listed, blocked.log);
    assert.equal(heldNote(blocked, true), one, blocked.log);
  }
});
