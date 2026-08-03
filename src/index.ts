#!/usr/bin/env node
/**
 * heartbeat-mcpl — periodic self-wake + reminder scheduler MCPL server.
 *
 * Two independent wake sources, both delivered as push/event on the same
 * `heartbeat` feature set:
 *   1. The ambient heartbeat — one global periodic wake (intervalSeconds,
 *      paused, message), configured via heartbeat_* tools. Unchanged.
 *   2. Reminders — any number of one-shot or recurring wakes, each with its own
 *      message, added/listed/cancelled via reminder_* tools. Persisted so they
 *      survive a server restart.
 *
 * Ambient config persists to $HEARTBEAT_CONFIG_FILE (default
 * ./heartbeat-config.json); reminders to $HEARTBEAT_REMINDERS_FILE (default
 * ./heartbeat-reminders.json).
 *
 * Usage: heartbeat-mcpl --stdio
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type {
  McplInitializeParams, PushEventParams, JsonRpcId,
} from '@animalabs/mcpl-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { formatAgentDateTime, resolveAgentTimeZone } from './timezone.js';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy,
} from './mcpl05.js';
import type {
  FeatureSetDeclaration05, FeatureSetMap, FeatureSetState, FeatureSetWireEntry,
  Grant, InitializeCapabilities05, McplInitializeResult05, McplServerCapabilities05,
} from './mcpl05.js';

const CONFIG_PATH = process.env.HEARTBEAT_CONFIG_FILE ?? './heartbeat-config.json';
const REMINDERS_PATH = process.env.HEARTBEAT_REMINDERS_FILE ?? './heartbeat-reminders.json';
const FS_NAME = 'heartbeat';
const AGENT_TIME_ZONE = resolveAgentTimeZone();
// setTimeout overflows past 2^31-1 ms (~24.8 days) and fires immediately; clamp
// long waits and re-check on wake so far-future reminders still fire on time.
const MAX_TIMEOUT_MS = 2_147_483_647;
// Floor on any reminder delay/interval — keeps a runaway "every 0s" from
// spamming the agent, while still allowing brisk test cadences.
const MIN_REMINDER_SECONDS = 5;

interface HeartbeatConfig { intervalSeconds: number; paused: boolean; message: string; }
const DEFAULT_CONFIG: HeartbeatConfig = {
  intervalSeconds: 4 * 60 * 60,
  paused: false,
  message: '[heartbeat] Periodic self-check-in. Review anything pending — reminders, schedules, follow-ups — and act if needed; otherwise a brief note to yourself is fine.',
};

/** A scheduled wake. `everySeconds === null` ⇒ one-shot (dropped after it fires);
 *  otherwise `fireAt` advances by the interval after each fire. */
interface Reminder {
  id: string;
  message: string;
  createdAt: number; // epoch ms
  fireAt: number;    // epoch ms — the next time this reminder is due
  everySeconds: number | null; // recurrence interval; null = one-shot
}

function log(...a: unknown[]): void { console.error('[heartbeat-mcpl]', ...a); }
function loadConfig(): HeartbeatConfig {
  try { if (existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch (e) { log('config read failed:', (e as Error).message); }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(c: HeartbeatConfig): void {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
  catch (e) { log('config write failed:', (e as Error).message); }
}

/** Structural guard so a corrupt/hand-edited reminders file can't crash the
 *  server or inject malformed entries — bad rows are dropped, good ones kept. */
function isReminder(x: unknown): x is Reminder {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === 'string'
    && typeof r.message === 'string'
    && typeof r.createdAt === 'number'
    && typeof r.fireAt === 'number'
    && (r.everySeconds === null || typeof r.everySeconds === 'number');
}
function loadReminders(): Reminder[] {
  try {
    if (existsSync(REMINDERS_PATH)) {
      const parsed = JSON.parse(readFileSync(REMINDERS_PATH, 'utf8')) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isReminder);
      log('reminders file is not an array; ignoring');
    }
  } catch (e) { log('reminders read failed:', (e as Error).message); }
  return [];
}
function saveReminders(reminders: Reminder[]): void {
  try { writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2)); }
  catch (e) { log('reminders write failed:', (e as Error).message); }
}

