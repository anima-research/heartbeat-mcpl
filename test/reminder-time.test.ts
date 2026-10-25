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

test('a repeated hour names the agent zone and both values to copy', () => {
  assert.throws(
    () => parseReminderTime('2024-11-03T01:30:00', 'America/New_York'),
    { message: '"atIso" "2024-11-03T01:30:00" happens twice in America/New_York, where the clocks go back over it. '
      + 'End it with the offset you mean: "2024-11-03T01:30:00-04:00" or "2024-11-03T01:30:00-05:00".' },
  );
});

const londonFold = {
  message: '"atIso" "2024-10-27T01:30:00" happens twice in Europe/London, where the clocks go back over it. '
    + 'End it with the offset you mean: "2024-10-27T01:30:00+01:00" or "2024-10-27T01:30:00+00:00".',
};

test('a repeated hour whose later offset is zero names it as +00:00', () => {
  assert.throws(() => parseReminderTime('2024-10-27T01:30:00', 'Europe/London'), londonFold);
});

test('a zero offset that Intl names as bare GMT is labelled +00:00', (t) => {
  // ICU 78 names a zero offset GMT+00:00, where ICU 76, which Node 22.12.0 has, names it GMT.
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (this: Intl.DateTimeFormat, date?: Date | number) {
    return formatToParts.call(this, date).map((part) => (
      part.type === 'timeZoneName' && part.value === 'GMT+00:00' ? { ...part, value: 'GMT' } : part));
  });
  assert.throws(() => parseReminderTime('2024-10-27T01:30:00', 'Europe/London'), londonFold);
});

test('an offset name Intl gives that this code cannot read is refused, never read as UTC', (t) => {
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (this: Intl.DateTimeFormat, date?: Date | number) {
    return formatToParts.call(this, date).map((part) => (
      part.type === 'timeZoneName' ? { ...part, value: 'GMT+5' } : part));
  });
  assert.throws(
    () => parseReminderTime('2024-07-15T09:00:00', 'Asia/Karachi'),
    { message: '"atIso" "2024-07-15T09:00:00" has no offset, and the zone it would be read in, Asia/Karachi, can\'t be read here. '
      + 'End it with an offset, like "2024-07-15T09:00:00Z" or "2024-07-15T09:00:00+01:00", or give a delay from now in inSeconds, inMinutes or inHours.' },
  );
});

test('a time a permanent offset decrease repeats is refused with both offsets', () => {
  assert.throws(
    () => parseReminderTime('2014-10-26T01:30:00', 'Europe/Moscow'),
    { message: '"atIso" "2014-10-26T01:30:00" happens twice in Europe/Moscow, where the clocks go back over it. '
      + 'End it with the offset you mean: "2014-10-26T01:30:00+04:00" or "2014-10-26T01:30:00+03:00".' },
  );
});

test('a skipped hour is refused rather than shifted, with the offsets on either side to copy', () => {
  assert.throws(
    () => parseReminderTime('2024-03-10T02:30:00', 'America/New_York'),
    { message: '"atIso" "2024-03-10T02:30:00" doesn\'t exist in America/New_York, where the clocks skip over it. '
      + 'Give a time that exists there, or end it with an offset to say which instant you mean, '
      + 'like "2024-03-10T02:30:00-05:00" or "2024-03-10T02:30:00-04:00".' },
  );
});

test('a half-hour repeated interval is refused with its actual offsets', () => {
  assert.throws(
    () => parseReminderTime('2024-04-07T01:45:00', 'Australia/Lord_Howe'),
    { message: '"atIso" "2024-04-07T01:45:00" happens twice in Australia/Lord_Howe, where the clocks go back over it. '
      + 'End it with the offset you mean: "2024-04-07T01:45:00+11:00" or "2024-04-07T01:45:00+10:30".' },
  );
});

test('a half-hour skipped interval is refused, with the offsets on either side to copy', () => {
  assert.throws(
    () => parseReminderTime('2024-10-06T02:15:00', 'Australia/Lord_Howe'),
    { message: '"atIso" "2024-10-06T02:15:00" doesn\'t exist in Australia/Lord_Howe, where the clocks skip over it. '
      + 'Give a time that exists there, or end it with an offset to say which instant you mean, '
      + 'like "2024-10-06T02:15:00+10:30" or "2024-10-06T02:15:00+11:00".' },
  );
});

test('a date alone whose midnight the zone skips is refused, naming that midnight', () => {
  assert.throws(
    () => parseReminderTime('2024-03-10', 'America/Havana'),
    { message: '"atIso" "2024-03-10" is read as 2024-03-10T00:00, which doesn\'t exist in America/Havana, where the clocks '
      + 'skip over it. Give a time that exists there, or end it with an offset to say which instant you mean, '
      + 'like "2024-03-10T00:00-05:00" or "2024-03-10T00:00-04:00".' },
  );
});

