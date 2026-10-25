/**
 * Saves write the file in place, so it keeps its mode, owner, group and links. A file copied
 * aside is named by its bytes, so starting on the same file again keeps one copy.
 */
import { copyFileSync, constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** What a stored file gave its store. `value` is its parsed content when that
 *  is what the store writes, and undefined otherwise; `bytes` is what the
 *  file held, whenever it could be read, so with every `value`. `unused` says
 *  there was a file whose content the store starts without, and `replaced`
 *  that `value` holds replacement characters for bytes that weren't UTF-8.
 *  `unsaveable`, when set, says why nothing may be saved over the file until
 *  a restart reads it again. `note` is the log line for whoever runs the
 *  host, when there is one. */
export interface Stored {
  value: unknown; bytes: Buffer | null; unused: boolean; replaced: boolean; unsaveable: string | null; note: string | null;
}

/** TextDecoder reads past a byte order mark at the start, which an editor may add, so the
 *  next save leaves it out. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UTF8_REPLACING = new TextDecoder('utf-8');

/** What keeping a file aside left: why nothing may be saved over it, if the
 *  copy failed, and the log line. */
export interface KeptAside { unsaveable: string | null; note: string; }

/** Read `path`, the `what` file, whose store writes what `isWritten` accepts. */
export function readStored(path: string, what: string, isWritten: (value: unknown) => boolean): Stored {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { value: undefined, bytes: null, unused: false, replaced: false, unsaveable: null, note: null };
    }
    const unsaveable = `the ${what} file ${path} couldn't be read (${(e as Error).message})`;
    return {
      value: undefined, bytes: null, unused: true, replaced: false, unsaveable,
      note: `${unsaveable}; nothing is saved over it until a restart reads it again`,
    };
  }
  // The server writes UTF-8. A file with bytes that aren't, such as one
  // edited in another encoding, is read with replacement characters in their
  // place, so the store keeps what it can use, and it's copied aside first,
  // since the next save writes those characters over the bytes.
  let replaced = false;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    text = UTF8_REPLACING.decode(bytes);
    replaced = true;
  }
  let value: unknown;
  let parsed = true;
  try { value = JSON.parse(text); } catch { parsed = false; }
  if (parsed && isWritten(value)) {
    if (!replaced) return { value, bytes, unused: false, replaced: false, unsaveable: null, note: null };
    const kept = keepAside(path, what, bytes, "holds bytes that aren't UTF-8", 'starting with what it holds, read with replacement characters');
    return { value, bytes, unused: false, replaced: true, ...kept };
  }
  const unlike = parsed ? `isn't what this server writes` : `isn't JSON`;
  return { value: undefined, bytes, unused: true, replaced: false, ...keepAside(path, what, bytes, unlike, 'starting without it') };
}

/** Copy `path`, the `what` file, which held `bytes`, aside before anything
 *  saves over it: `why` says what's wrong with it, and `then` what its store
 *  does next. When the copy fails, nothing may save over the file. */
export function keepAside(path: string, what: string, bytes: Buffer, why: string, then: string): KeptAside {
  const copy = `${path}.unreadable-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
  try {
    copyAside(path, copy, bytes);
  } catch (e) {
    const unsaveable = `the ${what} file ${path} ${why}, and copying it to ${copy} failed (${(e as Error).message})`;
    return { unsaveable, note: `${unsaveable}; nothing is saved over it until a restart reads it again` };
  }
  return { unsaveable: null, note: `the ${what} file ${path} ${why}; copied it to ${copy}, and ${then}` };
}

/** Copy `path` to `copy` with its mode, unless `copy` already holds `bytes`,
 *  as it does when a start before this one copied the same file aside. */
function copyAside(path: string, copy: string, bytes: Buffer): void {
  try {
    copyFileSync(path, copy, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (!readFileSync(copy).equals(bytes)) throw new Error(`${copy} already exists and holds something else`);
  }
}

/** Why nothing may be saved over a file until a restart reads it again: it
 *  couldn't be read, or it couldn't be copied aside. */
export type Unsaveable = 'unread' | 'uncopied';

/** What a reply adds when the change it made can't be saved, since its file
 *  holds what is on disk nowhere else, with what whoever runs the host can do
 *  so that a restart reads it again. What stopped the server differs (a mode,
 *  a directory at the path, another file at the copy's name, a full disk),
 *  and its log names it. */
export function unsavedNote(what: string, why: Unsaveable): string {
  const [couldnt, fix] = why === 'unread'
    ? [`read the ${what} file`, 'what stops the server reading the file']
    : [`copy the ${what} file aside`, 'what stopped the copy'];
  return `This change can't be saved: this server couldn't ${couldnt}, and saves nothing over it until a restart reads it again, `
    + "so the change won't last past a restart. Calling again won't change that; if you need it kept, ask whoever runs this "
    + `host to fix ${fix}, as its log says, and restart it.`;
}

/** What a reply that shows a store adds when this start read some of its
 *  file's text with replacement characters, since bytes there weren't UTF-8.
 *  The file's bytes are kept: in its copy, or in the file itself when the
 *  copy failed and nothing may be saved over it. */
export function replacedNote(what: string): string {
  return `Some text in the ${what} file couldn't be read, so it was loaded with replacement characters (\ufffd) in its place. `
    + 'The original is kept; ask whoever runs this host if you need it.';
}

/** What a reply that shows or counts the reminders adds when this start
 *  couldn't load the reminders saved before it: `all` of them, or only some. */
export function remindersNotLoadedNote(all: boolean): string {
  return all ? "The reminders file couldn't be used at start, so reminders saved before then aren't loaded; ask whoever runs this host."
    : "Some reminders saved before this start couldn't be loaded; ask whoever runs this host.";
}

/** What a reply that shows the schedule adds when this start couldn't load
 *  the config. A change since then shows as made, so the schedule shown
 *  started from the default. */
export const CONFIG_NOT_LOADED = "The config file couldn't be used at start, so the schedule shown started from the default, "
  + 'not from what was saved; ask whoever runs this host.';

/** A save writes the file in place, so a write that fails partway may have emptied it of what
 *  was saved before; a later save that goes through writes everything again. */
export function failedSaveNote(what: string): string {
  return `This change wasn't saved, because writing the ${what} file failed, so as things stand it won't last past a restart, `
    + 'and the failed write may also have left the file missing what was saved before. A later save of that file that goes through '
    + 'saves everything again; if it keeps happening, ask whoever runs this host to fix what stops the server writing the file, '
    + 'as its log says.';
}
