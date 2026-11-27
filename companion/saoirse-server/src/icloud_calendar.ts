import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import ICAL from 'ical.js';
import { CalendarError, ICloudDav, type CalendarObject } from './icloud_dav.js';
import { makeLiveCard, type LiveCard } from './live_cards.js';

type EventComponent = InstanceType<typeof ICAL.Component>;
type CalendarTime = InstanceType<typeof ICAL.Time>;
type ZonedTime = Temporal.ZonedDateTime;
interface EventTime { at: ZonedTime; allDay: boolean }
interface EventWindow { start: EventTime; end: EventTime }
interface CalendarEvent extends EventWindow { title: string; location?: string; component: EventComponent }
export interface CalendarChange { preview: string[]; card?: LiveCard; save(signal: AbortSignal): Promise<void> }

const DAY_MS = 86_400_000;
const MAX_DAYS = 31;
const MAX_SPOKEN_EVENTS = 5;

function time(value: unknown, zone: string): EventTime {
  if (typeof value !== 'string') throw new CalendarError('Please give me the date and time.');
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { at: Temporal.PlainDate.from(value).toZonedDateTime(zone), allDay: true };
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      return { at: Temporal.PlainDateTime.from(value).toZonedDateTime(zone, { disambiguation: 'reject' }), allDay: false };
    }
  } catch {
    throw new CalendarError('That date or time is invalid or ambiguous in the local time zone. Please give me a different time.');
  }
  throw new CalendarError('Please give me a clear local date and time.');
}

function parseTime(value: CalendarTime, property: string, component: EventComponent, zone: string): EventTime {
  if (value.isDate) return time(value.toString(), zone);
  if (value.zone === ICAL.Timezone.localTimezone) {
    const tzid = component.getFirstProperty(property)?.getParameter('tzid');
    const local = Temporal.PlainDateTime.from(value.toString());
    return { at: local.toZonedDateTime(typeof tzid === 'string' ? tzid : zone).withTimeZone(zone), allDay: false };
  }
  return { at: Temporal.Instant.fromEpochMilliseconds(value.toJSDate().getTime()).toZonedDateTimeISO(zone), allDay: false };
}

function icalTime(value: EventTime): CalendarTime {
  return value.allDay ? ICAL.Time.fromDateString(value.at.toPlainDate().toString())
    : ICAL.Time.fromJSDate(new Date(value.at.epochMilliseconds), true);
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim().slice(0, max) || undefined;
}

function field(value: unknown, name: string, max = 180): string {
  const cleaned = cleanText(value, max);
  if (!cleaned || (value as string).trim().length > max) throw new CalendarError(`Please give me a ${name} between 1 and ${max} characters.`);
  return cleaned;
}

function eventSummary(event: CalendarEvent, zone: string): string {
  const format = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: zone,
    ...(event.start.allDay ? {} : { hour: 'numeric', minute: '2-digit', hour12: true }),
  });
  const start = new Date(event.start.at.epochMilliseconds);
  // iCalendar all-day events have an exclusive end date. Speak the last occupied day.
  const end = new Date((event.end.allDay ? event.end.at.subtract({ days: 1 }) : event.end.at).epochMilliseconds);
  const range = end > start ? format.formatRange(start, end) : format.format(start);
  return `${event.title}, ${event.start.allDay ? 'all day, ' : ''}${range}${event.location ? `, at ${event.location}` : ''}`;
}

function parseCalendar(data: string): EventComponent {
  try {
    const calendar = new ICAL.Component(ICAL.parse(data));
    if (calendar.name === 'vcalendar') return calendar;
  } catch { /* Return a fixed error. Calendar payloads do not belong in logs. */ }
  throw new CalendarError('iCloud returned an unreadable calendar event.');
}

function parseEvent(component: EventComponent, zone: string): CalendarEvent {
  try {
    const event = new ICAL.Event(component);
    const start = parseTime(event.startDate, 'dtstart', component, zone);
    const end = parseTime(event.endDate, component.hasProperty('dtend') ? 'dtend' : 'dtstart', component, zone);
    return { component, start, end, title: cleanText(event.summary, 180) ?? 'Untitled event', location: cleanText(event.location, 180) };
  } catch {
    throw new CalendarError('iCloud returned an event with an unreadable date or time.');
  }
}

