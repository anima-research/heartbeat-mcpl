import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { HeartbeatServer } from '../src/server.js';
import { FileWake, fileWakeConfig } from '../src/filewake.js';
import type { FileWakeConfig, FileWakeFailure } from '../src/filewake.js';
import { serverInProcess, until, useClock } from './in-process-host.js';
import { logged, origin, POLICY, serverWithHost } from './scripted-host.js';
import type { PushAnswer } from './scripted-host.js';

function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-filewake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const config = (dir: string, extra: Partial<FileWakeConfig> = {}): FileWakeConfig => ({
  ...fileWakeConfig({ FILEWAKE_DIR: dir })!, ...extra,
});
const turns = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

function watcher(t: TestContext, settings: FileWakeConfig, push: (text: string, name: string) => Promise<boolean>) {
  const logs: string[] = [];
  const wake = new FileWake(settings, push, (...a) => logs.push(a.join(' ')));
  t.after(() => wake.stop());
  return { wake, logs };
}

test('filewake is off unless its directory is set; defaults and explicit settings are validated', () => {
  assert.equal(fileWakeConfig({ FILEWAKE_EXT: 'bad', FILEWAKE_INTERVAL_MS: 'bad' }), undefined);
  assert.deepEqual(fileWakeConfig({ FILEWAKE_DIR: 'inbox' }), {
    dir: 'inbox', ext: '', intervalMs: 5000, maxChars: 4000, prefix: '',
  });
  assert.deepEqual(fileWakeConfig({ FILEWAKE_DIR: 'inbox', FILEWAKE_EXT: '.alert', FILEWAKE_INTERVAL_MS: '1000',
    FILEWAKE_MAX_CHARS: '8000', FILEWAKE_PREFIX: '[filewake {name}] ' }), {
    dir: 'inbox', ext: '.alert', intervalMs: 1000, maxChars: 8000, prefix: '[filewake {name}] ',
  });
  for (const value of ['', ' ', '\0']) assert.throws(() => fileWakeConfig({ FILEWAKE_DIR: value }), /FILEWAKE_DIR/);
  for (const value of ['txt', '.', '*.txt', '../txt', '.t/xt', '.t\\xt', '.t xt']) {
    assert.throws(() => fileWakeConfig({ FILEWAKE_DIR: 'inbox', FILEWAKE_EXT: value }), /FILEWAKE_EXT/);
  }
  for (const key of ['FILEWAKE_INTERVAL_MS', 'FILEWAKE_MAX_CHARS']) {
    for (const value of ['', ' ', '0', '-1', '1.5', '1e4', 'Infinity', 'NaN', '9007199254740992']) {
      assert.throws(() => fileWakeConfig({ FILEWAKE_DIR: 'inbox', [key]: value }), new RegExp(key));
    }
  }
  for (const value of ['999', '86400001']) assert.throws(() => fileWakeConfig({ FILEWAKE_DIR: 'inbox', FILEWAKE_INTERVAL_MS: value }), /FILEWAKE_INTERVAL_MS/);
  assert.throws(() => fileWakeConfig({ FILEWAKE_DIR: 'inbox', FILEWAKE_MAX_CHARS: '1000001' }), /FILEWAKE_MAX_CHARS/);
  assert.equal(fileWakeConfig({ FILEWAKE_DIR: 'inbox', FILEWAKE_INTERVAL_MS: '86400000', FILEWAKE_MAX_CHARS: '1000000' })?.maxChars, 1000000);
});

test('the directory is created at startup; a file or symlink in its place is a clear startup error', (t) => {
  const dir = directory(t);
  const nested = join(dir, 'new', 'inbox');
  watcher(t, config(nested), async () => true);
  assert.ok(existsSync(nested));
  writeFileSync(join(dir, 'file'), 'content');
  symlinkSync(nested, join(dir, 'link'));
  for (const name of ['file', 'link']) {
    assert.throws(() => new FileWake(config(join(dir, name)), async () => true, () => {}), /FILEWAKE_DIR/);
  }
});

test('only direct regular, non-hidden files are pushed, in name order, with no reserved suffixes', async (t) => {
  const dir = directory(t);
  const ignored = ['.hidden', '.writing.txt'];
  const eligible = ['a', 'b.txt', 'work.TEMP', 'work.part', 'work.swp', 'work.tmp', 'work~', 'z.alert'];
  for (const name of [...ignored, ...eligible]) writeFileSync(join(dir, name), `body ${name}`);
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'inner.txt'), 'inner');
  symlinkSync(join(dir, 'b.txt'), join(dir, 'link.txt'));
  const fifo = spawnSync('mkfifo', [join(dir, 'pipe.txt')]);
  assert.equal(fifo.status, 0, String(fifo.stderr));
  const seen: string[] = [];
  const { wake, logs } = watcher(t, config(dir), async (text, name) => {
    assert.equal(text, `body ${name}`);
    assert.ok(existsSync(join(dir, name)), 'the file exists until accepted');
    seen.push(name);
    return true;
  });
  wake.start();
  await until(() => logs.length === eligible.length, () => logs.join('\n'));
  assert.deepEqual(seen, eligible);
  for (const name of seen) assert.ok(!existsSync(join(dir, name)));
  for (const name of ignored) assert.ok(existsSync(join(dir, name)));
  assert.ok(existsSync(join(dir, 'nested', 'inner.txt')));
  assert.ok(existsSync(join(dir, 'pipe.txt')));
  assert.ok(logs.every((line) => line.endsWith(': pushed')));
  assert.ok(logs.every((line) => !line.includes('body')));
});

