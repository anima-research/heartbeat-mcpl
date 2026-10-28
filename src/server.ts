import { McplConnection, method } from '@animalabs/mcpl-core';
import type {
  McplInitializeParams, PushEventParams, JsonRpcId,
} from '@animalabs/mcpl-core';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { formatAgentDateTime } from './timezone.js';
import { sendSilentWithFallback } from './silent-delivery.js';
import { sendPush } from './push.js';
import { formatReminderText } from './reminder-text.js';
import { FIRST_REMINDER_TIME, LAST_REMINDER_TIME, canHoldTime, parseReminderTime } from './reminder-time.js';
import { callAt } from './timer.js';
import { HOST_GONE, heldNote, wakeBlocked } from './wake-blocked.js';
import type { WakeBlocked } from './wake-blocked.js';
import { describeThrown, noSuchTool, thrownForLog, toolThrew } from './call-texts.js';
import {
  CONFIG_NOT_LOADED, failedSaveNote, keepAside, readStored, remindersNotLoadedNote, replacedNote, unsavedNote, type Stored, type Unsaveable,
} from './stored-file.js';
import { addUnits, andList, checkArguments, givenText, ignoredNote } from './arguments.js';
import type { Length, ToolSchema } from './arguments.js';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy,
} from './mcpl05.js';
import type {
  FeatureSetDeclaration05, FeatureSetMap, FeatureSetState, FeatureSetWireEntry,
  Grant, InitializeCapabilities05, McplInitializeResult05, McplServerCapabilities05,
} from './mcpl05.js';

// tsx runs this file from src/ and tsc builds it to dist/src/, so package.json is one or two directories up.
const { version: SERVER_VERSION } = createRequire(import.meta.url)(
  existsSync(new URL('../package.json', import.meta.url)) ? '../package.json' : '../../package.json',
) as { version: string };

const FS_NAME = 'heartbeat';
const MIN_REMINDER_SECONDS = 5;
const MIN_HEARTBEAT_SECONDS = 60;

const INTERVAL_UNITS = [['intervalSeconds', 1], ['intervalMinutes', 60], ['intervalHours', 3600]] as const;
const DELAY_UNITS = [['inSeconds', 1], ['inMinutes', 60], ['inHours', 3600]] as const;
const EVERY_UNITS = [['everySeconds', 1], ['everyMinutes', 60], ['everyHours', 3600]] as const;

type HeartbeatDeliveryMode = 'message' | 'silent';
interface HeartbeatConfig { intervalSeconds: number; paused: boolean; message: string; deliveryMode: HeartbeatDeliveryMode; }
const DEFAULT_CONFIG: HeartbeatConfig = {
  intervalSeconds: 4 * 60 * 60,
  paused: false,
  deliveryMode: 'message',
  message: '[heartbeat] Periodic self-check-in. Review anything pending — reminders, schedules, follow-ups — and act if needed; otherwise a brief note to yourself is fine.',
};

interface Reminder {
  id: string;
  message: string;
  createdAt: number; // epoch ms
  fireAt: number;    // epoch ms — the next time this reminder is due
  everySeconds: number | null; // recurrence interval; null = one-shot
}

const unsaveable = (file: Stored): Unsaveable | null => (file.unsaveable ? (file.bytes ? 'uncopied' : 'unread') : null);
const isObject = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);

/** JSON writes a time too large for a number as null. */
type StoredReminder = Omit<Reminder, 'fireAt'> & { fireAt: number | null };
function isStoredReminder(x: unknown): x is StoredReminder {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === 'string'
    && typeof r.message === 'string'
    && typeof r.createdAt === 'number'
    && (r.fireAt === null || typeof r.fireAt === 'number')
    && (r.everySeconds === null || typeof r.everySeconds === 'number');
}

// uses names every capability this feature set exercises (SPEC §6.2, §6.4): it answers
// tools/call and delivers each wake as push/event.
const featureSetDecl: FeatureSetDeclaration05 = {
  description: 'Periodic self-wake heartbeats, one-shot/recurring reminders, and schedule configuration',
  uses: ['tools', 'pushEvents'],
  rollback: false,
};
const declaredFeatureSets: FeatureSetMap = { [FS_NAME]: featureSetDecl };
const featureSets: FeatureSetWireEntry[] = [{ name: FS_NAME, ...featureSetDecl }];

interface ToolDefinition extends ToolSchema {
  description: string;
  inputSchema: ToolSchema['inputSchema'] & { type: 'object' };
}

