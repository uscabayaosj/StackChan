import { DOMParser, onErrorStopParsing, type Element } from '@xmldom/xmldom';

const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const ICLOUD = new URL('https://caldav.icloud.com/');
const XMLNS = `xmlns:d="${DAV}" xmlns:c="${CALDAV}"`;
const MAX_DAV_BYTES = 4 * 1024 * 1024;

export class CalendarError extends Error {}

function appleUrl(href: string, base: URL): URL {
  const url = new URL(href, base);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search ||
      !/^(?:p\d+-)?caldav\.icloud\.com$/.test(url.hostname)) {
    throw new CalendarError('iCloud returned an unexpected calendar address.');
  }
  return url;
}

function children(parent: Element, namespace: string, localName: string): Element[] {
  const matches: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (child.namespaceURI === namespace && child.localName === localName) matches.push(child);
  }
  return matches;
}

async function readBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    size += value.byteLength;
    if (size > MAX_DAV_BYTES) {
      await reader.cancel();
      throw new CalendarError('iCloud returned too many calendar details. Try a shorter date range.');
    }
    body += decoder.decode(value, { stream: true });
  }
}

function containsResource(collection: URL, object: URL): boolean {
  // iCloud may use the generic hostname in DAV hrefs on its partition hosts.
  const prefix = collection.pathname;
  return object.pathname.startsWith(prefix) && /^[^/]+$/.test(object.pathname.slice(prefix.length));
}

export interface CalendarObject { url: URL; data: string; etag?: string }
export interface ICloudConfig { account: string; password: string; name: string }

export class ICloudDav {
  private readonly authorization: string;
  private collection?: URL;

  constructor(private readonly config: ICloudConfig, private readonly fetchImpl: typeof fetch) {
    this.authorization = `Basic ${Buffer.from(`${config.account}:${config.password}`).toString('base64')}`;
  }

  private async request(url: URL, init: RequestInit, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
    for (let redirects = 0; redirects <= 4; redirects++) {
      signal.throwIfAborted();
      const response = await this.fetchImpl(url, {
        ...init,
        headers: { ...init.headers, Authorization: this.authorization },
        redirect: 'manual', signal,
      });
      const location = response.headers.get('location');
      if (init.method !== 'PUT' && [301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        url = appleUrl(location, url);
        continue;
      }
      if (response.ok) return { response, url };
      await response.body?.cancel();
      if (response.status === 401) throw new CalendarError('iCloud rejected the calendar sign-in. Check the app-specific password.');
      if (response.status === 403) throw new CalendarError('iCloud denied access to that calendar. Check its sharing permissions.');
      if (response.status === 404 && init.method === 'GET') throw new CalendarError('That event is no longer in the calendar.');
      if (response.status === 412) throw new CalendarError('The calendar changed before I could save. Please ask again.');
      if (init.method === 'PUT' && response.status >= 500) throw new Error('iCloud did not confirm the save');
      throw new CalendarError('iCloud could not complete the calendar request.');
    }
    throw new CalendarError('iCloud could not locate the calendar.');
  }

  private async dav(url: URL, method: 'PROPFIND' | 'REPORT', depth: '0' | '1', body: string, signal: AbortSignal) {
    const result = await this.request(url, {
      method, body, headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
    }, signal);
    const xml = await readBody(result.response);
    if (result.response.status !== 207 || /<!DOCTYPE/i.test(xml)) throw new CalendarError('iCloud returned an unreadable calendar response.');
    try {
      const root = new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, 'application/xml').documentElement;
      if (root?.namespaceURI !== DAV || root.localName !== 'multistatus') throw new Error();
      const rows = children(root, DAV, 'response').map(row => ({
        href: children(row, DAV, 'href')[0]?.textContent?.trim(),
        props: children(row, DAV, 'propstat')
          .filter(stat => /^HTTP\/\S+ 200\b/.test(children(stat, DAV, 'status')[0]?.textContent?.trim() ?? ''))
          .flatMap(stat => children(stat, DAV, 'prop')),
      }));
      return { url: result.url, rows };
    } catch {
      throw new CalendarError('iCloud returned an unreadable calendar response.');
    }
  }

