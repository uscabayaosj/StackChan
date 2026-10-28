import type { ServerTool } from './server_tools.js';
import { localHourMinute } from './clock.js';

/* ------------------------------- calculator ------------------------------- */

type Tok = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' } | { t: 'fn'; v: string } | { t: 'comma' };
const FUNCS: Record<string, { f: (...a: number[]) => number; min: number; max: number }> = {
  sqrt: { f: Math.sqrt, min: 1, max: 1 }, abs: { f: Math.abs, min: 1, max: 1 },
  round: { f: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d, min: 1, max: 2 },
  floor: { f: Math.floor, min: 1, max: 1 }, ceil: { f: Math.ceil, min: 1, max: 1 },
  min: { f: Math.min, min: 1, max: 99 }, max: { f: Math.max, min: 1, max: 99 },
  log: { f: Math.log10, min: 1, max: 1 }, ln: { f: Math.log, min: 1, max: 1 },
  sin: { f: Math.sin, min: 1, max: 1 }, cos: { f: Math.cos, min: 1, max: 1 }, tan: { f: Math.tan, min: 1, max: 1 },
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Outside brackets "1,250,000" is a number with thousands separators; inside, commas separate arguments. */
function stripThousands(src: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0 && /\d$/.test(out) && /^\d{3}(?!\d)/.test(src.slice(i + 1))) continue;
    out += c;
  }
  return out;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const s = stripThousands(src.replace(/×/g, '*').replace(/÷/g, '/'));
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[a-z]+/i.exec(s.slice(i));
    if (word) {
      const w = word[0].toLowerCase();
      if (w in FUNCS) out.push({ t: 'fn', v: w });
      else if (w in CONSTS) out.push({ t: 'num', v: CONSTS[w] });
      else throw new Error(`unknown word "${word[0]}"`);
      i += word[0].length; continue;
    }
    if ('+-*/^%'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (c === ',') {
      out.push({ t: 'comma' }); i++; continue;
    }
    throw new Error(`unexpected "${c}"`);
  }
  return out;
}

/** Evaluates an arithmetic expression (+ - * / ^ %, parentheses, a few functions). No code execution. */
export function evaluate(expr: string): number {
  const toks = tokenize(expr);
  let p = 0;
  let pct = false; // set when a primary reads "n%"
  const peek = () => toks[p];
  const isOp = (v: string) => { const k = peek(); return k?.t === 'op' && k.v === v; };
  function primary(): number {
    const k = toks[p++];
    if (!k) throw new Error('unexpected end');
    if (k.t === 'num') {
      if (isOp('%')) { p++; pct = true; return k.v / 100; } // "15%" alone is 0.15; "a + 15%" adds 15% of a
      return k.v;
    }
    if (k.t === 'op' && (k.v === '-' || k.v === '+')) { const v = power(); return k.v === '-' ? -v : v; }
    if (k.t === 'lp') { const v = expression(); if (toks[p++]?.t !== 'rp') throw new Error('missing )'); return v; }
    if (k.t === 'fn') {
      if (toks[p++]?.t !== 'lp') throw new Error(`${k.v} needs (`);
      const args = [expression()];
      while (peek()?.t === 'comma') { p++; args.push(expression()); }
      if (toks[p++]?.t !== 'rp') throw new Error('missing )');
      const fn = FUNCS[k.v];
      if (args.length < fn.min || args.length > fn.max) throw new Error(`${k.v} takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} argument${fn.max === 1 ? '' : 's'}, got ${args.length}`);
      return fn.f(...args);
    }
    throw new Error('syntax error');
  }
  function power(): number { const b = primary(); if (isOp('^')) { p++; return b ** power(); } return b; }
  function term(): { v: number; pct: boolean } {
    pct = false;
    let v = power();
    let onlyPct = pct;
    while (isOp('*') || isOp('/')) { const o = (toks[p++] as any).v; const r = power(); v = o === '*' ? v * r : v / r; onlyPct = false; }
    return { v, pct: onlyPct };
  }
  function expression(): number {
    let v = term().v;
    while (isOp('+') || isOp('-')) {
      const o = (toks[p++] as any).v;
      const r = term();
      // Calculator semantics: "100 + 10%" is 110, "80 - 25%" is 60.
      if (r.pct) v = o === '+' ? v * (1 + r.v) : v * (1 - r.v);
      else v = o === '+' ? v + r.v : v - r.v;
    }
    return v;
  }
  const v = expression();
  if (p !== toks.length) throw new Error('syntax error');
  if (!Number.isFinite(v)) throw new Error('the result is not a finite number');
  return v;
}

