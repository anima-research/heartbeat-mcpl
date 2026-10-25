/** A tool call's arguments, checked against the tool's input schema, so that
 *  every argument an agent sends is applied, or the call is refused and says
 *  why. Each tool then checks what its schema can't say: ranges, floors and
 *  arguments that contradict each other. */

/** What a tool's input schema declares about one argument. */
export interface ArgumentSchema {
  type: 'number' | 'boolean' | 'string';
  enum?: readonly string[];
  description: string;
}

/** The part of a tool definition the check reads. */
export interface ToolSchema {
  name: string;
  inputSchema: { properties: Record<string, ArgumentSchema>; required?: readonly string[] };
}

export interface ArgumentCheck {
  /** One sentence per argument that can't be applied, saying what to give instead. */
  problems: string[];
  /** Keys that no tool here takes and that are no slip for an argument any of
   *  them takes. They did nothing before and do nothing now: a call that is
   *  applied goes on without them, and its result names them, as a refused
   *  one's does. */
  ignored: string[];
}

/** Check `args` against `tool`'s schema. A key the tool doesn't take is a
 *  problem when it is a slip (isSlip) for one it does, or for an argument
 *  another of `tools` takes, since either way the agent believes the call did
 *  something it didn't. Any other key is ignored, unless every key sent is
 *  one, since a call to a tool that takes arguments then can only have meant
 *  something it didn't do. */
export function checkArguments(tool: ToolSchema, args: unknown, tools: readonly ToolSchema[]): ArgumentCheck {
  const problems: string[] = [];
  const ignored: string[] = [];
  const { properties, required = [] } = tool.inputSchema;
  const names = Object.keys(properties);
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    problems.push(`Its arguments are ${describeValue(args)}; give an object of named arguments${names.length ? `, such as {"${names[0]}": …}` : ', or none'}.`);
    for (const key of required) problems.push(`"${key}" is missing: ${firstSentence(properties[key].description)}`);
    return { problems, ignored };
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) {
      const others = tools.filter((other) => other !== tool);
      const theirs = [...new Set(others.flatMap((other) => Object.keys(other.inputSchema.properties)))];
      const slips = names.filter((name) => isSlip(key, name, args));
      if (slips.length > 0) {
        // Suggest every name the slip was decided on, ranked, and only those.
        problems.push(`"${key}" isn't an argument ${tool.name} takes; the closest is ${orList(closestNames(key, slips, slips.length))}.`);
      } else if (theirs.some((name) => isSlip(key, name, args))) {
        const meant = closestNames(key, theirs.filter((name) => isSlip(key, name, args)), 1)[0];
        const owners = joinNames(others.filter((other) => Object.hasOwn(other.inputSchema.properties, meant)).map((other) => `${other.name}'s`), 'and');
        problems.push(meant === key
          ? `"${key}" is ${owners} argument, not ${tool.name}'s; ${takes(tool, tool.name)}.`
          : `"${key}" is close to "${meant}", ${owners} argument, not one ${tool.name} takes; ${takes(tool, tool.name)}.`);
      } else {
        ignored.push(key);
      }
      continue;
    }
    const schema = properties[key];
    if (typeof value !== schema.type) {
      problems.push(`"${key}" is ${describeValue(value)}; give ${wanted(schema, value)}.`);
    } else if (schema.enum && !schema.enum.includes(value as string)) {
      problems.push(`"${key}" ${JSON.stringify(value)} isn't one of its values; give ${orList(schema.enum)}.`);
    }
  }
  if (ignored.length > 0 && ignored.length === Object.keys(args).length && names.length > 0) {
    problems.unshift(`It doesn't take ${andList(ignored)}; ${takes(tool)}.`);
    ignored.length = 0;
  }
  for (const key of required) {
    if (!Object.hasOwn(args, key)) problems.push(`"${key}" is missing: ${firstSentence(properties[key].description)}`);
  }
  return { problems, ignored };
}

