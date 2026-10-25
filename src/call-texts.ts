import { andList } from './arguments.js';

/** What the agent reads when a tools/call names no tool here: nothing ran,
 *  and these are the tools there are. */
export function noSuchTool(name: unknown, tools: readonly string[]): string {
  const named = typeof name === 'string' ? `There's no tool named ${JSON.stringify(name)} here`
    : name === undefined ? "The call doesn't name a tool"
    : `The call gives ${JSON.stringify(name)} as its tool's name, and a tool's name is a string`;
  return `${named}, so nothing ran. heartbeat-mcpl's tools are ${andList(tools)}.`;
}

/** A value as text: an object as JSON, anything else as a string. It can
 *  throw, for an object whose JSON or string form throws. */
const asText = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : undefined) ?? String(value);

/** Anything can be thrown, not only an Error, and even reading an Error's message can throw,
 *  or give something that isn't a string. */
export function describeThrown(thrown: unknown): string {
  try {
    if (thrown instanceof Error) {
      const message: unknown = thrown.message;
      return typeof message === 'string' ? message : asText(message);
    }
    return asText(thrown);
  } catch {
    return 'a value that can\'t be shown as text';
  }
}

/** Reads the stack once, since a getter needn't give the same thing twice. */
export function thrownForLog(thrown: unknown): string {
  try {
    if (thrown instanceof Error) {
      const stack: unknown = thrown.stack;
      if (typeof stack === 'string') return stack;
    }
  } catch { /* described below */ }
  return describeThrown(thrown);
}

/** What the agent is told after a tool threw, for the tools where that isn't
 *  "look before you call again": one that only reads changed nothing, and
 *  heartbeat_trigger may have sent its heartbeat, which neither of the tools
 *  the others point to shows. */
const AFTER_THROW: Record<string, string> = {
  heartbeat_status: 'It only reads, so it changed nothing.',
  reminder_list: 'It only reads, so it changed nothing.',
  heartbeat_trigger: 'It may have sent a heartbeat before it failed, so calling it again may send a second.',
};

/** What the agent reads when a tool threw. A tool that changes things may
 *  have done so first, so the agent looks before it calls again; a fault that
 *  comes back is for whoever runs the host, whose log has it. The
 *  description's closing full stops and whitespace go, so it doesn't end in
 *  two full stops, and one with nothing left to say gets no colon. */
export function toolThrew(name: unknown, thrown: unknown): string {
  const text = describeThrown(thrown);
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || /\s/.test(text[end - 1]))) end--;
  const why = text.slice(0, end).trim();
  const after = typeof name === 'string' && Object.hasOwn(AFTER_THROW, name) ? AFTER_THROW[name]
    : 'Whether it changed anything is unknown: check reminder_list or heartbeat_status before you call it again.';
  return `${typeof name === 'string' ? name : 'The tool'} failed inside heartbeat-mcpl${why ? `: ${why}` : ''}. `
    + `${after} If it fails the same way again, ask whoever runs this host.`;
}
