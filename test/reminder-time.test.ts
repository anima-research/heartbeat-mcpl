import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_REMINDER_TIME, LAST_REMINDER_TIME, canHoldTime, parseReminderTime } from '../src/reminder-time.js';
import { serverWithHost } from './scripted-host.js';

for (const [label, time, zone, expected] of [
  ['winter', '2024-01-15T09:00:00', 'America/New_York', '2024-01-15T14:00:00Z'],
  ['summer', '2024-07-15T09:00:00', 'America/New_York', '2024-07-15T13:00:00Z'],
  ['after fall transition', '2024-11-03T09:00:00', 'America/New_York', '2024-11-03T14:00:00Z'],
  ['fractional seconds', '2024-07-15T09:00:00.123', 'America/New_York', '2024-07-15T13:00:00.123Z'],
  ['quarter-hour offset', '2024-07-15T09:00', 'Asia/Kathmandu', '2024-07-15T03:15:00Z'],
  ['UTC', '2024-07-15T09:00', 'UTC', '2024-07-15T09:00:00Z'],
  ['year below 100', '0042-07-15T09:00', 'UTC', '0042-07-15T09:00:00Z'],
  ['end-of-day', '2024-07-15T24:00', 'America/New_York', '2024-07-16T04:00:00Z'],
  ['end-of-month midnight', '2024-07-31T24:00:00', 'America/New_York', '2024-08-01T04:00:00Z'],
  ['historical offset seconds', '1890-07-15T09:00', 'Europe/Paris', '1890-07-15T08:50:39Z'],
  ['maximum Date boundary', '+275760-09-13T00:00', 'UTC', '+275760-09-13T00:00:00Z'],
  ['minimum Date boundary', '-271821-04-20T00:00', 'UTC', '-271821-04-20T00:00:00Z'],
  ['date-only (midnight)', '2024-07-15', 'America/New_York', '2024-07-15T04:00:00Z'],
  ['space-separated', '2024-07-15 09:00', 'America/New_York', '2024-07-15T13:00:00Z'],
  ['lowercase-t', '2024-07-15t09:00', 'America/New_York', '2024-07-15T13:00:00Z'],
]) {
  test(`offset-less ${label} time uses the supplied agent zone`, () => {
    assert.equal(parseReminderTime(time, zone), Date.parse(expected));
  });
}

for (const time of [
  '2024-07-15T09:00:00Z',
  '2024-07-15T09:00:00+05:30',
  '2024-07-15T09:00:00-0400',
  '2024-11-03T01:30:00-04:00',
  '2024-11-03T01:30:00-05:00',
  '2024-03-10T02:30:00-05:00',
  '+275760-09-13T00:00:00Z',
  '-271821-04-20T00:00:00Z',
]) {
  test(`explicit offset retains its instant: ${time}`, () => {
    assert.equal(parseReminderTime(time, 'America/New_York'), Date.parse(time));
  });
}

for (const [time, expected] of [
  ['2024-07-15T09:00:00-04', '2024-07-15T13:00:00Z'],
  ['2024-07-15T09:00+05', '2024-07-15T04:00:00Z'],
  ['2024-07-15T09:00:00+0530', '2024-07-15T03:30:00Z'],
  ['2024-07-15T09:00:00z', '2024-07-15T09:00:00Z'],
  ['1890-07-15T09:00:00+000921', '1890-07-15T08:50:39Z'],
]) {
  test(`explicit offset in another ISO form retains its instant: ${time}`, () => {
    assert.equal(parseReminderTime(time, 'America/New_York'), Date.parse(expected));
  });
}

test('an explicit offset that puts the instant outside the Date range is refused as out of range', () => {
  for (const time of ['+275760-09-13T00:00:00-01:00', '-271821-04-20T00:00:00+01:00']) {
    assert.throws(() => parseReminderTime(time, 'UTC'), /outside the times a reminder can hold/);
  }
});

test('a historical offset containing seconds can be specified explicitly', () => {
  assert.equal(
    parseReminderTime('1890-07-15T09:00:00+00:09:21', 'Europe/Paris'),
    Date.parse('1890-07-15T08:50:39Z'),
  );
});

test('a repeated hour names the agent zone and both candidate offsets', () => {
  assert.throws(
    () => parseReminderTime('2024-11-03T01:30:00', 'America/New_York'),
    (error: Error) => /occurs twice/.test(error.message)
      && error.message.includes('America/New_York')
      && error.message.includes('-04:00')
      && error.message.includes('-05:00'),
  );
});