test('extension matching is case-sensitive, and rename publishes a hidden file on the next poll', async (t) => {
  useClock(t);
  const dir = directory(t);
  for (const name of ['.writing', 'skip.alert', 'skip.TXT']) writeFileSync(join(dir, name), 'text');
  const seen: string[] = [];
  const { wake } = watcher(t, config(dir, { ext: '.txt' }), async (_text, name) => { seen.push(name); return true; });
  wake.start();
  await turns();
  assert.deepEqual(seen, []);
  renameSync(join(dir, '.writing'), join(dir, 'ready.txt'));
  t.mock.timers.tick(5000);
  await until(() => !existsSync(join(dir, 'ready.txt')), () => 'renamed file was not consumed');
  assert.deepEqual(seen, ['ready.txt']);
});

test('reads are bounded, Unicode is truncated by code point, invalid UTF-8 is replaced, and prefix substitution is literal', async (t) => {
  const dir = directory(t);
  writeFileSync(join(dir, 'a-$&.txt'), '😀é中xyz');
  writeFileSync(join(dir, 'b-invalid'), Buffer.from([0xff, 0x61, 0xc3]));
  writeFileSync(join(dir, 'c-empty'), '');
  const huge = join(dir, 'd-huge');
  closeSync(openSync(huge, 'w'));
  truncateSync(huge, 2 ** 32);
  const seen: string[] = [];
  const { wake, logs } = watcher(t, config(dir, { maxChars: 3, prefix: '[{name}/{name}] ' }), async (text) => { seen.push(text); return true; });
  wake.start();
  await until(() => logs.length === 4, () => logs.join('\n'));
  assert.deepEqual(seen, ['[a-$&.txt/a-$&.txt] 😀é中', '[b-invalid/b-invalid] �a�', '[c-empty/c-empty] ', '[d-huge/d-huge] \0\0\0']);
});

test('refusals and throws keep each file for the next poll without blocking later files or overlapping polls', async (t) => {
  useClock(t);
  const dir = directory(t);
  for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, name), 'private content');
  let answer!: (accepted: boolean) => void;
  const seen: string[] = [];
  let retry = false;
  const { wake, logs } = watcher(t, config(dir), async (_text, name) => {
    seen.push(name);
    if (retry) return true;
    if (name === 'a') return new Promise<boolean>((resolve) => { answer = resolve; });
    if (name === 'b') throw new Error('transport failed');
    return true;
  });
  wake.start();
  await turns();
  t.mock.timers.tick(50_000);
  await turns();
  assert.deepEqual(seen, ['a'], 'no overlapping poll while the push is pending');
  assert.ok(existsSync(join(dir, 'a')));
  answer(false);
  await until(() => logs.length === 3, () => logs.join('\n'));
  await turns();
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.ok(existsSync(join(dir, 'a')));
  assert.ok(existsSync(join(dir, 'b')));
  assert.ok(!existsSync(join(dir, 'c')));
  assert.match(logs.join('\n'), /NOT pushed \(will retry\)/);
  assert.ok(logs.every((line) => !line.includes('private content')));
  retry = true;
  t.mock.timers.tick(4999);
  await turns();
  assert.equal(seen.length, 3);
  t.mock.timers.tick(1);
  await until(() => logs.length === 5, () => logs.join('\n'));
  assert.deepEqual(seen, ['a', 'b', 'c', 'a', 'b']);
  await wake.stop();
  writeFileSync(join(dir, 'after-stop'), 'keep');
  t.mock.timers.tick(50_000);
  await turns();
  assert.equal(seen.length, 5);
});

test('a file replaced or edited while its push is pending is not deleted', async (t) => {
  const dir = directory(t);
  for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, name), 'old');
  const { wake, logs } = watcher(t, config(dir), async (_text, name) => {
    if (name === 'a') {
      writeFileSync(join(dir, '.replacement'), 'replacement');
      renameSync(join(dir, '.replacement'), join(dir, name));
    } else if (name === 'b') writeFileSync(join(dir, name), 'edited contents');
    else {
      rmSync(join(dir, name));
      symlinkSync(join(dir, 'a'), join(dir, name));
    }
    return true;
  });
  wake.start();
  await until(() => logs.length === 3, () => logs.join('\n'));
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'replacement');
  assert.equal(readFileSync(join(dir, 'b'), 'utf8'), 'edited contents');
  assert.ok(logs.every((line) => line.endsWith('pushed; file changed, kept for retry')));
});

