// MCPL 0.5 delivers no push/event until the host has sent the initial policy as
// a Request (SPEC §5.3). session.updateFeatureSets() sends the Notification form,
// which can't establish that (§6.7), hence session.raw(...) here.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// mcpl-harness isn't published to npm, so HostSession is loaded from a checkout.
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

// Collect reminder push events (ignore any ambient heartbeat pushes). Each
// fire's text is `[reminder <id>, … · current time: …] <message>`; `body` is
// the message after that header, `headerId` the id the header names.
const HEADER = /^\[reminder (rem_[^,\s]+)(?:, set [^·]+|, repeats every \d+s)? · current time: [^\]]+\]\] /;
const fires = []; // { text, body, headerId, id, at }
function attach(session) {
  session.on('event', (ev) => {
    if (ev.kind !== 'push') return;
    const origin = ev.data?.origin ?? {};
    if (origin.source !== 'reminder') return;
    const text = ev.data?.payload?.content?.[0]?.text ?? '';
    const m = text.match(HEADER);
    fires.push({ text, body: m ? text.slice(m[0].length) : null, headerId: m?.[1] ?? null, id: origin.reminderId, at: Date.now() });
  });
}
const count = (body) => fires.filter((f) => f.body === body).length;

const env = { HEARTBEAT_REMINDERS_FILE: remindersFile, HEARTBEAT_CONFIG_FILE: configFile };
let session = new HostSession({ command: 'node', args: [SERVER, '--stdio'], env, autoApprove: true });
attach(session);

const POLICY = {
  effectiveCapabilities: ['tools', 'pushEvents'],
  deniedCapabilities: [],
  enabled: ['heartbeat'],
  disabled: [],
};
/** Send the initial policy as a Request and return the degradation receipt. */
const sendPolicy = (params = POLICY) => session.raw('featureSets/update', params);

try {
  await session.start();
  console.log('# heartbeat-mcpl reminder scheduler — e2e via mcpl-harness\n');

  // ── 0. initial policy: featureSets/update Request → degradation receipt ──
  console.log('0) no wake is delivered before policy; featureSets/update is answered with a receipt');
  const pre = await session.callTool('heartbeat_trigger', {});
  const preText = pre?.content?.[0]?.text ?? '';
  check(pre?.isError === true && preText.startsWith("heartbeat_trigger: no heartbeat was sent, because the host hasn't finished setting this server up"),
    `trigger before policy reports non-delivery as an error (${preText.slice(0, 80)}…)`);
  check(/\| delivery=BLOCKED \(the host hasn't finished setting this server up, or its last settings message was malformed\) \|/.test(preText),
    'its status names the reason in plain words');

  const receipt = await sendPolicy();
  check(receipt?.accepted === true, `receipt accepted (${JSON.stringify(receipt)})`);
  check(receipt?.mode === 'full', `mode=full with the full grant (${receipt?.mode})`);
  check(Array.isArray(receipt?.unavailableFeatures) && receipt.unavailableFeatures.length === 0,
    'nothing reported unavailable');
  const postText = (await session.callTool('heartbeat_trigger', {}))?.content?.[0]?.text ?? '';
  check(/Heartbeat fired/.test(postText), 'trigger after policy delivers the wake');

  // ── 1. one-shot fires exactly once ──────────────────────────────────────
  console.log('1) one-shot reminder fires exactly once');
  await session.callTool('reminder_add', { message: 'ONE', inSeconds: 5 });
  await sleep(4000);
  check(count('ONE') === 0, 'no premature fire before due');
  await sleep(3500); // ~7.5s total > 5s due
  check(count('ONE') === 1, 'fired exactly once at due');
  const one = fires.find((f) => f.body === 'ONE');
  check(!!one && one.headerId === one.id, `the text names its reminder and the time (${one?.text ?? 'no fire'})`);
  check(!!one && /^\[reminder \S+, set /.test(one.text), 'a one-shot says when it was set');

  // ── 2. recurring fires on cadence, then cancel silences it ──────────────
  console.log('2) recurring reminder fires on cadence; cancel silences it');
  const addRes = await session.callTool('reminder_add', { message: 'REC', everySeconds: 5 });
  const addText = addRes?.content?.[0]?.text ?? '';
  const recId = (addText.match(/Reminder (rem_\S+) set/) ?? [])[1];
  check(!!recId, `reminder_add returned an id (${recId ?? 'none'})`);
  await sleep(12000); // expect fires at ~5s and ~10s
  const afterTwoIntervals = count('REC');
  check(afterTwoIntervals >= 2, `recurring fired on cadence (${afterTwoIntervals} fires in ~12s)`);
  check(fires.some((f) => f.body === 'REC' && f.text.startsWith(`[reminder ${recId}, repeats every 5s · current time: `)),
    'a recurring fire names its interval');
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
  // A restart is a fresh connection, so the grant starts empty again (§5.3).
  const receiptAfterRestart = await sendPolicy();
  check(receiptAfterRestart?.accepted === true, 'policy re-established after restart');
  check(count('SURV') === 0, 'still not fired right after restart');
  await sleep(9000); // ~10.5s after add > 8s due
  check(count('SURV') === 1, 'reminder fired once after restart (survived from disk)');
} finally {
  session.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n# ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