/** Whether `key` is a slip for argument `name`: a near miss (isNearMiss), or
 *  a longer key that holds `name` whole, ignoring case, sent without it. Sent
 *  in its place, such a key is the argument under another name, such as
 *  `heartbeatIntervalMinutes` for `intervalMinutes`. Sent beside it, it is no
 *  slip for it unless it is a near miss too, since it explains the argument,
 *  as `pausedReason` does beside `paused`. The name needs three characters or
 *  more, as a part of a name does for isNearMiss, since a letter or two is in
 *  nearly every name. Only the whole call can tell the two apart, so this sits
 *  beside isNearMiss, not in it. */
function isSlip(key: string, name: string, args: object): boolean {
  if (isNearMiss(key, name)) return true;
  return name.length >= 3 && key.toLowerCase().includes(name.toLowerCase()) && !Object.hasOwn(args, name);
}

/** The sentence a result ends with when the call sent keys that do nothing:
 *  that they were ignored, or, when the call was refused for something else,
 *  that it doesn't take them either. */
export function ignoredNote(tool: ToolSchema, ignored: readonly string[], refused = false): string {
  return refused
    ? `It also doesn't take ${andList(ignored)}; ${takes(tool)}.`
    : `${tool.name} ignored ${andList(ignored)}, which it doesn't take; ${takes(tool)}.`;
}

/** "it takes a, b and c", or that it takes none. */
function takes(tool: ToolSchema, subject = 'it'): string {
  const names = Object.keys(tool.inputSchema.properties);
  return names.length ? `${subject} takes ${andList(names)}` : `${subject} takes no arguments`;
}

/** What to give instead of `value`: for text that reads as the type wanted,
 *  the value to copy. */
function wanted(schema: ArgumentSchema, value: unknown): string {
  if (schema.type === 'number') {
    const n = typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? `it as a number: ${n}` : 'a number';
  }
  if (schema.type === 'boolean') {
    return value === 'true' || value === 'false' ? `it as true or false, without quotes: ${value}` : 'true or false';
  }
  return schema.enum ? orList(schema.enum) : 'text, as a string';
}

/** A value as an agent would recognize what it sent. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  if (typeof value === 'number') return `the number ${value}`;
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'an object' : String(value);
}

function firstSentence(description: string): string {
  const sentence = /^[^.]*\./.exec(description)?.[0] ?? description;
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

export function andList(items: readonly string[]): string {
  return joinNames(items.map((item) => `"${item}"`), 'and');
}

function orList(items: readonly string[]): string {
  return joinNames(items.map((item) => `"${item}"`), 'or');
}

/** `a`, `a and b`, or `a, b and c`, as given (or with "or"). */
function joinNames(items: readonly string[], word: 'and' | 'or'): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

/** A length given in units that add up: each argument given with its value,
 *  and the total in seconds, to the millisecond, the timers' own resolution. */
export interface Length { given: Array<[string, number]>; seconds: number; }

/** Add up the units of `units` ([argument, seconds per unit]) given in `args`.
 *  Null when none is given, or when one is negative, which is then a problem.
 *  A total too large for a number is Infinity, for the caller's range check. */
export function addUnits(
  args: Record<string, unknown>, units: ReadonlyArray<readonly [string, number]>, problems: string[],
): Length | null {
  const given: Array<[string, number]> = [];
  let seconds = 0;
  let negative = false;
  for (const [name, perUnit] of units) {
    const value = args[name];
    if (typeof value !== 'number') continue; // absent, or the wrong type, which the schema check named
    if (value < 0) {
      problems.push(`"${name}" ${value} is negative; give 0 or more.`);
      negative = true;
    }
    given.push([name, value]);
    seconds += value * perUnit;
  }
  return given.length && !negative ? { given, seconds: Math.round(seconds * 1000) / 1000 } : null;
}

/** `"inHours" 1 and "inMinutes" 30`, as the agent gave them. */
function givenList(length: Length): string {
  return joinNames(length.given.map(([name, value]) => `"${name}" ${value}`), 'and');
}

/** `"inHours" 1 and "inMinutes" 30 add up to`, or `"inMinutes" 90 is`. */
export function givenText(length: Length, verbs: [one: string, several: string] = ['is', 'add up to']): string {
  return `${givenList(length)} ${length.given.length < 2 ? verbs[0] : verbs[1]}`;
}

