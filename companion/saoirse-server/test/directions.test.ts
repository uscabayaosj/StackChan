import { describe, expect, it, vi } from 'vitest';
import { getDirections, type DirectionsMode } from '../src/directions.js';

const origin = '51.5033, -0.1147';
const destination = '51.501, -0.1254';
const geometry = [[51.5033, -0.1147], [51.501, -0.1254]];
const shape = 'gkofaBv__FvnCv{S';
const maneuvers = [
  { type: 1, instruction: 'Walk southwest.', length: 0.131 },
  { type: 10, instruction: 'Turn right onto Leake Street.', length: 0.074 },
  { type: 4, instruction: 'You have arrived at your destination.', length: 0 },
];
const reply = (data: unknown, status = 200) => Response.json(data, {status});
const street = (overrides = {}) => ({ trip: { status: 0, units: 'kilometers', summary: { time: 750.889, length: 0.988 },
  legs: [{shape, maneuvers}], ...overrides } });
const geo = (name: string, city: string, point: [number, number], extra = {}) => ({
  geometry: { coordinates: [point[1], point[0]] }, properties: { name, city, ...extra },
});
const walking = (fetchImpl: typeof fetch, from = origin, to = destination) =>
  getDirections({ origin: from, destination: to, mode: 'walk' }, {fetchImpl});
const transit = (fetchImpl: typeof fetch, from = origin, to = destination) =>
  getDirections({ origin: from, destination: to, mode: 'transit' }, {fetchImpl});

