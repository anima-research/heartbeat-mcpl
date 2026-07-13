#!/usr/bin/env node
// Ad-hoc integration test for the reminder feature. Spawns the built server over
// stdio (newline-delimited JSON-RPC), plays the host side, and exercises:
//   - remind (relative + absolute + validation errors)
//   - reminders / unremind
//   - on-time firing via push/event (origin.reason === 'reminder')
//   - persistence to the reminders file
//   - startup catch-up of an overdue reminder
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'dist/src/index.js');
const REMINDERS_FILE = join(here, '.test-reminders.json');
const CONFIG_FILE = join(here, '.test-config.json');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const proc = spawn('node', [SERVER, '--stdio'], {
    env: { ...process.env, HEARTBEAT_REMINDERS_FILE: REMINDERS_FILE, HEARTBEAT_CONFIG_FILE: CONFIG_FILE },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pushes = [];
  let buf = '';
  const pending = new Map(); let nextId = 1;
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === 'push/event') {
        pushes.push(msg.params);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
      } else if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg); pending.delete(msg.id);
      }
    }
  });
  const send = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = (method, params) => new Promise((res) => {
    const id = nextId++; pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { proc, pushes, send, call };
}

async function handshake(s) {
  await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: {} } } });
  s.send('notifications/initialized', {});
  await sleep(50);
}
const tool = (s, name, args = {}) => s.call('tools/call', { name, arguments: args });
const textOf = (r) => r?.result?.content?.[0]?.text ?? '';

async function main() {
  for (const f of [REMINDERS_FILE, CONFIG_FILE]) if (existsSync(f)) rmSync(f);

  console.log('\n=== Phase 1: set, list, fire, persist ===');
  let s = startServer();
  await handshake(s);

  const r1 = await tool(s, 'remind', { message: 'ping me soon', inSeconds: 2, id: 'soon' });
  ok(/Reminder "soon" set/.test(textOf(r1)), 'remind (relative) accepted');

  const r2 = await tool(s, 'remind', { message: 'absolute test', atIso: new Date(Date.now() + 3600_000).toISOString() });
  ok(/Reminder ".+" set/.test(textOf(r2)), 'remind (absolute atIso) accepted, auto-id');

  const dup = await tool(s, 'remind', { message: 'x', inMinutes: 5, id: 'soon' });
  ok(/already exists/.test(textOf(dup)), 'duplicate id rejected');

  const past = await tool(s, 'remind', { message: 'x', inSeconds: -5 });
  ok(/past/.test(textOf(past)), 'past time rejected');

  const both = await tool(s, 'remind', { message: 'x', inSeconds: 5, inMinutes: 5 });
  ok(/exactly one timing/.test(textOf(both)), 'two timing inputs rejected');

  const none = await tool(s, 'remind', { message: 'x' });
  ok(/needs a time/.test(textOf(none)), 'missing timing rejected');

  const list = await tool(s, 'reminders');
  ok(/2 pending/.test(textOf(list)) && /soon/.test(textOf(list)), 'reminders lists both pending');

  const stored = JSON.parse(readFileSync(REMINDERS_FILE, 'utf8'));
  ok(stored.length === 2 && stored.some((r) => r.id === 'soon'), 'persisted to reminders file');

  console.log('  (waiting ~2.5s for "soon" to fire…)');
  await sleep(2500);
  const fired = s.pushes.find((p) => p.origin?.reason === 'reminder');
  ok(!!fired, 'reminder fired a push/event');
  ok(fired && /ping me soon/.test(fired.payload?.content?.[0]?.text ?? ''), 'push carried the reminder message');
  ok(fired && fired.origin?.source === 'heartbeat', "origin.source === 'heartbeat' (generic, no discord)");

  const after = JSON.parse(readFileSync(REMINDERS_FILE, 'utf8'));
  ok(after.length === 1 && !after.some((r) => r.id === 'soon'), 'fired reminder removed from store (one-shot)');

  const un = await tool(s, 'unremind', { id: after[0].id });
  ok(/Cancelled/.test(textOf(un)), 'unremind cancels by id');
  const unmissing = await tool(s, 'unremind', { id: 'nope' });
  ok(unmissing?.result?.isError === true, 'unremind unknown id errors');
  s.proc.kill();
  await sleep(100);

  console.log('\n=== Phase 2: startup catch-up of overdue reminder ===');
  writeFileSync(REMINDERS_FILE, JSON.stringify([
    { id: 'overdue', dueAt: Date.now() - 10_000, message: 'i was due before restart', createdAt: Date.now() - 60_000 },
    { id: 'future', dueAt: Date.now() + 3600_000, message: 'later', createdAt: Date.now() },
  ], null, 2));
  s = startServer();
  await handshake(s);
  await sleep(300);
  const caught = s.pushes.find((p) => p.origin?.reason === 'reminder' && /due before restart/.test(p.payload?.content?.[0]?.text ?? ''));
  ok(!!caught, 'overdue reminder fired on startup (catch-up)');
  const remain = JSON.parse(readFileSync(REMINDERS_FILE, 'utf8'));
  ok(remain.length === 1 && remain[0].id === 'future', 'future reminder survives, overdue cleared');
  s.proc.kill();

  for (const f of [REMINDERS_FILE, CONFIG_FILE]) if (existsSync(f)) rmSync(f);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
