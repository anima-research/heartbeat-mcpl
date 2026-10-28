import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { EPOCH, serverInProcess, until, useClock } from './in-process-host.js';

const copies = (dir: string, name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.unreadable-`));
const unsaved = (what: string, why: 'unread' | 'uncopied') => `This change can't be saved: this server couldn't `
  + `${why === 'unread' ? `read the ${what} file` : `copy the ${what} file aside`}, and saves nothing over it until a restart reads it again, `
  + "so the change won't last past a restart. Calling again won't change that; if you need it kept, ask whoever runs this host to fix "
  + `${why === 'unread' ? 'what stops the server reading the file' : 'what stopped the copy'}, as its log says, and restart it.`;
const failed = (what: string) => `This change wasn't saved, because writing the ${what} file failed, so as things stand it won't last `
  + 'past a restart, and the failed write may also have left the file missing what was saved before. A later save of that file that '
  + 'goes through saves everything again; if it keeps happening, ask whoever runs this host to fix what stops the server writing the '
  + 'file, as its log says.';
const noneLoaded = "The reminders file couldn't be used at start, so reminders saved before then aren't loaded; ask whoever runs this host.";
const someLoaded = "Some reminders saved before this start couldn't be loaded; ask whoever runs this host.";
const configNotLoaded = "The config file couldn't be used at start, so the schedule shown started from the default, not from what was saved; "
  + 'ask whoever runs this host.';
const replacedText = (what: string) => `Some text in the ${what} file couldn't be read, so it was loaded with replacement characters `
  + '(\ufffd) in its place. The original is kept; ask whoever runs this host if you need it.';
const asRoot = process.getuid?.() === 0 ? 'root reads and writes a file whatever its mode' : false;
const row = { id: 'rem_ok', message: 'ok', createdAt: EPOCH, fireAt: EPOCH + 3_600_000, everySeconds: null };

async function inLog(h: { stderr: () => string }, pattern: RegExp) {
  await until(() => pattern.test(h.stderr()), () => `expected the log to match ${pattern}, in\n${h.stderr()}`);
}

test('files the server can use load with no note, and no copy', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { reminders: [row], prepare: ({ config }) => writeFileSync(config, '{"paused":true}') });
  assert.match(await h.call('heartbeat_status'), /^Heartbeat PAUSED \| [^\n]* \| message="[^"\n]*"$/);
  assert.match(await h.call('reminder_list'), /^1 reminder\(s\):\nrem_ok \|[^\n]*$/);
  assert.deepEqual(readdirSync(h.files.dir).sort(), ['config.json', 'reminders.json']);
});

test('the tools that change a store say the reply tells when a change can\'t be or wasn\'t saved', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}));
  const { tools } = await h.request('tools/list', {}) as { tools: Array<{ name: string; description: string }> };
  const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? '';
  assert.match(description('heartbeat_configure'),
    /The schedule is saved so that it persists across restarts; the reply says if a change cannot be or was not saved\./);
  assert.match(description('reminder_add'), /The reminder is saved so that it survives restarts; the reply says if it cannot be or was not saved\./);
});

test('a reminders file that isn\'t JSON is copied aside, the replies say so, and the next save writes a good one', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, '[{"id": "rem_torn", "mess') });
  assert.equal(await h.call('reminder_list'), `No reminders held here.\n${noneLoaded}`);
  const status = await h.call('heartbeat_status');
  assert.ok(status.includes(' | reminders=0 | ') && status.endsWith(`"\n${noneLoaded}`), status);
  const [copy] = copies(h.files.dir, 'reminders.json');
  assert.equal(readFileSync(`${h.files.dir}/${copy}`, 'utf8'), '[{"id": "rem_torn", "mess');
  await inLog(h, /the reminders file .* isn't JSON; copied it to .*reminders\.json\.unreadable-[0-9a-f]{12}, and starting without it/);
  const added = await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.doesNotMatch(added, /can't be saved|wasn't saved/);
  assert.deepEqual(h.stored().map((r) => r.message), ['later']);
});