  private async discover(signal: AbortSignal): Promise<URL> {
    if (this.collection) return this.collection;
    const propfind = (url: URL, depth: '0' | '1', props: string) =>
      this.dav(url, 'PROPFIND', depth, `<d:propfind ${XMLNS}><d:prop>${props}</d:prop></d:propfind>`, signal);
    let url = ICLOUD;
    for (const [namespace, property, tag] of [
      [DAV, 'current-user-principal', 'd:current-user-principal'],
      [CALDAV, 'calendar-home-set', 'c:calendar-home-set'],
    ]) {
      const result = await propfind(url, '0', `<${tag}/>`);
      const href = result.rows.flatMap(row => row.props)
        .flatMap(prop => children(prop, namespace, property))
        .flatMap(prop => children(prop, DAV, 'href'))[0]?.textContent?.trim();
      if (!href) throw new CalendarError('iCloud did not return a calendar account for that sign-in.');
      url = appleUrl(href, result.url);
    }
    const result = await propfind(url, '1', '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>');
    const matches = result.rows.filter(({ href, props }) => href &&
      props.some(prop => children(prop, DAV, 'resourcetype').some(type => children(type, CALDAV, 'calendar').length)) &&
      props.some(prop => children(prop, DAV, 'displayname').some(name => name.textContent?.normalize() === this.config.name.normalize())) &&
      props.flatMap(prop => children(prop, CALDAV, 'supported-calendar-component-set')).every(set =>
        children(set, CALDAV, 'comp').some(comp => comp.getAttribute('name') === 'VEVENT')));
    if (matches.length !== 1) throw new CalendarError(matches.length
      ? 'More than one iCloud calendar has the configured name. Give the calendar a unique name.'
      : 'I could not find the configured iCloud calendar. Check its exact name.');
    const collection = appleUrl(matches[0].href!, result.url);
    if (!collection.pathname.endsWith('/')) collection.pathname += '/';
    // Keep the account partition from the calendar-home response for generic hrefs.
    if (collection.hostname === ICLOUD.hostname) collection.hostname = result.url.hostname;
    return this.collection = collection;
  }

  async query(start: string, end: string, signal: AbortSignal): Promise<CalendarObject[]> {
    const collection = await this.discover(signal);
    const range = `start="${start}" end="${end}"`;
    const result = await this.dav(collection, 'REPORT', '1', `
      <c:calendar-query ${XMLNS}>
        <d:prop><d:getetag/><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>
        <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
          <c:time-range ${range}/>
        </c:comp-filter></c:comp-filter></c:filter>
      </c:calendar-query>`, signal);
    return result.rows.flatMap(({ href, props }) => {
      const data = props.flatMap(prop => children(prop, CALDAV, 'calendar-data'))[0]?.textContent;
      if (!data || !href) throw new CalendarError('iCloud returned incomplete calendar results.');
      const url = appleUrl(href, result.url);
      if (!containsResource(collection, url)) throw new CalendarError('iCloud returned an unexpected event address.');
      if (url.hostname === ICLOUD.hostname) url.hostname = result.url.hostname;
      return [{ url, data }];
    });
  }

  async original(url: URL, signal: AbortSignal): Promise<CalendarObject> {
    const result = await this.request(url, { method: 'GET', headers: { Accept: 'text/calendar' } }, signal);
    if (result.url.pathname !== url.pathname) {
      await result.response.body?.cancel();
      throw new CalendarError('iCloud returned an unexpected event address.');
    }
    return { url: result.url, data: await readBody(result.response), etag: result.response.headers.get('etag') ?? undefined };
  }

  async save(data: string, signal: AbortSignal, original?: CalendarObject, uid?: string): Promise<void> {
    const url = original?.url ?? new URL(`${uid}.ics`, await this.discover(signal));
    const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (original) {
      if (!original.etag || !/^"[^"\r\n]*"$/.test(original.etag)) throw new CalendarError('iCloud did not provide a version for that event.');
      headers['If-Match'] = original.etag;
    } else {
      headers['If-None-Match'] = '*';
    }
    const { response } = await this.request(url, { method: 'PUT', headers, body: data }, signal);
    // Receiving the success status is the acknowledgement. The body carries no event data we need.
    void response.body?.cancel().catch(() => {});
  }
}
