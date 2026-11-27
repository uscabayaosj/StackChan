import { setTimeout as delay } from 'node:timers/promises';

export type DirectionsMode = 'walk' | 'cycle' | 'drive' | 'transit';
export type Coordinate = [latitude: number, longitude: number];
export interface DirectionsRoute {
  origin: string;
  destination: string;
  originCoordinate?: Coordinate;
  destinationCoordinate?: Coordinate;
  mode: DirectionsMode;
  distanceMeters?: number;
  durationMinutes: number;
  steps: { instruction: string; distanceMeters?: number; badge?: string }[];
  totalSteps: number;
  geometry: Coordinate[];
  source: string;
}

type ErrorCode = 'invalid_request' | 'ambiguous_place' | 'no_route' | 'unavailable';
export class DirectionsError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = 'DirectionsError'; }
}
interface Options {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  bias?: { latitude: number; longitude: number };
}
type Place = { name: string; point: Coordinate };
type RouteData = Pick<DirectionsRoute, 'source' | 'distanceMeters' | 'durationMinutes' | 'steps' | 'geometry'>;
const unavailable = () => new DirectionsError('unavailable', 'The directions service is unavailable. Please try again shortly.');
const noRoute = () => new DirectionsError('no_route', 'I couldn’t find a route for those places and that mode of travel.');
const modes = { walk: 'pedestrian', cycle: 'bicycle', drive: 'auto' } as const;
const identify = { 'User-Agent': 'SaoirseCompanion/1.0 (personal directions)', 'X-Client-Id': 'saoirse-personal-companion', Accept: 'application/json' };
const slots = new WeakMap<typeof fetch, Map<string, number>>();
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const valid = (lat: unknown, lon: unknown) => finite(lat) && Math.abs(lat) <= 90 && finite(lon) && Math.abs(lon) <= 180;
const tidy = (x: unknown) => typeof x === 'string' ? x.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
const words = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function input(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > 180 || /[\p{Cc}]/u.test(value))
    throw new DirectionsError('invalid_request', 'Please give a starting place and a destination, such as a station, address, or landmark.');
  const name = value.trim();
  if (/^(?:(?:from\s+)?here|near me|(?:my |our )?(?:current )?(?:location|position)|where (?:i am|we are)|(?:my |our )?(?:home|work)|there)$/i.test(name))
    throw new DirectionsError('invalid_request', 'What is the address, station, or landmark for that location?');
  return name;
}

// A single personal relay only calls these public services on an explicit directions request.
// Reserve each host’s slot synchronously so concurrent requests cannot start together.
async function json(url: URL, request: typeof fetch, signal: AbortSignal) {
  signal.throwIfAborted();
  let hosts = slots.get(request);
  if (!hosts) { hosts = new Map(); slots.set(request, hosts); }
  const now = Date.now(), next = Math.max(hosts.get(url.host) ?? now, now);
  if (next - now > 4000) throw unavailable();
  hosts.set(url.host, next + 1100);
  if (next > now) await delay(next - now, undefined, { signal });
  const response = await request(url, { headers: identify, signal });
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) throw unavailable();
    const detail = await response.json().catch(() => ({}));
    if (url.hostname === 'valhalla1.openstreetmap.de' && [170, 171, 172, 442].includes(detail?.error_code)) throw noRoute();
    if (url.hostname === 'api.tfl.gov.uk' && [300, 404].includes(response.status)) throw noRoute();
    throw unavailable();
  }
  return response.json();
}