test('a reminders file that can\'t be read is left alone, and replies say a change won\'t last', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { prepare: ({ reminders }) => { rmSync(reminders); mkdirSync(reminders); } });
  const added = await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.ok(added.endsWith(`| one-shot | "later". ${unsaved('reminders', 'unread')}`), added);
  const id = /^Reminder (rem_\S+) set/.exec(added)?.[1];
  const list = await h.call('reminder_list');
  assert.match(list, new RegExp(`^${id} \\|`, 'm'), 'it is held in memory meanwhile');
  assert.ok(list.endsWith(`\n${noneLoaded}`), list);
  const refused = await h.call('reminder_cancel', { id: 'rem_from_before' });
  assert.ok(refused.endsWith(`No reminder held here has the id "rem_from_before". If it was a one-off that has fired, or it was cancelled `
    + `already, there's nothing more to do. Otherwise, reminder_list shows the pending ids held here. ${noneLoaded}`), refused);
  assert.ok((await h.call('reminder_cancel', { id })).endsWith(`remain. ${unsaved('reminders', 'unread')} ${noneLoaded}`));
  assert.ok(statSync(h.files.reminders).isDirectory(), 'nothing was saved over it');
  await inLog(h, /the reminders file .* couldn't be read \(EISDIR.*\); nothing is saved over it until a restart reads it again/);
});

test('a reminders file the server can\'t read, though it could write it, keeps what it holds', { skip: asRoot }, async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), {
    prepare: ({ reminders }) => { writeFileSync(reminders, JSON.stringify([row])); chmodSync(reminders, 0o200); },
  });
  assert.ok((await h.call('reminder_add', { message: 'later', inHours: 1 })).endsWith(` ${unsaved('reminders', 'unread')}`));
  chmodSync(h.files.reminders, 0o600);
  assert.deepEqual(h.stored(), [row], 'nothing was saved over it');
  await inLog(h, /the reminders file .* couldn't be read \(EACCES.*\); nothing is saved over it until a restart reads it again/);
});

test('a save that fails on a file the server read is said in the reply, and a later save that goes through keeps the change', { skip: asRoot }, async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), {
    reminders: [row],
    prepare: ({ reminders, config }) => {
      chmodSync(reminders, 0o444);
      writeFileSync(config, JSON.stringify({ paused: false }));
      chmodSync(config, 0o444);
    },
  });
  const added = await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.ok(added.endsWith(`| one-shot | "later". ${failed('reminders')}`), added);
  await inLog(h, /reminders write failed: EACCES/);
  assert.ok((await h.call('reminder_cancel', { id: 'rem_ok' })).endsWith(`remain. ${failed('reminders')}`));
  assert.doesNotMatch(await h.call('reminder_list'), /couldn't be (used|loaded)/, 'the file was loaded whole');
  const updated = await h.call('heartbeat_configure', { paused: true });
  assert.ok(updated.startsWith(`Updated. ${failed('config')} Heartbeat PAUSED | `), updated);
  assert.deepEqual(JSON.parse(readFileSync(h.files.config, 'utf8')), { paused: false }, 'the config is as it was');
  chmodSync(h.files.reminders, 0o600);
  chmodSync(h.files.config, 0o600);
  assert.doesNotMatch(await h.call('reminder_add', { message: 'sooner', inMinutes: 5 }), /saved/);
  assert.deepEqual(h.stored().map((r) => r.message).sort(), ['later', 'sooner']);
  assert.ok((await h.call('heartbeat_configure', { message: 'hello' })).startsWith('Updated. Heartbeat PAUSED | '));
  assert.equal(JSON.parse(readFileSync(h.files.config, 'utf8')).paused, true);
});

test('a config that is JSON but not an object is copied aside, the defaults load, and each reply showing the schedule says so', async (t) => {
  useClock(t);
  for (const text of ['"quiet"', '[1]']) {
    const h = await serverInProcess(t, () => ({}), { prepare: ({ config }) => writeFileSync(config, text) });
      const status = await h.call('heartbeat_status');
    assert.match(status, /^Heartbeat ACTIVE \| mode=message \| interval=14400s /, text);
    assert.ok(status.endsWith(`"\n${configNotLoaded}`), status);
    assert.ok((await h.call('heartbeat_trigger')).endsWith(`"\n${configNotLoaded}`));
    assert.equal(copies(h.files.dir, 'config.json').length, 1, text);
    const updated = await h.call('heartbeat_configure', { paused: true });
    assert.ok(updated.startsWith('Updated. Heartbeat PAUSED | ') && updated.endsWith(`"\n${configNotLoaded}`), updated);
    const saved = JSON.parse(readFileSync(h.files.config, 'utf8'));
    assert.equal(saved.paused, true);
    assert.equal(saved['0'], undefined, `no key from the ${text} it held`);
  }
});

