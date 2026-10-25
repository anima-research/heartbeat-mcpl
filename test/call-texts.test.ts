import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '@animalabs/mcpl-core';
import { describeThrown, noSuchTool, thrownForLog, toolThrew } from '../src/call-texts.js';
import { logged, serverWithHost } from './scripted-host.js';

const tools = ['heartbeat_status', 'reminder_add'];
const listed = 'heartbeat-mcpl\'s tools are "heartbeat_status" and "reminder_add".';
const after = 'Whether it changed anything is unknown: check reminder_list or heartbeat_status before you call it again. '
  + 'If it fails the same way again, ask whoever runs this host.';

test('a tool that doesn\'t exist is named, with the tools there are; a call naming none says so', () => {
  assert.equal(noSuchTool('reminder_snooze', tools), `There's no tool named "reminder_snooze" here, so nothing ran. ${listed}`);
  assert.equal(noSuchTool(undefined, tools), `The call doesn't name a tool, so nothing ran. ${listed}`);
});

test('a name that isn\'t a string is quoted as the call gave it', () => {
  assert.equal(noSuchTool(5, tools), `The call gives 5 as its tool's name, and a tool's name is a string, so nothing ran. ${listed}`);
  assert.equal(noSuchTool(null, tools), `The call gives null as its tool's name, and a tool's name is a string, so nothing ran. ${listed}`);
});

test('a tool that threw says what failed, whether it can have changed anything, and what to do if it fails again', () => {
  assert.equal(toolThrew('reminder_add', new Error('disk full.')), `reminder_add failed inside heartbeat-mcpl: disk full. ${after}`);
  assert.equal(toolThrew(undefined, 'oops'), `The tool failed inside heartbeat-mcpl: oops. ${after}`);
  for (const message of ['disk full.. ', 'disk full. .', 'disk full.\n', 'disk full.\u00a0', '  disk full']) {
    assert.equal(toolThrew('reminder_add', new Error(message)), `reminder_add failed inside heartbeat-mcpl: disk full. ${after}`, JSON.stringify(message));
  }
  assert.equal(toolThrew('reminder_add', new Error('')), `reminder_add failed inside heartbeat-mcpl. ${after}`);
  assert.equal(toolThrew('reminder_add', ' . '), `reminder_add failed inside heartbeat-mcpl. ${after}`);
  for (const tool of ['heartbeat_status', 'reminder_list']) {
    assert.equal(toolThrew(tool, new Error('disk full')), `${tool} failed inside heartbeat-mcpl: disk full. It only reads, so it changed `
      + 'nothing. If it fails the same way again, ask whoever runs this host.');
  }
  assert.equal(toolThrew('heartbeat_trigger', new Error('disk full')), 'heartbeat_trigger failed inside heartbeat-mcpl: disk full. '
    + 'It may have sent a heartbeat before it failed, so calling it again may send a second. If it fails the same way again, ask '
    + 'whoever runs this host.');
  // An object literal inherits constructor from Object.prototype.
  assert.equal(toolThrew('constructor', new Error('disk full')), `constructor failed inside heartbeat-mcpl: disk full. ${after}`);
});

test('a thrown value is described without throwing, whatever it is', () => {
  assert.equal(describeThrown(new RangeError('Invalid time value')), 'Invalid time value');
  assert.equal(describeThrown({ code: 'EIO' }), '{"code":"EIO"}');
  assert.equal(describeThrown(Object.create(null)), '{}');
  assert.equal(describeThrown(undefined), 'undefined');
  const unprintable = { toJSON() { throw new Error('no'); }, toString() { throw new Error('no'); } };
  assert.equal(describeThrown(unprintable), 'a value that can\'t be shown as text');
  // An Error's message need not be a string, and reading it, or asking
  // whether a value is an Error at all, can throw.
  const numbered = new Error('x');
  Object.assign(numbered, { message: 5 });
  assert.equal(describeThrown(numbered), '5');
  const coded = new Error('x');
  Object.assign(coded, { message: { code: 'EIO' } });
  assert.equal(describeThrown(coded), '{"code":"EIO"}');
  for (const [message, text] of [[undefined, 'undefined'], [Number.NaN, 'NaN'], [Symbol('eio'), 'Symbol(eio)']] as const) {
    assert.equal(describeThrown(Object.assign(new Error('x'), { message })), text);
  }
  const guarded = new Error('x');
  Object.defineProperty(guarded, 'message', { get() { throw new Error('no'); } });
  assert.equal(describeThrown(guarded), 'a value that can\'t be shown as text');
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.equal(describeThrown(revocable.proxy), 'a value that can\'t be shown as text');
  assert.equal(toolThrew('reminder_add', revocable.proxy), `reminder_add failed inside heartbeat-mcpl: a value that can't be shown as text. ${after}`);
});

test('the log has a thrown Error\'s stack, or else the value\'s description, without throwing', () => {
  const error = new Error('disk full');
  assert.equal(thrownForLog(error), error.stack);
  assert.equal(thrownForLog({ code: 'EIO' }), '{"code":"EIO"}');
  const unstacked = new Error('disk full');
  Object.defineProperty(unstacked, 'stack', { value: 5 });
  assert.equal(thrownForLog(unstacked), 'disk full');
  let reads = 0;
  const fickle = new Error('disk full');
  Object.defineProperty(fickle, 'stack', { get: () => (reads++ === 0 ? 'Error: disk full' : Symbol('no')) });
  assert.equal(thrownForLog(fickle), 'Error: disk full');
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.equal(thrownForLog(revocable.proxy), 'a value that can\'t be shown as text');
});

test('through the server, a tool that throws is answered with that text, after it may have changed something, and logged', async (t) => {
  const fault = `--import=${new URL('./format-fault.mjs', import.meta.url).href}`;
  const h = await serverWithHost(() => ({}), { env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, fault].filter(Boolean).join(' ') } });
  t.after(h.close);
  for (const [atIso, why, inLog] of [
    ['2099-01-01T09:00Z', 'a fault this test put in formatToParts', 'Error: a fault this test put in formatToParts'],
    ['2099-01-02T09:00Z', 'undefined', 'undefined'],
  ] as const) {
    const error = await h.request('tools/call', { name: 'reminder_add', arguments: { message: atIso, atIso } })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof RpcError, `expected a JSON-RPC error for ${atIso}, got ${String(error)}`);
    assert.equal(error.code, -32000);
    // mcpl-core 0.2 starts the message with "RPC error <code>: ".
    assert.equal(error.message.replace(`RPC error ${error.code}: `, ''), `reminder_add failed inside heartbeat-mcpl: ${why}. ${after}`);
    await logged(h, `reminder_add threw: ${inLog}`);
  }
  const lines = h.stderr().split('\n');
  const at = lines.indexOf('[heartbeat-mcpl] reminder_add threw: Error: a fault this test put in formatToParts');
  assert.match(lines[at + 1] ?? '', /^\s+at /, h.stderr());
  assert.deepEqual(h.stored().map((r) => r.message), ['2099-01-01T09:00Z', '2099-01-02T09:00Z'], 'each was saved before its call failed');
  assert.match(await h.call('heartbeat_status'), /^Heartbeat ACTIVE \| /);
});
