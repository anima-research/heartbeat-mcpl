// End-to-end test for the reminder scheduler, driven through the real MCPL host
// harness (mcpl-harness HostSession) against the BUILT heartbeat-mcpl server.
//
// Proves the four behaviors from the A4 test plan:
//   1. one-shot fires exactly once at due
//   2. recurring fires on cadence; cancel silences it
//   3. a pending reminder survives a server restart
//
// Run:  node --import tsx test/reminders.harness.mjs   (from the heartbeat-mcpl dir)
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// mcpl-harness is not published to npm, so HostSession is loaded from a
// checkout. Resolution order: $MCPL_HARNESS_SESSION (explicit path to
// src/session.ts), then a sibling checkout next to this repo (what CI clones
// — see .github/workflows/publish.yml), then known dev-box locations.
const HARNESS_CANDIDATES = [
  process.env.MCPL_HARNESS_SESSION,
  join(HERE, '..', '..', 'mcpl-harness', 'src', 'session.ts'),
  '/home/luxia/projects/connectome-ecosystem/mcpl-harness/src/session.ts',
].filter(Boolean);
const HARNESS = HARNESS_CANDIDATES.find((p) => existsSync(p));
if (!HARNESS) {
  console.error('[reminders.harness] mcpl-harness checkout not found. Tried:');
  for (const p of HARNESS_CANDIDATES) console.error(`  - ${p}`);
  console.error('Clone https://github.com/anima-research/mcpl-harness next to this repo (and npm install there), or set MCPL_HARNESS_SESSION.');
  process.exit(1);
}
const { HostSession } = await import(pathToFileURL(HARNESS).href);
const SERVER = join(HERE, '..', 'dist', 'src', 'index.js');

const dir = mkdtempSync(join(tmpdir(), 'hb-a4-'));
const remindersFile = join(dir, 'reminders.json');
const configFile = join(dir, 'config.json'); // absent → defaults (ambient = 4h, won't fire)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, label) {
  if (cond) { console.log(`  ok  - ${label}`); }
  else { console.log(`  FAIL - ${label}`); failures++; }
}

// Collect reminder push events (ignore any ambient heartbeat pushes).
const fires = []; // { text, id, at }
function attach(session) {
  session.on('event', (ev) => {
    if (ev.kind !== 'push') return;
    const origin = ev.data?.origin ?? {};
    if (origin.source !== 'reminder') return;
    const text = ev.data?.payload?.content?.[0]?.text ?? '';
    fires.push({ text, id: origin.reminderId, at: Date.now() });
  });
}
const count = (text) => fires.filter((f) => f.text === text).length;

const env = { HEARTBEAT_REMINDERS_FILE: remindersFile, HEARTBEAT_CONFIG_FILE: configFile };
let session = new HostSession({ command: 'node', args: [SERVER, '--stdio'], env, autoApprove: true });
attach(session);

try {
  await session.start();
  console.log('# heartbeat-mcpl reminder scheduler — e2e via mcpl-harness\n');

  // ── 1. one-shot fires exactly once ──────────────────────────────────────
  console.log('1) one-shot reminder fires exactly once');
  await session.callTool('reminder_add', { message: 'ONE', inSeconds: 5 });
  await sleep(4000);
  check(count('ONE') === 0, 'no premature fire before due');
  await sleep(3500); // ~7.5s total > 5s due
  check(count('ONE') === 1, 'fired exactly once at due');

  // ── 2. recurring fires on cadence, then cancel silences it ──────────────
  console.log('2) recurring reminder fires on cadence; cancel silences it');
  const addRes = await session.callTool('reminder_add', { message: 'REC', everySeconds: 5 });
  const addText = addRes?.content?.[0]?.text ?? '';
  const recId = (addText.match(/Reminder (rem_\S+) set/) ?? [])[1];
  check(!!recId, `reminder_add returned an id (${recId ?? 'none'})`);
  await sleep(12000); // expect fires at ~5s and ~10s
  const afterTwoIntervals = count('REC');
  check(afterTwoIntervals >= 2, `recurring fired on cadence (${afterTwoIntervals} fires in ~12s)`);
  await session.callTool('reminder_cancel', { id: recId });
  const atCancel = count('REC');
  await sleep(7000); // one more interval would have elapsed
  check(count('REC') === atCancel, `cancel silenced the recurring reminder (stayed at ${atCancel})`);

  // ── 3. a pending reminder survives a restart ────────────────────────────
  console.log('3) a pending reminder survives a server restart');
  await session.callTool('reminder_add', { message: 'SURV', inSeconds: 8 });
  check(count('SURV') === 0, 'not yet fired before restart');
  await sleep(1500);
  await session.restart(); // respawn: server must reload reminders from disk
  check(count('SURV') === 0, 'still not fired right after restart');
  await sleep(9000); // ~10.5s after add > 8s due
  check(count('SURV') === 1, 'reminder fired once after restart (survived from disk)');
} finally {
  session.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n# ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
