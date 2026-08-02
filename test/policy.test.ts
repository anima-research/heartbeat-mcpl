// Unit tests for the MCPL 0.5 policy derivation (SPEC §5.3, §5.4, §6.2, §6.4,
// §6.7). Every assertion here is about failing closed: the interesting cases are
// the ones where the server must decline to act.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_PATHS, EMPTY_GRANT, buildReceipt, capabilityGranted, capabilityMatches,
  deriveFeatureSetState, featureSetMatches, isCapabilityPath, narrowGrant, parsePolicy,
  resolvePaths,
} from '../src/mcpl05.js';
import type { CapabilityPath, FeatureSetDeclaration05, Grant } from '../src/mcpl05.js';

const HEARTBEAT: FeatureSetDeclaration05 = {
  description: 'test',
  uses: ['tools', 'pushEvents'],
  rollback: false,
};

function grantOf(patterns: string[], extra: Partial<Grant> = {}): Grant {
  return {
    patterns,
    paths: resolvePaths(patterns),
    denied: [],
    disabled: [],
    enabled: null,
    ...extra,
  };
}

function stateOf(grant: Grant, decl: FeatureSetDeclaration05 = HEARTBEAT) {
  return deriveFeatureSetState('heartbeat', decl, grant);
}

// ── §6.2 vocabulary ──

test('the uses vocabulary is exactly the 17 paths of §6.2', () => {
  assert.equal(CAPABILITY_PATHS.length, 17);
  assert.ok(isCapabilityPath('contextHooks.beforeInference.inject.system'));
  assert.ok(!isCapabilityPath('contextHooks.beforeInference'));   // not a leaf in 0.5
  assert.ok(!isCapabilityPath('channels.observe'));               // 0.4 name, removed
  assert.ok(!isCapabilityPath('hostState'));
});

// ── §5.4 parse / fail-closed ──

test('a path in both effectiveCapabilities and deniedCapabilities is malformed', () => {
  const parsed = parsePolicy({ effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: ['pushEvents'] });
  assert.equal(parsed.ok, false);
});

test('non-string entries make the policy malformed rather than partially applied', () => {
  assert.equal(parsePolicy({ effectiveCapabilities: ['tools', 7] }).ok, false);
  assert.equal(parsePolicy({ effectiveCapabilities: 'tools' }).ok, false);
  assert.equal(parsePolicy({ disabled: {} }).ok, false);
  assert.equal(parsePolicy([]).ok, false);
});

test('absent effectiveCapabilities parses but grants nothing', () => {
  const parsed = parsePolicy({ enabled: ['heartbeat'] });
  assert.ok(parsed.ok);
  assert.equal(parsed.hadEffectiveCapabilities, false);
  assert.equal(capabilityGranted(parsed.grant, 'pushEvents'), false);
});

test('deniedCapabilities never authorizes anything on its own', () => {
  const parsed = parsePolicy({ deniedCapabilities: ['pushEvents', 'tools'] });
  assert.ok(parsed.ok);
  assert.equal(capabilityGranted(parsed.grant, 'tools'), false);
  // Carried verbatim for operator diagnostics, and only that.
  assert.deepEqual([...parsed.grant.denied], ['pushEvents', 'tools']);
});

// ── §5.4 matching ──

test('* matches one segment only, so a wildcard never widens into a subtree', () => {
  assert.ok(capabilityMatches('channels.*', 'channels.publish'));
  assert.ok(!capabilityMatches('contextHooks.*', 'contextHooks.beforeInference.inject.system'));
  assert.ok(!capabilityMatches('*', 'channels.publish'));
  assert.ok(capabilityMatches('*', 'pushEvents'));
});

test('patterns resolve only into the closed §6.2 vocabulary', () => {
  assert.deepEqual([...resolvePaths(['channels.*'])].sort(), [
    'channels.acknowledge', 'channels.incoming', 'channels.lifecycle',
    'channels.publish', 'channels.register', 'channels.streaming', 'channels.typing',
  ]);
  // A path this build does not know grants nothing, rather than being carried
  // forward as an unchecked string.
  assert.equal(resolvePaths(['someFutureCapability']).size, 0);
});

// ── §6.4 derivation ──

test('the full grant activates the feature set', () => {
  assert.deepEqual(stateOf(grantOf(['tools', 'pushEvents'])), { active: true, missing: [] });
});