/** Up to 6 significant figures, no trailing zeros, no exponent for everyday sizes. */
export function tidy(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-6) return n.toPrecision(6);
  const s = Number(n.toPrecision(abs >= 1e6 ? 15 : 6)).toString();
  return s;
}

/* ---------------------------- unit conversion ----------------------------- */

/** factor to the dimension's base unit (m, kg, l, m/s, s, m², J). Temperature is handled separately. */
const UNITS: Record<string, { dim: string; f: number; name: string }> = {};
function unit(dim: string, f: number, name: string, ...aliases: string[]) { for (const a of [name, ...aliases]) UNITS[a.toLowerCase()] = { dim, f, name }; }
unit('length', 1, 'm', 'metre', 'metres', 'meter', 'meters'); unit('length', 1000, 'km', 'kilometre', 'kilometres', 'kilometer', 'kilometers');
unit('length', 0.01, 'cm', 'centimetre', 'centimetres', 'centimeter', 'centimeters'); unit('length', 0.001, 'mm', 'millimetre', 'millimetres', 'millimeter', 'millimeters');
unit('length', 1609.344, 'mi', 'mile', 'miles'); unit('length', 0.9144, 'yd', 'yard', 'yards'); unit('length', 0.3048, 'ft', 'foot', 'feet');
unit('length', 0.0254, 'in', 'inch', 'inches'); unit('length', 1852, 'nmi', 'nautical mile', 'nautical miles');
unit('mass', 1, 'kg', 'kilogram', 'kilograms', 'kilo', 'kilos'); unit('mass', 0.001, 'g', 'gram', 'grams'); unit('mass', 1e-6, 'mg', 'milligram', 'milligrams');
unit('mass', 0.45359237, 'lb', 'lbs', 'pound', 'pounds'); unit('mass', 0.028349523125, 'oz', 'ounce', 'ounces'); unit('mass', 6.35029318, 'st', 'stone', 'stones');
unit('mass', 1000, 't', 'tonne', 'tonnes');
unit('volume', 1, 'l', 'litre', 'litres', 'liter', 'liters'); unit('volume', 0.001, 'ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters');
unit('volume', 0.01, 'cl', 'centilitre', 'centilitres'); unit('volume', 0.236588, 'cup', 'cups'); unit('volume', 0.0147868, 'tbsp', 'tablespoon', 'tablespoons');
unit('volume', 0.00492892, 'tsp', 'teaspoon', 'teaspoons'); unit('volume', 0.0295735, 'fl oz', 'fluid ounce', 'fluid ounces', 'floz');
unit('volume', 0.568261, 'pint', 'pints', 'uk pint', 'uk pints'); unit('volume', 0.473176, 'us pint', 'us pints');
unit('volume', 4.54609, 'gallon', 'gallons', 'uk gallon', 'uk gallons'); unit('volume', 3.785411784, 'us gallon', 'us gallons');
unit('speed', 1, 'm/s', 'metres per second', 'meters per second'); unit('speed', 1 / 3.6, 'km/h', 'kph', 'kmh', 'kilometres per hour', 'kilometers per hour');
unit('speed', 0.44704, 'mph', 'miles per hour'); unit('speed', 0.514444, 'knot', 'knots', 'kn');
unit('time', 1, 's', 'second', 'seconds', 'sec', 'secs'); unit('time', 60, 'min', 'minute', 'minutes', 'mins'); unit('time', 3600, 'h', 'hour', 'hours', 'hr', 'hrs');
unit('time', 86400, 'day', 'days'); unit('time', 604800, 'week', 'weeks');
unit('area', 1, 'm²', 'm2', 'square metre', 'square metres', 'sq m'); unit('area', 0.09290304, 'ft²', 'ft2', 'square foot', 'square feet', 'sq ft');
unit('area', 10000, 'hectare', 'hectares', 'ha'); unit('area', 4046.8564224, 'acre', 'acres'); unit('area', 1e6, 'km²', 'km2', 'square kilometre', 'square kilometres');
unit('energy', 1, 'J', 'joule', 'joules'); unit('energy', 1000, 'kJ', 'kilojoule', 'kilojoules'); unit('energy', 4184, 'kcal', 'calorie', 'calories', 'kilocalorie', 'kilocalories');
unit('energy', 3.6e6, 'kWh', 'kilowatt hour', 'kilowatt hours');
const TEMPS: Record<string, string> = { c: 'C', '°c': 'C', celsius: 'C', centigrade: 'C', f: 'F', '°f': 'F', fahrenheit: 'F', k: 'K', kelvin: 'K' };