// `uses` must name every capability the feature set actually exercises (SPEC
// §6.2 vocabulary; §6.4 derivation). This set answers tools/call AND delivers
// every wake as push/event, so it needs both `tools` and `pushEvents` — the
// declaration previously said only `tools` while pushing. `hostState` was
// removed from the declaration in 0.4.1 and is gone; `rollback` survives (§8.1).
const featureSetDecl: FeatureSetDeclaration05 = {
  description: 'Periodic self-wake heartbeats, one-shot/recurring reminders, and schedule configuration',
  uses: ['tools', 'pushEvents'],
  rollback: false,
};
// The name-keyed view §6.4/§6.7 derive over — one feature set here.
const declaredFeatureSets: FeatureSetMap = { [FS_NAME]: featureSetDecl };
// On the wire, still the 0.4 array-of-{name, …} shape. §6.1 and App. B.2 say
// object-keyed-by-name, but mcpl-harness reads only the array
// (src/session.ts:493-497) and agent-framework accepts either
// (feature-set-manager.ts:154-161). See the note in mcpl05.ts — flipping this is
// an ecosystem migration (it also feeds the §17.2 digest), not a one-server edit.
const featureSets: FeatureSetWireEntry[] = [{ name: FS_NAME, ...featureSetDecl }];

const toolDefinitions = [
  { name: 'heartbeat_status', description: 'Show your current heartbeat schedule (interval, paused state, time to next wake, message) and how many reminders are pending.',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'heartbeat_configure',
    description: 'Change your own ambient heartbeat schedule. Provide any of: intervalSeconds | intervalMinutes | intervalHours, paused, message. Persists across restarts. (Reminders are separate — see reminder_add.)',
    inputSchema: { type: 'object' as const, properties: {
      intervalSeconds: { type: 'number', description: 'Wake interval in seconds (min 60).' },
      intervalMinutes: { type: 'number', description: 'Wake interval in minutes (alternative).' },
      intervalHours: { type: 'number', description: 'Wake interval in hours (alternative).' },
      paused: { type: 'boolean', description: 'Pause (true) or resume (false) heartbeats.' },
      message: { type: 'string', description: 'The text delivered to you on each heartbeat.' },
    } } },
  { name: 'heartbeat_trigger', description: 'Fire an ambient heartbeat immediately (does not change the schedule).',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'reminder_add',
    description: 'Schedule a reminder that wakes you with a specific message. One-shot: give a delay (inSeconds | inMinutes | inHours) OR an absolute time (atIso, an ISO-8601 timestamp). Recurring: give an interval (everySeconds | everyMinutes | everyHours) — the first fire is one interval out unless you also give a delay. Survives restarts. Returns the reminder id.',
    inputSchema: { type: 'object' as const, properties: {
      message: { type: 'string', description: 'The text delivered to you when the reminder fires.' },
      inSeconds: { type: 'number', description: 'One-shot: fire this many seconds from now.' },
      inMinutes: { type: 'number', description: 'One-shot: fire this many minutes from now.' },
      inHours: { type: 'number', description: 'One-shot: fire this many hours from now.' },
      atIso: { type: 'string', description: 'One-shot: fire at this absolute ISO-8601 time (e.g. 2026-07-01T09:00:00Z). Past times fire immediately.' },
      everySeconds: { type: 'number', description: 'Recurring: repeat every N seconds (min 5).' },
      everyMinutes: { type: 'number', description: 'Recurring: repeat every N minutes.' },
      everyHours: { type: 'number', description: 'Recurring: repeat every N hours.' },
    }, required: ['message'] } },
  { name: 'reminder_list', description: 'List your pending reminders (id, next fire time, recurrence, message).',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'reminder_cancel', description: 'Cancel a reminder by its id (from reminder_add / reminder_list).',
    inputSchema: { type: 'object' as const, properties: {
      id: { type: 'string', description: 'The reminder id to cancel.' },
    }, required: ['id'] } },
];

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown; }
interface NotifMsg { method: string; params?: unknown; }

