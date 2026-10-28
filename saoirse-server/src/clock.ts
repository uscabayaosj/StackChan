/** Offset of `timeZone` (IANA name) from UTC at instant `at`, in minutes east of UTC (Manila = 480). */
export function timezoneOffsetMinutes(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
  // 'GMT' for UTC itself, otherwise 'GMT+08:00' / 'GMT-05:00' / 'GMT+05:45'.
  const m = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -minutes : minutes;
}

/** 'Tuesday, 27 October 2026, 12:05 GMT+8' for `at` in `timeZone`; built from parts so it does not depend on ICU phrasing. The zone name stops the model inventing one. */
export function formatLocalTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

/** Throws a RangeError for a time zone name this runtime does not know. */
export function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat('en-US', { timeZone });
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
function words(n: number): string {
  if (n < 20) return SMALL[n];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'][Math.floor(n / 10)];
  return n % 10 ? `${tens}-${SMALL[n % 10]}` : tens;
}
function partOfDay(h: number): string {
  if (h >= 5 && h < 12) return 'in the morning';
  if (h >= 12 && h < 18) return 'in the afternoon';
  if (h >= 18 && h < 22) return 'in the evening';
  return 'at night';
}

/**
 * The time as a person says it ("twenty-three minutes to six in the evening"), so the model reads it
 * out instead of converting digits (gpt-oss got that wrong about a third of the time).
 */
export function spokenTime(hour: number, minute: number): string {
  if (minute === 0 && hour === 0) return 'midnight';
  if (minute === 0 && hour === 12) return 'noon';
  const toNext = minute > 30;
  const h24 = toNext ? (hour + 1) % 24 : hour;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  // Part of day from the current hour ("ten to six in the morning" at 05:50).
  const day = partOfDay(hour);
  // "ten to midnight" / "five to noon", but "ten past twelve at night".
  const named = toNext && (h24 === 0 || h24 === 12);
  const hourWord = named ? (h24 === 0 ? 'midnight' : 'noon') : words(h12);
  const suffix = named ? '' : ` ${day}`;
  if (minute === 0) return `${words(h12)} o'clock ${day}`;
  if (minute === 15) return `quarter past ${hourWord}${suffix}`;
  if (minute === 30) return `half past ${hourWord}${suffix}`;
  if (minute === 45) return `quarter to ${hourWord}${suffix}`;
  const m = toNext ? 60 - minute : minute;
  const unit = m % 5 === 0 ? '' : m === 1 ? ' minute' : ' minutes';
  return `${words(m)}${unit} ${toNext ? 'to' : 'past'} ${hourWord}${suffix}`;
}

/** Hour and minute of `at` in `timeZone`. */
export function localHourMinute(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return { hour: get('hour'), minute: get('minute') };
}