test('a config that can\'t be read is left alone, and heartbeat_configure says its change won\'t last', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { prepare: ({ config }) => mkdirSync(config) });
  const updated = await h.call('heartbeat_configure', { paused: true });
  assert.ok(updated.startsWith(`Updated. ${unsaved('config', 'unread')} Heartbeat PAUSED | `), updated);
  const status = await h.call('heartbeat_status');
  assert.match(status, /^Heartbeat PAUSED/, 'it applies in memory meanwhile');
  assert.ok(status.endsWith(`\n${configNotLoaded}`), status);
  const unchanged = await h.call('heartbeat_configure');
  assert.ok(unchanged.startsWith('No changes. Heartbeat PAUSED | ') && !unchanged.includes('saved,'), unchanged);
  assert.ok(statSync(h.files.config).isDirectory(), 'nothing was saved over it');
});

test('a config the server can\'t read, though it could write it, keeps what it holds', { skip: asRoot }, async (t) => {
  useClock(t);
  const held = { intervalSeconds: 3600, paused: false, message: 'my own heartbeat', deliveryMode: 'message' };
  const h = await serverInProcess(t, () => ({}), {
    prepare: ({ config }) => { writeFileSync(config, JSON.stringify(held)); chmodSync(config, 0o200); },
  });
  assert.ok((await h.call('heartbeat_configure', { paused: true })).startsWith(`Updated. ${unsaved('config', 'unread')} Heartbeat PAUSED | `));
  chmodSync(h.files.config, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(h.files.config, 'utf8')), held, 'nothing was saved over it');
});

test('a reminders file that is JSON but not a list is copied aside too, and the next save writes a good one', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, '{"rem_1": "later"}') });
  assert.equal(await h.call('reminder_list'), `No reminders held here.\n${noneLoaded}`);
  assert.equal(copies(h.files.dir, 'reminders.json').length, 1);
  await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.deepEqual(h.stored().map((r) => r.message), ['later']);
});

test('a reminders file that starts with a byte order mark loads as it is, and the next save leaves the mark out', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, `\ufeff${JSON.stringify([row])}`) });
  assert.match(await h.call('reminder_list'), /^1 reminder\(s\):\nrem_ok \|[^\n]*$/);
  assert.deepEqual(copies(h.files.dir, 'reminders.json'), []);
  await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.notEqual(readFileSync(h.files.reminders)[0], 0xef, 'the save writes no mark');
  assert.deepEqual(h.stored().map((r) => r.id).filter((id) => id === 'rem_ok'), ['rem_ok']);
});

test('a reminders file with bytes that aren\'t UTF-8 is copied aside, and its reminders load with replacement characters', async (t) => {
  useClock(t);
  // 0xe9 is é in Latin-1, and no character in UTF-8.
  const bytes = Buffer.from(JSON.stringify([{ ...row, message: 'caf\u00e9' }]), 'latin1');
  const h = await serverInProcess(t, () => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, bytes) });
  const list = await h.call('reminder_list');
  assert.match(list, /^1 reminder\(s\):\nrem_ok \|[^\n]*"caf\ufffd"\n/);
  assert.ok(list.endsWith(`\n${replacedText('reminders')}`), list);
  const status = await h.call('heartbeat_status');
  assert.ok(status.includes(' | reminders=1 | ') && status.endsWith(`"\n${replacedText('reminders')}`), status);
  await inLog(h, /the reminders file .* holds bytes that aren't UTF-8; copied it to .*, and starting with what it holds, read with replacement characters/);
  const [copy] = copies(h.files.dir, 'reminders.json');
  assert.ok(readFileSync(`${h.files.dir}/${copy}`).equals(bytes), 'the copy holds the bytes');
  assert.doesNotMatch(await h.call('reminder_add', { message: 'later', inHours: 1 }), /saved/);
  assert.deepEqual(h.stored().map((r) => r.message).sort(), ['caf\ufffd', 'later']);
  assert.ok(readFileSync(`${h.files.dir}/${copy}`).equals(bytes), 'and the copy still holds the bytes');
  const refused = await h.call('reminder_cancel', { id: 'rem_gone' });
  assert.ok(refused.endsWith('No reminder has the id "rem_gone". If it was a one-off that has fired, or it was cancelled already, '
    + `there's nothing more to do. Otherwise, reminder_list shows the pending ids. ${replacedText('reminders')}`), refused);
  assert.ok((await h.call('reminder_cancel', { id: 'rem_ok' })).endsWith(`1 reminder(s) remain. ${replacedText('reminders')}`));
});

