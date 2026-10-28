import { describe, it, expect } from 'vitest';
import { createServerTools, formatForecast, cleanSearchAnswer, describeWeatherCode } from '../src/server_tools.js';
import { evaluate, convert, tidy, createUtilityTools, parseClockTime, secondsUntil } from '../src/utility_tools.js';
import { loadConfig } from '../src/config.js';

const base = { LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'wss://h/api/ws', SAOIRSE_DEVICE_TOKEN: 't', DEVICE_TZ: 'Europe/London' };
const cfg = loadConfig(base);
const sig = new AbortController().signal;
const forecast = {
  current: { temperature_2m: 8.3, apparent_temperature: 5.9, precipitation: 0, weather_code: 0, wind_speed_10m: 8.6 },
  daily: { time: ['2026-10-28', '2026-10-29', '2026-10-30'], weather_code: [3, 61, 1], temperature_2m_max: [15.4, 15.9, 15], temperature_2m_min: [8.3, 10.6, 8.9],
    precipitation_probability_max: [0, 70, 0], sunrise: ['2026-10-28T06:46', '2026-10-29T06:48', '2026-10-30T06:50'], sunset: ['2026-10-28T16:40', '2026-10-29T16:39', '2026-10-30T16:37'] },
};
const tool = (name: string, fetchImpl: typeof fetch, c = cfg) => createServerTools(c, fetchImpl).find(t => t.spec.function.name === name)!;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('config', () => {
  it('defaults: all five server tools, London home, Perplexity Sonar on the LLM key', () => {
    expect(cfg.serverTools).toEqual(['get_weather', 'web_search', 'calculate', 'convert_units', 'seconds_until']);
    expect(cfg.weather).toEqual({ place: 'London', latitude: 51.5072, longitude: -0.1276, hasCoordinates: true });
    expect(cfg.search).toMatchObject({ model: 'perplexity/sonar', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', timeoutMs: 15000 });
    const only = loadConfig({ ...base, SERVER_TOOLS: 'calculate', WEATHER_PLACE: 'Dublin', WEATHER_LATITUDE: '53.33', WEATHER_LONGITUDE: '-6.25' });
    expect(createServerTools(only, fetch).map(t => t.spec.function.name)).toEqual(['calculate']);
    expect(only.weather).toEqual({ place: 'Dublin', latitude: 53.33, longitude: -6.25, hasCoordinates: true });
    expect(loadConfig({ ...base, WEATHER_PLACE: 'Dublin' }).weather.hasCoordinates).toBe(false);
  });
});

describe('get_weather', () => {
  it('home: one forecast request in the device zone, formatted as sentences', async () => {
    const urls: string[] = [];
    const t = tool('get_weather', (async (u: string) => { urls.push(u); return json(forecast); }) as unknown as typeof fetch);
    const text = await t.run({}, sig);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('latitude=51.5072&longitude=-0.1276');
    expect(urls[0]).toContain('timezone=Europe%2FLondon&forecast_days=2');
    expect(text).toBe('London now: 8°C (feels like 6°C), clear sky, wind 9 km/h, no precipitation. '
      + 'Today: overcast, 8 to 15°C, 0% chance of rain, sunrise 06:46, sunset 16:40. '
      + 'Tomorrow: light rain, 11 to 16°C, 70% chance of rain, sunrise 06:48, sunset 16:39.');
  });
  it('another place is geocoded first; days are clamped to 1..3; an unknown place says so', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      if (u.includes('geocoding')) return json(u.includes('Nowhere') ? {} : { results: [{ name: 'Dublin', country: 'Ireland', latitude: 53.33, longitude: -6.25, timezone: 'Europe/Dublin' }] });
      return json(forecast);
    }) as unknown as typeof fetch;
    const t = tool('get_weather', fetchImpl);
    expect(await t.run({ place: 'Dublin', days: 9 }, sig)).toMatch(/^Dublin, Ireland now: .* The day after: /);
    expect(urls[1]).toContain('latitude=53.33&longitude=-6.25');
    expect(urls[1]).toContain('timezone=Europe%2FDublin&forecast_days=3');
    expect(await t.run({ place: 'Nowhere' }, sig)).toBe('No place called "Nowhere" was found.');
    expect(await t.run({ place: 'london', days: 1 }, sig)).not.toContain('Tomorrow');
  });
  it('throws on an HTTP error (the turn loop turns it into an Error tool result)', async () => {
    await expect(tool('get_weather', (async () => json({}, 503)) as unknown as typeof fetch).run({}, sig)).rejects.toThrow(/HTTP 503/);
  });
  it('maps WMO codes and tolerates missing fields', () => {
    expect(describeWeatherCode(95)).toBe('thunderstorm');
    expect(describeWeatherCode(12345)).toBe('unsettled weather');
    expect(formatForecast('X', {}, 2)).toBe('X now: ?°C (feels like ?°C), unsettled weather, wind ? km/h, no precipitation.');
  });
});