test('a date alone whose midnight the zone repeats is refused, naming that midnight and its offsets', () => {
  assert.throws(
    () => parseReminderTime('2024-11-03', 'America/Havana'),
    { message: '"atIso" "2024-11-03" is read as 2024-11-03T00:00, which happens twice in America/Havana, where the clocks '
      + 'go back over it. End it with the offset you mean: "2024-11-03T00:00-04:00" or "2024-11-03T00:00-05:00".' },
  );
});

test('an entire skipped calendar date is refused, with the offsets on either side to copy', () => {
  assert.throws(
    () => parseReminderTime('2011-12-30T12:00:00', 'Pacific/Apia'),
    { message: '"atIso" "2011-12-30T12:00:00" doesn\'t exist in Pacific/Apia, where the clocks skip over it. '
      + 'Give a time that exists there, or end it with an offset to say which instant you mean, '
      + 'like "2011-12-30T12:00:00-10:00" or "2011-12-30T12:00:00+14:00".' },
  );
});

test('malformed or out-of-range explicit offsets are refused, naming the offset and the forms to use', () => {
  for (const offset of ['+24:00', '+00:60', '+00:00:60', '+0:0', '+053', '+05:3000', '+0530:15', '+05:30:1']) {
    assert.throws(
      () => parseReminderTime(`2024-07-15T09:00:00${offset}`, 'UTC'),
      { message: `"atIso" "2024-07-15T09:00:00${offset}" ends in "${offset}", which isn't a UTC offset. `
        + 'End it with Z for UTC, or an offset like +05:30, +0530 or +05.' },
    );
  }
});

test('an offset this doesn\'t read is refused before the day or the clock, so no time offered to copy keeps it', () => {
  for (const [time, offset] of [
    ['2030-02-30T09:00+25:00', '+25:00'], ['2030-07-15T25:00+5:30', '+5:30'], ['+275760-09-14T00:00+99:99', '+99:99'],
  ]) {
    assert.throws(() => parseReminderTime(time, 'UTC'), {
      message: `"atIso" "${time}" ends in "${offset}", which isn't a UTC offset. `
        + 'End it with Z for UTC, or an offset like +05:30, +0530 or +05.',
    }, time);
  }
});

test('out-of-range clock fields are refused, with an example that keeps the offset or names the zone', () => {
  for (const [time, example] of [
    ['2024-07-15T25:00', '"2024-07-15T09:00", read in America/New_York'],
    ['2024-07-15T09:60', '"2024-07-15T09:00", read in America/New_York'],
    ['2024-07-15T09:00:60', '"2024-07-15T09:00", read in America/New_York'],
    ['2024-07-15T24:30', '"2024-07-15T09:00", read in America/New_York'],
    ['2024-07-15T24:00:01', '"2024-07-15T09:00", read in America/New_York'],
    ['2024-07-15T24:00:00.5', '"2024-07-15T09:00", read in America/New_York'],
    ['2024-07-15T25:00:00Z', '"2024-07-15T09:00Z"'],
    ['2024-07-15T09:60:00-04:00', '"2024-07-15T09:00-04:00"'],
    ['2024-07-15T09:00:60+05:30', '"2024-07-15T09:00+05:30"'],
  ]) {
    assert.throws(() => parseReminderTime(time, 'America/New_York'), {
      message: `"atIso" "${time}" has a time no clock shows: hours run 00 to 23 and minutes and seconds 00 to 59, `
        + `and 24:00, the end of the day, takes no minutes, seconds or milliseconds after it. Give one like ${example}.`,
    }, time);
  }
});

test('for these days and zones, a time offered to copy for a day or a clock time is one atIso accepts, in the zone the refusal names', () => {
  for (const [time, zone] of [
    ['2024-02-30T09:00:00', 'America/New_York'], ['2100-02-29T09:00+01:00', 'UTC'], ['2024-04-31T09:00Z', 'Asia/Kolkata'],
    ['2024-07-15T25:00', 'America/New_York'], ['2024-07-15T24:00:01', 'Europe/Berlin'], ['2024-07-15T09:60:00-04:00', 'UTC'],
    ['2024-07-15T09:00:60+05:30', 'America/New_York'],
  ]) {
    let message = '';
    try { parseReminderTime(time, zone); } catch (error) { message = (error as Error).message; }
    const copy = /like ("[^"]+")/.exec(message)?.[1];
    assert.ok(copy, `${time}: ${message}`);
    const offset = /T[\d:.]+(Z|[+-][\d:]+)$/.exec(time)?.[1];
    if (offset) assert.ok(copy.endsWith(`${offset}"`) && !message.includes(', read in '), message);
    else assert.ok(message.includes(`${copy}, read in ${zone}`), message);
    assert.doesNotThrow(() => parseReminderTime(JSON.parse(copy), zone), `${time} offers ${copy}`);
  }
});

