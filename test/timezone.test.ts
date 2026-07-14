import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentDateTime, resolveAgentTimeZone } from '../src/timezone.js';

test('formats heartbeat presentation times in the configured zone', () => {
  assert.equal(
    formatAgentDateTime(new Date('2026-07-15T12:34:56Z'), 'America/Los_Angeles'),
    '2026-07-15T05:34:56-07:00 [America/Los_Angeles]',
  );
  assert.throws(() => resolveAgentTimeZone('Not/A_Real_Zone'), /Invalid AGENT_TIMEZONE/);
});
