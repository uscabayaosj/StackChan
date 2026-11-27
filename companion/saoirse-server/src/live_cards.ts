import type { ServerTool } from './server_tools.js';
import { spokenTime } from './clock.js';
import { ELMS_ROAD, ELMS_ROAD_STOPS, LOCAL_RAIL_STATIONS } from './transport_request.js';

export interface LiveCard {
  title: string;
  source: string;
  rows: string[];
  kind?: 'weather' | 'bus' | 'tube' | 'rail' | 'calendar' | 'reminders' | 'definition' | 'directions';
  hero?: string;
  subtitle?: string;
  items?: LiveCardItem[];
}

export interface LiveCardItem { title: string; detail?: string; badge?: string }

export function makeLiveCard(kind: NonNullable<LiveCard['kind']>, title: string, source: string, items: LiveCardItem[],
  heading: Pick<LiveCard, 'hero' | 'subtitle'> = {}): LiveCard {
  const visible = items.slice(0, 12);
  return { kind, title, source, ...heading, items: visible, rows: [
    ...[heading.hero, heading.subtitle].filter((line): line is string => Boolean(line)),
    ...visible.map(item => `${item.badge ? `${item.badge}  ` : ''}${item.title}${item.detail ? `\n${item.detail}` : ''}`),
  ] };
}

interface RailCallingPoint {
  crs?: string;
  locationName?: string;
  isCancelled?: boolean;
  et?: string;
}

interface RailService {
  std?: string;
  etd?: string;
  platform?: string;
  isCancelled?: boolean;
  filterLocationCancelled?: boolean;
  destination?: { locationName: string }[];
  subsequentCallingPoints?: { callingPoint?: RailCallingPoint[] }[];
}

const railTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function railAnnouncement(origin: string, callingAt: string, service: RailService, terminal: string) {
  const platform = service.platform ? ` from platform ${service.platform}` : '';
  const train = `The next train from ${origin} calling at ${callingAt}`;
  if (service.etd && railTime.test(service.etd) && service.etd !== service.std) {
    const [hour, minute] = service.etd.split(':').map(Number);
    return `${train} is the ${terminal} service, expected at ${spokenTime(hour, minute)}${platform}.`;
  }
  if (!service.std || !railTime.test(service.std)) {
    return `${train} is the ${terminal} service${platform}. The departure time is unconfirmed.`;
  }
  const [hour, minute] = service.std.split(':').map(Number);
  const status = service.etd === 'On time' ? ' It’s on time.' : service.etd === 'Delayed' ? ' It’s delayed.' : '';
  return `${train} is the ${terminal} service scheduled for ${spokenTime(hour, minute)}${platform}.${status}`;
}

