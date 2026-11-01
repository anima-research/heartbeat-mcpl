import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface FileWakeConfig {
  dir: string;
  ext: string;
  intervalMs: number;
  maxChars: number;
  prefix: string;
}

export function fileWakeConfig(env: NodeJS.ProcessEnv = process.env): FileWakeConfig | undefined {
  if (env.FILEWAKE_DIR === undefined) return undefined;
  if (!env.FILEWAKE_DIR.trim() || env.FILEWAKE_DIR.includes('\0')) throw new Error('FILEWAKE_DIR must be a nonblank directory path');
  const ext = env.FILEWAKE_EXT ?? '';
  if (ext && !/^\.[A-Za-z0-9_-]+$/.test(ext)) throw new Error('FILEWAKE_EXT must be empty or an extension such as .txt (letters, digits, _ or -)');
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    }
    return n;
  };
  return {
    dir: env.FILEWAKE_DIR, ext,
    intervalMs: integer('FILEWAKE_INTERVAL_MS', 5_000, 1_000, 86_400_000),
    maxChars: integer('FILEWAKE_MAX_CHARS', 4_000, 1, 1_000_000),
    prefix: env.FILEWAKE_PREFIX ?? '',
  };
}

function unchanged(a: Stats, b: Stats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// Resolve existing ancestors too: state files/directories need not exist yet.
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(absolute) === absolute) throw e;
    // realpath fails on a dangling state-file symlink, but a future save can
    // create its target. Protect that target's directory before it exists.
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        return canonicalPath(resolve(dirname(absolute), readlinkSync(absolute)));
      }
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
    }
    return join(canonicalPath(dirname(absolute)), basename(absolute));
  }
}

export type FileWakeFailure = 'refused' | 'transport' | 'timeout';

export class FileWake {
  private stopped = true;
  private running = false;
  private retryRequested = false;
  private blockedReason: string | null = null;
  private refusalLogged = new Map<string, Set<FileWakeFailure>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly config: FileWakeConfig,
    private readonly push: (text: string, name: string) => Promise<boolean | FileWakeFailure>,
    private readonly log: (...a: unknown[]) => void,
    private readonly options: { protectedPaths?: readonly string[]; blocked?: () => string | null } = {},
  ) {
    try {
      mkdirSync(config.dir, { recursive: true });
      if (!lstatSync(config.dir).isDirectory()) throw new Error('not a directory (symlinks are not supported)');
      const inbox = realpathSync(config.dir);
      const inboxStat = statSync(config.dir);
      for (const path of options.protectedPaths ?? []) {
        // Check both the named location (where recovery copies go) and a
        // symlink's target (which could itself be a regular inbox file).
        const warn = (e: unknown) => {
          this.log(`WARNING: filewake could not resolve protected path ${JSON.stringify(path)}; using lexical state-directory comparison:`, (e as Error).message);
        };
        // A file-resolution failure must not discard its resolved parent (or
        // vice versa). Keep each successful candidate independently.
        const stateDirs = [() => canonicalPath(dirname(path)), () => dirname(canonicalPath(path))].map((candidate) => {
          try { return candidate(); }
          catch (e) { warn(e); return resolve(dirname(path)); }
        });
        const sameDirectory = stateDirs.some((dir) => {
          try {
            const state = statSync(dir);
            return state.dev === inboxStat.dev && state.ino === inboxStat.ino;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(e);
            return false;
          }
        });
        if (sameDirectory || resolve(config.dir) === resolve(dirname(path)) || stateDirs.includes(inbox)) {
          throw new Error(`must be separate from the persisted state directory for ${JSON.stringify(path)}`);
        }
      }
    } catch (e) {
      throw new Error(`FILEWAKE_DIR ${JSON.stringify(config.dir)}: ${(e as Error).message}`);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.retryRequested = false;
    this.run();
  }

  /** Policy changes request one scan, never a concurrent poll. */
  retry(): void {
    if (this.stopped) return;
    if (this.running) {
      this.retryRequested = true;
      return;
    }
    clearTimeout(this.timer);
    this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }

  private run(): void {
    this.running = true;
    this.pending = this.poll().catch((e) => this.log('filewake poll failed:', (e as Error).message)).then(() => {
      this.running = false;
      if (this.stopped) return;
      if (this.retryRequested) {
        this.retryRequested = false;
        this.run();
      } else {
        this.timer = setTimeout(() => this.run(), this.config.intervalMs);
      }
    });
  }

  private deliveryBlocked(): boolean {
    const reason = this.options.blocked?.() ?? null;
    if (reason !== null && reason !== this.blockedReason) this.log(`filewake blocked: ${reason}`);
    this.blockedReason = reason;
    return reason !== null;
  }

  private async poll(): Promise<void> {
    if (this.deliveryBlocked()) return;
    const { dir, ext, maxChars, prefix } = this.config;
    if (!lstatSync(dir).isDirectory()) throw new Error('FILEWAKE_DIR is no longer a directory');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith(ext))
      .map((entry) => entry.name).sort();
    const present = new Set(names);
    for (const name of this.refusalLogged.keys()) if (!present.has(name)) this.refusalLogged.delete(name);
    for (const name of names) {
      if (this.stopped || this.deliveryBlocked()) break;
      const label = `filewake ${JSON.stringify(name)}`;
      const path = join(dir, name);
      let accepted = false;
      try {
        // O_NONBLOCK also protects against a file replaced by a FIFO after readdir.
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let before: Stats;
        let text: string;
        try {
          before = fstatSync(fd);
          if (!before.isFile()) {
            this.log(`${label}: NOT pushed (will retry): not a regular file`);
            continue;
          }
          // A Unicode code point occupies at most four UTF-8 bytes. Never read the
          // whole file just to truncate it; allow three extra bytes for a leading BOM
          // and discard an incomplete boundary sequence.
          const bytes = Buffer.alloc(Math.min(before.size, maxChars * 4 + 3));
          let used = 0;
          while (used < bytes.length) {
            const n = readSync(fd, bytes, used, bytes.length - used, null);
            if (n === 0) break;
            used += n;
          }
          const decoded = new TextDecoder('utf-8').decode(bytes.subarray(0, used), { stream: used < before.size });
          text = prefix.replaceAll('{name}', () => name) + Array.from(decoded).slice(0, maxChars).join('');
          if (!unchanged(before, fstatSync(fd))) throw new Error('file changed while reading');
        } finally {
          closeSync(fd);
        }
        const outcome = await this.push(text, name);
        accepted = outcome === true;
        if (outcome !== true) {
          const failure = outcome === false ? 'refused' : outcome;
          const logged = this.refusalLogged.get(name) ?? new Set<FileWakeFailure>();
          if (!logged.has(failure)) this.log(`${label}: NOT pushed (will retry)`);
          logged.add(failure);
          this.refusalLogged.set(name, logged);
          continue;
        }
        this.refusalLogged.delete(name);
        // A producer may have replaced this name while the host was answering.
        if (!unchanged(before, lstatSync(path))) {
          this.log(`${label}: pushed; file changed, kept for retry`);
          continue;
        }
        unlinkSync(path);
        this.log(`${label}: pushed`);
      } catch (e) {
        if (accepted && (e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.log(`${label}: pushed; already removed`);
        } else {
          this.log(`${label}: ${accepted ? 'pushed, but not removed' : 'NOT pushed'} (will retry):`, (e as Error).message);
        }
      }
    }
  }
}