test('an unreadable poll is logged and retried; stopping waits for an outstanding push but starts no later file', async (t) => {
  useClock(t);
  const dir = directory(t);
  const inbox = join(dir, 'inbox');
  let answer!: (accepted: boolean) => void;
  const seen: string[] = [];
  const { wake, logs } = watcher(t, config(inbox), async (_text, name) => {
    seen.push(name);
    return new Promise<boolean>((resolve) => { answer = resolve; });
  });
  rmSync(inbox, { recursive: true });
  wake.start();
  await until(() => logs.length === 1, () => 'missing poll failure log');
  await turns();
  assert.match(logs[0], /filewake poll failed/);
  mkdirSync(inbox);
  writeFileSync(join(inbox, 'a'), 'first');
  writeFileSync(join(inbox, 'b'), 'later');
  t.mock.timers.tick(5000);
  await until(() => seen.length === 1, () => 'no retry');
  wake.retry(); // A queued policy retry must not survive stopping either.
  let stopped = false;
  const stopping = wake.stop().then(() => { stopped = true; });
  await turns();
  assert.equal(stopped, false);
  answer(false);
  await stopping;
  t.mock.timers.tick(50_000);
  await turns();
  assert.deepEqual(seen, ['a']);
  assert.ok(existsSync(join(inbox, 'a')));
  assert.ok(existsSync(join(inbox, 'b')));
});

test('filewake uses server policy and accepted/refused/failed push outcomes, independently of heartbeat silent/paused settings', async (t) => {
  useClock(t);
  const dir = directory(t);
  writeFileSync(join(dir, 'note.txt'), 'wake text');
  let attempt = 0;
  const h = await serverInProcess(t, () => {
    attempt++;
    if (attempt === 1) return { result: { accepted: false, reason: 'busy' } };
    if (attempt === 2) return { error: [-32000, 'failed'] };
    return {};
  }, { fileWake: config(dir), policy: false, prepare: (files) => writeFileSync(files.config, JSON.stringify({ paused: true, deliveryMode: 'silent' })) });
  assert.match(h.stderr(), /filewake blocked: no valid featureSets\/update Request/);
  assert.equal(h.pushes.length, 0);
  await h.request('featureSets/update', POLICY);
  await h.pushCount(1);
  await turns();
  assert.ok(existsSync(join(dir, 'note.txt')));
  for (let i = 2; i <= 3; i++) {
    await h.advance(5000);
    await h.pushCount(i);
    await turns();
    assert.equal(existsSync(join(dir, 'note.txt')), i < 3);
  }
  assert.deepEqual(origin(h.pushes[0]), { source: 'filewake', file: 'note.txt' });
  assert.equal(h.pushes[0].featureSet, 'heartbeat');
  assert.deepEqual(h.pushes[0].payload, { content: [{ type: 'text', text: 'wake text' }] });
  assert.equal(new Set(h.pushes.map((p) => p.eventId)).size, 3);
  writeFileSync(join(dir, 'held.txt'), 'held');
  await h.request('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] });
  await h.advance(5000);
  assert.equal(h.pushes.length, 3);
  assert.ok(existsSync(join(dir, 'held.txt')));
  await h.hangUp();
  await h.advance(50_000);
  assert.equal(h.pushes.length, 3);
});

test('a host disconnecting with a filewake push pending leaves the file and stops the poller', async (t) => {
  useClock(t);
  const dir = directory(t);
  const h = await serverInProcess(t, () => new Promise<PushAnswer>(() => {}), { fileWake: config(dir) });
  writeFileSync(join(dir, 'pending'), 'pending');
  await h.advance(5000);
  await h.pushCount(1);
  await h.hangUp();
  assert.ok(existsSync(join(dir, 'pending')));
  await h.advance(50_000);
  assert.equal(h.pushes.length, 1);
});

test('the built stdio entrypoint applies filewake environment settings and exits cleanly', async (t) => {
  const dir = directory(t);
  const inbox = join(dir, 'inbox');
  const h = await serverWithHost(() => ({}), { env: {
    FILEWAKE_DIR: inbox, FILEWAKE_EXT: '.alert', FILEWAKE_INTERVAL_MS: '1000',
    FILEWAKE_MAX_CHARS: '4', FILEWAKE_PREFIX: '[{name}] ',
  } });
  t.after(h.close);
  assert.ok(existsSync(inbox));
  writeFileSync(join(inbox, 'new.alert'), 'hello world');
  writeFileSync(join(inbox, 'skip.txt'), 'skip');
  await h.pushCount(1);
  await logged(h, 'filewake "new.alert": pushed');
  assert.deepEqual(origin(h.pushes[0]), { source: 'filewake', file: 'new.alert' });
  assert.deepEqual(h.pushes[0].payload, { content: [{ type: 'text', text: '[new.alert] hell' }] });
  assert.ok(!existsSync(join(inbox, 'new.alert')));
  assert.ok(existsSync(join(inbox, 'skip.txt')));
  await h.hangUp();
});

test('invalid filewake settings fail the built entrypoint at startup with the setting named', (t) => {
  const dir = directory(t);
  const result = spawnSync(process.execPath, ['dist/src/index.js', '--stdio'], {
    env: { ...process.env, FILEWAKE_DIR: dir, FILEWAKE_INTERVAL_MS: '0' }, input: '', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /FILEWAKE_INTERVAL_MS must be an integer from 1000 to 86400000/);
  assert.equal(String(result.stdout), '');
});

test('an unanswered filewake push times out, keeps the file, and retries on the next poll', async (t) => {
  useClock(t);
  const dir = directory(t);
  let attempts = 0;
  const h = await serverInProcess(t, () => ++attempts <= 2 ? new Promise<PushAnswer>(() => {}) : {}, { fileWake: config(dir) });
  writeFileSync(join(dir, 'unanswered'), 'text');
  await h.advance(5000);
  await h.pushCount(1);
  await h.advance(30_000);
  await h.logged('filewake "unanswered": NOT pushed (will retry)');
  assert.match(h.stderr(), /push failed \(filewake\):.*whether it was delivered is unknown, and a retry may deliver it twice/);
  assert.ok(existsSync(join(dir, 'unanswered')));
  assert.equal(h.pushes.length, 1);
  await h.advance(5000);
  await h.pushCount(2);
  await h.advance(30_000);
  await turns();
  assert.equal((h.stderr().match(/may deliver it twice/g) ?? []).length, 2, 'every timeout warns about duplicate delivery');
  assert.equal((h.stderr().match(/filewake "unanswered": NOT pushed/g) ?? []).length, 1, 'timeout summaries remain bounded');
  assert.ok(existsSync(join(dir, 'unanswered')));
  await h.advance(5000);
  await h.pushCount(3);
  await h.logged('filewake "unanswered": pushed');
  assert.ok(!existsSync(join(dir, 'unanswered')));
});

test('without FILEWAKE_DIR, the entrypoint ignores invalid filewake settings and serves normally', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, FILEWAKE_EXT: 'invalid', FILEWAKE_INTERVAL_MS: 'invalid', FILEWAKE_MAX_CHARS: 'invalid' };
  delete env.FILEWAKE_DIR;
  const result = spawnSync(process.execPath, ['dist/src/index.js', '--stdio'], {
    env, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }) + '\n', timeout: 5000,
  });
  assert.equal(result.status, 0, String(result.stderr));
  assert.doesNotMatch(String(result.stderr), /filewake/i);
  assert.ok(JSON.parse(String(result.stdout)).result.serverInfo);
});