function validateWindow(window: EventWindow): void {
  if (window.start.allDay !== window.end.allDay || window.start.at.epochMilliseconds >= window.end.at.epochMilliseconds) {
    throw new CalendarError('Please give me a matching start and end, with the end after the start.');
  }
}

function queryWindow(args: Record<string, unknown>, zone: string): EventWindow {
  const start = time(args.from, zone);
  const end = time(args.until, zone);
  validateWindow({ start, end });
  if (end.at.epochMilliseconds - start.at.epochMilliseconds > (MAX_DAYS + 1) * DAY_MS) {
    throw new CalendarError('I can check up to a month at a time. Which dates should I check?');
  }
  return { start, end };
}

function setTimes(event: EventComponent, window: EventWindow): void {
  event.removeAllProperties('dtstart');
  event.removeAllProperties('dtend');
  event.removeAllProperties('duration');
  event.addPropertyWithValue('dtstart', icalTime(window.start));
  event.addPropertyWithValue('dtend', icalTime(window.end));
}

export class ICloudCalendar {
  constructor(private readonly dav: ICloudDav, private readonly zone: string, private readonly name = 'Calendar') {}

  private async events(window: EventWindow, signal: AbortSignal) {
    const utc = (value: EventTime) => ICAL.Time.fromJSDate(new Date(value.at.epochMilliseconds), true).toICALString();
    const objects = await this.dav.query(utc(window.start), utc(window.end), signal);
    const events = objects.flatMap(object => parseCalendar(object.data).getAllSubcomponents('vevent').flatMap(component => {
      if (component.getFirstPropertyValue('status') === 'CANCELLED') return [];
      if (component.hasProperty('rrule') || component.hasProperty('rdate')) {
        throw new CalendarError('iCloud did not expand the recurring events for that date range.');
      }
      return [{ ...parseEvent(component, this.zone), url: object.url }];
    }));
    return events.filter(event => event.start.at.epochMilliseconds < window.end.at.epochMilliseconds &&
      (event.end.at.epochMilliseconds > window.start.at.epochMilliseconds ||
        (event.end.at.equals(event.start.at) && event.start.at.epochMilliseconds === window.start.at.epochMilliseconds)))
      .sort((a, b) => a.start.at.epochMilliseconds - b.start.at.epochMilliseconds);
  }