test('a config with bytes that aren\'t UTF-8 is copied aside, and loads with replacement characters', async (t) => {
  useClock(t);
  const bytes = Buffer.from(JSON.stringify({ intervalSeconds: 3600, paused: false, message: 'caf\u00e9', deliveryMode: 'message' }), 'latin1');
  const h = await serverInProcess(t, () => ({}), { prepare: ({ config }) => writeFileSync(config, bytes) });
  const status = await h.call('heartbeat_status');
  assert.match(status, /^Heartbeat ACTIVE \| mode=message \| interval=3600s .*\| message="caf\ufffd"\n/);
  assert.ok(status.endsWith(`"\n${replacedText('config')}`), status);
  const [copy] = copies(h.files.dir, 'config.json');
  assert.ok(readFileSync(`${h.files.dir}/${copy}`).equals(bytes), 'the copy holds the bytes');
  assert.ok((await h.call('heartbeat_configure', { paused: true })).startsWith('Updated. Heartbeat PAUSED | '));
  assert.equal(JSON.parse(readFileSync(h.files.config, 'utf8')).intervalSeconds, 3600, 'the save keeps what loaded');
});

test('a reminders file with bytes that aren\'t UTF-8 and a row that isn\'t a reminder says both, with one copy', async (t) => {
  useClock(t);
  const bytes = Buffer.from(JSON.stringify([{ ...row, message: 'caf\u00e9' }, { message: 'no id' }]), 'latin1');
  const h = await serverInProcess(t, () => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, bytes) });
  const list = await h.call('reminder_list');
  assert.match(list, /^1 reminder\(s\):\nrem_ok \|/);
  assert.ok(list.endsWith(`\n${someLoaded} ${replacedText('reminders')}`), list);
  const [copy, ...more] = copies(h.files.dir, 'reminders.json');
  assert.deepEqual(more, [], 'one copy, for both');
  assert.ok(readFileSync(`${h.files.dir}/${copy}`).equals(bytes));
});

test('files with bytes that aren\'t UTF-8, whose copies can\'t be made, load, and nothing is saved over them', async (t) => {
  useClock(t);
  const reminders = Buffer.from(JSON.stringify([{ ...row, message: 'caf\u00e9' }]), 'latin1');
  const config = Buffer.from(JSON.stringify({ intervalSeconds: 3600, message: 'caf\u00e9' }), 'latin1');
  const copyOf = (path: string, bytes: Buffer) => `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
  const h = await serverInProcess(t, () => ({}), {
    prepare: (files) => {
      writeFileSync(files.reminders, reminders);
      mkdirSync(copyOf(files.reminders, reminders));
      writeFileSync(files.config, config);
      mkdirSync(copyOf(files.config, config));
    },
  });
  const list = await h.call('reminder_list');
  assert.match(list, /^1 reminder\(s\):\nrem_ok \|[^\n]*"caf\ufffd"\n/);
  assert.ok(list.endsWith(`\n${replacedText('reminders')}`), list);
  const status = await h.call('heartbeat_status');
  assert.match(status, /^Heartbeat ACTIVE \| mode=message \| interval=3600s /);
  assert.ok(status.endsWith(`"\n${replacedText('config')}\n${replacedText('reminders')}`), status);
  assert.ok((await h.call('reminder_add', { message: 'later', inHours: 1 })).endsWith(` ${unsaved('reminders', 'uncopied')}`));
  assert.ok((await h.call('heartbeat_configure', { paused: true })).startsWith(`Updated. ${unsaved('config', 'uncopied')} Heartbeat PAUSED | `));
  assert.ok(readFileSync(h.files.reminders).equals(reminders), 'the reminders file is as it was');
  assert.ok(readFileSync(h.files.config).equals(config), 'and so is the config');
});

test('a file that can\'t be copied aside is left alone, as one that can\'t be read is', async (t) => {
  useClock(t);
  const copyPath = (path: string, text: string) => `${path}.unreadable-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  const h = await serverInProcess(t, () => ({}), {
    prepare: ({ reminders, config }) => {
      writeFileSync(reminders, 'not json');
      mkdirSync(copyPath(reminders, 'not json'));
      writeFileSync(config, 'not json either');
      mkdirSync(copyPath(config, 'not json either'));
    },
  });
  assert.ok((await h.call('reminder_add', { message: 'later', inHours: 1 })).endsWith(` ${unsaved('reminders', 'uncopied')}`));
  assert.ok((await h.call('heartbeat_configure', { paused: true })).startsWith(`Updated. ${unsaved('config', 'uncopied')} Heartbeat PAUSED | `));
  assert.ok((await h.call('reminder_list')).endsWith(`\n${noneLoaded}`));
  const status = await h.call('heartbeat_status');
  assert.ok(status.endsWith(`"\n${configNotLoaded}\n${noneLoaded}`), status);
  assert.equal(readFileSync(h.files.reminders, 'utf8'), 'not json', 'the reminders file is as it was');
  assert.equal(readFileSync(h.files.config, 'utf8'), 'not json either', 'and so is the config');
});

