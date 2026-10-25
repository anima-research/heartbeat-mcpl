import { formatAgentDateTime } from './timezone.js';

export interface FiredReminder {
  id: string;
  message: string;
  createdAt: number;
  fireAt: number;
  everySeconds: number | null;
}

const LATE_MS = 60_000;

function isRenderableTime(ms: number): boolean {
  return !Number.isNaN(new Date(ms).getTime());
}

export function formatReminderText(rem: FiredReminder, now: Date | number, timeZone: string): string {
  let schedule = '';
  if (rem.everySeconds !== null) schedule = `, repeats every ${rem.everySeconds}s`;
  else if (isRenderableTime(rem.createdAt)) schedule = `, set ${formatAgentDateTime(rem.createdAt, timeZone)}`;
  if (+now - rem.fireAt >= LATE_MS && isRenderableTime(rem.fireAt)) schedule += `, due ${formatAgentDateTime(rem.fireAt, timeZone)}`;
  return `[reminder ${rem.id}${schedule} · current time: ${formatAgentDateTime(now, timeZone)}] ${rem.message}`;
}