describe('explicit directions', () => {
  it.each([['walk', 'pedestrian'], ['cycle', 'bicycle'], ['drive', 'auto']] as const)(
    'requests the %s profile and returns provider maneuvers with lat/lon geometry', async (mode, costing) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply(street()));
      const route = await getDirections({ origin, destination, mode }, {fetchImpl});
      const [url, init] = fetchImpl.mock.calls[0];
      expect(JSON.parse(new URL(String(url)).searchParams.get('json')!)).toMatchObject({
        costing, units: 'kilometers', locations: [{ lat:51.5033, lon:-0.1147 }, {lat:51.501, lon:-0.1254}],
      });
      expect(new Headers(init?.headers).get('X-Client-Id')).toBe('saoirse-personal-companion');
      expect(route).toMatchObject({ originCoordinate:geometry[0], destinationCoordinate:geometry[1], mode,
        geometry, distanceMeters:988, durationMinutes:13, totalSteps:3,
        steps:[{badge:'Start', distanceMeters:131}, {instruction:'Turn right onto Leake Street.', badge:'Right', distanceMeters:74}, {badge:'Arrive'}] });
    });

  it('resolves nearby duplicated station entrances and passes only explicit geocoder bias', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({features:[geo('Waterloo Station','London',[51.5033,-.1147]),geo('Waterloo Station','London',[51.5034,-.1148])]}))
      .mockResolvedValueOnce(reply(street()));
    const route = await getDirections({origin:'Waterloo Station, London', destination, mode:'walk'},
      {fetchImpl, bias: {latitude:51.5,longitude:-.12}});
    expect(route.origin).toBe('Waterloo Station, London');
    expect(route.originCoordinate).toEqual(geometry[0]);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.hostname).toBe('photon.komoot.io');
    expect(url.searchParams.get('lat')).toBe('51.5');
  });

  it.each([
    ['a shared town name','Springfield',[geo('Springfield','USA',[40,-89]),geo('Springfield','USA',[44,-123])]],
    ['an unresolved house number','101 High Street, London',[geo('High Street','London',[51.5,-.1],{street:'High Street'})]],
    ['a wrong city','Waterloo Station, Liverpool',[geo('Waterloo Station','London',[51.5,-.1])]],
    ['no match','Gibberish Town',[]],
  ])('asks for clarification on %s without routing', async (_, name, features) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({features}));
    await expect(walking(fetchImpl, String(name))).rejects.toMatchObject({code:'ambiguous_place'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['here', 'my current location', 'work', '91, 0',''])('rejects unprovided or invalid coordinates (%s)',async name => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(walking(fetchImpl,name)).rejects.toMatchObject({code:'invalid_request'});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects identical endpoints and unknown modes without network traffic', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(walking(fetchImpl,origin,origin)).rejects.toMatchObject({code:'no_route'});
    await expect(getDirections({origin,destination,mode:'fly' as DirectionsMode},{fetchImpl})).rejects.toMatchObject({code:'invalid_request'});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caps previews while preserving maneuver count and first/last geographic points',async () => {
    const legs = Array.from({length:210}, () => ({shape, maneuvers}));
    const route = await walking(vi.fn<typeof fetch>().mockResolvedValue(reply(street({legs}))));
    expect(route.steps).toHaveLength(60); expect(route.totalSteps).toBe(630);
    expect(route.geometry).toHaveLength(400);
    expect(route.geometry[0]).toEqual(geometry[0]); expect(route.geometry.at(-1)).toEqual(geometry[1]);
  });

  it('keeps reliable instructions and omits an undecodable shape',async () => {
    const route = await walking(vi.fn<typeof fetch>().mockResolvedValue(reply(street({legs:[{shape:'~~~~~~', maneuvers}]}))));
    expect(route.geometry).toEqual([]); expect(route.totalSteps).toBe(3);
  });

  it.each([
    ['no road',reply({error_code:171},400),'no_route'],['unconnected',reply({error_code:442},400),'no_route'],
    ['service rate limit',reply({},429),'unavailable'],['upstream outage',reply({},503),'unavailable'],
    ['invalid provider response',reply(street({summary:{length:23}})),'unavailable'],
    ['missing maneuver',reply(street({legs:[{shape,maneuvers:[{type:15}]}]})),'unavailable'],
  ])('surfaces typed errors for %s',async (_, raw, code) => {
    await expect(walking(vi.fn<typeof fetch>().mockResolvedValue(raw as Response))).rejects.toMatchObject({code});
  });

  it('honours an already-cancelled request',async () => {
    const controller = new AbortController(); controller.abort(new Error('cancel this journey'));
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(getDirections({origin,destination,mode:'walk'},{fetchImpl,signal:controller.signal})).rejects.toThrow('cancel this journey');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('spaces user-triggered queries to the same public host',async () => {
    const starts: number[] = [];
    const fetchImpl: typeof fetch = async () => { starts.push(Date.now()); return reply(street()); };
    await Promise.all([walking(fetchImpl), walking(fetchImpl)]);
    expect(starts[1]-starts[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe('London public transport directions', () => {
  const walk = {mode:{id:'walking'},instruction:{summary:'Walk to County Hall'},distance:287,path:{lineString:JSON.stringify(geometry)}};
  const bus = {mode:{id:'bus'},instruction:{summary:'N381 bus to Westminster Station'},distance:19,path:{lineString:JSON.stringify(geometry)}};
  it('skips walking-only results and omits misleading TfL transit distances',async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({journeys:[{duration:8,legs:[walk]},{duration:14,legs:[walk,bus]}]}));
    const route = await transit(fetchImpl);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('api.tfl.gov.uk/Journey/JourneyResults/51.5033,-0.1147/to/51.501,-0.1254');
    expect(route.durationMinutes).toBe(14); expect(route.distanceMeters).toBeUndefined();
    expect(route.steps[0]).toMatchObject({instruction:'Walk to County Hall',distanceMeters:287,badge:'Walk'});
    expect(route.steps[1].instruction).toBe('N381 bus to Westminster Station'); expect(route.steps[1].distanceMeters).toBeUndefined();
    expect(route.geometry).toEqual([...geometry,...geometry]);
  });

  it('returns an honest no-route result if the only journey is walking',async () => {
    await expect(transit(vi.fn<typeof fetch>().mockResolvedValue(reply({journeys:[{duration:4,legs:[walk]}]})))).rejects.toMatchObject({code:'no_route'});
  });

  it('does not draw a straight line across a missing transit leg',async () => {
    const route = await transit(vi.fn<typeof fetch>().mockResolvedValue(reply({journeys:[{duration:10,legs:[walk,{...bus,path:{}}]}]})));
    expect(route.geometry).toEqual([]); expect(route.totalSteps).toBe(2);
  });

  it('explains where transit is supported without calling TfL for overseas journeys',async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(transit(fetchImpl,'48.8584, 2.2945','48.8606, 2.3376')).rejects.toMatchObject({code:'no_route',message:expect.stringContaining('London')});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