export function transportTool(fetchImpl: typeof fetch, darwinAuthorization?: string, railDataApiKey?: string): ServerTool {
  async function json(url: string, signal: AbortSignal, headers?: Record<string, string>) {
    const result = await fetchImpl(url, { signal, headers, redirect: headers ? 'error' : undefined });
    if (!result.ok) throw new Error(`Transport feed returned HTTP ${result.status}`);
    return result.json();
  }

  return {
    timeoutMs: 12_000,
    spec: { type: 'function', function: {
      name: 'get_london_departures',
      description: 'Live upcoming Tube and bus arrivals from TfL, or National Rail departures. Ask for the station or stop if missing. For rail supply the origin station’s three-letter CRS code in stop and, for a journey, the destination station’s CRS code in destination_crs. A journey can include trains that continue beyond the requested destination. For bus use the exact stop name, stop code or letter and optionally the route or direction. Does not provide future-day timetables.',
      parameters: { type: 'object', properties: {
        mode: { type: 'string', enum: ['tube', 'bus', 'rail'] },
        stop: { type: 'string', description: 'Exact station or stop name, TfL stop ID, or National Rail CRS.' },
        route: { type: 'string', description: 'Optional Tube line or bus route.' },
        direction: { type: 'string', description: 'Optional TfL destination or direction.' },
        destination_crs: { type: 'string', description: 'For rail journeys, the three-letter CRS code of the station the train must call at after leaving stop.' },
        letter: { type: 'string', description: 'Optional bus stop letter.' },
      }, required: ['mode', 'stop'] },
    } },
    async run(args, signal, display) {
      const field = (key: string) => typeof args[key] === 'string' ? args[key].trim().slice(0, 120) : '';
      let stop = field('stop');
      const mode = field('mode');
      if (!stop || !['tube', 'bus', 'rail'].includes(mode)) return 'Error: specify the transport mode and stop.';
      const show = (card: LiveCard, summary?: string) => {
        display?.(card, summary);
        return JSON.stringify(card);
      };
      const route = field('route').toLowerCase();
      let direction = field('direction').toLowerCase();
      let letter = field('letter').toLowerCase();
      if (mode === 'bus') {
        const toward = /[, ]+towards?\s+(.+)$/i.exec(stop);
        if (toward) {
          direction ||= toward[1].toLowerCase();
          stop = stop.slice(0, toward.index).trim();
        }
        const suffix = /[, ]+stop\s+([a-z]{1,2})[.!?]?$/i.exec(stop);
        if (suffix) {
          letter ||= suffix[1].toLowerCase();
          stop = stop.slice(0, suffix.index).trim();
        }
        direction = direction.replace(/^towards?\s+/, '').replace(/[.!?]+$/, '').trim();
        letter = letter.replace(/^stop\s+/, '').replace(/[.!?]+$/, '').trim();
        if (!stop) return 'Error: specify the bus stop name or code.';
      }
      if (mode === 'rail') {
        if (!railDataApiKey && !darwinAuthorization) {
          display?.(makeLiveCard('rail', 'National Rail', '', [{ title: 'Live departures need a Darwin connection' }]));
          return 'Error: the National Rail feed is not configured.';
        }
        if (!/^[a-z]{3}$/i.test(stop)) return 'Error: the National Rail lookup needs a three-letter CRS code.';
        const destination = field('destination_crs').toUpperCase();
        if (destination && (!/^[A-Z]{3}$/.test(destination) || destination === stop.toUpperCase())) {
          return 'Error: give a different, valid three-letter CRS code for the destination station.';
        }
        const host = railDataApiKey
          ? 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2'
          : 'https://realtime.nationalrail.co.uk';
        const headers: Record<string, string> = railDataApiKey ? { 'x-apikey': railDataApiKey } : { Authorization: darwinAuthorization! };
        const boardRequest = destination ? 'GetDepBoardWithDetails' : 'GetDepartureBoard';
        const query = destination ? `numRows=8&timeWindow=119&filterCrs=${destination}&filterType=to` : 'numRows=20&timeWindow=120';
        const board = await json(`${host}/LDBWS/api/20220120/${boardRequest}/${stop.toUpperCase()}?${query}`, signal, headers);
        if (!board?.locationName || board.areServicesAvailable === false) return 'Error: National Rail did not return a station board.';
        const services = (board.trainServices ?? []) as RailService[];
        const matching = services.flatMap<{ service: RailService; callingPoint?: RailCallingPoint }>(service => {
          if (!destination) {
            const matchesDirection = !direction || service.destination?.some(d => d.locationName?.toLowerCase().includes(direction));
            return matchesDirection ? [{ service, callingPoint: undefined }] : [];
          }
          if (service.isCancelled || service.filterLocationCancelled || /^(?:cancelled|departed)$/i.test(service.etd ?? '')) return [];
          const callingPoint = service.subsequentCallingPoints?.flatMap(group => group.callingPoint ?? [])
            .find(point => point.crs?.toUpperCase() === destination && !point.isCancelled && !/^cancelled$/i.test(point.et ?? ''));
          return callingPoint ? [{ service, callingPoint }] : [];
        }).slice(0, 8);
        const items: LiveCardItem[] = matching.map(({ service }) => ({
          badge: service.std ?? 'TBC', title: service.destination?.map(d => d.locationName).join(' / ') || 'Destination TBC',
          detail: [service.isCancelled ? 'Cancelled' : service.etd || 'Scheduled', service.platform ? `Platform ${service.platform}` : ''].filter(Boolean).join(' / '),
        }));
        const callingAt = matching[0]?.callingPoint?.locationName ||
          LOCAL_RAIL_STATIONS[destination as keyof typeof LOCAL_RAIL_STATIONS] || destination;
        const summary = destination ? matching[0]
          ? railAnnouncement(board.locationName, callingAt, matching[0].service, items[0].title)
          : `National Rail shows no upcoming trains from ${board.locationName} calling at ${callingAt} on the live board.`
          : undefined;
        return show(makeLiveCard('rail', board.locationName, 'National Rail', items.length ? items : [{
          title: destination ? 'No matching departures' : 'No matching services on the board',
        }], destination ? { subtitle: `Calling at ${callingAt}` } : {}), summary);
      }

      const root = 'https://api.tfl.gov.uk/StopPoint';
      const localStop = mode === 'bus' && stop.toLowerCase() === ELMS_ROAD.toLowerCase()
        ? Object.values(ELMS_ROAD_STOPS).find(stop => stop.letter.toLowerCase() === letter)
        : undefined;
      const direct = /^(?:[0-9][A-Z0-9]{7,14}|HUB[A-Z0-9]{3})$/i.test(stop);
      const busCode = mode === 'bus' && /^\d{5}$/.test(stop);
      const key = (name: string) => name.toLowerCase().replace(/['’]/g, '').replace(/\s+(?:underground station|station|bus stop)$/, '').trim();
      const isBusGroup = (id: string) => mode === 'bus' && id.startsWith('490G');
      const hasLetter = (entry: { id: string; stopLetter?: string }) => !letter ||
        (entry.stopLetter?.toLowerCase() || /[a-z]+$/i.exec(entry.id)?.[0]?.toLowerCase()) === letter;
      const matches: any[] = localStop ? [{ id: localStop.id, name: ELMS_ROAD, stopLetter: localStop.letter }] :
        direct ? [{ id: stop.toUpperCase(), name: stop }] :
        busCode ? await (async () => {
          const result = await json(`${root}/Sms/${stop}`, signal);
          const stops = Array.isArray(result) ? result : result.stopPoints ?? [result];
          return stops.filter((item: any) => item.naptanId || item.id)
            .map((item: any) => ({ id: item.naptanId || item.id, name: item.commonName || stop, stopLetter: item.stopLetter }));
        })() : (await json(`${root}/Search/${encodeURIComponent(stop)}?modes=${mode}`, signal)).matches ?? [];
      const exact = matches.filter(m => (mode === 'bus' ? m.name.split('/') : [m.name]).some((name: string) => key(name) === key(stop)));
      const candidates = (exact.length ? exact : matches).filter(m => m.id.startsWith('HUB') || isBusGroup(m.id) || hasLetter(m));
      if (busCode && candidates.length === 0) return 'Error: TfL did not resolve that bus code. Ask for the stop name and letter.';
      if (!candidates.length) return 'Error: TfL could not find that stop. Ask for the exact name or stop code.';
      if (new Set(candidates.map(x => key(x.name))).size > 1 || candidates.length > 12)
        return `Several stops match. Ask which one: ${[...new Set(candidates.slice(0, 6).map(x => x.name))].join(', ')}.`;
      const expand = async (id: string, includeGroups = true): Promise<string[]> => {
        const hub = await json(`${root}/${encodeURIComponent(id)}`, signal);
        const prefix = mode === 'tube' ? '940G' : '490';
        const children: { id: string; stopLetter?: string }[] = (hub.children ?? []).filter((child: any) => child.id?.startsWith(prefix));
        if (isBusGroup(id) && !children.length) return letter ? [] : [id];
        return (await Promise.all(children.slice(0, 24).map(child => {
          if (isBusGroup(child.id)) return includeGroups && child.id !== id ? expand(child.id, false) : [];
          return hasLetter(child) ? [child.id] : [];
        }))).flat();
      };
      const stopIds = (await Promise.all(candidates.map(({ id }) => id.startsWith('HUB') || isBusGroup(id) ? expand(id) : [id]))).flat();
      if (!stopIds.length && letter) return 'Error: TfL did not find that stop letter. Ask for the stop code.';
      const feeds = await Promise.all([...new Set(stopIds)].map(async id => {
        const arrivals = await json(`${root}/${encodeURIComponent(id)}/Arrivals`, signal);
        if (!Array.isArray(arrivals)) throw new Error('TfL did not return predictions.');
        return arrivals;
      }));
      const now = Date.now();
      const upcoming = feeds.flat().filter(x => x.modeName === mode && Number.isFinite(Date.parse(x.expectedArrival)) &&
        Date.parse(x.expectedArrival) >= now - 15_000 &&
        (!route || [x.lineId, x.lineName].some(v => typeof v === 'string' && v.toLowerCase() === route)) &&
        (!direction || [x.destinationName, x.towards, x.platformName].some(v => typeof v === 'string' && v.toLowerCase().includes(direction))))
        .sort((a, b) => Date.parse(a.expectedArrival) - Date.parse(b.expectedArrival))
        .slice(0, 8).map(x => ({
          minutes: Math.max(0, Math.ceil((Date.parse(x.expectedArrival) - now) / 60_000)),
          line: String(x.lineName || 'Bus'),
          destination: String(x.destinationName || x.towards || 'Destination TBC'),
          platform: x.platformName,
        }));
      const first = upcoming[0];
      const rows = upcoming.map(x =>
        `${x.minutes ? `${x.minutes} min` : 'Due'}  ${x.line} → ${x.destination}${x.platform ? `\n${x.platform}` : ''}`);
      const items = upcoming.map(x => ({ badge: x.minutes ? `${x.minutes} min` : 'Due',
        title: x.destination, detail: [mode === 'bus' ? `Route ${x.line}` : x.line, x.platform].filter(Boolean).join('  /  ') }));
      const summary = mode === 'bus'
        ? first ? `${localStop ? `At Elms Road Stop ${localStop.letter}, the` : 'The'} ${first.line} to ${first.destination} is ${first.minutes ? `due in ${first.minutes} minute${first.minutes === 1 ? '' : 's'}` : 'due now'}.`
          : `TfL shows no matching live arrivals${localStop ? ` at Elms Road Stop ${localStop.letter}` : ''}.`
        : undefined;
      const stationName = String(feeds.flat().find(x => x.stationName)?.stationName || candidates[0].name);
      return show({ kind: mode === 'bus' ? 'bus' : 'tube', ...(letter ? { subtitle: `Stop ${letter.toUpperCase()}` } : {}),
        title: stationName.replace(/\s+(?:Underground Station|Rail Station|Bus Stop)$/i, ''), source: 'TfL live',
        rows: rows.length ? rows : ['No matching live predictions reported'],
        items: items.length ? items : [{ title: 'No matching live arrivals' }] }, summary);
    },
  };
}
