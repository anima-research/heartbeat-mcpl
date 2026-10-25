import test from 'node:test';
import assert from 'node:assert/strict';
import { addUnits, checkArguments, closestNames, ignoredNote } from '../src/arguments.js';
import type { ToolSchema } from '../src/arguments.js';

const configure: ToolSchema = { name: 'configure', inputSchema: { properties: {
  intervalSeconds: { type: 'number', description: 'Interval in seconds.' },
  intervalMinutes: { type: 'number', description: 'Interval in minutes.' },
  paused: { type: 'boolean', description: 'Pause or resume.' },
  mode: { type: 'string', enum: ['message', 'silent'], description: 'How it is delivered.' },
} } };
const cancel: ToolSchema = { name: 'cancel', inputSchema: {
  properties: { id: { type: 'string', description: 'The id of the reminder to cancel. More detail.' } },
  required: ['id'],
} };
const list: ToolSchema = { name: 'list', inputSchema: { properties: {} } };
const tools = [configure, cancel, list];

test('arguments the schema takes, of the types it gives, pass', () => {
  assert.deepEqual(checkArguments(configure, { intervalMinutes: 30, paused: true, mode: 'silent' }, tools), { problems: [], ignored: [] });
  assert.deepEqual(checkArguments(list, {}, tools), { problems: [], ignored: [] });
});

test('each wrong type, value outside an enum and missing required argument is named, all at once', () => {
  const { problems } = checkArguments(configure, { intervalMinutes: '30', paused: 'true', mode: 'loud', intervalSeconds: null }, tools);
  assert.deepEqual(problems, [
    '"intervalMinutes" is the string "30"; give it as a number: 30.',
    '"paused" is the string "true"; give it as true or false, without quotes: true.',
    '"mode" "loud" isn\'t one of its values; give "message" or "silent".',
    '"intervalSeconds" is null; give a number.',
  ]);
  assert.deepEqual(checkArguments(cancel, {}, tools).problems, ['"id" is missing: the id of the reminder to cancel.']);
});

test('a near miss, or another tool\'s argument or a near miss of one, is a problem: the agent believes it did something', () => {
  assert.deepEqual(checkArguments(configure, { Paused: true }, tools).problems,
    ['"Paused" isn\'t an argument configure takes; the closest is "paused".']);
  assert.deepEqual(checkArguments(configure, { pasued: true }, tools).problems,
    ['"pasued" isn\'t an argument configure takes; the closest is "paused".']);
  assert.deepEqual(checkArguments(configure, { paused: true, interval: 30 }, tools).problems,
    ['"interval" isn\'t an argument configure takes; the closest is "intervalSeconds" or "intervalMinutes".']);
  assert.deepEqual(checkArguments(configure, { Seconds: 30 }, tools).problems,
    ['"Seconds" isn\'t an argument configure takes; the closest is "intervalSeconds".']);
  const send: ToolSchema = { name: 'send', inputSchema: { properties: {
    channel: { type: 'string', description: 'A channel.' },
    channelId: { type: 'string', description: 'A channel id.' },
  } } };
  assert.deepEqual(checkArguments(send, { channel: 'general', channel_id: 'c1' }, [send]).problems,
    ['"channel_id" isn\'t an argument send takes; the closest is "channelId".']);
  assert.deepEqual(checkArguments(send, { channel_id: 'c1' }, [send]).problems,
    ['"channel_id" isn\'t an argument send takes; the closest is "channel" or "channelId".']);
  assert.deepEqual(checkArguments(list, { id: 'rem_1' }, tools).problems,
    ['"id" is cancel\'s argument, not list\'s; list takes no arguments.']);
  assert.deepEqual(checkArguments(list, { Id: 'rem_1' }, tools).problems,
    ['"Id" is close to "id", cancel\'s argument, not one list takes; list takes no arguments.']);
});

test('a key like nothing here is ignored, unless it is all a tool that takes arguments was sent', () => {
  assert.deepEqual(checkArguments(configure, { paused: true, reason: 'quiet' }, tools), { problems: [], ignored: ['reason'] });
  assert.deepEqual(checkArguments(list, { verbose: true }, tools), { problems: [], ignored: ['verbose'] });
  assert.deepEqual(checkArguments(configure, { reason: 'quiet' }, tools), {
    problems: ['It doesn\'t take "reason"; it takes "intervalSeconds", "intervalMinutes", "paused" and "mode".'],
    ignored: [],
  });
  assert.deepEqual(checkArguments(configure, { paused: true, pausedReason: 'quiet' }, tools), { problems: [], ignored: ['pausedReason'] });
});