test('a reminders file with a row that isn\'t a reminder is copied aside, and the store starts with the rest', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { reminders: [row, { message: 'no id' }] });
  const held = readFileSync(h.files.reminders);
  const list = await h.call('reminder_list');
  assert.match(list, /^1 reminder\(s\):\nrem_ok \|/);
  assert.ok(list.endsWith(`\n${someLoaded}`), list);
  const status = await h.call('heartbeat_status');
  assert.ok(status.includes(' | reminders=1 | ') && status.endsWith(`"\n${someLoaded}`), status);
  await inLog(h, /dropped reminder \{"message":"no id"\}: it isn't a reminder this server writes/);
  await inLog(h, /the reminders file .* holds rows this server can't load; copied it to .*, and starting with the rest/);
  const [copy] = copies(h.files.dir, 'reminders.json');
  assert.ok(readFileSync(`${h.files.dir}/${copy}`).equals(held), 'the copy holds the file as it was');
  await h.call('reminder_add', { message: 'later', inHours: 1 });
  assert.deepEqual(h.stored().map((r) => r.id).filter((id) => id === 'rem_ok'), ['rem_ok'], 'the save keeps the rest');
  const saved = readFileSync(h.files.reminders, 'utf8');
  const again = await serverInProcess(t, () => ({}), { prepare: ({ reminders }) => writeFileSync(reminders, saved) });
  assert.doesNotMatch(await again.call('reminder_list'), /couldn't be (used|loaded)/);
  assert.deepEqual(copies(again.files.dir, 'reminders.json'), []);
});

test('a reminders file with a row whose time can\'t be held is copied aside the same way', async (t) => {
  useClock(t);
  // Past a Date's range, and the null JSON writes for a time too large for a number.
  const far = { ...row, id: 'rem_far', fireAt: Date.now() + 1e16 };
  const never = { ...row, id: 'rem_never', fireAt: null };
  const h = await serverInProcess(t, () => ({}), { reminders: [row, far, never] });
  const held = readFileSync(h.files.reminders);
  const list = await h.call('reminder_list');
  assert.match(list, /^1 reminder\(s\):\nrem_ok \|/);
  assert.ok(list.endsWith(`\n${someLoaded}`), list);
  await inLog(h, /dropped reminder \{"id":"rem_never",.*\}: its stored time is outside the times a reminder can hold/);
  const [copy] = copies(h.files.dir, 'reminders.json');
  assert.ok(readFileSync(`${h.files.dir}/${copy}`).equals(held), 'the copy holds the rows');
});

test('a reminders file with a row that isn\'t a reminder, whose copy can\'t be made, is left alone', async (t) => {
  useClock(t);
  const rows = [row, { message: 'no id' }];
  const text = JSON.stringify(rows);
  const h = await serverInProcess(t, () => ({}), {
    prepare: ({ reminders }) => mkdirSync(`${reminders}.unreadable-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`),
    reminders: rows,
  });
  const list = await h.call('reminder_list');
  assert.match(list, /^1 reminder\(s\):\nrem_ok \|/);
  assert.ok(list.endsWith(`\n${someLoaded}`), list);
  assert.ok((await h.call('reminder_add', { message: 'later', inHours: 1 })).endsWith(` ${unsaved('reminders', 'uncopied')}`));
  assert.equal(readFileSync(h.files.reminders, 'utf8'), text, 'the file is as it was');
  await inLog(h, /the reminders file .* holds rows this server can't load, and copying it to .* failed .*; nothing is saved over it/);
});

test('a reminders file none of whose rows is a reminder is copied aside, and the list says none was loaded', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}), { reminders: [{ message: 'no id' }, { title: 'another format' }] });
  assert.equal(await h.call('reminder_list'), `No reminders held here.\n${noneLoaded}`);
  assert.equal(copies(h.files.dir, 'reminders.json').length, 1);
});
