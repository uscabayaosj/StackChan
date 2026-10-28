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

import { spokenTime, localHourMinute } from '../src/clock.js';
describe('spokenTime', () => {
  it('says the time the way a person would', () => {
    expect(spokenTime(5, 59)).toBe('one minute to six in the morning');
    expect(spokenTime(5, 58)).toBe('two minutes to six in the morning');
    expect(spokenTime(6, 2)).toBe('two minutes past six in the morning');
    expect(spokenTime(17, 47)).toBe('thirteen minutes to six in the afternoon');
    expect(spokenTime(17, 40)).toBe('twenty to six in the afternoon');
    expect(spokenTime(21, 15)).toBe('quarter past nine in the evening');
    expect(spokenTime(21, 30)).toBe('half past nine in the evening');
    expect(spokenTime(9, 45)).toBe('quarter to ten in the morning');
    expect(spokenTime(18, 0)).toBe("six o'clock in the evening");
    expect(spokenTime(22, 23)).toBe('twenty-three minutes past ten at night');
    expect(spokenTime(0, 0)).toBe('midnight');
    expect(spokenTime(12, 0)).toBe('noon');
    expect(spokenTime(23, 50)).toBe('ten to midnight');
    expect(spokenTime(0, 10)).toBe('ten past twelve at night');
    expect(spokenTime(11, 55)).toBe('five to noon');
    expect(spokenTime(12, 5)).toBe('five past twelve in the afternoon');
  });
  it('reads hour and minute in the device zone', () => {
    expect(localHourMinute(new Date('2026-07-15T12:47:00Z'), 'Europe/London')).toEqual({ hour: 13, minute: 47 });
    expect(localHourMinute(new Date('2026-10-28T05:59:00Z'), 'Europe/London')).toEqual({ hour: 5, minute: 59 });
  });
});
