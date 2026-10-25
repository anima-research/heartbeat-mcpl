// readStored keeps a file the server can't use from being lost to a save: one
// that can't be read is left alone and marked unsaveable, and one that reads
// but isn't what the server writes is copied aside, named by its content,
// before anything saves over it.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readStored } from '../src/stored-file.js';

const copyOf = (path: string, text: string) => `${path}.unreadable-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

function fresh(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-stored-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'reminders.json');
}

test('no file is nothing stored yet, and a file the store writes is read', (t) => {
  const path = fresh(t);
  assert.deepEqual(readStored(path, 'reminders', Array.isArray),
    { value: undefined, bytes: null, unused: false, replaced: false, unsaveable: null, note: null });
  writeFileSync(path, '[{"id":"rem_1"}]');
  assert.deepEqual(readStored(path, 'reminders', Array.isArray),
    { value: [{ id: 'rem_1' }], bytes: Buffer.from('[{"id":"rem_1"}]'), unused: false, replaced: false, unsaveable: null, note: null });
});

test('a file that can\'t be read at all is left alone, and nothing may save over it', (t) => {
  const path = fresh(t);
  mkdirSync(path);
  const stored = readStored(path, 'reminders', Array.isArray);
  assert.equal(stored.value, undefined);
  assert.equal(stored.unused, true, 'the store starts without what it holds');
  assert.match(String(stored.unsaveable), /^the reminders file .* couldn't be read \(EISDIR/);
  assert.match(String(stored.note), /; nothing is saved over it until a restart reads it again$/);
});

test('a file that isn\'t JSON, or isn\'t the shape its store writes, is copied aside with its mode, once', (t) => {
  for (const [text, unlike] of [['[{"id": "rem_1"', "isn't JSON"], ['{"id": "rem_1"}', "isn't what this server writes"]]) {
    const path = fresh(t);
    writeFileSync(path, text, { mode: 0o600 });
    const copy = copyOf(path, text);
    const stored = readStored(path, 'reminders', Array.isArray);
    assert.deepEqual(stored, {
      value: undefined, bytes: Buffer.from(text), unused: true, replaced: false, unsaveable: null,
      note: `the reminders file ${path} ${unlike}; copied it to ${copy}, and starting without it`,
    });
    assert.equal(readFileSync(copy, 'utf8'), text);
    assert.equal(statSync(copy).mode & 0o777, 0o600, 'the copy has the file\'s mode, so no one can read it who couldn\'t read the file');
    assert.equal(readFileSync(path, 'utf8'), text, 'the file itself is left for the next save');
    // Starting on the same content again keeps the one copy.
    assert.equal(readStored(path, 'reminders', Array.isArray).unsaveable, null);
    assert.deepEqual(readdirSync(dirname(path)).filter((f) => f.includes('.unreadable-')), [basename(copy)]);
  }
});

// 0xe9 is é in Latin-1, and no character in UTF-8.
const latin1 = (before: string, after: string) => Buffer.concat([Buffer.from(before), Buffer.from([0xe9]), Buffer.from(after)]);

test('a file with bytes that aren\'t UTF-8 is copied aside, and read with replacement characters in their place', (t) => {
  const path = fresh(t);
  const bytes = latin1('[{"id":"rem_1","message":"caf', '"}]');
  writeFileSync(path, bytes);
  const copy = `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
  const stored = readStored(path, 'reminders', Array.isArray);
  assert.deepEqual(stored, {
    value: [{ id: 'rem_1', message: 'caf\ufffd' }], bytes, unused: false, replaced: true, unsaveable: null,
    note: `the reminders file ${path} holds bytes that aren't UTF-8; copied it to ${copy}, and starting with what it holds, `
      + 'read with replacement characters',
  });
  assert.ok(readFileSync(copy).equals(bytes), 'the copy holds the byte');
});

