import { describe, it, expect } from 'vitest';
import { transportTool, type LiveCard } from '../src/live_cards.js';

const signal = new AbortController().signal;
const response = (data: unknown) => new Response(JSON.stringify(data));

describe('live transport cards', () => {
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
});
