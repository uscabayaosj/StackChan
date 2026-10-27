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