describe('web_search', () => {
  it('asks the search model with a system prompt and returns a cleaned answer', async () => {
    let req: any;
    const t = tool('web_search', (async (u: string, init: any) => {
      req = { u, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return json({ choices: [{ message: { content: 'Arsenal won **2-1** on Saturday [1][2]. The next match is on Wednesday [3].' } }] });
    }) as unknown as typeof fetch);
    expect(await t.run({ query: 'Did Arsenal win at the weekend?' }, sig)).toBe('Arsenal won 2-1 on Saturday. The next match is on Wednesday.');
    expect(req.u).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req.body.model).toBe('perplexity/sonar');
    expect(req.body.messages[1]).toEqual({ role: 'user', content: 'Did Arsenal win at the weekend?' });
    expect(req.auth).toBe('Bearer k');
  });
  it('empty query, empty answer and HTTP errors', async () => {
    const empty = tool('web_search', (async () => json({ choices: [{ message: { content: '' } }] })) as unknown as typeof fetch);
    expect(await empty.run({ query: ' ' }, sig)).toBe('Error: query is required');
    expect(await empty.run({ query: 'q' }, sig)).toBe('The search returned nothing.');
    await expect(tool('web_search', (async () => json({}, 429)) as unknown as typeof fetch).run({ query: 'q' }, sig)).rejects.toThrow(/429/);
  });
  it('cleanSearchAnswer strips citation markers, bold and extra space', () => {
    expect(cleanSearchAnswer('A [1], B [2, 3]\n\n**C** [4][5].')).toBe('A, B C.');
  });
});

describe('calculate', () => {
  it('evaluates arithmetic with precedence, powers, percentages and functions', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('(2 + 3) * 4')).toBe(20);
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluate('-3 ^ 2')).toBe(-9);
    expect(evaluate('15% * 80')).toBe(12);
    expect(evaluate('48.60 * 1.125 / 4')).toBeCloseTo(13.6688, 4);
    expect(evaluate('sqrt(2) * sqrt(2)')).toBeCloseTo(2);
    expect(evaluate('round(2.345, 2) + max(1, 4, 2)')).toBe(6.35);
    expect(evaluate('1,250 × 2 ÷ 5')).toBe(500);
    expect(evaluate('pi * 2')).toBeCloseTo(6.2832, 4);
  });
  it('rejects anything that is not arithmetic, and non-finite results', () => {
    expect(() => evaluate('process.exit()')).toThrow(/unknown word/);
    expect(() => evaluate('2 +')).toThrow();
    expect(() => evaluate('(2')).toThrow(/missing \)/);
    expect(() => evaluate('1 / 0')).toThrow(/finite/);
    expect(() => evaluate('2 3')).toThrow(/syntax/);
  });
  it('the tool answers "expr = value" or an Error line', async () => {
    const calc = createUtilityTools(1000).find(t => t.spec.function.name === 'calculate')!;
    expect(await calc.run({ expression: '48.6 * 1.125 / 4' }, sig)).toBe('48.6 * 1.125 / 4 = 13.6688');
    expect(await calc.run({ expression: 'rm -rf' }, sig)).toMatch(/^Error: /);
    expect(tidy(0.1 + 0.2)).toBe('0.3');
    expect(tidy(1234567.891)).toBe('1234567.891');
  });
});