test('a repeated hour whose later offset is zero names it as +00:00', () => {
  assert.throws(
    () => parseReminderTime('2024-10-27T01:30:00', 'Europe/London'),
    (error: Error) => /occurs twice/.test(error.message) && error.message.includes('Include +01:00 or +00:00'),
  );
});

test('a zero offset that Intl names as bare GMT is labelled +00:00', (t) => {
  // ICU 78 (Node 20.20, 24.21) names a zero offset GMT+00:00; ICU 72 to 77 (Node 20.0 to 24.0) name it GMT.
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (this: Intl.DateTimeFormat, date?: Date | number) {
    return formatToParts.call(this, date).map((part) => (
      part.type === 'timeZoneName' && part.value === 'GMT+00:00' ? { ...part, value: 'GMT' } : part));
  });
  assert.throws(
    () => parseReminderTime('2024-10-27T01:30:00', 'Europe/London'),
    (error: Error) => error.message.includes('Include +01:00 or +00:00'),
  );
});

test('an offset name Intl gives that this code cannot read is refused, never read as UTC', (t) => {
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (this: Intl.DateTimeFormat, date?: Date | number) {
    return formatToParts.call(this, date).map((part) => (
      part.type === 'timeZoneName' ? { ...part, value: 'GMT+5' } : part));
  });
  assert.throws(
    () => parseReminderTime('2024-07-15T09:00:00', 'Asia/Karachi'),
    /Cannot read the UTC offset for Asia\/Karachi\. Give atIso an explicit UTC offset instead\./,
  );
});

test('a time a permanent offset decrease repeats is refused with both offsets', () => {
  assert.throws(
    () => parseReminderTime('2014-10-26T01:30:00', 'Europe/Moscow'),
    (error: Error) => /occurs twice/.test(error.message)
      && error.message.includes('+04:00')
      && error.message.includes('+03:00'),
  );
});

test('a skipped hour is refused rather than shifted', () => {
  assert.throws(
    () => parseReminderTime('2024-03-10T02:30:00', 'America/New_York'),
    /does not exist in America\/New_York/,
  );
});

test('a half-hour repeated interval is refused with its actual offsets', () => {
  assert.throws(
    () => parseReminderTime('2024-04-07T01:45:00', 'Australia/Lord_Howe'),
    (error: Error) => /occurs twice/.test(error.message)
      && error.message.includes('+11:00')
      && error.message.includes('+10:30'),
  );
});

test('a half-hour skipped interval is refused', () => {
  assert.throws(
    () => parseReminderTime('2024-10-06T02:15:00', 'Australia/Lord_Howe'),
    /does not exist in Australia\/Lord_Howe/,
  );
});

test('a date alone whose midnight the zone skips is refused, naming that midnight', () => {
  assert.throws(
    () => parseReminderTime('2024-03-10', 'America/Havana'),
    (error: Error) => error.message.startsWith(
      '"atIso" 2024-03-10 is read as 2024-03-10T00:00, which does not exist in America/Havana.',
    ),
  );
});

test('a date alone whose midnight the zone repeats is refused, naming that midnight and its offsets', () => {
  assert.throws(
    () => parseReminderTime('2024-11-03', 'America/Havana'),
    (error: Error) => error.message.startsWith(
      '"atIso" 2024-11-03 is read as 2024-11-03T00:00, which occurs twice in America/Havana.',
    ) && error.message.includes('-04:00') && error.message.includes('-05:00'),
  );
});

test('an entire skipped calendar date is refused', () => {
  assert.throws(
    () => parseReminderTime('2011-12-30T12:00:00', 'Pacific/Apia'),
    /does not exist in Pacific\/Apia/,
  );
});

test('malformed or out-of-range explicit offsets are refused, naming atIso and the forms accepted', () => {
  for (const offset of ['+24:00', '+00:60', '+00:00:60', '+0:0', '+053', '+05:3000', '+0530:15', '+05:30:1']) {
    assert.throws(
      () => parseReminderTime(`2024-07-15T09:00:00${offset}`, 'UTC'),
      (error: Error) => error.message.startsWith(`"atIso" has an invalid UTC offset ${offset}:`)
        && error.message.includes('±hh, ±hh:mm or ±hhmm'),
    );
  }
});

