export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** AGENT_TIMEZONE names the zone for agent-visible times and for reading an offset-less
 *  atIso, trimmed. One this runtime can't format in is warned of on stderr, and the system
 *  zone, or UTC where there is none, is used, as when it's unset. */
export function resolveAgentTimeZone(configured = process.env.AGENT_TIMEZONE): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const zone = configured?.trim();
  if (!zone) return fallback;
  if (!isValidTimeZone(zone)) {
    console.error(`[timezone] Invalid AGENT_TIMEZONE ${JSON.stringify(zone)} — falling back to system time zone ${JSON.stringify(fallback)}`);
    return fallback;
  }
  return zone;
}

export function formatAgentDateTime(value: Date | number, timeZone = resolveAgentTimeZone()): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const rawOffset = get('timeZoneName');
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset} [${timeZone}]`;
}
