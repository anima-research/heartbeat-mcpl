import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const candidates = [
  process.env.MCPL_HARNESS_SESSION,
  join(HERE, '..', '..', 'mcpl-harness', 'src', 'session.ts'),
  '/Users/antra/connectome-local/mcpl-harness/src/session.ts',
].filter(Boolean);
const harness = candidates.find((p) => existsSync(p));
if (!harness) throw new Error(`mcpl-harness not found: ${candidates.join(', ')}`);
const { HostSession } = await import(pathToFileURL(harness).href);
const server = join(HERE, '..', 'dist', 'src', 'index.js');
const dir = mkdtempSync(join(tmpdir(), 'hb-silent-'));
const config = join(dir, 'config.json');
const reminders = join(dir, 'reminders.json');
const session = new HostSession({ command: 'node', args: [server, '--stdio'], env: {
  HEARTBEAT_CONFIG_FILE: config,
  HEARTBEAT_REMINDERS_FILE: reminders,
}, autoApprove: true });
const pushes = [];
session.on('event', (ev) => { if (ev.kind === 'push') pushes.push(ev.data); });
const check = (cond, msg) => { if (!cond) throw new Error(msg); console.log(`ok - ${msg}`); };
try {
  await session.start();
  await session.raw('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
    enabled: ['heartbeat'], disabled: [],
  });
  await session.callTool('heartbeat_configure', { deliveryMode: 'silent', paused: false });
  const status = (await session.callTool('heartbeat_status', {}))?.content?.[0]?.text ?? '';
  check(status.includes('mode=silent'), 'status reports silent mode');
  await session.callTool('heartbeat_trigger', {});
  await new Promise((r) => setTimeout(r, 100));
  const hb = pushes.find((p) => p?.origin?.source === 'heartbeat');
  check(!!hb, 'manual trigger emits one heartbeat push');
  check(hb.origin.silent === true, 'silent marker is server-authored');
  check(Array.isArray(hb.payload?.content) && hb.payload.content.length === 0, 'silent push has no message content');

  await session.callTool('reminder_add', { message: 'REMINDER-TEXT', inSeconds: 5 });
  await new Promise((r) => setTimeout(r, 6000));
  const rem = pushes.find((p) => p?.origin?.source === 'reminder');
  check(rem?.payload?.content?.[0]?.text === 'REMINDER-TEXT', 'reminders remain message-bearing');

  await session.restart();
  await session.raw('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [],
    enabled: ['heartbeat'], disabled: [],
  });
  const after = (await session.callTool('heartbeat_status', {}))?.content?.[0]?.text ?? '';
  check(after.includes('mode=silent'), 'silent mode survives restart');
} finally {
  session.close();
  rmSync(dir, { recursive: true, force: true });
}
