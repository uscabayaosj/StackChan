import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { ICloudCalendar } from '../src/icloud_calendar.js';
import { ICloudDav } from '../src/icloud_dav.js';

const signal = new AbortController().signal;
const host = 'p42-caldav.icloud.com';
const collection = '/42/calendars/selected/';
const range = { from: '2026-07-01', until: '2026-07-03' };
const fixtureTitle = 'Piano & lunch';
const ics = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0',
  ...events.flatMap(lines => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');
const single = ['UID:example', `SUMMARY:${fixtureTitle}`, 'DTSTART:20260701T130000Z', 'DTEND:20260701T140000Z'];
const allDay = ['UID:second', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260702', 'DTEND;VALUE=DATE:20260703'];
const xml = (rows: string) => new Response(`<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${rows}</D:multistatus>`, { status: 207 });
const row = (href: string, props: string) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const named = (name: string) => `<D:displayname>${name}</D:displayname><D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>`;
const data = (value: string) => `<cal:calendar-data>${value.replace(/&/g, '&amp;')}</cal:calendar-data>`;

function setup(options: { duplicate?: boolean; untrustedRedirect?: boolean; updateStatus?: number; query?: string; original?: string } = {}) {
  const calls: { url: URL; method?: string; body?: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method, body: init?.body as string, headers });
    if (url.hostname === 'caldav.icloud.com') {
      if (options.untrustedRedirect) return new Response(null, { status: 307, headers: { location: 'https://example.org' } });
      return xml(row('/', '<D:current-user-principal><D:href>/42/principal/</D:href></D:current-user-principal>'));
    }
    if (url.pathname === '/42/principal/') return xml(row(url.pathname, `<cal:calendar-home-set><D:href>https://${host}/42/calendars/</D:href></cal:calendar-home-set>`));
    if (url.pathname === '/42/calendars/') return xml(row(collection, named('Test Calendar')) + row('/42/calendars/other/', named(options.duplicate ? 'Test Calendar' : 'Another calendar')));
    if (init?.method === 'REPORT') return xml(row(`https://caldav.icloud.com${collection}example.ics`, data(options.query ?? ics(single, allDay))));
    if (init?.method === 'GET') return new Response(options.original ?? ics([...single, 'DESCRIPTION:Private notes']), { headers: { ETag: '"original"' } });
    if (init?.method === 'PUT') return new Response(null, { status: options.updateStatus ?? 204 });
    throw new Error('Unexpected request in calendar test');
  };
  // Give generic discovery both a relative principal and a redirect to Apple's account partition.
  const fetchDav: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'caldav.icloud.com' && url.pathname === '/42/principal/') {
      return Promise.resolve(new Response(null, { status: 307, headers: { location: `https://${host}${url.pathname}` } }));
    }
    return fetchImpl(input, init);
  };
  const calendar = new ICloudCalendar(new ICloudDav({ account: 'example@icloud.com', password: 'test-secret', name: 'Test Calendar' }, fetchDav), 'Europe/London');
  return { calendar, calls };
}

function decodeEvent(body: string) {
  return new ICAL.Component(ICAL.parse(body)).getFirstSubcomponent('vevent')!;
}

describe('iCloud calendar', () => {
  it('discovers exactly one named calendar and reads expanded events in the robot time zone', async () => {
    const { calendar, calls } = setup();
    const events = await calendar.list(range, signal);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/Piano & lunch.*2:00.*3:00/i);
    expect(events[1]).toMatch(/Holiday.*all day.*2 Jul/i);
    const report = calls.find(call => call.method === 'REPORT')!;
    expect(report.url.href).toBe(`https://${host}${collection}`);
    expect(report.body).toContain('<c:expand start="20260630T230000Z" end="20260702T230000Z"/>');
    expect(report.headers.get('Authorization')).toMatch(/^Basic /);
  });

  it('rejects ambiguous calendar names and never forwards credentials to a non-Apple redirect', async () => {
    const duplicate = setup({ duplicate: true });
    await expect(duplicate.calendar.list(range, signal)).rejects.toThrow(/More than one/);
    expect(duplicate.calls.some(call => call.method === 'REPORT')).toBe(false);
    const redirect = setup({ untrustedRedirect: true });
    await expect(redirect.calendar.list(range, signal)).rejects.toThrow(/unexpected calendar address/);
    expect(redirect.calls).toHaveLength(1);
  });

  it('previews a new all-day event and writes valid iCalendar with a create-only precondition', async () => {
    const { calendar, calls } = setup();
    const change = await calendar.prepare('create', { title: 'Practice, strings; duet', start: '2026-07-01', end: '2026-07-02' }, signal);
    expect(change.preview.join(' ')).toContain('confirm calendar change');
    expect(calls.some(call => call.method === 'PUT')).toBe(false);
    await change.save(signal);
    const put = calls.at(-1)!;
    const event = decodeEvent(put.body!);
    expect(put.url.pathname).toBe(`${collection}${event.getFirstPropertyValue('uid')}.ics`);
    expect(put.headers.get('If-None-Match')).toBe('*');
    expect(event.getFirstPropertyValue('summary')).toBe('Practice, strings; duet');
    expect(event.getFirstProperty('dtstart')?.type).toBe('date');
    expect(event.getFirstPropertyValue('dtstamp')).toBeTruthy();
  });

  it('preserves an event’s duration and other properties, and uses its original ETag', async () => {
    const { calendar, calls } = setup();
    const change = await calendar.prepare('update', { ...range, title: fixtureTitle, start: '2026-07-02T17:00' }, signal);
    expect(calls.some(call => call.method === 'PUT')).toBe(false);
    await change.save(signal);
    const put = calls.at(-1)!;
    expect(put.headers.get('If-Match')).toBe('"original"');
    const event = new ICAL.Event(decodeEvent(put.body!));
    expect(event.uid).toBe('example');
    expect(event.startDate.toICALString()).toBe('20260702T160000Z');
    expect(event.endDate.toICALString()).toBe('20260702T170000Z');
    expect(event.description).toBe('Private notes');
  });

  it('rejects concurrent updates, recurring series and ambiguous local times', async () => {
    const changed = setup({ updateStatus: 412 });
    const change = await changed.calendar.prepare('update', { ...range, title: fixtureTitle, new_title: 'Lesson' }, signal);
    await expect(change.save(signal)).rejects.toThrow(/changed before/);
    expect(changed.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    const recurring = setup({ original: ics([...single, 'RRULE:FREQ=DAILY']) });
    await expect(recurring.calendar.prepare('update', { ...range, title: fixtureTitle, new_title: 'Lesson' }, signal)).rejects.toThrow(/one-off/);
    await expect(changed.calendar.prepare('create', { title: 'Lesson', start: '2026-10-25T01:30', end: '2026-10-25T02:30' }, signal)).rejects.toThrow(/ambiguous/);
  });
});