describe('convert_units', () => {
  it('converts length, mass, volume, cooking, speed, time, area, energy and temperature', () => {
    expect(convert(5, 'miles', 'km').value).toBeCloseTo(8.04672, 5);
    expect(convert(1, 'stone', 'kg').value).toBeCloseTo(6.35029, 5);
    expect(convert(2, 'cups', 'ml').value).toBeCloseTo(473.176, 3);
    expect(convert(1, 'pint', 'ml').value).toBeCloseTo(568.261, 3);
    expect(convert(1, 'us pint', 'ml').value).toBeCloseTo(473.176, 3);
    expect(convert(100, 'km/h', 'mph').value).toBeCloseTo(62.137, 3);
    expect(convert(90, 'min', 'h').value).toBe(1.5);
    expect(convert(1, 'acre', 'm²').value).toBeCloseTo(4046.856, 3);
    expect(convert(1, 'kcal', 'kJ').value).toBeCloseTo(4.184, 6);
    expect(convert(180, 'C', 'F')).toEqual({ value: 356, from: '°C', to: '°F' });
    expect(convert(350, 'fahrenheit', 'celsius').value).toBeCloseTo(176.667, 3);
    expect(convert(0, 'C', 'K').value).toBeCloseTo(273.15, 2);
  });
  it('refuses unknown units and mixed dimensions', () => {
    expect(() => convert(1, 'parsec', 'km')).toThrow(/unknown unit "parsec"/);
    expect(() => convert(1, 'kg', 'km')).toThrow(/can't convert mass \(kg\) to length \(km\)/);
    expect(() => convert(1, 'C', 'kg')).toThrow(/can't convert/);
  });
  it('the tool answers "value from = value to" or an Error line', async () => {
    const conv = createUtilityTools(1000).find(t => t.spec.function.name === 'convert_units')!;
    expect(await conv.run({ value: 180, from: 'C', to: 'F' }, sig)).toBe('180 °C = 356 °F');
    expect(await conv.run({ value: 2, from: 'cups', to: 'ml' }, sig)).toBe('2 cup = 473.176 ml');
    expect(await conv.run({ value: 'lots', from: 'g', to: 'kg' }, sig)).toBe('Error: value must be a number');
  });
});

describe('review fixes', () => {
  it('calculator: percentages added to a number, thousands separators only outside brackets, argument counts', () => {
    expect(evaluate('100 + 10%')).toBeCloseTo(110, 9);
    expect(evaluate('80 - 25%')).toBeCloseTo(60, 9);
    expect(evaluate('64.50 + 18%')).toBeCloseTo(76.11, 9);
    expect(evaluate('(100 + 10%) / 2')).toBeCloseTo(55, 9);
    expect(evaluate('10% * 50 + 5')).toBe(10);
    expect(evaluate('max(1,250)')).toBe(250);
    expect(evaluate('min(5,100)')).toBe(5);
    expect(evaluate('1,234,567 / 1')).toBe(1234567);
    expect(() => evaluate('sqrt(4,9)')).toThrow(/sqrt takes 1 argument, got 2/);
    expect(() => evaluate('round(1,2,3)')).toThrow(/round takes 1 to 2 arguments, got 3/);
    expect(() => evaluate('max()')).toThrow();
  });

  it('seconds_until: parses clock times and counts to the next occurrence in the device zone', async () => {
    expect(parseClockTime('18:00')).toBe(1080);
    expect(parseClockTime('6pm')).toBe(1080);
    expect(parseClockTime('6:30 p.m.')).toBe(1110);
    expect(parseClockTime('12am')).toBe(0);
    expect(parseClockTime('12 pm')).toBe(720);
    expect(parseClockTime('noon')).toBe(720);
    expect(parseClockTime('midnight')).toBe(0);
    expect(parseClockTime('25:00')).toBeNull();
    expect(parseClockTime('13pm')).toBeNull();
    expect(parseClockTime('teatime')).toBeNull();
    const at = new Date('2026-10-28T17:40:30Z'); // 17:40:30 in London (GMT)
    expect(secondsUntil(at, 'Europe/London', 18 * 60)).toBe(1170);
    expect(secondsUntil(at, 'Europe/London', 17 * 60)).toBe(86400 - 2430);
    expect(secondsUntil(new Date('2026-07-15T17:40:00Z'), 'Europe/London', 19 * 60)).toBe(1200); // BST
    const tool = createUtilityTools(1000, 'Europe/London', () => at).find(t => t.spec.function.name === 'seconds_until')!;
    expect(await tool.run({ time: '6pm' }, sig)).toBe('18:00 is 1170 seconds from now (20 min).');
    expect(await tool.run({ time: 'teatime' }, sig)).toBe('Error: could not read "teatime" as a clock time');
  });

  it('search cleaning is linear on long digit runs (no catastrophic backtracking)', () => {
    const t0 = Date.now();
    cleanSearchAnswer('[' + '1'.repeat(5000) + 'x');
    cleanSearchAnswer('A [' + '1 '.repeat(3000) + '.');
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('weather: a WEATHER_PLACE without coordinates is geocoded, not paired with London', async () => {
    const urls: string[] = [];
    const c = loadConfig({ ...base, WEATHER_PLACE: 'Dublin' });
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      if (u.includes('geocoding')) return json({ results: [{ name: 'Dublin', country: 'Ireland', latitude: 53.33, longitude: -6.25, timezone: 'Europe/Dublin' }] });
      return json(forecast);
    }) as unknown as typeof fetch;
    const text = await tool('get_weather', fetchImpl, c).run({}, sig);
    expect(urls[0]).toContain('geocoding-api.open-meteo.com');
    expect(urls[1]).toContain('latitude=53.33&longitude=-6.25');
    expect(text).toMatch(/^Dublin, Ireland now:/);
  });
});
