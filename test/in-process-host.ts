import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import { format } from 'node:util';
import { McplConnection } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { HeartbeatServer } from '../src/server.js';
import { POLICY } from './scripted-host.js';
import type { PushAnswer, ServerFiles } from './scripted-host.js';

export const EPOCH = Date.UTC(2031, 0, 1, 9);

const ARMED_DUE_LIMIT = 1_000;
let armedDue = 0;

export function useClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: EPOCH });
  const mocked = globalThis.setTimeout as (...a: unknown[]) => ReturnType<typeof setTimeout>;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (!(Number(ms) > 0) && ++armedDue > ARMED_DUE_LIMIT) {
      throw new Error(`a timer was armed already due ${ARMED_DUE_LIMIT} times in one move of the mocked clock, at ${new Date().toISOString()}: `
        + 'something keeps re-arming for a time before the mocked now, such as a due time read from another clock');
    }
    return mocked(fn, ms, ...args);
  }) as typeof setTimeout;
}

function tick(t: TestContext, ms: number): void {
  armedDue = 0;
  t.mock.timers.tick(ms);
}

const TURNS = 500;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function until(cond: () => boolean, what: () => string, tick = () => {}): Promise<void> {
  for (let i = 0; i < TURNS; i++) {
    if (cond()) return;
    tick();
    await turn();
  }
  assert.fail(`after ${TURNS} turns of the event loop, ${what()}`);
}

export async function serverInProcess(
  t: TestContext,
  answerPush: (p: PushEventParams) => PushAnswer | Promise<PushAnswer>,
  { reminders = [] as unknown[], mcpl = true, policy = true, prepare = (_files: ServerFiles) => {} } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-in-process-'));
  let conn: McplConnection | undefined;
  let served: Promise<void> | undefined;
  t.after(async () => {
    try {
      if (conn && served) {
        let ended = false;
        conn.close();
        void served.finally(() => { ended = true; }).catch(() => {});
        await until(() => ended, () => 'the server never ended its serve');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const remindersFile = join(dir, 'reminders.json');
  const files: ServerFiles = { dir, reminders: remindersFile, config: join(dir, 'config.json') };
  writeFileSync(remindersFile, JSON.stringify(reminders));
  prepare(files);
  let stderr = '';
  const log = (...a: unknown[]) => { stderr += `${format('[heartbeat-mcpl]', ...a)}\n`; };
  const pushes: PushEventParams[] = [];

  const connect = () => {
    const toServer = new PassThrough();
    const toHost = new PassThrough();
    const server = new HeartbeatServer({ configPath: files.config, remindersPath: remindersFile, timeZone: 'UTC', log });
    served = server.serve(McplConnection.fromStreams(toServer, toHost));
    const host = McplConnection.fromStreams(toHost, toServer);
    conn = host;
    void (async () => {
      try {
        for (;;) {
          const msg = await host.nextMessage();
          if (msg.type !== 'request' || msg.request.method !== 'push/event') continue;
          const p = msg.request.params as PushEventParams;
          const { id } = msg.request;
          pushes.push(p);
          const send = (answer: PushAnswer) => {
            if (host.isClosed) return;
            if (answer.error) host.sendError(id, ...answer.error);
            else host.sendResponse(id, answer.result ?? { accepted: true, inferenceId: 'i' });
          };
          const answer = answerPush(p);
          if (answer instanceof Promise) void answer.then(send);
          else send(answer);
        }
      } catch (e) {
        if ((e as Error).name !== 'ConnectionClosedError') throw e;
      }
    })();
  };
  const due = () => tick(t, 0);
  const settled = async <T>(promise: Promise<T>, what: string): Promise<T> => {
    let done = false;
    const watched = promise.finally(() => { done = true; });
    watched.catch(() => {});
    await until(() => done, () => `no answer to ${what}`, due);
    return watched;
  };
  const request = (method: string, params: unknown) => settled(conn!.sendRequest(method, params, 0), method);
  const notify = (method: string, params: unknown) => conn!.sendNotification(method, params);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await request('tools/call', { name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  const start = async () => {
    connect();
    await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true } } } : {},
      clientInfo: { name: 'test-host', version: '0' },
    });
    if (mcpl && policy) await request('featureSets/update', POLICY);
  };
  const hangUp = async () => { conn!.close(); await settled(served!, 'the server ending its serve'); };
  await start();
  return {
    pushes, request, notify, call, files,
    stderr: () => stderr,
    advance: async (ms: number) => { tick(t, ms); for (let i = 0; i < 20; i++) { due(); await turn(); } },
    until: (cond: () => boolean, what: () => string) => until(cond, what, due),
    pushCount: (n: number) => until(() => pushes.length >= n, () => `expected ${n} push/event(s), saw ${pushes.length}; the log:\n${stderr}`, due),
    logged: (line: string) => until(() => stderr.split('\n').includes(`[heartbeat-mcpl] ${line}`),
      () => `expected the log line\n${line}\nin\n${stderr}`, due),
    listed: async (pattern: RegExp) => {
      let list = '';
      for (let i = 0; i < 100; i++) {
        list = await call('reminder_list');
        if (pattern.test(list)) return list;
        due();
        await turn();
      }
      return assert.fail(`reminder_list never matched ${pattern}:\n${list}`);
    },
    stored: () => JSON.parse(readFileSync(remindersFile, 'utf8')) as Array<Record<string, unknown>>,
    hangUp,
    restart: async () => { await hangUp(); await start(); },
  };
}
