const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** The first and last instants a Date, and so a reminder, can hold. */
export const FIRST_REMINDER_TIME = '-271821-04-20T00:00:00Z';
export const LAST_REMINDER_TIME = '+275760-09-13T00:00:00Z';

/** Whether a reminder can hold this time: a Date can, so it can be listed and
 *  logged. Every time a reminder is saved with passes this. */
export function canHoldTime(ms: number): boolean {
  return Math.abs(ms) <= MAX_DATE_MS;
}

/** What atIso accepts, for its refusals. */
const accepted = (timeZone: string) => 'Use a calendar date YYYY-MM-DD (or an expanded year, ±YYYYYY-MM-DD),'
  + ' optionally with a time THH:MM, THH:MM:SS or THH:MM:SS.fff, which can end in Z or a UTC offset ±hh, ±hh:mm or ±hhmm.'
  + ` Without one, the time is read in ${timeZone}, and a date alone is midnight there.`;

/** A UTC offset in milliseconds, or null if it isn't one: ±hh, ±hh:mm or ±hhmm,
 *  with seconds (±hh:mm:ss, ±hhmmss) for the historical offsets Intl names, and
 *  one separator style throughout. Intl's names carry a GMT prefix, and ICU 72 to
 *  77 (Node 20.0 to 24.0) name the zero offset GMT alone. */
function offsetMilliseconds(offset: string): number | null {
  if (/^(Z|GMT)$/i.test(offset)) return 0;
  const match = /^(?:GMT)?([+-])(\d{2})(?:(:?)(\d{2})(?:\3(\d{2}))?)?$/.exec(offset);
  if (!match || +match[2] > 23 || +(match[4] ?? 0) > 59 || +(match[5] ?? 0) > 59) return null;
  return (match[1] === '-' ? -1 : 1)
    * (+match[2] * 3600 + +(match[4] ?? 0) * 60 + +(match[5] ?? 0)) * 1000;
}

/** Read wall times in the agent zone, while explicit offsets name their own instant.
 *  A date alone is midnight in the agent zone. A gap or repeated wall time requires
 *  the caller to choose a time or offset. */
export function parseReminderTime(atIso: string, timeZone: string): number {
  const invalid = `"atIso" is not a valid ISO-8601 timestamp: ${atIso}. ${accepted(timeZone)}`;
  const parts = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-][\d:]+)?)?$/.exec(atIso);
  if (!parts) throw new Error(invalid);
  // Validate the date separately so ISO's 24:00 can advance a valid date,
  // while February 30 cannot silently become March 2. ISO parsing preserves years 0–99.
  const calendarDate = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const midnight = Date.parse(`${calendarDate}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).getUTCDate() !== +parts[3]) {
    throw new Error(invalid);
  }
  const wall = Date.parse(`${calendarDate}T${parts[4] ?? '00'}:${parts[5] ?? '00'}:${parts[6] ?? '00'}.${(parts[7] ?? '0').slice(0, 3).padEnd(3, '0')}Z`);
  if (!Number.isFinite(wall)) throw new Error(invalid);

  if (parts[8]) {
    const offset = offsetMilliseconds(parts[8]);
    if (offset === null) {
      throw new Error(`"atIso" has an invalid UTC offset ${parts[8]}: ${atIso}. ${accepted(timeZone)}`);
    }
    const instant = wall - offset;
    if (Math.abs(instant) > MAX_DATE_MS) {
      throw new Error(
        `"atIso" ${atIso} is outside the times a reminder can hold, -271821-04-20T00:00:00Z to +275760-09-13T00:00:00Z.`,
      );
    }
    return instant;
  }

  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const offsetAt = (ms: number) => {
    const name = formatter.formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value;
    const offset = name ? offsetMilliseconds(name) : null;
    if (!name || offset === null) {
      throw new Error(`Cannot read the UTC offset for ${timeZone}. Give atIso an explicit UTC offset instead.`);
    }
    return { ms: offset, label: name === 'GMT' ? '+00:00' : name.slice(3) };
  };

  // Offsets on either side cover ordinary times and both sides of a transition.
  // Validate each candidate at its own instant: a gap has none, a fold has two.
  const offsets = new Map<number, string>();
  for (const delta of [-DAY_MS, DAY_MS]) {
    const sample = Math.abs(wall + delta) <= MAX_DATE_MS ? wall + delta : wall;
    const offset = offsetAt(sample);
    offsets.set(offset.ms, offset.label);
  }
  const candidates = [...offsets].filter(([offset]) => {
    const instant = wall - offset;
    return Math.abs(instant) <= MAX_DATE_MS && offsetAt(instant).ms === offset;
  });
  if (candidates.length === 1) return wall - candidates[0][0];
  // A date alone is read as its midnight. Name that time, since an offset can follow only a time.
  const read = parts[4] === undefined ? `${atIso} is read as ${calendarDate}T00:00, which` : atIso;
  if (candidates.length > 1) {
    throw new Error(
      `"atIso" ${read} occurs twice in ${timeZone}. Include ${candidates.map(([, label]) => label).join(' or ')} to choose the intended instant.`,
    );
  }
  throw new Error(
    `"atIso" ${read} does not exist in ${timeZone}. Choose an existing local time or give an explicit UTC offset.`,
  );
}
