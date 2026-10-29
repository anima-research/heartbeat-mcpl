#!/usr/bin/env node
import { McplConnection } from '@animalabs/mcpl-core';
import { resolveAgentTimeZone } from './timezone.js';
import { HeartbeatServer } from './server.js';
import { fileWakeConfig } from './filewake.js';

const CONFIG_PATH = process.env.HEARTBEAT_CONFIG_FILE ?? './heartbeat-config.json';
const REMINDERS_PATH = process.env.HEARTBEAT_REMINDERS_FILE ?? './heartbeat-reminders.json';
const AGENT_TIME_ZONE = resolveAgentTimeZone();

function log(...a: unknown[]): void { console.error('[heartbeat-mcpl]', ...a); }

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) { console.error('Usage: heartbeat-mcpl --stdio'); process.exit(1); }
  const fileWake = fileWakeConfig();
  log('starting on stdio; config=' + CONFIG_PATH + ' reminders=' + REMINDERS_PATH);
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  await new HeartbeatServer({ configPath: CONFIG_PATH, remindersPath: REMINDERS_PATH, timeZone: AGENT_TIME_ZONE, log, fileWake }).serve(conn);
}
main().catch((e) => { console.error('[heartbeat-mcpl] fatal:', e); process.exit(1); });
