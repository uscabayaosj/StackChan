import type { Config } from './config.js';
import type { ToolSpec } from './llm.js';
import { createUtilityTools } from './utility_tools.js';

/** A tool that runs on the server (not the robot): weather, web search. */
export interface ServerTool {
  spec: ToolSpec;
  timeoutMs: number;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** WMO weather interpretation codes (Open-Meteo `weather_code`). */
const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'light snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};
export const describeWeatherCode = (code: number): string => WMO[code] ?? 'unsettled weather';

async function getJson(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<any> {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

const round = (n: unknown) => (typeof n === 'number' ? Math.round(n) : '?');
const hhmm = (iso: unknown) => (typeof iso === 'string' && iso.includes('T') ? iso.split('T')[1].slice(0, 5) : '?');

/** Formats an Open-Meteo forecast response as a few plain sentences for the LLM. */
export function formatForecast(place: string, data: any, days: number): string {
  const c = data?.current ?? {};
  const d = data?.daily ?? {};
  const lines: string[] = [];
  lines.push(`${place} now: ${round(c.temperature_2m)}°C (feels like ${round(c.apparent_temperature)}°C), ${describeWeatherCode(c.weather_code)}, wind ${round(c.wind_speed_10m)} km/h, ${c.precipitation > 0 ? `${c.precipitation} mm precipitation` : 'no precipitation'}.`);
  const names = ['Today', 'Tomorrow', 'The day after'];
  const n = Math.min(days, Array.isArray(d.time) ? d.time.length : 0);
  for (let i = 0; i < n; i++) {
    lines.push(`${names[i] ?? d.time[i]}: ${describeWeatherCode(d.weather_code?.[i])}, ${round(d.temperature_2m_min?.[i])} to ${round(d.temperature_2m_max?.[i])}°C, ${round(d.precipitation_probability_max?.[i])}% chance of rain, sunrise ${hhmm(d.sunrise?.[i])}, sunset ${hhmm(d.sunset?.[i])}.`);
  }
  return lines.join(' ');
}

function weatherTool(cfg: Config, fetchImpl: typeof fetch): ServerTool {
  const home = cfg.weather;
  return {
    timeoutMs: cfg.toolTimeoutMs.other,
    spec: {
      type: 'function',
      function: {
        name: 'get_weather',
        description: `Current weather and the forecast for up to 3 days. Without a place it is for home (${home.place}).`,
        parameters: {
          type: 'object',
          properties: {
            place: { type: 'string', description: `A city or town; omit for home (${home.place}).` },
            days: { type: 'integer', minimum: 1, maximum: 3, description: 'Forecast days including today (default 2).' },
          },
          required: [],
        },
      },
    },
    async run(args, signal) {
      let { latitude, longitude, place, timezone } = { latitude: home.latitude, longitude: home.longitude, place: home.place, timezone: cfg.deviceTz };
      const asked = (typeof args.place === 'string' ? args.place.trim() : '') || (home.hasCoordinates ? '' : home.place);
      if (asked && (asked.toLowerCase() !== home.place.toLowerCase() || !home.hasCoordinates)) {
        const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(asked)}&count=1&language=en&format=json`, fetchImpl, signal);
        const hit = geo?.results?.[0];
        if (!hit) return `No place called "${asked}" was found.`;
        ({ latitude, longitude } = hit);
        place = [hit.name, hit.country].filter(Boolean).join(', ');
        timezone = hit.timezone || 'auto';
      }
      const days = Math.min(3, Math.max(1, Number.isInteger(args.days) ? (args.days as number) : 2));
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
        + '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'
        + `&timezone=${encodeURIComponent(timezone)}&forecast_days=${days}`;
      return formatForecast(place, await getJson(url, fetchImpl, signal), days);
    },
  };
}

export const SEARCH_SYSTEM_PROMPT =
  'Answer the query with current, specific facts in two to four plain sentences, as briefly as the question allows. ' +
  'Include dates and numbers when they matter. No citation markers, no URLs, no markdown. If you cannot find it, say so.';

/** Removes citation markers like [1] or [2][3] and stray markdown emphasis. */
export function cleanSearchAnswer(text: string): string {
  return text.replace(/\s*\[\d+(?:[,\s]+\d+)*\](?:\[\d+\])*/g, '').replace(/\*\*?/g, '').replace(/\s+/g, ' ').trim();
}

function webSearchTool(cfg: Config, fetchImpl: typeof fetch): ServerTool {
  const s = cfg.search;
  return {
    timeoutMs: s.timeoutMs,
    spec: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Searches the web and returns a short factual answer. For anything current or specific: news, sport, prices, opening hours, recent events, facts you are unsure of.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'A complete, specific search question.' } },
          required: ['query'],
        },
      },
    },
    async run(args, signal) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'Error: query is required';
      const res = await fetchImpl(`${s.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/uscabayaosj/StackChan', 'X-Title': 'Saoirse StackChan' },
        body: JSON.stringify({ model: s.model, max_tokens: 300, messages: [{ role: 'system', content: SEARCH_SYSTEM_PROMPT }, { role: 'user', content: query }] }),
        signal,
      });
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const json: any = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) return 'The search returned nothing.';
      return cleanSearchAnswer(text).slice(0, 1200);
    },
  };
}

/** The server tools enabled by `cfg.serverTools` (get_weather, web_search, calculate, convert_units, seconds_until). */
export function createServerTools(cfg: Config, fetchImpl: typeof fetch = fetch): ServerTool[] {
  const all = [weatherTool(cfg, fetchImpl), webSearchTool(cfg, fetchImpl), ...createUtilityTools(cfg.toolTimeoutMs.other, cfg.deviceTz)];
  const on = new Set(cfg.serverTools);
  return all.filter(t => on.has(t.spec.function.name));
}