// closestNames, isNearMiss, noiseLimit and editDistance, from here to the end of this file, are
// agent-framework's src/closest-names.ts, copied since agent-framework doesn't export it, so this
// server and agent-framework decide near misses and rank suggestions the same way.

/**
 * The names someone most likely meant, when the one they gave matches none:
 * for a refusal's "did you mean", such as a tool name an agent got wrong.
 *
 * Case is ignored. A candidate that the name matches as a whole `--` segment
 * ("ls" for "workspace--ls"), then one that starts with it or that it starts
 * with, then one that contains it or that it contains, ranks ahead of one
 * that is only a few edits away, however many edits those matches take. The
 * prefix and substring matches need three characters on the shorter side,
 * since a letter or two is in nearly every name. A candidate that matches in
 * none of those ways counts only within the edits noiseLimit allows, and past
 * that it's noise. So a name that is part of no candidate, holds none and is
 * close to none gets nothing back, and a name in a crowded namespace doesn't
 * get its neighbours (`workspace--write` for `workspace--read`).
 */
export function closestNames(name: string, candidates: readonly string[], max = 2): string[] {
  const wanted = name.toLowerCase();
  const ranked: { candidate: string; tier: number; distance: number }[] = [];
  for (const candidate of new Set(candidates)) {
    const other = candidate.toLowerCase();
    const shorter = Math.min(wanted.length, other.length);
    const tier = other === wanted ? 0
      : wanted && other.split('--').includes(wanted) ? 1
      : shorter >= 3 && (other.startsWith(wanted) || wanted.startsWith(other)) ? 2
      : shorter >= 3 && (other.includes(wanted) || wanted.includes(other)) ? 3
      : 4;
    // In tiers 0 to 3 one name holds the other, so the length difference is
    // already their distance, and a long name skips the edit table.
    const limit = tier === 4 ? noiseLimit(wanted, other) : Infinity;
    const distance = tier === 4 ? editDistance(wanted, other, limit) : Math.abs(wanted.length - other.length);
    if (distance > limit) continue;
    ranked.push({ candidate, tier, distance });
  }
  // Array.prototype.sort is stable, so candidates that tie keep the order they were given in.
  ranked.sort((a, b) => a.tier - b.tier || a.distance - b.distance);
  return ranked.slice(0, Math.max(0, max)).map((entry) => entry.candidate);
}

/**
 * Whether `name` looks like a slip for `candidate`, ignoring case: the same;
 * a few edits apart, where a transposition counts as one edit; or, at three
 * characters or more, a part of it, which is a shortened attempt at it
 * (`mode` for `deliveryMode`, `interval` for `refillIntervalMs`). A part
 * counts only that way round: a name that holds the candidate, and is more
 * edits from it than a slip allows, is another name, usually an extra that
 * explains it (`channel_note` beside `channel`, where `channels` is a slip).
 * Beyond these, two names are different names rather than one mistyped.
 */
export function isNearMiss(name: string, candidate: string): boolean {
  const a = name.toLowerCase(), b = candidate.toLowerCase();
  if (a.length >= 3 && b.includes(a)) return true;
  const limit = noiseLimit(a, b);
  return editDistance(a, b, limit) <= limit;
}

/**
 * The most edits that still read as a slip: a quarter of what follows the
 * prefix the two names share, and at least one. A shared prefix is mostly a
 * namespace (`workspace--`, `mcpl--discord--`) and says nothing about the
 * rest, so `workspace--read` and `workspace--write` are four edits apart in
 * a four-letter tool name, not in a fifteen-letter one.
 */
function noiseLimit(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return Math.max(1, Math.floor((Math.max(a.length, b.length) - shared) / 4));
}

/**
 * Edits between two strings: insertions, deletions, substitutions and
 * swaps of neighbours (optimal string alignment). Past `limit` the exact
 * count doesn't matter, so it answers `limit + 1` as soon as it is sure.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    // No row's smallest entry is below the one before it, so none later can come back under the limit.
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}