test('a queued file replaced by a symlink is not followed, and its read error does not stop later files', async (t) => {
  const dir = directory(t);
  for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, name), name);
  writeFileSync(join(dir, '.target'), 'must not be delivered');
  const seen: string[] = [];
  const { wake, logs } = watcher(t, config(dir), async (_text, name) => {
    seen.push(name);
    if (name === 'a') {
      rmSync(join(dir, 'b'));
      symlinkSync(join(dir, '.target'), join(dir, 'b'));
    }
    return true;
  });
  wake.start();
  await until(() => logs.length === 3, () => logs.join('\n'));
  assert.deepEqual(seen, ['a', 'c']);
  assert.match(logs[1], /filewake "b": NOT pushed \(will retry\)/);
  assert.equal(readFileSync(join(dir, '.target'), 'utf8'), 'must not be delivered');
});

test('FILEWAKE_EXT=.tmp delivers non-hidden .tmp files', async (t) => {
  const dir = directory(t);
  for (const name of ['.writing.tmp', 'note.tmp', 'skip.txt']) writeFileSync(join(dir, name), 'text');
  const seen: string[] = [];
  const { wake, logs } = watcher(t, fileWakeConfig({ FILEWAKE_DIR: dir, FILEWAKE_EXT: '.tmp' })!, async (_text, name) => {
    seen.push(name);
    return true;
  });
  wake.start();
  await until(() => logs.length === 1, () => logs.join('\n'));
  assert.deepEqual(seen, ['note.tmp']);
  assert.ok(!existsSync(join(dir, 'note.tmp')));
  assert.ok(existsSync(join(dir, '.writing.tmp')));
  assert.ok(existsSync(join(dir, 'skip.txt')));
});

test('a queued file replaced by a FIFO is logged as non-regular without blocking later files', async (t) => {
  const dir = directory(t);
  for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, name), name);
  const seen: string[] = [];
  const { wake, logs } = watcher(t, config(dir), async (_text, name) => {
    seen.push(name);
    if (name === 'a') {
      rmSync(join(dir, 'b'));
      const fifo = spawnSync('mkfifo', [join(dir, 'b')]);
      assert.equal(fifo.status, 0, String(fifo.stderr));
    }
    return true;
  });
  wake.start();
  await until(() => logs.length === 3, () => logs.join('\n'));
  assert.deepEqual(seen, ['a', 'c']);
  assert.equal(logs[1], 'filewake "b": NOT pushed (will retry): not a regular file');
  assert.ok(existsSync(join(dir, 'b')));
});