test('a file with bytes that aren\'t UTF-8 whose copy fails is still read, and nothing may save over it', (t) => {
  const path = fresh(t);
  const bytes = latin1('[{"id":"rem_1","message":"caf', '"}]');
  writeFileSync(path, bytes);
  mkdirSync(`${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`);
  const stored = readStored(path, 'reminders', Array.isArray);
  assert.deepEqual(stored.value, [{ id: 'rem_1', message: 'caf\ufffd' }]);
  assert.equal(stored.replaced, true);
  assert.match(String(stored.unsaveable), /holds bytes that aren't UTF-8, and copying it to .* failed/);
});

test('a file with bytes that aren\'t UTF-8, and isn\'t what its store writes even read that way, is copied aside and not used', (t) => {
  for (const [bytes, unlike] of [[latin1('[{"id": "caf', ''), "isn't JSON"], [latin1('{"id":"caf', '"}'), "isn't what this server writes"]] as const) {
    const path = fresh(t);
    writeFileSync(path, bytes);
    const stored = readStored(path, 'reminders', Array.isArray);
    assert.equal(stored.value, undefined);
    assert.equal(stored.unused, true);
    assert.equal(stored.replaced, false);
    assert.match(String(stored.note), new RegExp(`^the reminders file .* ${unlike}; copied it to .*, and starting without it$`));
  }
});

test('a file that starts with a byte order mark is read past it', (t) => {
  const path = fresh(t);
  writeFileSync(path, '\ufeff[{"id":"rem_1"}]');
  const stored = readStored(path, 'reminders', Array.isArray);
  assert.deepEqual(stored.value, [{ id: 'rem_1' }]);
  assert.equal(stored.unused, false);
  assert.deepEqual(readdirSync(dirname(path)), [basename(path)], 'no copy');
});

test('a copy is named by the file\'s bytes, so files that decode to the same text each keep their own', (t) => {
  const path = fresh(t);
  // 0xff and 0xfe are each invalid UTF-8, and each decodes to U+FFFD.
  const first = Buffer.from([0x5b, 0xff]);
  const second = Buffer.from([0x5b, 0xfe]);
  writeFileSync(path, first);
  assert.equal(readStored(path, 'reminders', Array.isArray).unsaveable, null);
  writeFileSync(path, second);
  assert.equal(readStored(path, 'reminders', Array.isArray).unsaveable, null);
  for (const bytes of [first, second]) {
    const copy = `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
    assert.ok(readFileSync(copy).equals(bytes), `${copy} holds its own file's bytes`);
  }
});

test('a file whose copy can\'t be made is kept as one that can\'t be read is', (t) => {
  const path = fresh(t);
  writeFileSync(path, 'not json');
  mkdirSync(copyOf(path, 'not json'));
  const stored = readStored(path, 'reminders', Array.isArray);
  assert.equal(stored.value, undefined);
  assert.match(String(stored.unsaveable), /isn't JSON, and copying it to .* failed/);
  assert.equal(existsSync(path) && readFileSync(path, 'utf8'), 'not json');
});

test('a file at the copy\'s name that holds something else is never taken for the copy, nor written over', (t) => {
  // 0xff and 0xfe are each invalid UTF-8, read as U+FFFD.
  const cases: [Buffer, Buffer, string][] = [
    [Buffer.from('not json'), Buffer.from('something else'), "isn't JSON"],
    [Buffer.from([0x5b, 0xff]), Buffer.from([0x5b, 0xfe]), "isn't JSON"],
  ];
  for (const [file, other, unlike] of cases) {
    const path = fresh(t);
    writeFileSync(path, file);
    const copy = `${path}.unreadable-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`;
    writeFileSync(copy, other);
    const stored = readStored(path, 'reminders', Array.isArray);
    assert.equal(stored.value, undefined);
    assert.equal(stored.unsaveable,
      `the reminders file ${path} ${unlike}, and copying it to ${copy} failed (${copy} already exists and holds something else)`);
    assert.ok(readFileSync(path).equals(file), 'the file is as it was');
    assert.ok(readFileSync(copy).equals(other), 'and so is the file at the copy\'s name');
  }
});

test('a copy that fails says why', { skip: process.getuid?.() === 0 ? 'root writes into any directory' : false }, (t) => {
  const path = fresh(t);
  writeFileSync(path, 'not json');
  // A directory the server can't write into: the copy fails with EACCES.
  chmodSync(dirname(path), 0o555);
  try {
    const stored = readStored(path, 'reminders', Array.isArray);
    assert.match(String(stored.unsaveable), /isn't JSON, and copying it to .* failed \(EACCES/);
  } finally {
    chmodSync(dirname(path), 0o755);
  }
});