const toolDefinitionsIn = (timeZone: string): ToolDefinition[] => [
  { name: 'heartbeat_status', description: 'Show your current heartbeat schedule (interval, paused state, time to the next wake while one is coming, message), whether wakes can be delivered, and how many reminders are pending.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'heartbeat_configure',
    description: 'Change your own ambient heartbeat schedule. Give any of: the interval, in intervalSeconds, intervalMinutes and intervalHours, which add up, 60 seconds or more; paused; deliveryMode; message. The schedule is saved so that it persists across restarts; the reply says if a change cannot be or was not saved. With no arguments it changes nothing and shows the schedule. (Reminders are separate — see reminder_add.)',
    inputSchema: { type: 'object', properties: {
      intervalSeconds: { type: 'number', description: 'Wake interval in seconds. Adds to intervalMinutes and intervalHours; together, 60 seconds or more.' },
      intervalMinutes: { type: 'number', description: 'Wake interval in minutes. Adds to intervalSeconds and intervalHours.' },
      intervalHours: { type: 'number', description: 'Wake interval in hours. Adds to intervalSeconds and intervalMinutes.' },
      paused: { type: 'boolean', description: 'Pause (true) or resume (false) heartbeats.' },
      deliveryMode: { type: 'string', enum: ['message', 'silent'], description: 'message = durable prompt; silent = ephemeral private tick with no durable message or automatic prose.' },
      message: { type: 'string', description: 'The text delivered to you in message mode.' },
    } } },
  { name: 'heartbeat_trigger', description: 'Fire an ambient heartbeat immediately (does not change the schedule).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'reminder_add',
    description: 'Schedule a reminder that wakes you with a specific message. One-off: give a delay, in inSeconds, inMinutes and inHours, which add up, or an absolute time, atIso. Repeating: give an interval, in everySeconds, everyMinutes and everyHours, which add up, 5 seconds or more. A repeating reminder first fires one interval out, or at the delay or atIso you also give. The reminder is saved so that it survives restarts; the reply says if it cannot be or was not saved. Returns the reminder id.',
    inputSchema: { type: 'object', properties: {
      message: { type: 'string', description: 'The text delivered to you when the reminder fires. It arrives after a header naming the reminder, when it was set (or its interval) and the current time, e.g. `[reminder <id>, set <time> · current time: <time>] <message>`.' },
      inSeconds: { type: 'number', description: 'Fire this many seconds from now. Adds to inMinutes and inHours.' },
      inMinutes: { type: 'number', description: 'Fire this many minutes from now. Adds to inSeconds and inHours.' },
      inHours: { type: 'number', description: 'Fire this many hours from now. Adds to inSeconds and inMinutes.' },
      atIso: { type: 'string', description: `When it fires, or first fires if it repeats: an ISO-8601 date/time. Without an offset, read in AGENT_TIMEZONE (${timeZone}), and a date alone (YYYY-MM-DD) is midnight there; nonexistent or repeated wall times are refused so no DST choice is made for you. For a repeated time, supply one of the offsets named in the error. Z or a numeric offset specifies the instant directly (e.g. 2026-07-01T09:00:00-04:00). A past time fires as soon as a wake can be delivered.` },
      everySeconds: { type: 'number', description: 'Repeat every N seconds. Adds to everyMinutes and everyHours; together, 5 seconds or more.' },
      everyMinutes: { type: 'number', description: 'Repeat every N minutes. Adds to everySeconds and everyHours.' },
      everyHours: { type: 'number', description: 'Repeat every N hours. Adds to everySeconds and everyMinutes.' },
    }, required: ['message'] } },
  { name: 'reminder_list', description: 'List your pending reminders (id, when each is due, recurrence, message).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'reminder_cancel', description: 'Cancel a reminder by its id (from reminder_add / reminder_list).',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'The id of the reminder to cancel, as reminder_add returned it and reminder_list shows it; it starts with rem_.' },
    }, required: ['id'] } },
];

const REFUSED: Record<string, string> = {
  heartbeat_status: 'nothing was shown',
  heartbeat_configure: 'nothing was changed',
  heartbeat_trigger: 'no heartbeat was sent',
  reminder_add: 'no reminder was set',
  reminder_list: 'nothing was listed',
  reminder_cancel: 'nothing was cancelled',
};

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown; }
interface NotifMsg { method: string; params?: unknown; }

export interface HeartbeatServerOptions {
  configPath: string;
  remindersPath: string;
  timeZone: string;
  log?: (...a: unknown[]) => void;
}