test('out-of-range clock fields are refused, with or without an offset', () => {
  for (const time of [
    '2024-07-15T25:00', '2024-07-15T09:60', '2024-07-15T09:00:60', '2024-07-15T24:30',
    '2024-07-15T25:00:00Z', '2024-07-15T09:60:00-04:00', '2024-07-15T09:00:60+05:30',
  ]) {
    assert.throws(() => parseReminderTime(time, 'America/New_York'), /valid ISO-8601/, time);
  }
});

test('invalid calendar dates and forms other than an ISO calendar date are refused with what atIso accepts', () => {
  for (const time of [
    '2024-02-30T09:00:00', 'not a timestamp', '2026-07', '2030',
    'Mon, 15 Jul 2030 09:00:00 GMT', '2030/07/15 09:00', '2024-07-15+05:00',
  ]) {
    assert.throws(
      () => parseReminderTime(time, 'America/New_York'),
      (error: Error) => /valid ISO-8601/.test(error.message)
        && error.message.includes('YYYY-MM-DD')
        && error.message.includes('Without one, the time is read in America/New_York'),
      time,
    );
  }
});

test('a reminder can hold exactly the times a Date can, both ends included, and the range is named by those ends', () => {
  assert.equal(canHoldTime(8.64e15), true);
  assert.equal(canHoldTime(8.64e15 + 1), false);
  assert.equal(canHoldTime(-8.64e15), true);
  assert.equal(canHoldTime(-8.64e15 - 1), false);
  assert.equal(canHoldTime(Infinity), false);
  assert.equal(canHoldTime(Number.NaN), false);
  // The refusals and log lines name the range with these, and the log test
  // builds its expected lines from them, so they're pinned here.
  assert.equal(Date.parse(FIRST_REMINDER_TIME), -8.64e15);
  assert.equal(Date.parse(LAST_REMINDER_TIME), 8.64e15);
});

test('the log keeps each reminder a stored time drops or ends, whole, with the range', async () => {
  const now = Date.now();
  const row = (id: string, fireAt: number | null, everySeconds: number | null) =>
    ({ id, message: `the message of ${id}`, createdAt: now, fireAt, everySeconds });
  // Past the range, the null JSON wrote for an infinite time, and below the
  // range: each dropped at load. And a recurring reminder whose next time is
  // past the last one, which ends once the host takes its push.
  const dropped = [row('rem_far', now + 1e16, null), row('rem_null', null, null), row('rem_low', -9e15, 60)];
  const last = row('rem_last', now + 1000, 1e13);
  const h = await serverWithHost(() => ({}), { reminders: [...dropped, last] });
  try {
    await h.pushCount(1);
    const ended = `[heartbeat-mcpl] ended recurring reminder ${JSON.stringify(last)}: its next time, ${last.fireAt + 1e13 * 1000}, `
      + `is past ${LAST_REMINDER_TIME}, the last time a reminder can hold`;
    // The end is logged once the server has read the host's answer, a little after the push.
    for (const deadline = Date.now() + 5_000; !h.stderr().split('\n').includes(ended) && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lines = h.stderr().split('\n');
    for (const r of dropped) {
      const line = `[heartbeat-mcpl] dropped reminder ${JSON.stringify(r)}: its stored time is outside the times a reminder can hold, `
        + `${FIRST_REMINDER_TIME} to ${LAST_REMINDER_TIME}`;
      assert.ok(lines.includes(line), `expected the log line\n${line}\nin\n${h.stderr()}`);
    }
    assert.ok(lines.includes(ended), `expected the log line\n${ended}\nin\n${h.stderr()}`);
  } finally {
    h.close();
  }
});

test('a stored row dropped for its time stays in the file until the next save, which leaves it out', async () => {
  const now = Date.now();
  const row = (id: string, fireAt: number | null) =>
    ({ id, message: `the message of ${id}`, createdAt: now, fireAt, everySeconds: null });
  const rows = [row('rem_far', now + 1e16), row('rem_null', null), row('rem_ok', now + 3_600_000)];
  const h = await serverWithHost(() => ({}), { reminders: rows });
  try {
    // Once the list answers, the file has been read and the rows dropped.
    assert.doesNotMatch(await h.call('reminder_list'), /rem_far|rem_null/);
    assert.deepEqual(h.stored(), rows, 'loading writes nothing');
    await h.call('reminder_add', { message: 'later', inHours: 2 });
    const ids = h.stored().map((r) => r.id);
    assert.equal(ids.length, 2, `the save leaves the dropped rows out: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('rem_ok'));
  } finally {
    h.close();
  }
});