test('a file already gone after acceptance is logged as pushed and already removed, not retried', async (t) => {
  useClock(t);
  const dir = directory(t);
  const path = join(dir, 'note');
  writeFileSync(path, 'text');
  let pushes = 0;
  const { wake, logs } = watcher(t, config(dir), async () => {
    pushes++;
    rmSync(path);
    return true;
  });
  wake.start();
  await until(() => logs.length === 1, () => logs.join('\n'));
  assert.equal(logs[0], 'filewake "note": pushed; already removed');
  assert.ok(!existsSync(path));
  await turns();
  t.mock.timers.tick(5000);
  await turns();
  assert.equal(pushes, 1);
  assert.equal(logs.length, 1);
});

test('startup protects both persisted state directories, including missing files and path aliases', (t) => {
  const dir = directory(t);
  const inbox = join(dir, 'inbox');
  const outside = join(dir, 'state');
  mkdirSync(inbox);
  mkdirSync(outside);
  symlinkSync(inbox, join(dir, 'alias'));
  symlinkSync(dir, join(dir, 'parent-alias'));
  writeFileSync(join(inbox, 'config.json'), 'not JSON');
  writeFileSync(join(inbox, 'config.json.unreadable-existing'), 'recovery bytes');
  writeFileSync(join(inbox, 'reminders.json'), '[]');
  symlinkSync(join(inbox, 'config.json'), join(outside, 'linked-config'));
  symlinkSync(join(inbox, 'future-config'), join(outside, 'dangling-config'));
  const paths = [
    join(inbox, 'config.json'),
    join(inbox, 'missing.json'),
    relative(process.cwd(), join(inbox, 'config.json')),
    join(dir, 'alias', 'missing.json'),
    join(dir, 'parent-alias', 'inbox', 'missing.json'),
    join(outside, 'linked-config'),
    join(outside, 'dangling-config'),
  ];
  for (const path of paths) {
    for (const field of ['configPath', 'remindersPath']) {
      assert.throws(() => new HeartbeatServer({
        configPath: join(outside, 'config.json'), remindersPath: join(outside, 'reminders.json'),
        timeZone: 'UTC', log: () => {}, fileWake: config(inbox, { ext: '.alert' }), [field]: path,
      }), /FILEWAKE_DIR.*must be separate from the persisted state directory/);
    }
  }
  assert.throws(() => new HeartbeatServer({
    configPath: join(inbox, 'config.json'), remindersPath: join(outside, 'reminders.json'),
    timeZone: 'UTC', log: () => {}, fileWake: config(join(dir, 'parent-alias', 'inbox')),
  }), /FILEWAKE_DIR.*must be separate from the persisted state directory/);
  assert.equal(readFileSync(join(inbox, 'config.json'), 'utf8'), 'not JSON');
  assert.equal(readFileSync(join(inbox, 'config.json.unreadable-existing'), 'utf8'), 'recovery bytes');
  // Direct-only polling allows a dedicated child inbox beneath a state directory.
  assert.doesNotThrow(() => new HeartbeatServer({
    configPath: join(dir, 'new-state', 'config.json'), remindersPath: join(dir, 'reminders.json'),
    timeZone: 'UTC', log: () => {}, fileWake: config(inbox),
  }));
});

test('the built entrypoint rejects default and custom state directories before consuming state or recovery copies', (t) => {
  const dir = directory(t);
  writeFileSync(join(dir, 'heartbeat-config.json'), '{}');
  writeFileSync(join(dir, 'heartbeat-reminders.json'), '[]');
  writeFileSync(join(dir, 'heartbeat-config.json.unreadable-copy'), 'kept');
  for (const field of [undefined, 'HEARTBEAT_CONFIG_FILE', 'HEARTBEAT_REMINDERS_FILE']) {
    const env: NodeJS.ProcessEnv = { ...process.env, FILEWAKE_DIR: dir };
    delete env.HEARTBEAT_CONFIG_FILE;
    delete env.HEARTBEAT_REMINDERS_FILE;
    if (field) {
      env.HEARTBEAT_CONFIG_FILE = join(dir, 'outside', 'config.json');
      env.HEARTBEAT_REMINDERS_FILE = join(dir, 'outside', 'reminders.json');
      env[field] = join(dir, 'missing-state.json');
    }
    const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/src/index.js'), '--stdio'], {
      cwd: dir, env, input: '', timeout: 5000,
    });
    assert.equal(result.status, 1, String(result.stderr));
    assert.match(String(result.stderr), /FILEWAKE_DIR.*must be separate from the persisted state directory/);
    assert.equal(String(result.stdout), '');
  }
  assert.equal(readFileSync(join(dir, 'heartbeat-config.json'), 'utf8'), '{}');
  assert.equal(readFileSync(join(dir, 'heartbeat-reminders.json'), 'utf8'), '[]');
  assert.equal(readFileSync(join(dir, 'heartbeat-config.json.unreadable-copy'), 'utf8'), 'kept');
});

