import { describe, it, expect } from 'vitest';
import { timezoneOffsetMinutes, formatLocalTime, assertTimeZone } from '../src/clock.js';

describe('timezoneOffsetMinutes', () => {
  it('is 480 for Asia/Manila, 0 for UTC, -300 for New York in January and -240 in July', () => {
    expect(timezoneOffsetMinutes('Asia/Manila', new Date('2026-10-27T12:00:00Z'))).toBe(480);
    expect(timezoneOffsetMinutes('UTC', new Date('2026-10-27T12:00:00Z'))).toBe(0);
    expect(timezoneOffsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(timezoneOffsetMinutes('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe(-240);
  });
  it('handles non-whole-hour zones', () => {
    expect(timezoneOffsetMinutes('Asia/Kathmandu', new Date('2026-10-27T12:00:00Z'))).toBe(345);
  });
});

describe('formatLocalTime', () => {
  it('formats weekday, date, 24-hour HH:MM and the zone name in the given zone', () => {
    expect(formatLocalTime(new Date('2026-10-27T04:05:00Z'), 'Asia/Manila')).toBe('Tuesday, 27 October 2026, 12:05 GMT+8');
    expect(formatLocalTime(new Date('2026-10-27T00:30:00Z'), 'UTC')).toBe('Tuesday, 27 October 2026, 00:30 UTC');
    expect(formatLocalTime(new Date('2026-10-27T21:36:00Z'), 'Europe/London')).toBe('Tuesday, 27 October 2026, 21:36 GMT');
    expect(formatLocalTime(new Date('2026-07-15T12:00:00Z'), 'Europe/London')).toBe('Wednesday, 15 July 2026, 13:00 GMT+1');
  });
});

describe('assertTimeZone', () => {
  it('throws for an unknown zone', () => {
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(RangeError);
    expect(() => assertTimeZone('Asia/Manila')).not.toThrow();
  });
});
