import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWake, fileWakeConfig } from '../src/filewake.js';
import type { FileWakeConfig } from '../src/filewake.js';
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
  await h.logged('filewake "note.txt": NOT pushed (will retry)');
  assert.equal(h.pushes.length, 0);
  await h.request('featureSets/update', POLICY);
  for (let i = 1; i <= 3; i++) {
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
  const h = await serverInProcess(t, () => ++attempts === 1 ? new Promise<PushAnswer>(() => {}) : {}, { fileWake: config(dir) });
  writeFileSync(join(dir, 'unanswered'), 'text');
  await h.advance(5000);
  await h.pushCount(1);
  await h.advance(30_000);
  await h.logged('filewake "unanswered": NOT pushed (will retry)');
  assert.ok(existsSync(join(dir, 'unanswered')));
  assert.equal(h.pushes.length, 1);
  await h.advance(5000);
  await h.pushCount(2);
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
