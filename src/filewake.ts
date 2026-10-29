import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';

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

export class FileWake {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly config: FileWakeConfig,
    private readonly push: (text: string, name: string) => Promise<boolean>,
    private readonly log: (...a: unknown[]) => void,
  ) {
    try {
      mkdirSync(config.dir, { recursive: true });
      if (!lstatSync(config.dir).isDirectory()) throw new Error('not a directory (symlinks are not supported)');
    } catch (e) {
      throw new Error(`FILEWAKE_DIR ${JSON.stringify(config.dir)}: ${(e as Error).message}`);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }

  private run(): void {
    this.pending = this.poll().catch((e) => this.log('filewake poll failed:', (e as Error).message)).then(() => {
      if (!this.stopped) this.timer = setTimeout(() => this.run(), this.config.intervalMs);
    });
  }

  private async poll(): Promise<void> {
    const { dir, ext, maxChars, prefix } = this.config;
    if (!lstatSync(dir).isDirectory()) throw new Error('FILEWAKE_DIR is no longer a directory');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith(ext))
      .map((entry) => entry.name).sort();
    for (const name of names) {
      if (this.stopped) break;
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
          // whole file just to truncate it; discard an incomplete boundary sequence.
          const bytes = Buffer.alloc(Math.min(before.size, maxChars * 4));
          let used = 0;
          while (used < bytes.length) {
            const n = readSync(fd, bytes, used, bytes.length - used, null);
            if (n === 0) break;
            used += n;
          }
          const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, used), { stream: used < before.size });
          text = prefix.replaceAll('{name}', () => name) + Array.from(decoded).slice(0, maxChars).join('');
          if (!unchanged(before, fstatSync(fd))) throw new Error('file changed while reading');
        } finally {
          closeSync(fd);
        }
        accepted = await this.push(text, name);
        if (!accepted) {
          this.log(`${label}: NOT pushed (will retry)`);
          continue;
        }
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