  async list(args: Record<string, unknown>, signal: AbortSignal, display?: (card: LiveCard) => void): Promise<string[]> {
    const window = queryWindow(args, this.zone);
    const events = await this.events(window, signal);
    const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: this.zone });
    const timeLabel = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: this.zone });
    const items = events.slice(0, 11).map(event => ({
      title: event.title,
      badge: event.start.allDay ? 'All day' : timeLabel.format(event.start.at.epochMilliseconds),
      detail: [date.format(event.start.at.epochMilliseconds), event.location].filter(Boolean).join('  /  '),
    }));
    if (!events.length) items.push({ title: 'No events in this range', badge: '', detail: '' });
    if (events.length > 11) items.push({ title: `${events.length - 11} more. Ask for a shorter range.`, badge: '', detail: '' });
    const last = window.end.allDay ? window.end.at.subtract({ days: 1 }) : window.end.at;
    const days = date.formatRange(window.start.at.epochMilliseconds, last.epochMilliseconds);
    display?.(makeLiveCard('calendar', this.name, 'iCloud', items, { subtitle: days }));
    if (!events.length) return ['Your iCloud calendar has no events in that time range.'];
    const spoken = events.slice(0, MAX_SPOKEN_EVENTS).map(event => `${eventSummary(event, this.zone)}.`);
    const remaining = events.length - spoken.length;
    if (remaining > 0) spoken.push(`There ${remaining === 1 ? 'is one more event' : `are ${remaining} more events`} in that range.`);
    return spoken;
  }

  async prepare(action: 'create' | 'update', args: Record<string, unknown>, signal: AbortSignal): Promise<CalendarChange> {
    const title = field(args.title, 'title');
    let original: CalendarObject | undefined;
    let calendar: EventComponent;
    let component: EventComponent;
    let previous: CalendarEvent | undefined;
    let uid: string | undefined;
    if (action === 'update') {
      const matches = (await this.events(queryWindow(args, this.zone), signal))
        .filter(event => {
          const summary = event.component.getFirstPropertyValue('summary');
          return typeof summary === 'string' && summary.trim().normalize().toLowerCase() === title.normalize().toLowerCase();
        });
      if (!matches.length) throw new CalendarError('I could not find an event with that title and date on your iCloud calendar.');
      if (matches.length !== 1) throw new CalendarError('More than one event matches. Please specify a narrower date or time range.');
      original = await this.dav.original(matches[0].url, signal);
      calendar = parseCalendar(original.data);
      const events = calendar.getAllSubcomponents('vevent');
      component = events[0];
      if (events.length !== 1 || ['rrule', 'rdate', 'exdate', 'recurrence-id', 'organizer', 'attendee', 'related-to']
        .some(property => component.hasProperty(property))) {
        throw new CalendarError('I can edit one-off events without guests. Please use Apple Calendar to edit this event.');
      }
      previous = parseEvent(component, this.zone);
      if (component.getFirstPropertyValue('uid') !== matches[0].component.getFirstPropertyValue('uid') ||
          previous.title !== matches[0].title || !previous.start.at.equals(matches[0].start.at) ||
          !previous.end.at.equals(matches[0].end.at) || previous.location !== matches[0].location ||
          component.getFirstPropertyValue('status') === 'CANCELLED') {
        throw new CalendarError('That event changed while I was looking it up. Please ask again.');
      }
      if (args.new_title === undefined && args.location === undefined && args.start === undefined && args.end === undefined) {
        throw new CalendarError('What do you want to change about the event?');
      }
    } else {
      calendar = new ICAL.Component('vcalendar');
      calendar.addPropertyWithValue('version', '2.0');
      calendar.addPropertyWithValue('prodid', '-//StackChan//Saoirse Calendar//EN');
      component = new ICAL.Component('vevent');
      calendar.addSubcomponent(component);
      uid = randomUUID();
      component.addPropertyWithValue('uid', uid);
      component.addPropertyWithValue('summary', title);
    }

    if (!previous || args.start !== undefined || args.end !== undefined) {
      const start = args.start !== undefined || !previous ? time(args.start, this.zone) : previous.start;
      let end: EventTime;
      if (args.end !== undefined || !previous) {
        end = time(args.end, this.zone);
      } else {
        if (start.allDay !== previous.start.allDay) throw new CalendarError('Please give me both the new start and end.');
        const at = start.allDay
          ? start.at.add({ days: previous.start.at.toPlainDate().until(previous.end.at.toPlainDate()).days })
          : start.at.add({ milliseconds: previous.end.at.epochMilliseconds - previous.start.at.epochMilliseconds });
        end = { at, allDay: start.allDay };
      }
      validateWindow({ start, end });
      setTimes(component, { start, end });
    }
    if (previous && args.new_title !== undefined) component.updatePropertyWithValue('summary', field(args.new_title, 'new title'));
    if (args.location !== undefined) component.updatePropertyWithValue('location', field(args.location, 'location'));
    const updated = eventSummary(parseEvent(component, this.zone), this.zone);
    const prior = previous ? eventSummary(previous, this.zone) : undefined;
    const preview = [
      ...(prior ? [`Change ${prior}.`] : []),
      `${previous ? 'New details are' : 'Add'} ${updated}.`,
      'Say “confirm calendar change” to save it, or “cancel calendar change” to cancel.',
    ];
    const card = makeLiveCard('calendar', previous ? 'Edit event' : 'Add event', 'iCloud', [
      ...(prior ? [{ title: prior, badge: 'Before' }] : []),
      { title: updated, badge: previous ? 'After' : undefined },
    ], { subtitle: 'Say "confirm calendar change" to save.' });
    return { preview, card, save: signal => {
      const now = ICAL.Time.fromJSDate(new Date(), true);
      component.updatePropertyWithValue('dtstamp', now);
      if (previous) component.updatePropertyWithValue('last-modified', now);
      return this.dav.save(`${calendar.toString()}\r\n`, signal, original, uid);
    } };
  }
}
