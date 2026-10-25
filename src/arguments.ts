export interface ArgumentSchema {
  type: 'number' | 'boolean' | 'string';
  enum?: readonly string[];
  description: string;
}

export interface ToolSchema {
  name: string;
  inputSchema: { properties: Record<string, ArgumentSchema>; required?: readonly string[] };
}

export interface ArgumentCheck {
  problems: string[];
  ignored: string[];
}

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

function isSlip(key: string, name: string, args: object): boolean {
  if (isNearMiss(key, name)) return true;
  return name.length >= 3 && key.toLowerCase().includes(name.toLowerCase()) && !Object.hasOwn(args, name);
}

export function ignoredNote(tool: ToolSchema, ignored: readonly string[], refused = false): string {
  return refused
    ? `It also doesn't take ${andList(ignored)}; ${takes(tool)}.`
    : `${tool.name} ignored ${andList(ignored)}, which it doesn't take; ${takes(tool)}.`;
}

function takes(tool: ToolSchema, subject = 'it'): string {
  const names = Object.keys(tool.inputSchema.properties);
  return names.length ? `${subject} takes ${andList(names)}` : `${subject} takes no arguments`;
}

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

function joinNames(items: readonly string[], word: 'and' | 'or'): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

export interface Length { given: Array<[string, number]>; seconds: number; }

export function addUnits(
  args: Record<string, unknown>, units: ReadonlyArray<readonly [string, number]>, problems: string[],
): Length | null {
  const given: Array<[string, number]> = [];
  let seconds = 0;
  let negative = false;
  for (const [name, perUnit] of units) {
    const value = args[name];
    if (typeof value !== 'number') continue;
    if (value < 0) {
      problems.push(`"${name}" ${value} is negative; give 0 or more.`);
      negative = true;
    }
    given.push([name, value]);
    seconds += value * perUnit;
  }
  return given.length && !negative ? { given, seconds: Math.round(seconds * 1000) / 1000 } : null;
}

function givenList(length: Length): string {
  return joinNames(length.given.map(([name, value]) => `"${name}" ${value}`), 'and');
}

export function givenText(length: Length, verbs: [one: string, several: string] = ['is', 'add up to']): string {
  return `${givenList(length)} ${length.given.length < 2 ? verbs[0] : verbs[1]}`;
}

// closestNames, isNearMiss, noiseLimit and editDistance, from here to the end of this file, are
// agent-framework's src/closest-names.ts, copied since agent-framework doesn't export it, so this
// server and agent-framework decide near misses and rank suggestions the same way.

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
    const limit = tier === 4 ? noiseLimit(wanted, other) : Infinity;
    const distance = tier === 4 ? editDistance(wanted, other, limit) : Math.abs(wanted.length - other.length);
    if (distance > limit) continue;
    ranked.push({ candidate, tier, distance });
  }
  // Array.prototype.sort is stable, so candidates that tie keep the order they were given in.
  ranked.sort((a, b) => a.tier - b.tier || a.distance - b.distance);
  return ranked.slice(0, Math.max(0, max)).map((entry) => entry.candidate);
}

export function isNearMiss(name: string, candidate: string): boolean {
  const a = name.toLowerCase(), b = candidate.toLowerCase();
  if (a.length >= 3 && b.includes(a)) return true;
  const limit = noiseLimit(a, b);
  return editDistance(a, b, limit) <= limit;
}

function noiseLimit(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return Math.max(1, Math.floor((Math.max(a.length, b.length) - shared) / 4));
}

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
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}