/** Converts a value between units of the same kind; throws with a readable message otherwise. */
export function convert(value: number, from: string, to: string): { value: number; from: string; to: string } {
  const a = from.trim().toLowerCase(), b = to.trim().toLowerCase();
  if (a in TEMPS || b in TEMPS) {
    const fa = TEMPS[a], fb = TEMPS[b];
    if (!fa || !fb) throw new Error(`can't convert ${from} to ${to}`);
    const c = fa === 'C' ? value : fa === 'F' ? (value - 32) * 5 / 9 : value - 273.15;
    const out = fb === 'C' ? c : fb === 'F' ? c * 9 / 5 + 32 : c + 273.15;
    return { value: out, from: fa === 'K' ? 'K' : `°${fa}`, to: fb === 'K' ? 'K' : `°${fb}` };
  }
  const ua = UNITS[a], ub = UNITS[b];
  if (!ua) throw new Error(`unknown unit "${from}"`);
  if (!ub) throw new Error(`unknown unit "${to}"`);
  if (ua.dim !== ub.dim) throw new Error(`can't convert ${ua.dim} (${from}) to ${ub.dim} (${to})`);
  return { value: (value * ua.f) / ub.f, from: ua.name, to: ub.name };
}

/* ------------------------------ time until ------------------------------- */

/** Parses "18:00", "6pm", "6:30 pm", "noon", "midnight" into minutes after midnight, or null. */
export function parseClockTime(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\./g, '');
  if (t === 'noon' || t === 'midday') return 12 * 60;
  if (t === 'midnight') return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'am') h = h === 12 ? 0 : h; else h = h === 12 ? 12 : h + 12;
  } else if (h > 23 || (!m[2] && h > 23)) return null;
  return h * 60 + min;
}

/** Seconds from `at` until the next occurrence of `minutesOfDay` in `timeZone` (1..86400). */
export function secondsUntil(at: Date, timeZone: string, minutesOfDay: number): number {
  const { hour, minute } = localHourMinute(at, timeZone);
  const nowSec = hour * 3600 + minute * 60 + at.getUTCSeconds();
  let diff = minutesOfDay * 60 - nowSec;
  if (diff <= 0) diff += 86400;
  return diff;
}

export function createUtilityTools(timeoutMs: number, timeZone = 'UTC', now: () => Date = () => new Date()): ServerTool[] {
  return [
    {
      timeoutMs,
      spec: { type: 'function', function: {
        name: 'seconds_until',
        description: 'Exact number of seconds from now until a clock time (the next time it comes round, today or tomorrow). Use it for reminders at a time ("at 6 pm") instead of working it out yourself.',
        parameters: { type: 'object', properties: { time: { type: 'string', description: 'e.g. "18:00", "6pm", "6:30 pm", "noon"' } }, required: ['time'] },
      } },
      async run(args) {
        const text = typeof args.time === 'string' ? args.time : '';
        const mins = parseClockTime(text);
        if (mins === null) return `Error: could not read "${text}" as a clock time`;
        const s = secondsUntil(now(), timeZone, mins);
        const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
        const hh = String(Math.floor(mins / 60)).padStart(2, '0'), mm = String(mins % 60).padStart(2, '0');
        return `${hh}:${mm} is ${s} seconds from now (${h > 0 ? `${h} h ` : ''}${m} min)${s > 24 * 3600 - 60 ? ', tomorrow' : ''}.`;
      },
    },
    {
      timeoutMs,
      spec: { type: 'function', function: {
        name: 'calculate',
        description: 'Exact arithmetic. Use for any sum, percentage, tip, split or multi-step number instead of working it out yourself. Operators + - * / ^ and %, parentheses, sqrt round min max abs. "15% of 80" is 15% * 80.',
        parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      } },
      async run(args) {
        const expr = typeof args.expression === 'string' ? args.expression : '';
        try { return `${expr.trim()} = ${tidy(evaluate(expr))}`; } catch (err) { return `Error: ${(err as Error).message}`; }
      },
    },
    {
      timeoutMs,
      spec: { type: 'function', function: {
        name: 'convert_units',
        description: 'Exact unit conversion: length, weight, volume and cooking measures (cups, tbsp, tsp; pints and gallons are UK unless "us pint"/"us gallon"), temperature (C, F, K), speed, time, area, energy (kcal, kJ, kWh).',
        parameters: { type: 'object', properties: { value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['value', 'from', 'to'] },
      } },
      async run(args) {
        const value = typeof args.value === 'number' ? args.value : Number(args.value);
        if (!Number.isFinite(value)) return 'Error: value must be a number';
        try {
          const r = convert(value, String(args.from ?? ''), String(args.to ?? ''));
          return `${tidy(value)} ${r.from} = ${tidy(r.value)} ${r.to}`;
        } catch (err) { return `Error: ${(err as Error).message}`; }
      },
    },
  ];
}