export class HeartbeatServer {
  private readonly configPath: string;
  private readonly remindersPath: string;
  private readonly timeZone: string;
  private readonly log: (...a: unknown[]) => void;
  private readonly toolDefinitions: ToolDefinition[];
  private silentFallbackExplained = false;
  private configUnsaveable: Unsaveable | null = null;
  private remindersUnsaveable: Unsaveable | null = null;
  private configNotLoaded = false;
  private remindersNotLoaded: 'all' | 'some' | null = null;
  private configReplaced = false;
  private remindersReplaced = false;
  private conn: McplConnection | null = null;
  private config: HeartbeatConfig;
  private reminders: Reminder[];
  private cancelHeartbeat: (() => void) | null = null;
  private cancelReminderWake: (() => void) | null = null;
  private nextFireAt = 0;
  private mcplEnabled = false;
  private grant: Grant = EMPTY_GRANT;
  /** SPEC §5.3, §6.7: only a featureSets/update Request establishes the ready state. */
  private policyReady = false;
  private notificationOnly = false;
  private requestSeen = false;
  private silentFellBack = false;
  private inFlight = new Set<string>();
  private refused = new Map<string, { at: number; reason: string }>();

  constructor(options: HeartbeatServerOptions) {
    this.configPath = options.configPath;
    this.remindersPath = options.remindersPath;
    this.timeZone = options.timeZone;
    this.log = options.log ?? ((...a: unknown[]) => console.error('[heartbeat-mcpl]', ...a));
    this.toolDefinitions = toolDefinitionsIn(this.timeZone);
    this.config = this.loadConfig();
    this.reminders = this.loadReminders();
  }

  private configNote(): string | null {
    return this.configNotLoaded ? CONFIG_NOT_LOADED : this.configReplaced ? replacedNote('config') : null;
  }

  private remindersNote(): string | null {
    if (this.remindersNotLoaded === 'all') return remindersNotLoadedNote(true);
    const notes = [this.remindersNotLoaded === 'some' ? remindersNotLoadedNote(false) : '', this.remindersReplaced ? replacedNote('reminders') : ''];
    return notes.filter(Boolean).join(' ') || null;
  }

  private loadConfig(): HeartbeatConfig {
    const file = readStored(this.configPath, 'config', isObject);
    if (file.note) this.log(file.note);
    this.configUnsaveable = unsaveable(file);
    this.configNotLoaded = file.unused;
    this.configReplaced = file.replaced;
    if (file.value === undefined) return { ...DEFAULT_CONFIG };
    const merged = { ...DEFAULT_CONFIG, ...(file.value as object) } as HeartbeatConfig;
    if (merged.deliveryMode !== 'message' && merged.deliveryMode !== 'silent') merged.deliveryMode = 'message';
    const stored: unknown = merged.intervalSeconds;
    if (stored === null) {
      this.log(`config intervalSeconds is null, as earlier versions of heartbeat_configure saved an infinite interval; loading paused, at the default ${DEFAULT_CONFIG.intervalSeconds}s for when it's resumed`);
      merged.intervalSeconds = DEFAULT_CONFIG.intervalSeconds;
      merged.paused = true;
    } else if (typeof stored !== 'number' || !Number.isFinite(stored)) {
      this.log(`config intervalSeconds ${JSON.stringify(stored)} is not a number of seconds; using the default, ${DEFAULT_CONFIG.intervalSeconds}s`);
      merged.intervalSeconds = DEFAULT_CONFIG.intervalSeconds;
    } else if (stored < 60) {
      this.log(`config intervalSeconds ${stored} is under the 60-second floor; using 60s`);
      merged.intervalSeconds = 60;
    } else if (!canHoldTime(Date.now() + stored * 1000)) {
      this.log(`config intervalSeconds ${stored} puts the next heartbeat past ${LAST_REMINDER_TIME}; loading paused, at the default ${DEFAULT_CONFIG.intervalSeconds}s for when it's resumed`);
      merged.intervalSeconds = DEFAULT_CONFIG.intervalSeconds;
      merged.paused = true;
    }
    return merged;
  }
  private saveConfig(c: HeartbeatConfig): string | null {
    if (this.configUnsaveable) return unsavedNote('config', this.configUnsaveable);
    try {
      writeFileSync(this.configPath, JSON.stringify(c, null, 2));
      return null;
    } catch (e) {
      this.log('config write failed:', (e as Error).message);
      return failedSaveNote('config');
    }
  }

