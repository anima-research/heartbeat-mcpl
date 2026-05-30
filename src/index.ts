#!/usr/bin/env node
/**
 * heartbeat-mcpl — periodic self-wake MCPL server for Connectome agents.
 *
 * Emits push/event on a configurable interval to wake the agent, and exposes
 * MCP tools so the agent can configure its OWN schedule. Config persists to
 * $HEARTBEAT_CONFIG_FILE (default ./heartbeat-config.json).
 *
 * Usage: heartbeat-mcpl --stdio
 */
import { McplConnection, method } from '@connectome/mcpl-core';
import type {
  FeatureSetDeclaration, McplCapabilities, McplInitializeParams,
  McplInitializeResult, InitializeCapabilities, PushEventParams, JsonRpcId,
} from '@connectome/mcpl-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG_PATH = process.env.HEARTBEAT_CONFIG_FILE ?? './heartbeat-config.json';
const FS_NAME = 'heartbeat';

interface HeartbeatConfig { intervalSeconds: number; paused: boolean; message: string; }
const DEFAULT_CONFIG: HeartbeatConfig = {
  intervalSeconds: 4 * 60 * 60,
  paused: false,
  message: '[heartbeat] Periodic self-check-in. Review anything pending — reminders, schedules, follow-ups — and act if needed; otherwise a brief note to yourself is fine.',
};

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

const featureSetDecl: FeatureSetDeclaration = {
  name: FS_NAME,
  description: 'Periodic self-wake heartbeats and schedule configuration',
  uses: ['tools'],
  rollback: false,
  hostState: false,
};
// The host (agent-framework initializeServer) consumes capabilities.featureSets as a
// NAME-KEYED RECORD (declared[name], Object.keys, wildcard resolution) even though the
// mcpl-core type annotates it as an array. Send a record so enabledFeatureSets
// (["heartbeat"]) actually enables this set; an array keys by index ("0"), leaving the
// set disabled and every push/event rejected as "Feature set not enabled".
const featureSets = { [FS_NAME]: featureSetDecl } as unknown as FeatureSetDeclaration[];

const toolDefinitions = [
  { name: 'heartbeat_status', description: 'Show your current heartbeat schedule (interval, paused state, time to next wake, message).',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'heartbeat_configure',
    description: 'Change your own heartbeat schedule. Provide any of: intervalSeconds | intervalMinutes | intervalHours, paused, message. Persists across restarts.',
    inputSchema: { type: 'object' as const, properties: {
      intervalSeconds: { type: 'number', description: 'Wake interval in seconds (min 60).' },
      intervalMinutes: { type: 'number', description: 'Wake interval in minutes (alternative).' },
      intervalHours: { type: 'number', description: 'Wake interval in hours (alternative).' },
      paused: { type: 'boolean', description: 'Pause (true) or resume (false) heartbeats.' },
      message: { type: 'string', description: 'The text delivered to you on each heartbeat.' },
    } } },
  { name: 'heartbeat_trigger', description: 'Fire a heartbeat immediately (does not change the schedule).',
    inputSchema: { type: 'object' as const, properties: {} } },
];

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown; }

class HeartbeatServer {
  private conn: McplConnection | null = null;
  private config = loadConfig();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextFireAt = 0;
  private mcplEnabled = false;

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    this.reschedule();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request as ReqMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') log('connection error:', e);
    }
    if (this.timer) clearTimeout(this.timer);
    this.conn = null;
  }

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: McplCapabilities = { version: '0.4', pushEvents: true, channels: false, rollback: false, featureSets };
    const capabilities: InitializeCapabilities = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult = { protocolVersion: '2024-11-05', capabilities, serverInfo: { name: 'heartbeat-mcpl', version: '0.1.0' } };
    conn.sendResponse(msg.request.id, result);
    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      log('initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
    }
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': conn.sendResponse(req.id, { tools: toolDefinitions }); break;
        case 'tools/call': conn.sendResponse(req.id, this.handleToolCall(params.name as string, (params.arguments ?? {}) as Record<string, unknown>)); break;
        case method.CHANNELS_LIST: conn.sendResponse(req.id, { channels: [] }); break;
        default: conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      conn.sendError(req.id, -32000, (e as Error).message);
    }
  }

  private text(t: string): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    return { content: [{ type: 'text', text: t }] };
  }

  private statusText(): string {
    const c = this.config;
    const remaining = this.nextFireAt ? Math.max(0, Math.round((this.nextFireAt - Date.now()) / 1000)) : null;
    return `Heartbeat ${c.paused ? 'PAUSED' : 'ACTIVE'} | interval=${c.intervalSeconds}s (${(c.intervalSeconds / 3600).toFixed(2)}h)` +
      (c.paused || remaining === null ? '' : ` | next in ~${remaining}s`) + ` | message="${c.message}"`;
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
      case 'heartbeat_trigger':
        this.fire('manual');
        return this.text('Heartbeat fired. ' + this.statusText());
      default:
        return { ...this.text(`Unknown tool: ${name}`), isError: true };
    }
  }

  private reschedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.config.paused) { this.nextFireAt = 0; log('paused; no next fire scheduled'); return; }
    const ms = this.config.intervalSeconds * 1000;
    this.nextFireAt = Date.now() + ms;
    this.timer = setTimeout(() => { this.fire('schedule'); this.reschedule(); }, ms);
    log(`next heartbeat in ${this.config.intervalSeconds}s`);
  }

  private fire(reason: string): void {
    const conn = this.conn;
    if (!conn) return;
    if (this.config.paused && reason === 'schedule') return;
    const params: PushEventParams = {
      featureSet: FS_NAME,
      eventId: `heartbeat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      origin: { source: 'heartbeat', reason },
      payload: { content: [{ type: 'text', text: this.config.message }] },
    };
    conn.sendRequest(method.PUSH_EVENT, params)
      .then((r) => log('push response:', JSON.stringify(r)))
      .catch((e) => log('push failed:', (e as Error).message));
    log(`fired heartbeat (${reason})`);
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) { console.error('Usage: heartbeat-mcpl --stdio'); process.exit(1); }
  log('starting on stdio; config=' + CONFIG_PATH);
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await new HeartbeatServer().serve(conn);
}
main().catch((e) => { console.error('[heartbeat-mcpl] fatal:', e); process.exit(1); });