test('a key that holds an argument\'s whole name is a slip for it sent without it, and an extra beside it', () => {
  assert.deepEqual(checkArguments(configure, { pausedReason: 'quiet' }, tools).problems,
    ['"pausedReason" isn\'t an argument configure takes; the closest is "paused".']);
  assert.deepEqual(checkArguments(configure, { heartbeatIntervalMinutes: 30, paused: false }, tools).problems,
    ['"heartbeatIntervalMinutes" isn\'t an argument configure takes; the closest is "intervalMinutes".']);
  assert.deepEqual(checkArguments(configure, { pausedMode: true }, tools).problems,
    ['"pausedMode" isn\'t an argument configure takes; the closest is "paused" or "mode".']);
  assert.deepEqual(checkArguments(list, { intervalMinutesValue: 5 }, tools).problems,
    ['"intervalMinutesValue" is close to "intervalMinutes", configure\'s argument, not one list takes; list takes no arguments.']);
  assert.deepEqual(checkArguments(list, { intervalMinutes: 5, intervalMinutesValue: 6 }, tools), {
    problems: ['"intervalMinutes" is configure\'s argument, not list\'s; list takes no arguments.'],
    ignored: ['intervalMinutesValue'],
  });
  assert.deepEqual(checkArguments(list, { valid: true }, tools), { problems: [], ignored: ['valid'] });
});

test('the note on ignored keys names them and every argument the tool takes, applied or refused', () => {
  assert.equal(ignoredNote(configure, ['pausedReason', 'reason']),
    'configure ignored "pausedReason" and "reason", which it doesn\'t take; it takes "intervalSeconds", "intervalMinutes", "paused" and "mode".');
  assert.equal(ignoredNote(configure, ['reason'], true),
    'It also doesn\'t take "reason"; it takes "intervalSeconds", "intervalMinutes", "paused" and "mode".');
});

test('a letter or two of a name, or a key that shares only its start with one, is no slip', () => {
  const add: ToolSchema = { name: 'add', inputSchema: { properties: {
    message: { type: 'string', description: 'The text.' },
    atIso: { type: 'string', description: 'A time.' },
  } } };
  assert.deepEqual(checkArguments(add, { message: 'm', at: '2099-01-01' }, [add]), { problems: [], ignored: ['at'] });
  assert.deepEqual(checkArguments(configure, { paused: true, intervalMins: 30 }, tools), { problems: [], ignored: ['intervalMins'] });
});

test('arguments that aren\'t an object are a problem', () => {
  assert.deepEqual(checkArguments(cancel, 'rem_1', tools).problems, [
    'Its arguments are the string "rem_1"; give an object of named arguments, such as {"id": …}.',
    '"id" is missing: the id of the reminder to cancel.',
  ]);
  assert.deepEqual(checkArguments(list, [], tools).problems, ['Its arguments are a list; give an object of named arguments, or none.']);
});

test('a key named like an Object.prototype member is no argument', () => {
  assert.deepEqual(checkArguments(list, { constructor: 1 }, tools), { problems: [], ignored: ['constructor'] });
});

test('closestNames ranks prefixes and substrings ahead of edits, gives two at most, and returns nothing past noise', () => {
  assert.deepEqual(closestNames('PAUSED', ['paused', 'mode']), ['paused']);
  assert.deepEqual(closestNames('mod', ['paused', 'mode']), ['mode']);
  assert.deepEqual(closestNames('pasued', ['paused', 'mode']), ['paused']);
  assert.deepEqual(closestNames('reason', ['paused', 'mode']), []);
  assert.deepEqual(closestNames('mod', ['mud', 'mode']), ['mode', 'mud']);
  assert.deepEqual(closestNames('every', ['everyHours', 'everyMinutes', 'everySeconds']), ['everyHours', 'everyMinutes']);
});

test('addUnits adds the units given, and refuses a negative one', () => {
  const units = [['inSeconds', 1], ['inMinutes', 60], ['inHours', 3600]] as const;
  const problems: string[] = [];
  assert.deepEqual(addUnits({ inHours: 1, inMinutes: 30 }, units, problems), { given: [['inMinutes', 30], ['inHours', 1]], seconds: 5400 });
  assert.equal(addUnits({}, units, problems), null);
  assert.deepEqual(problems, []);
  assert.equal(addUnits({ inMinutes: -5, inSeconds: 10 }, units, problems), null);
  assert.deepEqual(problems, ['"inMinutes" -5 is negative; give 0 or more.']);
  assert.equal(addUnits({ inHours: 1e306 }, units, [])?.seconds, Infinity);
  assert.equal(addUnits({ inSeconds: 4.6 }, units, [])?.seconds, 4.6);
  assert.equal(addUnits({ inMinutes: 0.1 }, units, [])?.seconds, 6);
  assert.equal(addUnits({ inSeconds: 0.0004 }, units, [])?.seconds, 0);
});