function coordinateInput(name: string): Coordinate | undefined {
  const pair = /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/.exec(name);
  if (!pair) return;
  const point: Coordinate = [Number(pair[1]), Number(pair[2])];
  if (!valid(...point)) throw new DirectionsError('invalid_request', 'Please supply a valid latitude followed by longitude.');
  return point;
}
function separation(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180;
  const h = Math.sin((a[0] - b[0]) * rad / 2) ** 2
    + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin((a[1] - b[1]) * rad / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
type PhotonFeature = { geometry?: { coordinates?: number[] }; properties?: Record<string, string> };
function candidate(feature: PhotonFeature, query: string): Place & { exact: boolean } | undefined {
  const xy = feature?.geometry?.coordinates, p = feature?.properties;
  if (!xy || !valid(xy[1], xy[0]) || !p) return;
  const name = tidy(p.name), street = tidy(p.street), house = tidy(p.housenumber), postcode = tidy(p.postcode);
  const requested = words(query), queryTokens = requested.split(' ');
  const postcodeMatch = postcode && requested.replaceAll(' ', '') === words(postcode).replaceAll(' ', '');
  const houseMatch = house && queryTokens.includes(words(house));
  const primary = postcodeMatch ? postcode : houseMatch && street ? [house, street].join(' ') : name || street;
  if (!primary) return;
  const own = words(primary).split(' ');
  const tokens = words([primary, name, street, house, postcode, p.city, p.district, p.county, p.state, p.country, p.countrycode].filter(Boolean).join(' ')).split(' ');
  // Photon can return a street when it cannot resolve a requested house number, or a
  // similarly named POI in another city. Only accept features accounting for the query.
  if (!postcodeMatch && (!queryTokens.some(t => own.includes(t)) || queryTokens.some(t => !tokens.includes(t) && !['the', 'station', 'railway', 'underground'].includes(t)))) return;
  const city = tidy(p.city);
  return { name: city && !words(primary).split(' ').includes(words(city)) && words(city) !== words(primary) ? `${primary}, ${city}` : primary,
    point: [xy[1], xy[0]], exact: !!postcodeMatch || requested === words(primary) || requested === words([primary, city].join(' ')) };
}
async function place(name: string, request: typeof fetch, signal: AbortSignal, bias?: Options['bias']): Promise<Place> {
  const point = coordinateInput(name);
  if (point) return { name, point };
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', name); url.searchParams.set('limit', '6'); url.searchParams.set('lang', 'en');
  const center: Coordinate | undefined = bias && valid(bias.latitude, bias.longitude) ? [bias.latitude, bias.longitude] : undefined;
  if (center) { url.searchParams.set('lat', String(center[0])); url.searchParams.set('lon', String(center[1])); }
  const data = await json(url, request, signal);
  if (!Array.isArray(data?.features)) throw unavailable();
  const matches = (data.features as PhotonFeature[]).map(f => candidate(f, name)).filter(x => x !== undefined);
  const exact = matches.filter(x => x.exact);
  const options = exact.length ? exact : matches;
  const best = options[0];
  if (!best) throw new DirectionsError('ambiguous_place', `I couldn’t identify “${name}”. Please include a town, postcode, or more specific address.`);
  const conflicts = options.slice(1).filter(x => separation(x.point, best.point) > 700);
  if (conflicts.length && !(center && separation(center, best.point) < 30_000 && conflicts.every(x => separation(center, x.point) > 100_000)))
    throw new DirectionsError('ambiguous_place', `Which “${name}” do you mean? Please include the town, postcode, or full address.`);
  return best;
}

// Valhalla returns a six-decimal encoded polyline, latitude first.
function decodeShape(s: unknown): Coordinate[] {
  if (typeof s !== 'string' || s.length > 2_000_000) return [];
  const points: Coordinate[] = [];
  const encoded = s;
  let index = 0, lat = 0, lon = 0;
  function delta(): number {
    let value = 0;
    for (let shift = 0; shift <= 30 && index < encoded.length; shift += 5) {
      const digit = encoded.charCodeAt(index++) - 63;
      if (digit < 0 || digit > 63) break;
      value += (digit & 31) * 2 ** shift;
      if (digit < 32) return value % 2 ? -(value + 1) / 2 : value / 2;
    }
    return NaN;
  }
  while (index < s.length) {
    lat += delta(); lon += delta();
    if (!valid(lat / 1e6, lon / 1e6)) return [];
    points.push([lat / 1e6, lon / 1e6]);
  }
  return points;
}
function bounded(points: Coordinate[][]): Coordinate[] {
  if (points.some(leg => leg.length < 2)) return [];
  const all = points.flat();
  if (all.length <= 400) return all;
  return Array.from({length:400}, (_, i) => all[Math.round(i * (all.length - 1) / 399)]);
}
const badges: Record<number, string> = {
  1:'Start', 2:'Start', 3:'Start', 4:'Arrive', 5:'Arrive', 6:'Arrive', 7:'Ahead', 8:'Ahead',
  9:'Right', 10:'Right', 11:'Right', 12:'U-turn', 13:'U-turn', 14:'Left', 15:'Left', 16:'Left',
  18:'Right', 19:'Left', 20:'Exit', 21:'Exit', 22:'Ahead', 23:'Right', 24:'Left', 27:'Exit',
};

async function streetRoute(from: Place, to: Place, mode: Exclude<DirectionsMode, 'transit'>, request: typeof fetch, signal: AbortSignal): Promise<RouteData> {
  const url = new URL('https://valhalla1.openstreetmap.de/route');
  url.searchParams.set('json', JSON.stringify({ locations: [from, to].map(({point: [lat, lon]}) => ({lat, lon, search_cutoff: 600})),
    costing: modes[mode], units: 'kilometers', language: 'en-GB' }));
  const data = await json(url, request, signal), trip = data?.trip;
  if (!trip || trip.status !== 0 || trip.units !== 'kilometers' || !Array.isArray(trip.legs) || !trip.legs.length || !positive(trip.summary?.time) || !positive(trip.summary?.length)) throw unavailable();
  const steps: RouteData['steps'] = [], shapes: Coordinate[][] = [];
  for (const leg of trip.legs) {
    if (!Array.isArray(leg?.maneuvers) || !leg.maneuvers.length) throw unavailable();
    for (const m of leg.maneuvers) {
      const instruction = tidy(m?.instruction).replace(/(\d+\.\d*?[1-9])0{3,}\b/g, '$1');
      if (!instruction) throw unavailable();
      steps.push({ instruction, distanceMeters: finite(m.length) && m.length >= 0 ? Math.round(m.length * 1000) : undefined, badge: badges[m.type] });
    }
    shapes.push(decodeShape(leg.shape));
  }
  return { source:'Valhalla · © OpenStreetMap contributors', durationMinutes: Math.max(1, Math.round(trip.summary.time / 60)),
    distanceMeters: Math.round(trip.summary.length * 1000), steps, geometry: bounded(shapes) };
}

function tflShape(value: unknown): Coordinate[] {
  if (typeof value !== 'string' || value.length > 2_000_000) return [];
  try {
    const points: unknown = JSON.parse(value);
    if (Array.isArray(points) && points.every(p => Array.isArray(p) && valid(p[0], p[1]))) return points as Coordinate[];
  } catch { /* TfL occasionally omits geometry for a leg. */ }
  return [];
}
async function transitRoute(from: Place, to: Place, request: typeof fetch, signal: AbortSignal): Promise<RouteData> {
  const londonArea = ([lat, lon]: Coordinate) => lat >= 51.1 && lat <= 51.9 && lon >= -0.85 && lon <= 0.5;
  if (![from.point,to.point].some(londonArea)) throw new DirectionsError('no_route', 'I can plan public transport journeys in the London area. Which London journey would you like?');
  const url = new URL(`https://api.tfl.gov.uk/Journey/JourneyResults/${from.point.join(',')}/to/${to.point.join(',')}`);
  url.searchParams.set('journeyPreference', 'leasttime');
  const data = await json(url, request, signal);
  if (!Array.isArray(data?.journeys)) throw unavailable();
  for (const journey of data.journeys) {
    if (!positive(journey?.duration) || !Array.isArray(journey.legs) || !journey.legs.length) continue;
    const legs = journey.legs as { instruction?: { summary?: string }; mode?: { id?: string; name?: string }; distance?: number; path?: {lineString?: string} }[];
    if (!legs.some(l => l?.mode?.id && !['walking','cycle','cycling','bicycle','taxi','car'].includes(l.mode.id))) continue;
    if (!legs.every(l => l?.mode?.id && tidy(l.instruction?.summary))) continue;
    const steps = legs.map(l => ({instruction: tidy(l.instruction?.summary),
      distanceMeters: l.mode?.id === 'walking' && positive(l.distance) ? Math.round(l.distance) : undefined, badge: l.mode?.id === 'walking' ? 'Walk' : undefined}));
    return { source:'Powered by TfL', durationMinutes: Math.max(1,Math.round(journey.duration)),
      // TfL can report tens of metres for a bus journey across London. Only its walk lengths are usable.
      steps, geometry: bounded(legs.map(l => tflShape(l.path?.lineString))) };
  }
  throw noRoute();
}

export async function getDirections(
  params: { origin: string; destination: string; mode: DirectionsMode }, options: Options = {},
): Promise<DirectionsRoute> {
  const origin = input(params.origin), destination = input(params.destination);
  if (!['walk','cycle','drive','transit'].includes(params.mode)) throw new DirectionsError('invalid_request', 'Choose walking, cycling, driving, or public transport.');
  const request = options.fetchImpl ?? fetch, timeout = AbortSignal.timeout(12_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const from = await place(origin, request, signal, options.bias), to = await place(destination, request, signal, options.bias);
    if (separation(from.point, to.point) < 8) throw new DirectionsError('no_route', 'The starting point and destination are at the same location.');
    const route = params.mode === 'transit' ? await transitRoute(from, to, request, signal) : await streetRoute(from, to, params.mode, request, signal);
    return { ...route, origin: from.name, destination: to.name, mode: params.mode,
      originCoordinate: from.point, destinationCoordinate: to.point, steps: route.steps.slice(0,60), totalSteps: route.steps.length };
  } catch (e) {
    options.signal?.throwIfAborted();
    if (e instanceof DirectionsError) throw e;
    throw unavailable();
  }
}
