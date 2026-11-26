import { describe, it, expect } from 'vitest';
import { transportTool, type LiveCard } from '../src/live_cards.js';
import { parseBusRequest } from '../src/transport_request.js';

const signal = new AbortController().signal;
const response = (data: unknown) => new Response(JSON.stringify(data));

describe('live transport cards', () => {
  it.each([['northbound', '490006520N', 'C'], ['southbound', '490006520S', 'J']])(
    'looks up only the %s platform and identifies it in the live card and speech', async (direction, id, letter) => {
      const fetchImpl = (async (url: string) => {
        expect(url).toBe(`https://api.tfl.gov.uk/StopPoint/${id}/Arrivals`);
        return response([{ modeName: 'bus', lineName: '155', destinationName: 'Example destination',
          expectedArrival: new Date(Date.now() + 90_000).toISOString() }]);
      }) as typeof fetch;
      const args = parseBusRequest(`When is the next ${direction} bus arriving?`)!;
      const cards: LiveCard[] = [];
      const summaries: (string | undefined)[] = [];
      const tool = transportTool(fetchImpl);
      await tool.run(args, signal, (card, summary) => { cards.push(card); summaries.push(summary); });
      expect(cards[0]).toMatchObject({ kind: 'bus', subtitle: `Stop ${letter}`, items: [{ badge: '2 min', title: 'Example destination' }] });
      expect(summaries[0]).toContain(`At Elms Road Stop ${letter}`);
      const empty = transportTool((async () => response([])) as typeof fetch);
      await empty.run(args, signal, (card, summary) => { cards.push(card); summaries.push(summary); });
      expect(cards[1]).toMatchObject({ title: 'Elms Road / Windmill on the Common', subtitle: `Stop ${letter}` });
      expect(summaries[1]).toBe(`TfL shows no matching live arrivals at Elms Road Stop ${letter}.`);
    },
  );

  it('uses the Tube child of a mixed-mode hub and sorts matching live predictions', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/Search/')) return response({ matches: [{ id: 'HUBVIC', name: 'Victoria' }] });
      if (url.endsWith('/HUBVIC')) return response({ children: [{ id: '940GZZLUVIC' }, { id: '490G000812' }] });
      expect(url).toContain('/940GZZLUVIC/Arrivals');
      return response([5, 2].map(n => ({
        lineName: 'Victoria', modeName: 'tube', destinationName: 'Brixton',
        stationName: 'Victoria Underground Station', expectedArrival: new Date(Date.now() + n * 60_000).toISOString(),
      })));
    }) as typeof fetch;
    const cards: LiveCard[] = [];
    await transportTool(fetchImpl).run({ mode: 'tube', stop: 'Victoria' }, signal, card => cards.push(card));
    expect(cards[0].rows).toEqual(['2 min  Victoria → Brixton', '5 min  Victoria → Brixton']);
  });

  it.each([
    { stop: 'Clapham Common Station', letter: 'Stop D', direction: 'towards Stockwell' },
    { stop: 'Clapham Common Station, stop D towards Stockwell' },
  ])('accepts spoken bus stop and direction phrases ($stop)', async args => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/Search/')) {
        expect(decodeURIComponent(url)).toContain('/Search/Clapham Common Station?');
        return response({ matches: ['D', 'AD'].map(letter => ({
          id: '490000050' + letter, name: 'Clapham Common Station',
        })) });
      }
      expect(url).toContain('/490000050D/Arrivals');
      return response(['Stockwell', 'Brixton'].map(destinationName => ({
        modeName: 'bus', lineName: '50', destinationName, expectedArrival: new Date(Date.now() + 60_000).toISOString(),
      })));
    }) as typeof fetch;
    const cards: LiveCard[] = [];
    await transportTool(fetchImpl).run({ mode: 'bus', ...args }, signal, card => cards.push(card));
    expect(cards[0].rows).toEqual(['1 min  50 → Stockwell']);
  });

  it('marks a cancelled National Rail departure and sends auth only to Darwin', async () => {
    const fetchImpl = (async (url: string, options: RequestInit) => {
      expect(url).toMatch(/^https:\/\/realtime\.nationalrail\.co\.uk\/.*\/VIC\?/);
      expect(options.headers).toEqual({ Authorization: 'Basic fixture' });
      return response({ locationName: 'London Victoria', trainServices: [
        { std: '15:00', etd: 'On time', isCancelled: true, destination: [{ locationName: 'Brighton' }] },
      ] });
    }) as typeof fetch;
    const result = await transportTool(fetchImpl, 'Basic fixture').run({ mode: 'rail', stop: 'VIC' }, signal);
    expect(result).toContain('Cancelled');
  });

  it('uses the Marketplace Consumer Key at its gateway for a live National Rail card', async () => {
    const fetchImpl = (async (url: string, options: RequestInit) => {
      const endpoint = new URL(url);
      expect(endpoint.origin).toBe('https://api1.raildata.org.uk');
      expect(endpoint.pathname).toBe('/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepartureBoard/WAT');
      expect(options.headers).toEqual({ 'x-apikey': 'marketplace-fixture' });
      expect(options.redirect).toBe('error');
      return response({ locationName: 'London Waterloo', trainServices: [
        { std: '15:05', etd: '15:08', platform: '6', destination: [{ locationName: 'Woking' }] },
      ] });
    }) as typeof fetch;
    const cards: LiveCard[] = [];
    await transportTool(fetchImpl, 'Basic legacy-fixture', 'marketplace-fixture').run({ mode: 'rail', stop: 'wat' }, signal, card => cards.push(card));
    expect(cards[0]).toMatchObject({ kind: 'rail', title: 'London Waterloo', items: [
      { badge: '15:05', title: 'Woking', detail: '15:08 / Platform 6' },
    ] });
  });

  it('shows only live rail services verified to call at the requested station', async () => {
    const clapham = { crs: 'CLJ', locationName: 'Clapham Junction' };
    const service = { std: '15:05', etd: '15:08', platform: '6', destination: [{ locationName: 'Woking' }] };
    const callingPoints = (...points: { crs: string; locationName?: string; isCancelled?: boolean }[]) =>
      [{ callingPoint: points }];
    const fetchImpl = (async (url: string) => {
      const endpoint = new URL(url);
      expect(endpoint.pathname).toMatch(/\/GetDepBoardWithDetails\/WAT$/);
      expect(endpoint.searchParams.get('filterCrs')).toBe('CLJ');
      expect(endpoint.searchParams.get('filterType')).toBe('to');
      return response({ locationName: 'London Waterloo', trainServices: [
        { ...service, std: '15:01', subsequentCallingPoints: callingPoints({ crs: 'WOK' }) },
        { ...service, std: '15:02', isCancelled: true, subsequentCallingPoints: callingPoints(clapham) },
        { ...service, std: '15:03', subsequentCallingPoints: callingPoints({ ...clapham, isCancelled: true }) },
        { ...service, std: '15:04', destination: [clapham] },
        { ...service, std: '15:04', filterLocationCancelled: true, subsequentCallingPoints: callingPoints(clapham) },
        { ...service, subsequentCallingPoints: callingPoints(clapham, { crs: 'WOK' }) },
      ] });
    }) as typeof fetch;
    const args = { mode: 'rail', stop: 'wat', destination_crs: 'clj' };
    const cards: LiveCard[] = [];
    const summaries: (string | undefined)[] = [];
    const display = (card: LiveCard, summary?: string) => { cards.push(card); summaries.push(summary); };
    await transportTool(fetchImpl, undefined, 'marketplace-fixture').run(args, signal, display);
    expect(cards[0]).toMatchObject({
      kind: 'rail', title: 'London Waterloo', subtitle: 'Calling at Clapham Junction',
      items: [{ badge: '15:05', title: 'Woking', detail: '15:08 / Platform 6' }],
    });
    expect(summaries[0]).toBe('The next train from London Waterloo calling at Clapham Junction is the Woking service, expected at eight minutes past three in the afternoon from platform 6.');
    const empty = (async () => response({ locationName: 'London Waterloo' })) as typeof fetch;
    await transportTool(empty, undefined, 'marketplace-fixture').run(args, signal, display);
    expect(cards[1]).toMatchObject({ subtitle: 'Calling at Clapham Junction', items: [{ title: 'No matching departures' }] });
    expect(summaries[1]).toContain('no upcoming trains from London Waterloo calling at Clapham Junction');
  });

  it('matches an alternate bus stop name and chooses the stop letter from the TfL group children', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/Search/')) return response({ matches: [
        { id: '490G00006520', name: 'Elms Road / Windmill on the Common' }, { id: '490G00006866', name: 'Five Elms Road' },
      ] });
      if (url.endsWith('/490G00006520')) return response({ children: [
        { id: '490006520N', stopLetter: 'C' }, { id: '490006520S', stopLetter: 'J' },
      ] });
      expect(url).toContain('/490006520N/Arrivals');
      return response([{ modeName: 'bus', lineName: '50', destinationName: 'Stockwell', platformName: 'C',
        expectedArrival: new Date(Date.now() + 60_000).toISOString() }]);
    }) as typeof fetch;
    const cards: LiveCard[] = [];
    await transportTool(fetchImpl).run({ mode: 'bus', stop: "Elm's Road stop C" }, signal, card => cards.push(card));
    expect(cards[0]).toMatchObject({ kind: 'bus', subtitle: 'Stop C', items: [{ title: 'Stockwell', badge: '1 min' }] });
  });
});