  private loadReminders(): Reminder[] {
    const file = readStored(this.remindersPath, 'reminders', Array.isArray);
    if (file.note) this.log(file.note);
    this.remindersUnsaveable = unsaveable(file);
    this.remindersNotLoaded = file.unused ? 'all' : null;
    this.remindersReplaced = file.replaced;
    if (!Array.isArray(file.value) || !file.bytes) return [];
    const parsed: unknown[] = file.value;
    const rows = parsed.filter((x): x is StoredReminder => {
      if (isStoredReminder(x)) return true;
      this.log(`dropped reminder ${JSON.stringify(x)}: it isn't a reminder this server writes`);
      return false;
    });
    // Formatting a time outside a Date's range throws, so such a row can't be listed.
    const holdable = rows.filter((r): r is Reminder => {
      if (r.fireAt !== null && canHoldTime(r.fireAt)) return true;
      this.log(`dropped reminder ${JSON.stringify(r)}: its stored time is outside the times a reminder can hold, `
        + `${FIRST_REMINDER_TIME} to ${LAST_REMINDER_TIME}`);
      return false;
    });
    if (holdable.length < parsed.length) {
      const kept = keepAside(this.remindersPath, 'reminders', file.bytes, "holds rows this server can't load", 'starting with the rest');
      this.log(kept.note);
      this.remindersUnsaveable = kept.unsaveable ? 'uncopied' : null;
      this.remindersNotLoaded = holdable.length === 0 ? 'all' : 'some';
    }
    return holdable.map((r) => {
      if (r.everySeconds === null || r.everySeconds >= MIN_REMINDER_SECONDS) return r;
      if (r.everySeconds <= 0) {
        this.log(`reminder ${r.id}: stored interval ${r.everySeconds}s is no interval; it fires once`);
        return { ...r, everySeconds: null };
      }
      this.log(`reminder ${r.id}: stored interval ${r.everySeconds}s is under the ${MIN_REMINDER_SECONDS}-second floor; using ${MIN_REMINDER_SECONDS}s`);
      return { ...r, everySeconds: MIN_REMINDER_SECONDS };
    });
  }
  private saveReminders(reminders: Reminder[]): string | null {
    if (this.remindersUnsaveable) return unsavedNote('reminders', this.remindersUnsaveable);
    try {
      writeFileSync(this.remindersPath, JSON.stringify(reminders, null, 2));
      return null;
    } catch (e) {
      this.log('reminders write failed:', (e as Error).message);
      return failedSaveNote('reminders');
    }
  }

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    conn.on('error', (e: Error) => this.log('connection error:', e.message));
    await this.handleInitialize();
    this.reschedule();
    this.scheduleReminders();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') this.log('connection error:', e);
    }
    this.cancelHeartbeat?.();
    this.cancelReminderWake?.();
    this.conn = null;
  }

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { this.log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: McplServerCapabilities05 = { version: '0.5', pushEvents: true, featureSets };
    const capabilities: InitializeCapabilities05 = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult05 = { protocolVersion: '2024-11-05', capabilities, serverInfo: { name: 'heartbeat-mcpl', version: SERVER_VERSION } };
    conn.sendResponse(msg.request.id, result);
    this.log('initialize answered' + (this.mcplEnabled ? ' (MCPL mode; awaiting featureSets/update policy)' : ' (MCP mode; push events unavailable)'));
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': conn.sendResponse(req.id, { tools: this.toolDefinitions }); break;
        case 'tools/call': conn.sendResponse(req.id, this.handleToolCall(params.name, params.arguments ?? {})); break;
        case method.FEATURE_SETS_UPDATE: this.handleFeatureSetsUpdateRequest(req); break;
        // SPEC §6.6: a method that will never be answered MUST return an error.
        default: conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      const tool = req.method === 'tools/call';
      conn.sendError(req.id, -32000, tool ? toolThrew(params.name, e) : describeThrown(e));
      this.log(`${tool && typeof params.name === 'string' ? params.name : req.method} threw: ${thrownForLog(e)}`);
    }
  }

  private handleNotification(notif: NotifMsg): void {
    switch (notif.method) {
      case 'notifications/initialized':
        this.log('initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
        break;
      case method.FEATURE_SETS_UPDATE:
        this.handleFeatureSetsUpdateNotification(notif);
        break;
      default:
        this.log(`ignored notification: ${notif.method}`);
    }
  }

  /** SPEC §6.7: a server MUST immediately respect a reduction, so the grant is installed before
   *  the receipt goes out. */
  private handleFeatureSetsUpdateRequest(req: ReqMsg): void {
    const conn = this.conn!;
    const parsed = parsePolicy(req.params);
    this.requestSeen = true;
    this.notificationOnly = false;
    if (!parsed.ok) {
      // SPEC §5.4: a malformed policy message fails closed.
      this.grant = EMPTY_GRANT;
      this.policyReady = false;
      this.log(`featureSets/update rejected as malformed: ${parsed.error}; grant cleared`);
      conn.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      this.retryRefused();
      return;
    }
    this.grant = parsed.grant;
    this.policyReady = true;
    const receipt = buildReceipt(declaredFeatureSets, this.grant);
    this.log(`featureSets/update applied (Request): grant=[${this.grant.patterns.join(', ')}] mode=${receipt.mode}`);
    if (!parsed.hadEffectiveCapabilities) {
      this.log('featureSets/update carried no effectiveCapabilities; per §5.4 absence is denial, so nothing is granted');
    }
    if (this.grant.denied.length > 0) {
      this.log(`host reported deniedCapabilities (diagnostic only): [${this.grant.denied.join(', ')}]`);
    }
    for (const note of receipt.notes ?? []) this.log(`receipt note: ${note}`);
    conn.sendResponse(req.id, receipt);
    this.retryRefused();
  }

  private handleFeatureSetsUpdateNotification(notif: NotifMsg): void {
    const parsed = parsePolicy(notif.params);
    if (!parsed.ok) {
      this.log(`featureSets/update (Notification) malformed: ${parsed.error}; ignored, grant unchanged`);
      return;
    }
    this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
    this.log(`featureSets/update (Notification) applied as reduction only: grant=[${this.grant.patterns.join(', ')}]`
      + (this.policyReady ? '' : '; ready state NOT established — §6.7 requires a Request'));
    if (!this.requestSeen) this.notificationOnly = true;
    this.retryRefused();
    if (this.notificationOnly) {
      this.log('WARNING: initial policy has still not arrived as a Request. Per SPEC §5.3 every '
        + 'capability-dependent behavior stays unavailable, so NO heartbeat or reminder will be '
        + 'delivered on this connection. The host must send featureSets/update as a Request '
        + 'carrying effectiveCapabilities (including "pushEvents").');
    }
  }

  private featureSetState(): FeatureSetState {
    return deriveFeatureSetState(FS_NAME, featureSetDecl, this.grant);
  }

  private pushBlocked(): WakeBlocked | null {
    // mcpl-core rejects a push still out when the connection closes. Whether that answer
    // settles before or after serve ends rests on promise steps in mcpl-core as well as here, so
    // both are checked before a push is sent or a reminder's wake armed.
    if (!this.conn || this.conn.isClosed) return HOST_GONE;
    return wakeBlocked(this.mcplEnabled, this.notificationOnly, this.policyReady, () => this.featureSetState(), FS_NAME);
  }

  private text(t: string, isError?: boolean): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    return { content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) };
  }

  private statusText(): string {
    const c = this.config;
    const remaining = this.nextFireAt ? Math.max(0, Math.round((this.nextFireAt - Date.now()) / 1000)) : null;
    const blocked = this.pushBlocked();
    const mode = c.deliveryMode === 'silent' && this.silentFellBack
      ? 'silent (the host refused a silent wake, which carries no text, so heartbeats arrive as messages. '
        + "Setting deliveryMode again won't change that; ask whoever runs this host if you need them silent)"
      : c.deliveryMode;
    return `Heartbeat ${c.paused ? 'PAUSED' : 'ACTIVE'} | mode=${mode} | interval=${c.intervalSeconds}s (${(c.intervalSeconds / 3600).toFixed(2)}h)` +
      (c.paused || remaining === null || blocked ? '' : ` | next in ~${remaining}s`) +
      ` | reminders=${this.reminders.length}` +
      ` | delivery=${blocked ? `BLOCKED (${blocked.reason})` : 'ok'}` +
      ` | message="${c.message}"` +
      [this.configNote(), this.remindersNote()].map((note) => (note ? `\n${note}` : '')).join('');
  }

  private handleToolCall(name: unknown, rawArgs: unknown) {
    const tool = this.toolDefinitions.find((t) => t.name === name);
    if (!tool) return this.text(noSuchTool(name, this.toolDefinitions.map((t) => t.name)), true);
    const { problems, ignored } = checkArguments(tool, rawArgs, this.toolDefinitions);
    const args = (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
    const result = this.callTool(tool.name, args, problems);
    if (ignored.length > 0) result.content[0].text += ` ${ignoredNote(tool, ignored, result.isError === true)}`;
    return result;
  }

  private callTool(name: string, args: Record<string, unknown>, problems: string[]) {
    switch (name) {
      case 'heartbeat_configure': return this.configure(args, problems);
      case 'reminder_add': return this.addReminder(args, problems);
      case 'reminder_cancel': return this.cancelReminder(args, problems);
    }
    if (problems.length > 0) return this.refuse(name, problems);
    switch (name) {
      case 'heartbeat_trigger': {
        const blocked = this.pushBlocked();
        this.fire('manual');
        if (!blocked) return this.text(`Heartbeat fired. ${this.statusText()}`);
        return this.text(`heartbeat_trigger: ${REFUSED.heartbeat_trigger}, because ${blocked.reason}. ${blocked.remedy} `
          + this.statusText(), true);
      }
      case 'reminder_list':
        return this.text(this.listRemindersText());
      default:
        return this.text(this.statusText());
    }
  }

  private refuse(tool: string, problems: readonly string[]) {
    return this.text(`${tool}: ${REFUSED[tool]}. ${problems.join(' ')}`, true);
  }

  private configure(args: Record<string, unknown>, problems: string[]) {
    const interval = addUnits(args, INTERVAL_UNITS, problems);
    if (interval && !canHoldTime(Date.now() + interval.seconds * 1000)) {
      problems.push(`${givenText(interval, ['puts', 'put'])} the next heartbeat past ${LAST_REMINDER_TIME}, the last time it can be set for; `
        + 'give a shorter interval, or leave the interval out and pause the heartbeat with "paused": true.');
    } else if (interval && interval.seconds < MIN_HEARTBEAT_SECONDS) {
      problems.push(`${givenText(interval)} ${interval.seconds} s, under the heartbeat's ${MIN_HEARTBEAT_SECONDS}-second floor; `
        + `give ${MIN_HEARTBEAT_SECONDS} seconds or more, or leave the interval out and pause the heartbeat with "paused": true.`);
    }
    if (typeof args.message === 'string' && !args.message.trim()) {
      problems.push('"message" is blank; give the text each heartbeat should bring, or leave it out to keep the one it has.');
    }
    if (problems.length > 0) return this.refuse('heartbeat_configure', problems);
    const c = this.config;
    let changed = false;
    if (interval) { c.intervalSeconds = interval.seconds; changed = true; }
    if (typeof args.paused === 'boolean') { c.paused = args.paused; changed = true; }
    if (args.deliveryMode === 'message' || args.deliveryMode === 'silent') { c.deliveryMode = args.deliveryMode; changed = true; }
    if (typeof args.message === 'string') { c.message = args.message; changed = true; }
    const unsaved = changed ? this.saveConfig(c) : null;
    if (changed) this.reschedule();
    return this.text((changed ? 'Updated. ' : 'No changes. ') + (unsaved ? `${unsaved} ` : '') + this.statusText());
  }

  private reschedule(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    if (this.config.paused) { this.nextFireAt = 0; this.log('paused; no next fire scheduled'); return; }
    this.nextFireAt = Date.now() + this.config.intervalSeconds * 1000;
    this.cancelHeartbeat = callAt(this.nextFireAt, () => { this.fire('schedule'); this.reschedule(); });
    this.log(`next heartbeat in ${this.config.intervalSeconds}s`);
  }

  private fire(reason: string): void {
    if (this.config.paused && reason === 'schedule') return;
    const now = formatAgentDateTime(new Date(), this.timeZone);
    const text = `[current time: ${now}] ${this.config.message}`;
    const silent = this.config.deliveryMode === 'silent';
    const sent = silent
      ? this.emitSilentHeartbeat(reason, now, text)
      : this.emitPush(text, { source: 'heartbeat', reason }, 'heartbeat');
    this.log(`${sent ? 'fired' : 'DROPPED'} heartbeat (${reason}${silent ? ', silent' : ''})`);
  }

  private emitSilentHeartbeat(reason: string, now: string, text: string): boolean {
    const conn = this.conn;
    if (!conn) return false;
    const blocked = this.pushBlocked();
    if (blocked) { this.log(`suppressed heartbeat push/event — ${blocked.log}`); return false; }
    sendSilentWithFallback(
      (params) => conn.sendRequest(method.PUSH_EVENT, params),
      this.pushParams('heartbeat', { source: 'heartbeat', reason, silent: true, scheduledAt: now }, []),
      () => this.pushParams('heartbeat', { source: 'heartbeat', reason, silentFallback: true }, [{ type: 'text', text }]),
    )
      .then((outcome) => {
        this.silentFellBack = outcome.delivered === 'message';
        if (outcome.delivered === 'message' && !this.silentFallbackExplained) {
          this.silentFallbackExplained = true;
          this.log(`WARNING: the host refused the silent heartbeat as an empty push (${outcome.rejection}). `
            + 'Silent ticks are being delivered in message mode instead. Silent mode needs agent-framework >= 0.20.0 '
            + 'with this server configured under the id "heartbeat" (see README). Logged once per process.');
        }
        this.logPushResult(outcome.result, 'heartbeat');
      })
      .catch((e) => this.log('push failed (heartbeat):', (e as Error).message));
    return true;
  }

  private pushParams(kind: string, origin: Record<string, unknown>, content: Array<{ type: 'text'; text: string }>): PushEventParams {
    return {
      featureSet: FS_NAME,
      eventId: `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      origin,
      payload: { content },
    };
  }

  private logPushResult(r: unknown, kind: string): void {
    // SPEC §6.6: a rejection is diagnostics, not authorization, so it changes no grant.
    const accepted = (r as { accepted?: unknown } | null)?.accepted;
    if (accepted === false) this.log(`push/event NOT accepted (${kind}):`, JSON.stringify(r));
    else this.log('push response:', JSON.stringify(r));
  }

  private emitPush(text: string, origin: Record<string, unknown>, kind: string, onSettled?: (refusal: string | null) => void): boolean {
    const conn = this.conn;
    if (!conn) return false;
    const blocked = this.pushBlocked();
    if (blocked) { this.log(`suppressed ${kind} push/event — ${blocked.log}`); return false; }
    void sendPush(conn, this.pushParams(kind, origin, [{ type: 'text', text }])).then((outcome) => {
      if ('error' in outcome) this.log(`push failed (${kind}):`, outcome.error.message);
      else this.logPushResult(outcome.result, kind);
      onSettled?.(outcome.refusal);
    }).catch((e) => this.log(`handling the host's answer to a ${kind} push failed:`, e));
    return true;
  }

  private addReminder(args: Record<string, unknown>, problems: string[]) {
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (typeof args.message === 'string' && !message) problems.push('"message" is blank; give the text to deliver when it fires.');
    const delay = addUnits(args, DELAY_UNITS, problems);
    const every = addUnits(args, EVERY_UNITS, problems);
    const delayNames = DELAY_UNITS.map(([name]) => name).filter((name) => Object.hasOwn(args, name));
    const atGiven = Object.hasOwn(args, 'atIso');
    if (every && every.seconds < MIN_REMINDER_SECONDS) {
      problems.push(`${givenText(every)} ${every.seconds} s, under the ${MIN_REMINDER_SECONDS}-second floor for a repeating reminder; `
        + `give ${MIN_REMINDER_SECONDS} seconds or more, or leave the interval out and give a delay or atIso for a one-off.`);
    }
    if (atGiven && delayNames.length > 0) problems.push(`"atIso" and ${andList(delayNames)} both set when it first fires; give one of them.`);
    const timeGiven = delayNames.length > 0 || atGiven || EVERY_UNITS.some(([name]) => Object.hasOwn(args, name));
    if (!timeGiven) {
      problems.push('No time was given: give a delay in inSeconds, inMinutes or inHours, a time in atIso, '
        + 'or an interval to repeat in everySeconds, everyMinutes or everyHours.');
    }
    let at: number | null = null;
    if (typeof args.atIso === 'string') {
      try {
        at = parseReminderTime(args.atIso, this.timeZone);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }

    const now = Date.now();
    const first = delayNames.length > 0 ? (delay ? now + delay.seconds * 1000 : null)
      : atGiven ? at
      : every ? now + every.seconds * 1000 : null;
    const pastTheLastTime = (length: Length, which: string, remedy: string) =>
      `${givenText(length, ['puts', 'put'])} ${which} past ${LAST_REMINDER_TIME}, the last time a reminder can hold. ${remedy}`;
    if (first !== null && !canHoldTime(first)) {
      problems.push(delay
        ? pastTheLastTime(delay, every ? 'its first fire' : 'it', 'Give a shorter delay, or an atIso before then.')
        : pastTheLastTime(every!, 'its first fire', 'Give a shorter interval.'));
    } else if (first !== null && every && !canHoldTime(first + every.seconds * 1000)) {
      problems.push(pastTheLastTime(every, 'its second fire', 'Give a shorter interval.'));
    }
    if (problems.length > 0 || first === null) return this.refuse('reminder_add', problems);

    const rem: Reminder = {
      id: `rem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message,
      createdAt: now,
      fireAt: first,
      everySeconds: every?.seconds ?? null,
    };
    this.reminders.push(rem);
    const unsaved = this.saveReminders(this.reminders);
    this.retryRefused();
    this.log(`added reminder ${rem.id} fireAt=${new Date(first).toISOString()} every=${rem.everySeconds ?? 'once'}`);
    const blocked = this.pushBlocked();
    const notes = [blocked ? heldNote(blocked, true) : null, unsaved]
      .filter((note): note is string => note !== null);
    return this.text(`Reminder ${rem.id} set: ${this.describeReminder(rem, now)}${notes.length > 0 ? `. ${notes.join(' ')}` : ''}`);
  }

  private describeReminder(rem: Reminder, now: number): string {
    let when = this.inFlight.has(rem.id) ? "sent, waiting for the host's answer"
      : rem.fireAt <= now ? 'overdue' : `~${Math.round((rem.fireAt - now) / 1000)}s`;
    const refused = this.refused.get(rem.id);
    if (refused) when += `; at ${formatAgentDateTime(refused.at, this.timeZone)}, ${refused.reason}`;
    const rec = rem.everySeconds !== null ? `repeats every ${rem.everySeconds}s` : 'one-shot';
    return `due ${formatAgentDateTime(rem.fireAt, this.timeZone)} (${when}) | ${rec} | "${rem.message}"`;
  }

  private listRemindersText(): string {
    const note = this.remindersNote();
    if (this.reminders.length === 0) return note ? `No reminders held here.\n${note}` : 'No reminders set.';
    const now = Date.now();
    const lines = [...this.reminders]
      .sort((a, b) => a.fireAt - b.fireAt)
      .map((r) => `${r.id} | ${this.describeReminder(r, now)}`);
    const blocked = this.pushBlocked();
    const waiting = blocked ? `\n${heldNote(blocked, false)}` : '';
    const refused = this.reminders.some((r) => this.refused.has(r.id))
      ? '\nA reminder whose push was refused or failed is tried again when the host next updates its settings, when a reminder is added or cancelled, or when the server restarts, and a recurring one also an interval after it was refused or failed.'
      : '';
    return `${this.reminders.length} reminder(s):\n${lines.join('\n')}${waiting}${refused}${note ? `\n${note}` : ''}`;
  }

  private cancelReminder(args: Record<string, unknown>, problems: string[]) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (typeof args.id === 'string' && !id.trim()) problems.push('"id" is blank; give the reminder\'s id, as reminder_list shows it.');
    if (problems.length > 0) return this.refuse('reminder_cancel', problems);
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => r.id !== id);
    const note = this.remindersNote();
    const held = this.remindersNotLoaded ? ' held here' : '';
    if (this.reminders.length === before) {
      return this.refuse('reminder_cancel', [`No reminder${held} has the id "${id}". If it was a one-off that has fired, `
        + `or it was cancelled already, there's nothing more to do. Otherwise, reminder_list shows the pending ids${held}.`
        + (note ? ` ${note}` : '')]);
    }
    const unsaved = this.saveReminders(this.reminders);
    this.retryRefused();
    this.log(`cancelled reminder ${id}`);
    return this.text(`Cancelled ${id}. ${this.reminders.length} reminder(s) remain.${unsaved ? ` ${unsaved}` : ''}${note ? ` ${note}` : ''}`);
  }

  private scheduleReminders(): void {
    this.cancelReminderWake?.();
    this.cancelReminderWake = null;
    if (this.reminders.length === 0) return;
    const blocked = this.pushBlocked();
    if (blocked !== null) {
      this.log(`none of the ${this.reminders.length} reminder(s) `
        + `${blocked.final ? 'will fire on this host' : 'fires until a wake can be delivered'}: ${blocked.log}`);
      return;
    }
    const due = this.reminders.map((r) => this.dueAt(r)).filter((t): t is number => t !== null);
    if (due.length === 0) return;
    this.cancelReminderWake = callAt(Math.min(...due), () => this.processDueReminders());
  }

  private retryRefused(): void {
    this.refused.clear();
    this.scheduleReminders();
  }

  private dueAt(rem: Reminder): number | null {
    if (this.inFlight.has(rem.id)) return null;
    const refused = this.refused.get(rem.id);
    if (!refused) return rem.fireAt;
    return rem.everySeconds === null ? null : refused.at + rem.everySeconds * 1000;
  }

  private processDueReminders(): void {
    const now = Date.now();
    for (const rem of this.reminders.filter((r) => (this.dueAt(r) ?? Infinity) <= now)) this.fireReminder(rem);
    this.scheduleReminders();
  }

  private fireReminder(rem: Reminder): void {
    const sent = this.emitPush(
      formatReminderText(rem, new Date(), this.timeZone),
      { source: 'reminder', reminderId: rem.id, recurring: rem.everySeconds !== null },
      'reminder',
      (refusal) => this.settleReminder(rem.id, refusal),
    );
    const kind = rem.everySeconds !== null ? 'recurring' : 'one-shot';
    if (sent) {
      this.refused.delete(rem.id);
      this.inFlight.add(rem.id);
      this.log(`fired reminder ${rem.id} (${kind})`);
    } else {
      this.log(`reminder ${rem.id} (${kind}) not sent; it stays due`);
    }
  }

  private settleReminder(id: string, refusal: string | null): void {
    this.inFlight.delete(id);
    const i = this.reminders.findIndex((r) => r.id === id);
    if (i === -1) return;
    const rem = this.reminders[i]!;
    if (refusal !== null) {
      this.refused.set(id, { at: Date.now(), reason: refusal });
      this.log(`reminder ${id}: ${refusal}; holding it until the next policy update, add, cancel or restart`
        + (rem.everySeconds === null ? '' : `, or for its interval, ${rem.everySeconds}s`));
    } else {
      if (rem.everySeconds === null) {
        this.reminders.splice(i, 1);
      } else {
        const now = Date.now();
        let next = rem.fireAt + rem.everySeconds * 1000;
        if (next <= now) next = now + rem.everySeconds * 1000;
        if (canHoldTime(next)) this.reminders[i] = { ...rem, fireAt: next };
        else {
          this.reminders.splice(i, 1);
          this.log(`ended recurring reminder ${JSON.stringify(rem)}: its next time, ${next}, is past ${LAST_REMINDER_TIME}, `
            + 'the last time a reminder can hold');
        }
      }
      this.saveReminders(this.reminders);
    }
    this.scheduleReminders();
  }
}
