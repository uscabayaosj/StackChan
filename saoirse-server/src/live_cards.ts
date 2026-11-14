import type { ServerTool } from './server_tools.js';

export interface LiveCard {
  title: string;
  source: string;
  rows: string[];
}

export function transportTool(fetchImpl: typeof fetch, darwinAuthorization?: string): ServerTool {
  async function json(url: string, signal: AbortSignal, headers?: Record<string, string>) {
    const result = await fetchImpl(url, { signal, headers });
    if (!result.ok) throw new Error(`Transport feed returned HTTP ${result.status}`);
    return result.json();
  }

  return {
    timeoutMs: 12_000,
    spec: { type: 'function', function: {
      name: 'get_london_departures',
      description: 'Live upcoming Tube and bus arrivals from TfL, or National Rail departures. Ask for the station or stop if missing. For rail supply the three-letter CRS code. For bus use the exact stop name, stop code or letter and optionally the route or direction. Does not provide future-day timetables.',
      parameters: { type: 'object', properties: {
        mode: { type: 'string', enum: ['tube', 'bus', 'rail'] },
        stop: { type: 'string', description: 'Exact station or stop name, TfL stop ID, or National Rail CRS.' },
        route: { type: 'string', description: 'Optional Tube line or bus route.' },
        direction: { type: 'string', description: 'Optional destination or direction.' },
        letter: { type: 'string', description: 'Optional bus stop letter.' },
      }, required: ['mode', 'stop'] },
    } },
    async run(args, signal, display) {
      const field = (key: string) => typeof args[key] === 'string' ? args[key].trim().slice(0, 120) : '';
      let stop = field('stop');
      const mode = field('mode');
      if (!stop || !['tube', 'bus', 'rail'].includes(mode)) return 'Error: specify the transport mode and stop.';
      const show = (card: LiveCard) => {
        display?.(card);
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
        if (!darwinAuthorization) return 'Error: the National Rail feed is not configured.';
        if (!/^[a-z]{3}$/i.test(stop)) return 'Error: the National Rail lookup needs a three-letter CRS code.';
        const board = await json(`https://realtime.nationalrail.co.uk/LDBWS/api/20220120/GetDepartureBoard/${stop.toUpperCase()}?numRows=20&timeWindow=120`, signal, { Authorization: darwinAuthorization });
        if (!board?.locationName || board.areServicesAvailable === false) return 'Error: National Rail did not return a station board.';
        const rows = (board.trainServices ?? []).filter((s: any) => !direction || s.destination?.some((d: any) => d.locationName?.toLowerCase().includes(direction)))
          .slice(0, 4).map((s: any) =>
            `${s.std ?? '—'}  ${s.destination?.map((d: any) => d.locationName).join(' / ') || 'Destination TBC'}${s.platform ? ` • P${s.platform}` : ''}\n${s.isCancelled ? 'Cancelled' : s.etd || 'Scheduled'}`);
        return show({ title: board.locationName, source: 'National Rail • Darwin', rows: rows.length ? rows : ['No matching services on the board'] });
      }

      const root = 'https://api.tfl.gov.uk/StopPoint';
      const direct = /^(?:[0-9][A-Z0-9]{7,14}|HUB[A-Z0-9]{3})$/i.test(stop);
      const busCode = mode === 'bus' && /^\d{5}$/.test(stop);
      const key = (name: string) => name.toLowerCase().replace(/\s+(?:underground station|station|bus stop)$/, '').trim();
      const matches: any[] = direct ? [{ id: stop.toUpperCase(), name: stop }] :
        busCode ? await (async () => {
          const result = await json(`${root}/Sms/${stop}`, signal);
          const stops = Array.isArray(result) ? result : result.stopPoints ?? [result];
          return stops.filter((item: any) => item.naptanId || item.id)
            .map((item: any) => ({ id: item.naptanId || item.id, name: item.commonName || stop }));
        })() : (await json(`${root}/Search/${encodeURIComponent(stop)}?modes=${mode}`, signal)).matches ?? [];
      const exact = matches.filter(m => key(m.name) === key(stop));
      const candidates = (exact.length ? exact : matches).filter(m => !letter || (m.stopLetter?.toLowerCase() ?? /[a-z]+$/i.exec(m.id)?.[0]?.toLowerCase()) === letter);
      if (busCode && candidates.length === 0) return 'Error: TfL did not resolve that bus code. Ask for the stop name and letter.';
      if (!candidates.length) return 'Error: TfL could not find that stop. Ask for the exact name or stop code.';
      if (new Set(candidates.map(x => key(x.name))).size > 1 || candidates.length > 12)
        return `Several stops match. Ask which one: ${[...new Set(candidates.slice(0, 6).map(x => x.name))].join(', ')}.`;
      const stopIds = (await Promise.all(candidates.map(async ({ id }) => {
        if (!id.startsWith('HUB')) return [id];
        const hub = await json(`${root}/${encodeURIComponent(id)}`, signal);
        const prefix = mode === 'tube' ? '940G' : '490';
        return (hub.children ?? []).filter((child: any) => child.id?.startsWith(prefix)).map((child: any) => child.id);
      }))).flat();
      const feeds = await Promise.all([...new Set(stopIds)].map(async id => {
        const arrivals = await json(`${root}/${encodeURIComponent(id)}/Arrivals`, signal);
        if (!Array.isArray(arrivals)) throw new Error('TfL did not return predictions.');
        return arrivals;
      }));
      const now = Date.now();
      const rows = feeds.flat().filter(x => x.modeName === mode && Number.isFinite(Date.parse(x.expectedArrival)) &&
        Date.parse(x.expectedArrival) >= now - 15_000 &&
        (!route || [x.lineId, x.lineName].some(v => typeof v === 'string' && v.toLowerCase() === route)) &&
        (!direction || [x.destinationName, x.towards, x.platformName].some(v => typeof v === 'string' && v.toLowerCase().includes(direction))))
        .sort((a, b) => Date.parse(a.expectedArrival) - Date.parse(b.expectedArrival))
        .slice(0, 4).map(x => {
          const minutes = Math.max(0, Math.ceil((Date.parse(x.expectedArrival) - now) / 60_000));
          return `${minutes ? `${minutes} min` : 'Due'}  ${x.lineName} → ${x.destinationName || x.towards || 'Destination TBC'}${x.platformName ? `\n${x.platformName}` : ''}`;
        });
      return show({ title: feeds.flat().find(x => x.stationName)?.stationName || candidates[0].name,
        source: 'TfL • live predictions', rows: rows.length ? rows : ['No matching live predictions reported'] });
    },
  };
}