test('no policy at all means no feature set — absence is denial', () => {
  const state = stateOf(EMPTY_GRANT);
  assert.equal(state.active, false);
  assert.equal(state.reason, 'capability_denied');
  assert.deepEqual(state.missing, ['tools', 'pushEvents']);
});

test('tools without pushEvents disables the wake feature set and names what is missing', () => {
  const state = stateOf(grantOf(['tools']));
  assert.equal(state.active, false);
  assert.deepEqual(state.missing, ['pushEvents']);
});

test('absent, empty, or unrecognized uses is invalid_uses, not a guess', () => {
  const grant = grantOf(['tools', 'pushEvents']);
  assert.equal(stateOf(grant, { ...HEARTBEAT, uses: [] }).reason, 'invalid_uses');
  assert.equal(
    stateOf(grant, { ...HEARTBEAT, uses: ['tools', 'wakeMe'] as unknown as CapabilityPath[] }).reason,
    'invalid_uses',
  );
  assert.equal(
    stateOf(grant, { ...HEARTBEAT, uses: undefined as unknown as CapabilityPath[] }).reason,
    'invalid_uses',
  );
});

test('a host disable wins over a full grant, and §6.3 wildcards apply', () => {
  assert.equal(stateOf(grantOf(['tools', 'pushEvents'], { disabled: ['heartbeat'] })).reason, 'host_disabled');
  assert.ok(featureSetMatches('memory.*', 'memory.retrieval'));
  assert.ok(!featureSetMatches('memory.*', 'memories'));
  assert.ok(featureSetMatches('heartbeat', 'heartbeat'));
});

test('an enabled list that omits us is treated as not enabled', () => {
  assert.equal(stateOf(grantOf(['tools', 'pushEvents'], { enabled: ['something.else'] })).reason, 'not_enabled');
  assert.equal(stateOf(grantOf(['tools', 'pushEvents'], { enabled: ['heartbeat'] })).active, true);
});

// ── §6.7 receipt ──

test('a full grant yields an accepted receipt in full mode with nothing unavailable', () => {
  const receipt = buildReceipt({ heartbeat: HEARTBEAT }, grantOf(['tools', 'pushEvents']));
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, 'full');
  assert.deepEqual(receipt.unavailableFeatures, []);
});

test('a denied capability yields a degraded receipt naming the consequence', () => {
  const receipt = buildReceipt({ heartbeat: HEARTBEAT }, grantOf(['tools']));
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, 'degraded');
  assert.deepEqual(receipt.unavailableFeatures, [
    { featureSet: 'heartbeat', missingCapabilities: ['pushEvents'], effect: 'disabled' },
  ]);
  // Testimony about what the server will do — no request for more capability.
  assert.match(receipt.notes?.join(' ') ?? '', /will not be delivered/);
});

// ── §6.7 notification form ──

test('a notification-form update can only narrow the grant, never widen it', () => {
  const narrowed = narrowGrant(grantOf(['tools', 'pushEvents']), grantOf(['tools']), true);
  assert.deepEqual([...narrowed.paths].sort(), ['tools']);

  const widened = narrowGrant(
    grantOf(['tools']),
    grantOf(['tools', 'pushEvents', 'channels.publish']),
    true,
  );
  assert.deepEqual([...widened.paths].sort(), ['tools']);
});

test('a wildcard in a narrowing update keeps exactly the leaves it covers', () => {
  const narrowed = narrowGrant(grantOf(['channels.publish', 'pushEvents']), grantOf(['channels.*']), true);
  assert.deepEqual([...narrowed.paths].sort(), ['channels.publish']);
});

test('a notification without effectiveCapabilities leaves capabilities alone but still narrows feature sets', () => {
  const before = grantOf(['tools', 'pushEvents']);
  const after = narrowGrant(before, grantOf([], { disabled: ['heartbeat'] }), false);
  assert.deepEqual([...after.paths].sort(), ['pushEvents', 'tools']);
  assert.equal(stateOf(after).reason, 'host_disabled');
});

test('a notification-form enabled list constrains even when none was held before', () => {
  const after = narrowGrant(
    grantOf(['tools', 'pushEvents']),
    grantOf([], { enabled: ['something.else'] }),
    false,
  );
  assert.equal(stateOf(after).reason, 'not_enabled');
});