class HeartbeatServer {
  private conn: McplConnection | null = null;
  private config = loadConfig();
  private reminders = loadReminders();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  private nextFireAt = 0;
  private mcplEnabled = false;
  /** The effective grant (§5.4). Empty until the host sends one — there is no
   *  server-side default, and nothing this server says can add to it. */
  private grant: Grant = EMPTY_GRANT;
  /** §5.3/§6.7: only a Request-form featureSets/update establishes ready state.
   *  Until then every capability-dependent behavior is unavailable. */
  private policyReady = false;

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    this.reschedule();
    this.scheduleReminders(); // reminders loaded from disk resume here (restart-survival)
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        // Notifications used to be discarded here before method lookup, which is
        // exactly how a featureSets/update Notification went missing (§6.7).
        if (msg.type === 'request') await this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') log('connection error:', e);
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.conn = null;
  }

  /** Consumes exactly the `initialize` request. `notifications/initialized` and
   *  anything the host sends next — including the initial policy of §5.3 — are
   *  left for the main loop rather than swallowed by a second blind read. */
  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    // §5.1: advertisement mirrors the capability paths, and `false` or absence
    // means none — so every path this server does not implement is simply
    // absent rather than spelled out as `false`. The old block also carried
    // `rollback`, which is not a §6.2 capability path at all: it is a
    // feature-set property (§8.1) and lives on the declaration.
    // `revision` (§17.2) is omitted: this manifest is fixed for the connection.
    const serverCaps: McplServerCapabilities05 = { version: '0.5', pushEvents: true, featureSets };
    const capabilities: InitializeCapabilities05 = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult05 = { protocolVersion: '2024-11-05', capabilities, serverInfo: { name: 'heartbeat-mcpl', version: '0.1.0' } };
    conn.sendResponse(msg.request.id, result);
    log('initialize answered' + (this.mcplEnabled ? ' (MCPL mode; awaiting featureSets/update policy)' : ' (MCP mode; push events unavailable)'));
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': conn.sendResponse(req.id, { tools: toolDefinitions }); break;
        case 'tools/call': conn.sendResponse(req.id, this.handleToolCall(params.name as string, (params.arguments ?? {}) as Record<string, unknown>)); break;
        case method.FEATURE_SETS_UPDATE: this.handleFeatureSetsUpdateRequest(req); break;
        // §6.6: a method that will never be answered MUST return an error, so
        // everything else — channels/* included, since no channel capability is
        // advertised or granted — falls through to -32601.
        default: conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      conn.sendError(req.id, -32000, (e as Error).message);
    }
  }

  private handleNotification(notif: NotifMsg): void {
    switch (notif.method) {
      case 'notifications/initialized':
        log('initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
        break;
      case method.FEATURE_SETS_UPDATE:
        this.handleFeatureSetsUpdateNotification(notif);
        break;
      default:
        log(`ignored notification: ${notif.method}`);
    }
  }

  // ── Negotiated policy (§5.3, §5.4, §6.7) ──

  /**
   * `featureSets/update` as a Request: apply the grant, then answer with a
   * degradation receipt.
   *
   * Ordering per §6.7 — the new grant is installed *before* the response goes
   * out, so a reduction takes effect atomically first and never waits on our
   * consent. The receipt that follows is testimony about consequences only; it
   * asks for nothing, and the host is barred from widening anything because of
   * it.
   */
  private handleFeatureSetsUpdateRequest(req: ReqMsg): void {
    const conn = this.conn!;
    const parsed = parsePolicy(req.params);
    if (!parsed.ok) {
      // §5.4: reject a malformed policy message, and hold no grant meanwhile.
      this.grant = EMPTY_GRANT;
      this.policyReady = false;
      log(`featureSets/update rejected as malformed: ${parsed.error}; grant cleared`);
      conn.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      return;
    }
    this.grant = parsed.grant;
    this.policyReady = true;
    const receipt = buildReceipt(declaredFeatureSets, this.grant);
    log(`featureSets/update applied (Request): grant=[${this.grant.patterns.join(', ')}] mode=${receipt.mode}`);
    if (!parsed.hadEffectiveCapabilities) {
      log('featureSets/update carried no effectiveCapabilities; per §5.4 absence is denial, so nothing is granted');
    }
    // §5.4: deniedCapabilities is diagnostic data only. It is logged so an
    // operator can see what the host withheld, and it takes part in no decision
    // above — the grant was computed from effectiveCapabilities alone.
    if (this.grant.denied.length > 0) {
      log(`host reported deniedCapabilities (diagnostic only): [${this.grant.denied.join(', ')}]`);
    }
    for (const note of receipt.notes ?? []) log(`receipt note: ${note}`);
    conn.sendResponse(req.id, receipt);
  }

  /**
   * `featureSets/update` as a Notification (§6.7): valid only for metadata that
   * does not alter the grant, and it cannot establish ready state. A host that
   * changes the grant this way is non-conforming, so the message is honoured in
   * the one direction that is always safe — narrowing. Every dimension can only
   * shrink, and nothing here flips `policyReady`.
   */
  private handleFeatureSetsUpdateNotification(notif: NotifMsg): void {
    const parsed = parsePolicy(notif.params);
    if (!parsed.ok) {
      log(`featureSets/update (Notification) malformed: ${parsed.error}; ignored, grant unchanged`);
      return;
    }
    this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
    log(`featureSets/update (Notification) applied as reduction only: grant=[${this.grant.patterns.join(', ')}]`
      + (this.policyReady ? '' : '; ready state NOT established — §6.7 requires a Request'));
    if (!this.policyReady) {
      // The one moment we can positively identify a pre-0.5 host: it is talking
      // policy, but in the form §6.7 says cannot establish ready state. Say so
      // once, in full, because the consequence is that no wake will ever be
      // delivered on this connection and the operator needs to know why.
      log('WARNING: initial policy has still not arrived as a Request. Per SPEC §5.3 every '
        + 'capability-dependent behavior stays unavailable, so NO heartbeat or reminder will be '
        + 'delivered on this connection. The host must send featureSets/update as a Request '
        + 'carrying effectiveCapabilities (including "pushEvents").');
    }
  }

  private featureSetState(): FeatureSetState {
    return deriveFeatureSetState(FS_NAME, featureSetDecl, this.grant);
  }

  /** Why a wake cannot be delivered right now, or null when it can. */
  private pushBlockedReason(): string | null {
    if (!this.mcplEnabled) return 'host is MCP-only (no experimental.mcpl); push events are not part of MCP (§3.2)';
    if (!this.policyReady) return 'no featureSets/update Request received yet; capability-dependent behavior is unavailable until initial policy completes (§5.3)';
    const state = this.featureSetState();
    if (state.active) return null;
    if (state.reason === 'capability_denied') return `capability not granted: ${state.missing.join(', ')} (§5.4 — absence is denial)`;
    return `feature set "${FS_NAME}" is ${state.reason}`;
  }

  private text(t: string, isError?: boolean): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    return { content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) };
  }

  private statusText(): string {
    const c = this.config;
    const remaining = this.nextFireAt ? Math.max(0, Math.round((this.nextFireAt - Date.now()) / 1000)) : null;
    const blocked = this.pushBlockedReason();
    return `Heartbeat ${c.paused ? 'PAUSED' : 'ACTIVE'} | interval=${c.intervalSeconds}s (${(c.intervalSeconds / 3600).toFixed(2)}h)` +
      (c.paused || remaining === null ? '' : ` | next in ~${remaining}s`) +
      ` | reminders=${this.reminders.length}` +
      // Surfaced to the agent deliberately: if wakes cannot be delivered, the
      // agent asking "when do I next wake?" should be told, not reassured.
      ` | delivery=${blocked ? `BLOCKED (${blocked})` : 'ok'}` +
      ` | message="${c.message}"`;
  }

  private handleToolCall(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'heartbeat_status':
        return this.text(this.statusText());
      case 'heartbeat_configure': {
        let changed = false;
        if (typeof args.intervalHours === 'number') { this.config.intervalSeconds = Math.max(60, Math.round(args.intervalHours * 3600)); changed = true; }
        if (typeof args.intervalMinutes === 'number') { this.config.intervalSeconds = Math.max(60, Math.round(args.intervalMinutes * 60)); changed = true; }
        if (typeof args.intervalSeconds === 'number') { this.config.intervalSeconds = Math.max(60, Math.round(args.intervalSeconds)); changed = true; }
        if (typeof args.paused === 'boolean') { this.config.paused = args.paused; changed = true; }
        if (typeof args.message === 'string' && args.message.trim()) { this.config.message = args.message; changed = true; }
        if (changed) { saveConfig(this.config); this.reschedule(); }
        return this.text((changed ? 'Updated. ' : 'No changes. ') + this.statusText());
      }
      case 'heartbeat_trigger': {
        const blocked = this.pushBlockedReason();
        this.fire('manual');
        return this.text((blocked ? `Heartbeat NOT delivered — ${blocked}. ` : 'Heartbeat fired. ') + this.statusText());
      }
      case 'reminder_add':
        return this.addReminder(args);
      case 'reminder_list':
        return this.text(this.listRemindersText());
      case 'reminder_cancel':
        return this.cancelReminder(args);
      default:
        return this.text(`Unknown tool: ${name}`, true);
    }
  }

  // ── Ambient heartbeat ──

  private reschedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.config.paused) { this.nextFireAt = 0; log('paused; no next fire scheduled'); return; }
    const ms = this.config.intervalSeconds * 1000;
    this.nextFireAt = Date.now() + ms;
    this.timer = setTimeout(() => { this.fire('schedule'); this.reschedule(); }, ms);
    log(`next heartbeat in ${this.config.intervalSeconds}s`);
  }

  private fire(reason: string): void {
    if (this.config.paused && reason === 'schedule') return;
    // Prefix the current time so each heartbeat is temporally anchored — without
    // it every heartbeat is byte-identical, giving the agent no sense of "when"
    // (and identical repeats invite confabulation/looping).
    const now = formatAgentDateTime(new Date(), AGENT_TIME_ZONE);
    const sent = this.emitPush(`[current time: ${now}] ${this.config.message}`, { source: 'heartbeat', reason }, 'heartbeat');
    log(`${sent ? 'fired' : 'DROPPED'} heartbeat (${reason})`);
  }

  /** Shared push/event emission for both heartbeats and reminders. Push events
   *  that arrive while the agent is mid-inference are buffered host-side by the
   *  agent-framework gate (bufferForInference), so no server-side buffering is
   *  needed here — we just emit and let the host deliver when idle.
   *
   *  Gated on the capability grant: `pushEvents` is what a wake costs, and until
   *  the host has granted it the wake is dropped with a logged reason rather
   *  than sent hopefully (§5.3, §5.4). Dropping is loud on purpose — a silent
   *  drop is the failure this whole migration is about.
   *
   *  Returns whether the event actually went out, so callers do not log "fired"
   *  over a wake that was suppressed. */
  private emitPush(text: string, origin: Record<string, unknown>, kind: string): boolean {
    const conn = this.conn;
    if (!conn) return false;
    const blocked = this.pushBlockedReason();
    if (blocked) { log(`suppressed ${kind} push/event — ${blocked}`); return false; }
    const params: PushEventParams = {
      featureSet: FS_NAME,
      eventId: `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      origin,
      payload: { content: [{ type: 'text', text }] },
    };
    conn.sendRequest(method.PUSH_EVENT, params)
      .then((r) => {
        // §9.3 result, or §6.6 rejection. Either is diagnostics: it is recorded
        // so a dropped wake is visible, and it changes no grant here — a
        // rejection never re-grants or re-negotiates anything (§6.6).
        const accepted = (r as { accepted?: unknown } | null)?.accepted;
        if (accepted === false) log(`push/event NOT accepted (${kind}):`, JSON.stringify(r));
        else log('push response:', JSON.stringify(r));
      })
      .catch((e) => log(`push failed (${kind}):`, (e as Error).message));
    return true;
  }

  // ── Reminders ──

  /** Parse a recurrence interval (everyHours|everyMinutes|everySeconds) to
   *  seconds, floored at MIN_REMINDER_SECONDS. Returns null if none supplied. */
  private parseEvery(args: Record<string, unknown>): number | null {
    let s: number | null = null;
    if (typeof args.everyHours === 'number') s = args.everyHours * 3600;
    if (typeof args.everyMinutes === 'number') s = args.everyMinutes * 60;
    if (typeof args.everySeconds === 'number') s = args.everySeconds;
    if (s === null) return null;
    if (!Number.isFinite(s) || s <= 0) return null;
    return Math.max(MIN_REMINDER_SECONDS, Math.round(s));
  }

  /** Parse a relative delay (inHours|inMinutes|inSeconds) to seconds, floored at
   *  MIN_REMINDER_SECONDS. Returns null if none supplied. */
  private parseDelay(args: Record<string, unknown>): number | null {
    let s: number | null = null;
    if (typeof args.inHours === 'number') s = args.inHours * 3600;
    if (typeof args.inMinutes === 'number') s = args.inMinutes * 60;
    if (typeof args.inSeconds === 'number') s = args.inSeconds;
    if (s === null) return null;
    if (!Number.isFinite(s) || s <= 0) return null;
    return Math.max(MIN_REMINDER_SECONDS, Math.round(s));
  }

  private addReminder(args: Record<string, unknown>) {
    const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : null;
    if (!message) return this.text('reminder_add requires a non-empty "message".', true);

    const now = Date.now();
    const everySeconds = this.parseEvery(args);
    const delay = this.parseDelay(args);
    let fireAt: number | null = null;

    if (everySeconds !== null) {
      // Recurring: first fire is `delay` out if given, else one interval out.
      fireAt = now + (delay ?? everySeconds) * 1000;
    } else if (delay !== null) {
      fireAt = now + delay * 1000;
    } else if (typeof args.atIso === 'string') {
      const t = Date.parse(args.atIso);
      if (Number.isNaN(t)) return this.text(`reminder_add: "atIso" is not a valid ISO-8601 timestamp: ${args.atIso}`, true);
      fireAt = t; // a past time is allowed — it fires on the next tick
    }

    if (fireAt === null) {
      return this.text(
        'reminder_add: specify WHEN — a one-shot delay (inSeconds/inMinutes/inHours) or absolute time (atIso), ' +
        'or a recurring interval (everySeconds/everyMinutes/everyHours).', true,
      );
    }

    const rem: Reminder = {
      id: `rem_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message,
      createdAt: now,
      fireAt,
      everySeconds,
    };
    this.reminders.push(rem);
    saveReminders(this.reminders);
    this.scheduleReminders();
    log(`added reminder ${rem.id} fireAt=${new Date(fireAt).toISOString()} every=${everySeconds ?? 'once'}`);
    return this.text(`Reminder ${rem.id} set: ${this.describeReminder(rem, now)}`);
  }

  private describeReminder(rem: Reminder, now: number): string {
    const inS = Math.max(0, Math.round((rem.fireAt - now) / 1000));
    const rec = rem.everySeconds !== null ? `repeats every ${rem.everySeconds}s` : 'one-shot';
    return `next ${formatAgentDateTime(rem.fireAt, AGENT_TIME_ZONE)} (~${inS}s) | ${rec} | "${rem.message}"`;
  }

  private listRemindersText(): string {
    if (this.reminders.length === 0) return 'No reminders set.';
    const now = Date.now();
    const lines = [...this.reminders]
      .sort((a, b) => a.fireAt - b.fireAt)
      .map((r) => `${r.id} | ${this.describeReminder(r, now)}`);
    return `${this.reminders.length} reminder(s):\n${lines.join('\n')}`;
  }

  private cancelReminder(args: Record<string, unknown>) {
    const id = typeof args.id === 'string' ? args.id : null;
    if (!id) return this.text('reminder_cancel requires an "id".', true);
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => r.id !== id);
    if (this.reminders.length === before) return this.text(`No reminder with id ${id}.`);
    saveReminders(this.reminders);
    this.scheduleReminders();
    log(`cancelled reminder ${id}`);
    return this.text(`Cancelled ${id}. ${this.reminders.length} reminder(s) remain.`);
  }

  /** (Re)arm a single timer for the earliest due reminder. One timer covers all
   *  reminders; it re-arms after each fire. Clamped to MAX_TIMEOUT_MS so a
   *  far-future reminder doesn't overflow setTimeout (it just wakes to re-check). */
  private scheduleReminders(): void {
    if (this.reminderTimer) { clearTimeout(this.reminderTimer); this.reminderTimer = null; }
    if (this.reminders.length === 0) return;
    const now = Date.now();
    const soonest = Math.min(...this.reminders.map((r) => r.fireAt));
    const delay = Math.max(0, Math.min(soonest - now, MAX_TIMEOUT_MS));
    this.reminderTimer = setTimeout(() => this.processDueReminders(), delay);
  }

  /** Fire every reminder that is due, drop one-shots, advance recurring ones to
   *  their next future slot, persist, then re-arm the timer. */
  private processDueReminders(): void {
    const now = Date.now();
    const kept: Reminder[] = [];
    let firedAny = false;
    for (const rem of this.reminders) {
      if (rem.fireAt > now) { kept.push(rem); continue; }
      this.fireReminder(rem);
      firedAny = true;
      if (rem.everySeconds !== null) {
        // Advance to the next future slot. If we were behind (e.g. server was
        // down through several intervals), skip ahead rather than firing a burst.
        let next = rem.fireAt + rem.everySeconds * 1000;
        if (next <= now) next = now + rem.everySeconds * 1000;
        kept.push({ ...rem, fireAt: next });
      }
      // one-shot: not kept → removed
    }
    this.reminders = kept;
    if (firedAny) saveReminders(this.reminders);
    this.scheduleReminders();
  }

  private fireReminder(rem: Reminder): void {
    const sent = this.emitPush(
      rem.message,
      { source: 'reminder', reminderId: rem.id, recurring: rem.everySeconds !== null },
      'reminder',
    );
    log(`${sent ? 'fired' : 'DROPPED'} reminder ${rem.id} (${rem.everySeconds !== null ? 'recurring' : 'one-shot'})`);
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) { console.error('Usage: heartbeat-mcpl --stdio'); process.exit(1); }
  log('starting on stdio; config=' + CONFIG_PATH + ' reminders=' + REMINDERS_PATH);
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await new HeartbeatServer().serve(conn);
}
main().catch((e) => { console.error('[heartbeat-mcpl] fatal:', e); process.exit(1); });