test('an EACCES state directory warns but a separate inbox still starts the built entrypoint',
  { skip: process.getuid?.() === 0 ? 'root can traverse any directory' : false }, (t) => {
    const dir = directory(t);
    const state = join(dir, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'config.json'), '{}');
    chmodSync(state, 0o000);
    try {
      const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/src/index.js'), '--stdio'], {
        env: { ...process.env, FILEWAKE_DIR: join(dir, 'inbox'), HEARTBEAT_CONFIG_FILE: join(state, 'config.json'),
          HEARTBEAT_REMINDERS_FILE: join(state, 'reminders.json') },
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }) + '\n',
        timeout: 5000,
      });
      assert.equal(result.status, 0, String(result.stderr));
      assert.match(String(result.stderr), /WARNING: filewake could not resolve protected path .*using lexical state-directory comparison: EACCES/);
      assert.match(String(result.stderr), /couldn't be read \(EACCES/);
      assert.ok(JSON.parse(String(result.stdout)).result.serverInfo);
      const linkedConfig = join(dir, 'inbox', 'linked-config');
      symlinkSync(join(state, 'config.json'), linkedConfig);
      const collision = spawnSync(process.execPath, [join(process.cwd(), 'dist/src/index.js'), '--stdio'], {
        env: { ...process.env, FILEWAKE_DIR: join(dir, 'inbox'), HEARTBEAT_CONFIG_FILE: linkedConfig,
          HEARTBEAT_REMINDERS_FILE: join(state, 'reminders.json') }, input: '', timeout: 5000,
      });
      assert.equal(collision.status, 1, String(collision.stderr));
      assert.match(String(collision.stderr), /WARNING:.*lexical.*EACCES/);
      assert.match(String(collision.stderr), /must be separate from the persisted state directory/);
    } finally {
      chmodSync(state, 0o755);
    }
  });

test('unresolvable protected paths fall back to lexical comparison and still refuse collisions', (t) => {
  const dir = directory(t);
  const inbox = join(dir, 'inbox');
  const state = join(dir, 'state');
  mkdirSync(inbox);
  mkdirSync(state);
  const logs: string[] = [];
  for (const parent of [state, inbox]) {
    const path = join(parent, 'loop');
    symlinkSync(path, path);
    const construct = () => new FileWake(config(inbox), async () => true, (...a) => logs.push(a.join(' ')),
      { protectedPaths: [path] });
    if (parent === state) assert.doesNotThrow(construct);
    else assert.throws(construct, /must be separate from the persisted state directory/);
  }
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => /WARNING:.*lexical.*ELOOP/.test(line)));
});

