import { describe, it, expect } from 'vitest';
import { EnergyVad } from '../src/vad.js';

const mk = () => new EnergyVad({ rmsThreshold: 0.02, silenceMs: 300, minSpeechMs: 180, frameMs: 60 });

describe('EnergyVad', () => {
  it('stays silent on quiet frames', () => {
    const v = mk();
    for (let i = 0; i < 20; i++) expect(v.push(0.001)).toBe('silence');
  });
  it('reports end after speech followed by enough silence', () => {
    const v = mk();
    const out: string[] = [];
    for (let i = 0; i < 5; i++) out.push(v.push(0.1)); // 300 ms speech
    for (let i = 0; i < 4; i++) out.push(v.push(0.001)); // 240 ms silence
    out.push(v.push(0.001)); // 300 ms silence -> end
    expect(out.slice(0, 5)).toEqual(['speech', 'speech', 'speech', 'speech', 'speech']);
    expect(out[8]).toBe('silence');
    expect(out[9]).toBe('end');
    expect(v.speechMs).toBe(300);
  });
  it('reports too-short for a blip shorter than minSpeechMs', () => {
    const v = mk();
    v.push(0.1); v.push(0.1); // 120 ms
    for (let i = 0; i < 4; i++) v.push(0.001);
    expect(v.push(0.001)).toBe('too-short');
  });
  it('reset clears state', () => {
    const v = mk();
    v.push(0.1); v.reset();
    expect(v.speechMs).toBe(0);
    expect(v.push(0.001)).toBe('silence');
  });
});