test('24:00 is the end of its day, and digits past the millisecond don\'t count', () => {
  assert.equal(parseReminderTime('2024-07-15T24:00Z', 'UTC'), Date.parse('2024-07-16T00:00:00Z'));
  assert.equal(parseReminderTime('2024-07-15T24:00:00.0001Z', 'UTC'), Date.parse('2024-07-16T00:00:00Z'));
});

test('a day the calendar doesn\'t have is refused, naming it', () => {
  const zoned = '"2030-03-01T09:00", read in America/New_York';
  for (const [time, day, example] of [
    ['2024-02-30T09:00:00', '2024-02-30', zoned], ['2023-02-29', '2023-02-29', zoned], ['2024-13-01', '2024-13-01', zoned],
    ['2024-07-00', '2024-07-00', zoned], ['1900-02-29', '1900-02-29', zoned], ['2100-02-29T09:00+01:00', '2100-02-29', '"2030-03-01T09:00+01:00"'],
    ['2024-04-31T09:00Z', '2024-04-31', '"2030-03-01T09:00Z"'],
  ]) {
    assert.throws(() => parseReminderTime(time, 'America/New_York'), {
      message: `"atIso" "${time}" names a day the calendar doesn't have, ${day}. Give a real date, like ${example}.`,
    }, time);
  }
  assert.equal(parseReminderTime('2024-02-29T00:00Z', 'UTC'), Date.parse('2024-02-29T00:00:00Z'));
  assert.equal(parseReminderTime('2000-02-29T00:00Z', 'UTC'), Date.parse('2000-02-29T00:00:00Z'));
});

test('forms other than an ISO calendar date are refused with forms to copy', () => {
  for (const time of [
    'not a timestamp', '2026-07', '2030', 'Mon, 15 Jul 2030 09:00:00 GMT', '2030/07/15 09:00', '2024-07-15+05:00', '-000000-01-01',
  ]) {
    assert.throws(() => parseReminderTime(time, 'America/New_York'), {
      message: `"atIso" ${JSON.stringify(time)} isn't a time this tool reads. Give a date and time like "2030-07-15T09:00", `
        + 'read in America/New_York, or end it with an offset, like "2030-07-15T09:00Z" or "2030-07-15T09:00+01:00". A date '
        + 'alone is midnight in America/New_York. For a delay from now, give inSeconds, inMinutes or inHours instead.',
    }, time);
  }
});

test('a real day and time past either end of the range is refused as out of range, not as a skipped time', () => {
  const outOfRange = (time: string, zone: string | null) => ({
    message: `"atIso" "${time}"${zone ? `, read in ${zone},` : ''} is outside the times a reminder can hold, -271821-04-20T00:00:00Z to `
      + '+275760-09-13T00:00:00Z. Give a time inside that range.',
  });
  for (const [time, zone] of [
    ['+275760-09-13T00:00:01', 'UTC'], ['+275760-09-14', 'UTC'], ['-271821-04-19T23:59', 'UTC'],
    ['+275760-09-13T00:00', 'America/New_York'],
  ]) {
    assert.throws(() => parseReminderTime(time, zone), outOfRange(time, zone), `${time} in ${zone}`);
  }
  assert.throws(() => parseReminderTime('-271821-04-19T24:00Z', 'UTC'), outOfRange('-271821-04-19T24:00Z', null));
});

test('a reminder can hold exactly the times a Date can, both ends included, and the range is named by those ends', () => {
  assert.equal(canHoldTime(8.64e15), true);
  assert.equal(canHoldTime(8.64e15 + 1), false);
  assert.equal(canHoldTime(-8.64e15), true);
  assert.equal(canHoldTime(-8.64e15 - 1), false);
  assert.equal(canHoldTime(Infinity), false);
  assert.equal(canHoldTime(Number.NaN), false);
  assert.equal(Date.parse(FIRST_REMINDER_TIME), -8.64e15);
  assert.equal(Date.parse(LAST_REMINDER_TIME), 8.64e15);
});

test('the log keeps each reminder a stored time drops or ends, whole, with the range', async () => {
  const now = Date.now();
  const row = (id: string, fireAt: number | null, everySeconds: number | null) =>
    ({ id, message: `the message of ${id}`, createdAt: now, fireAt, everySeconds });
  // JSON writes an infinite time as null.
  const dropped = [row('rem_far', now + 1e16, null), row('rem_null', null, null), row('rem_low', -9e15, 60)];
  const lastAt = now + 1000;
  const last = row('rem_last', lastAt, 1e13);
  const h = await serverWithHost(() => ({}), { reminders: [...dropped, last] });
  try {
    await h.pushCount(1);
    const ended = `[heartbeat-mcpl] ended recurring reminder ${JSON.stringify(last)}: its next time, ${lastAt + 1e13 * 1000}, `
      + `is past ${LAST_REMINDER_TIME}, the last time a reminder can hold`;
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