test('the state guard compares both dev and ino for directory aliases that realpath does not resolve', (t) => {
  const dir = directory(t);
  const inbox = join(dir, 'inbox');
  const state = join(dir, 'state');
  mkdirSync(inbox);
  mkdirSync(state);
  const original = fs.statSync;
  const inboxStat = original(inbox);
  const aliasStat = original(state);
  // Model a bind mount without requiring mount privileges in the test suite.
  const mocked = t.mock.method(fs, 'statSync', (path: fs.PathLike) => path === state ? aliasStat : original(path));
  syncBuiltinESMExports();
  try {
    const construct = () => new FileWake(config(inbox), async () => true, () => {},
      { protectedPaths: [join(state, 'config.json')] });
    aliasStat.dev = inboxStat.dev;
    aliasStat.ino = inboxStat.ino;
    assert.throws(construct, /must be separate from the persisted state directory/);
    aliasStat.dev++;
    assert.doesNotThrow(construct, 'inode equality on a different device is not a collision');
    aliasStat.dev = inboxStat.dev;
    aliasStat.ino++;
    assert.doesNotThrow(construct, 'device equality with a different inode is not a collision');
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('failure summaries dedup by basename and outcome class and reset after absence or success', async (t) => {
  const dir = directory(t);
  const path = join(dir, 'note');
  writeFileSync(path, 'private body');
  const logs: string[] = [];
  let outcome: boolean | FileWakeFailure = false;
  const wake = new FileWake(config(dir), async () => outcome, (...a) => logs.push(a.join(' ')));
  t.after(() => wake.stop());
  wake.start();
  await turns();
  for (const failure of ['refused', 'transport', 'timeout', 'refused', 'transport', 'timeout'] as const) {
    outcome = failure;
    wake.retry();
    await turns();
  }
  assert.equal(logs.length, 3, 'one summary per class, not one per basename');
  rmSync(path);
  wake.retry();
  await turns();
  writeFileSync(path, 'new body');
  wake.retry();
  await turns();
  assert.equal(logs.length, 4, 'absence resets all classes');
  outcome = true;
  wake.retry();
  await turns();
  assert.ok(!existsSync(path));
  writeFileSync(path, 'another body');
  outcome = 'timeout';
  wake.retry();
  await turns();
  assert.equal(logs.length, 6, 'success resets all classes');
});

test('a refusal followed by transport failures logs the new outcome and every transport diagnostic without host refusal text', async (t) => {
  useClock(t);
  const dir = directory(t);
  writeFileSync(join(dir, 'note'), 'private body');
  let refuse = true;
  const h = await serverInProcess(t, () => refuse
    ? { result: { accepted: false, reason: 'private refusal' } }
    : { error: [-32000, 'transport exploded'] }, { fileWake: config(dir) });
  await h.logged('filewake "note": NOT pushed (will retry)');
  const refusedLog = h.stderr();
  await h.advance(5000);
  assert.equal(h.stderr(), refusedLog, 'repeated host refusal stays quiet');
  refuse = false;
  await h.advance(5000);
  await h.logged('push failed (filewake): the push failed: transport exploded');
  await turns();
  assert.equal((h.stderr().match(/filewake "note": NOT pushed/g) ?? []).length, 2);
  await h.advance(5000);
  await turns();
  assert.equal((h.stderr().match(/push failed \(filewake\):.*transport exploded/g) ?? []).length, 2);
  assert.equal((h.stderr().match(/filewake "note": NOT pushed/g) ?? []).length, 2);
  assert.doesNotMatch(h.stderr(), /private body|private refusal/);
});

test('a leading UTF-8 BOM is stripped before the character cap, including a one-emoji budget', async (t) => {
  for (const maxChars of [1, 3]) {
    const dir = directory(t);
    const bodies = ['\uFEFF😀😀😀tail', '\uFEFFabcde', '\uFEFF', 'a\uFEFFb', '\uFEFF\uFEFFx'];
    for (const [i, body] of bodies.entries()) writeFileSync(join(dir, String(i)), body);
    const seen: string[] = [];
    const { wake, logs } = watcher(t, config(dir, { maxChars, prefix: '[{name}] ' }), async (text) => {
      seen.push(text);
      return true;
    });
    wake.start();
    await until(() => logs.length === bodies.length, () => logs.join('\n'));
    assert.deepEqual(seen, bodies.map((body, i) =>
      `[${i}] ` + Array.from(body.replace(/^\uFEFF/, '')).slice(0, maxChars).join('')));
    await wake.stop();
  }
});

test('policy grants deliver startup files without advancing a day-long poll interval; reductions still block', async (t) => {
  useClock(t);
  const dir = directory(t);
  writeFileSync(join(dir, 'startup'), 'ready');
  const h = await serverInProcess(t, () => ({}), { fileWake: config(dir, { intervalMs: 86_400_000 }), policy: false });
  assert.equal(h.pushes.length, 0);
  h.notify('featureSets/update', POLICY);
  await turns();
  assert.equal(h.pushes.length, 0, 'a notification cannot establish policy readiness');
  await h.request('featureSets/update', POLICY);
  await h.logged('filewake "startup": pushed');
  assert.equal(h.pushes.length, 1);
  h.notify('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] });
  await turns();
  writeFileSync(join(dir, 'after-reduction'), 'keep');
  await h.advance(86_400_000);
  assert.equal(h.pushes.length, 1);
  assert.ok(existsSync(join(dir, 'after-reduction')));
  await h.request('featureSets/update', POLICY);
  await h.logged('filewake "after-reduction": pushed');
  assert.equal(h.pushes.length, 2);
});

test('policy retries coalesce while a push is pending and cannot restart a stopped watcher', async (t) => {
  useClock(t);
  const dir = directory(t);
  writeFileSync(join(dir, 'note'), 'text');
  let answer!: (accepted: boolean) => void;
  let attempts = 0;
  const { wake, logs } = watcher(t, config(dir, { intervalMs: 86_400_000 }), async () => {
    attempts++;
    if (attempts === 1) return new Promise<boolean>((resolve) => { answer = resolve; });
    return false;
  });
  wake.start();
  await turns();
  for (let i = 0; i < 20; i++) wake.retry();
  await turns();
  assert.equal(attempts, 1);
  answer(false);
  await until(() => attempts === 2, () => 'missing coalesced retry');
  await turns();
  assert.equal(attempts, 2, 'all pending retries collapse to one additional scan');
  assert.equal(logs.length, 1, 'repeated refusal is logged only once');
  await wake.stop();
  wake.retry();
  t.mock.timers.tick(86_400_000);
  await turns();
  assert.equal(attempts, 2);
});

test('blocked polls skip even directory reads and log only a changed blocked state', async (t) => {
  useClock(t);
  const dir = directory(t);
  const inbox = join(dir, 'inbox');
  let blocked: string | null = 'not ready';
  let attempts = 0;
  const logs: string[] = [];
  const wake = new FileWake(config(inbox), async () => { attempts++; return true; },
    (...a) => logs.push(a.join(' ')), { blocked: () => blocked });
  t.after(() => wake.stop());
  rmSync(inbox, { recursive: true });
  wake.start();
  await turns();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(5000);
    await turns();
  }
  assert.deepEqual(logs, ['filewake blocked: not ready'], 'no directory errors or per-poll messages');
  blocked = 'denied';
  wake.retry();
  await turns();
  assert.deepEqual(logs, ['filewake blocked: not ready', 'filewake blocked: denied']);
  mkdirSync(inbox);
  writeFileSync(join(inbox, 'ready'), 'text');
  blocked = null;
  wake.retry();
  await until(() => !existsSync(join(inbox, 'ready')), () => logs.join('\n'));
  assert.equal(attempts, 1);
});

test('server logging stays bounded across blocked and repeatedly refused files, then recovers', async (t) => {
  useClock(t);
  const dir = directory(t);
  const names = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, '0'));
  for (const name of names) writeFileSync(join(dir, name), 'private body');
  let accepted = false;
  const h = await serverInProcess(t, () => ({ result: { accepted, reason: 'private refusal' } }),
    { fileWake: config(dir), policy: false });
  const blockedLog = h.stderr();
  for (let i = 0; i < 4; i++) await h.advance(5000);
  assert.equal(h.stderr(), blockedLog);
  assert.equal(h.pushes.length, 0);
  assert.doesNotMatch(blockedLog, /NOT pushed|suppressed filewake/);
  await h.request('featureSets/update', POLICY);
  await h.pushCount(names.length);
  await turns();
  const refusedLog = h.stderr();
  assert.equal((refusedLog.match(/NOT pushed/g) ?? []).length, names.length);
  for (let i = 0; i < 4; i++) await h.advance(5000);
  assert.equal(h.pushes.length, names.length * 5, 'refused files still retry once per poll');
  assert.equal(h.stderr(), refusedLog, 'neither the server nor watcher logs repeated refusals');
  assert.doesNotMatch(refusedLog, /private body|private refusal/);
  for (const name of names) assert.ok(existsSync(join(dir, name)));
  accepted = true;
  await h.advance(5000);
  await h.until(() => names.every((name) => !existsSync(join(dir, name))), () => h.stderr());
  assert.equal(h.pushes.length, names.length * 6);
  assert.equal((h.stderr().match(/: pushed/g) ?? []).length, names.length);
});

test('policy changes during an in-flight push respect reductions before starting another file', async (t) => {
  useClock(t);
  const dir = directory(t);
  writeFileSync(join(dir, 'a'), 'first');
  writeFileSync(join(dir, 'b'), 'second');
  let answer!: (value: PushAnswer) => void;
  const h = await serverInProcess(t, () => new Promise<PushAnswer>((resolve) => { answer = resolve; }),
    { fileWake: config(dir, { intervalMs: 86_400_000 }) });
  await h.pushCount(1);
  for (let i = 0; i < 3; i++) await h.request('featureSets/update', POLICY);
  assert.equal(h.pushes.length, 1, 'grants cannot overlap a pending push');
  await h.request('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] });
  answer({});
  await h.logged('filewake "a": pushed');
  await turns();
  assert.equal(h.pushes.length, 1, 'a reduction holds the next file and the coalesced scan');
  assert.ok(existsSync(join(dir, 'b')));
  await assert.rejects(h.request('featureSets/update', { enabled: 123 }));
  assert.equal(h.pushes.length, 1, 'malformed policy fails closed too');
  await h.request('featureSets/update', POLICY);
  await h.pushCount(2);
  assert.deepEqual(h.pushes.map((p) => origin(p).file), ['a', 'b']);
  answer({});
  await h.logged('filewake "b": pushed');
});

test('the built entrypoint delivers a BOM-prefixed startup file immediately on policy grant', async (t) => {
  const dir = directory(t);
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox);
  writeFileSync(join(inbox, 'startup.alert'), '\uFEFF😀😀😀tail');
  const h = await serverWithHost(() => ({}), { policy: false, env: {
    FILEWAKE_DIR: inbox, FILEWAKE_EXT: '.alert', FILEWAKE_INTERVAL_MS: '86400000',
    FILEWAKE_MAX_CHARS: '3', FILEWAKE_PREFIX: '[{name}] ',
  } });
  t.after(h.close);
  assert.equal(h.pushes.length, 0);
  assert.ok(existsSync(join(inbox, 'startup.alert')));
  await h.request('featureSets/update', POLICY);
  await h.pushCount(1);
  await logged(h, 'filewake "startup.alert": pushed');
  assert.deepEqual(h.pushes[0].payload, { content: [{ type: 'text', text: '[startup.alert] 😀😀😀' }] });
  assert.ok(!existsSync(join(inbox, 'startup.alert')));
  await h.hangUp();
});
