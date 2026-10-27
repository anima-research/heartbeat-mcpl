import test from 'node:test';
import assert from 'node:assert/strict';
import { serverWithHost } from './scripted-host.js';

type Host = Awaited<ReturnType<typeof serverWithHost>>;

const SEPARATED = 'before\u2028after';

async function inStderr(h: Host, text: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!h.stderr().includes(text)) {
    assert.ok(Date.now() < deadline, `expected ${JSON.stringify(text)} in\n${h.stderr()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function rawAnswer(h: Host, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
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

test('a call whose text holds U+2028, written raw as agent-framework writes it, is answered', async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  h.writeRaw(JSON.stringify({
    jsonrpc: '2.0', id: 'raw-1', method: 'tools/call',
    params: { name: 'reminder_add', arguments: { message: SEPARATED, inHours: 1 } },
  }) + '\n');
  const answer = await rawAnswer(h, 'raw-1');
  assert.ok('result' in answer, `expected a result, got ${JSON.stringify(answer)}`);
  assert.deepEqual(h.stored().map((r) => r.message), [SEPARATED]);
});

test('no line heartbeat writes holds a raw U+2028, so a host that ends lines there gets each message whole', async (t) => {
  const due = Date.now() + 500;
  const h = await serverWithHost(() => ({}), {
    reminders: [{ id: 'rem_separated', message: SEPARATED, createdAt: due - 60_000, fireAt: due, everySeconds: null }],
  });
  t.after(h.close);
  await h.pushCount(1);
  assert.ok(JSON.stringify(h.pushes[0]).includes(SEPARATED), 'the push carries the text whole');
  assert.ok(!h.rawOut().includes('\u2028'), 'no raw U+2028 in what the server wrote');
});

test("a line that isn't JSON is logged, and the next request is answered", async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  h.writeRaw('this is not json\n');
  await inStderr(h, '[heartbeat-mcpl] connection error: Malformed JSON-RPC message: ');
  assert.match(await h.call('heartbeat_status'), /./);
});

test('a broken output pipe ends the connection without an unhandled error', { timeout: 15_000 }, async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  h.child.stdout.destroy();
  h.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 'raw-2', method: 'tools/list' }) + '\n');
  await inStderr(h, '[heartbeat-mcpl] connection error: ');
  h.child.stdin.end();
  await h.exited;
  assert.equal(h.exitCode(), 0, `the server's stderr:\n${h.stderr()}`);
  assert.ok(!h.stderr().includes("Unhandled 'error' event"), h.stderr());
});
