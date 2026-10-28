import test from 'node:test';
import assert from 'node:assert/strict';
import { CEILING_MS, serverWithHost } from './scripted-host.js';

type Host = Awaited<ReturnType<typeof serverWithHost>>;

const SEPARATED = 'before\u2028middle\u2029after';
const RAW_SEPARATOR = /[\u2028\u2029]/;

async function inStderr(h: Host, text: string): Promise<void> {
  const deadline = Date.now() + CEILING_MS;
  while (!h.stderr().includes(text)) {
    assert.ok(Date.now() < deadline, `expected ${JSON.stringify(text)} in\n${h.stderr()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function rawAnswer(h: Host, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + CEILING_MS;
  for (;;) {
    for (const line of h.rawOut().split('\n')) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (msg.id === id) return msg;
    }
    assert.ok(Date.now() < deadline, `no answer to ${id}; the server's stderr:\n${h.stderr()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a call whose text holds U+2028 and U+2029, written raw as agent-framework writes it, is answered', async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  h.writeRaw(JSON.stringify({
    jsonrpc: '2.0', id: 'raw-1', method: 'tools/call',
    params: { name: 'reminder_add', arguments: { message: SEPARATED, inHours: 1 } },
  }) + '\n');
  const answer = await rawAnswer(h, 'raw-1');
  assert.ok('result' in answer, `expected a result, got ${JSON.stringify(answer)}`);
  assert.ok(JSON.stringify(answer).includes(SEPARATED), 'the answer quotes the text whole');
  assert.ok(!RAW_SEPARATOR.test(h.rawOut()), 'no raw separator in what the server wrote');
  assert.deepEqual(h.stored().map((r) => r.message), [SEPARATED]);
});

test('no line heartbeat writes holds a raw U+2028 or U+2029, so a host that ends lines there gets each message whole', async (t) => {
  const due = Date.now();
  const h = await serverWithHost(() => ({}), {
    reminders: [{ id: 'rem_separated', message: SEPARATED, createdAt: due - 60_000, fireAt: due, everySeconds: null }],
  });
  t.after(h.close);
  await h.pushCount(1);
  assert.ok(JSON.stringify(h.pushes[0]).includes(SEPARATED), 'the push carries the text whole');
  assert.ok(!RAW_SEPARATOR.test(h.rawOut()), 'no raw separator in what the server wrote');
});

test("a line that isn't JSON is logged, and the next request is answered", async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  h.writeRaw('this is not json\n');
  await inStderr(h, '[heartbeat-mcpl] connection error: Malformed JSON-RPC message: ');
  assert.match(await h.call('heartbeat_status'), /^Heartbeat ACTIVE \| /);
});

test('a broken output pipe ends the server, exit 0, without an unhandled error', { timeout: 2 * CEILING_MS }, async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  h.child.stdout.destroy();
  h.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 'raw-2', method: 'tools/list' }) + '\n');
  await h.exited;
  assert.ok(h.stderr().includes('[heartbeat-mcpl] connection error: write EPIPE'), h.stderr());
  assert.equal(h.exitCode(), 0, `the server's stderr:\n${h.stderr()}`);
  assert.ok(!h.stderr().includes("Unhandled 'error' event"), h.stderr());
});
