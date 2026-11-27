import { makeLiveCard } from './live_cards.js';
import { DirectionsError, getDirections, type DirectionsMode, type DirectionsRoute } from './directions.js';
import type { ServerTool } from './server_tools.js';

export const DIRECTIONS_TOOL = 'get_directions';
const modes: Record<DirectionsMode, string> = {
  walk: 'Walking', cycle: 'Cycling', drive: 'Driving', transit: 'Public transport',
};
const namedMode: Record<string, DirectionsMode> = {
  walk: 'walk', walking: 'walk', foot: 'walk', cycle: 'cycle', cycling: 'cycle', bike: 'cycle', bicycle: 'cycle',
  drive: 'drive', driving: 'drive', car: 'drive', transit: 'transit', bus: 'transit', tube: 'transit',
  train: 'transit', 'public transport': 'transit',
};
const modeWords = Object.keys(namedMode).join('|');
const trailingMode = new RegExp(`\\s+(?:by|on|via)\\s+(?:the\\s+)?(${modeWords})$`, 'i');
const explicitDirections = /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:give me\s+|show me\s+|find me\s+|plan\s+)?(?:the\s+|a\s+)?(?:(walking|cycling|driving|public transport|transit)\s+)?(?:map\s+)?(?:directions|route|journey)\s+(?=from\b|to\b)/i;
const gettingThere = /^(?:please\s+)?(?:how (?:do|can|should|would) I (get|walk|cycle|drive)|what(?:'s| is) the best way to (get|walk|cycle|drive))\s+(?=from\b|to\b)/i;
const vagueOrigin = /^(?:here|home|my (?:location|address|home|office|work)|where i am|work|current location)$/i;

export function asksForDirections(text: string): boolean {
  return /\b(?:directions|route|journey plan|how (?:do|can|should) (?:i|we) (?:get|walk|drive|cycle)|(?:walk|drive|cycle) from .+ to)\b/i.test(text);
}

export interface DirectionsQuery { origin?: string; destination: string; mode: DirectionsMode }

export function parseDirectionsRequest(text: string): DirectionsQuery | undefined {
  const clean = text.trim().replace(/[.!?]+$/, '').replace(/,?\s+please$/i, '');
  const opening = explicitDirections.exec(clean) ?? gettingThere.exec(clean);
  if (!opening) return;
  const routeText = clean.slice(opening[0].length);
  const modeMatch = trailingMode.exec(routeText);
  const hint = (modeMatch?.[1] ?? opening[1] ?? opening[2] ?? '').toLowerCase();
  const mode = namedMode[hint] ?? 'walk';
  const places = modeMatch ? routeText.slice(0, modeMatch.index) : routeText;
  const endpoints = /^from\s+(.+?)\s+to\s+(.+)$/i.exec(places);
  if (endpoints) {
    const origin = endpoints[1].trim().replace(/,$/, '');
    return { origin: vagueOrigin.test(origin) ? undefined : origin, destination: endpoints[2].trim(), mode };
  }
  const destination = /^to\s+(.+)$/i.exec(places)?.[1].trim();
  return destination ? { destination, mode } : undefined;
}

export function parseDirectionsOrigin(text: string): string | undefined {
  const clean = text.trim().replace(/[.!?]+$/, '').replace(/,?\s+please$/i, '');
  const marked = /^(?:from|start(?:ing)? (?:from|at))\s+(.+)$/i.exec(clean);
  if (marked) return vagueOrigin.test(marked[1]) ? undefined : marked[1];
  if (/[!?]/.test(text) || vagueOrigin.test(clean) || clean.length < 2 || clean.split(/\s+/).length > 8 ||
      /^(?:never mind|cancel|good (?:morning|evening|night)|hello|thanks?|yes|no|what|where|when|which|how|who|why|is|are|can|could|do|does|tell|play|set|show|turn|weather|directions|take|remind)\b/i.test(clean)) return;
  return clean;
}

const digits = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
function distance(meters: number | undefined): string | undefined {
  if (!Number.isFinite(meters) || meters === undefined || meters <= 0) return;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${digits.format(meters / 1000)} km`;
}

function previewTitle(destination: string): string {
  const place = destination.split(',')[0];
  return place.length > 30 ? `To ${place.slice(0, 27).trimEnd()}…` : `To ${place}`;
}

export function directionsTool(fetchImpl: typeof fetch): ServerTool {
  return {
    timeoutMs: 11_000,
    spec: { type: 'function', function: {
      name: DIRECTIONS_TOOL,
      description: 'Plan map directions between two places the user expressly specified. Ask where to start if missing. Never infer the start from home, here, a weather location, or GPS. Use walk by default, cycle for bicycle, drive for car, and transit for public transport. For live departure boards use get_london_departures.',
      parameters: { type: 'object', properties: {
        origin: { type: 'string', description: 'Spoken starting address, named place, or postcode, including any stated city.' },
        destination: { type: 'string', description: 'Spoken destination address, named place, or postcode, including any stated city.' },
        mode: { type: 'string', enum: ['walk', 'cycle', 'drive', 'transit'] },
      }, required: ['origin', 'destination', 'mode'] },
    } },
    async run(args, signal, display) {
      const origin = typeof args.origin === 'string' ? args.origin.trim() : '';
      const destination = typeof args.destination === 'string' ? args.destination.trim() : '';
      const mode = (args.mode ?? 'walk') as DirectionsMode;
      if (!origin || vagueOrigin.test(origin)) return 'Error: Where are you starting from?';
      if (!destination) return 'Error: Where would you like to go?';
      if (origin.length > 160 || destination.length > 160 || !Object.hasOwn(modes, mode)) {
        return 'Error: Give two places and choose walking, cycling, driving, or public transport.';
      }
      if (mode === 'transit' && /\b(?:tomorrow|tonight|next (?:week|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:at|by) \d{1,2}(?::\d{2}|\s*(?:a\.?m|p\.?m))\b)/i.test(destination)) {
        return 'Error: I can show the route leaving now. For a timed journey, choose your departure or arrival time in Maps.';
      }
      let route: DirectionsRoute;
      try {
        route = await getDirections({ origin, destination, mode }, { fetchImpl, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        return 'Error: ' + (error instanceof DirectionsError ? error.message : 'I couldn’t get a route right now.');
      }
      if (signal.aborted) return '';
      const time = Math.max(1, Math.round(route.durationMinutes));
      const timeLabel = time < 60 ? `${time} min` : `${Math.floor(time / 60)}h ${time % 60}m`;
      const places = route.destination.split(',')[0];
      const routeDistance = distance(route.distanceMeters);
      const first = route.steps[0]?.instruction.trim();
      const items = route.steps.slice(0, route.totalSteps > 9 ? 8 : 9).map((step, i) => ({
        badge: step.badge || String(i + 1), title: step.instruction.slice(0, 145), detail: distance(step.distanceMeters),
      }));
      if (items.length < route.totalSteps) items.push({
        badge: '', title: `${route.totalSteps - items.length} more steps`, detail: 'See the map for the rest',
      });
      const spoken = `It’s about ${time} minute${time === 1 ? '' : 's'} to ${places} ${mode === 'walk' ? 'on foot' : mode === 'cycle' ? 'by bike' : mode === 'drive' ? 'by car' : 'by public transport'}.`
        + (first ? ` ${first}${/[.!?]$/.test(first) ? '' : '.'}` : '');
      display?.(makeLiveCard('directions', previewTitle(route.destination), route.source, items, {
        hero: timeLabel, subtitle: [modes[mode], routeDistance].filter(Boolean).join(' · '),
      }), spoken, route);
      return spoken;
    },
  };
}
