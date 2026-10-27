import { describe, it, expect } from 'vitest';
import { SentenceAccumulator, extractEmotion } from '../src/text.js';

describe('SentenceAccumulator', () => {
  it('emits sentences as tokens arrive and keeps the remainder', () => {
    const a = new SentenceAccumulator();
    expect(a.push('You said "we')).toEqual([]);
    expect(a.push("'ll see.\" That means no")).toEqual(['You said "we\'ll see."']);
    expect(a.push('. Ask the real question?')).toEqual(['That means no.']);
    expect(a.flush()).toBe('Ask the real question?');
    expect(a.flush()).toBeNull();
  });
  it('does not split on decimals or common abbreviations', () => {
    const a = new SentenceAccumulator();
    expect(a.push('It is 3.5 kg, e.g. heavy. Fine.')).toEqual(['It is 3.5 kg, e.g. heavy.']);
    expect(a.flush()).toBe('Fine.');
  });
  it('splits on newlines too', () => {
    const a = new SentenceAccumulator();
    expect(a.push('One\nTwo')).toEqual(['One']);
  });
});

describe('extractEmotion', () => {
  it('strips a leading tag', () => {
    expect(extractEmotion('[doubtful] Really.')).toEqual({ emotion: 'doubtful', rest: 'Really.' });
  });
  it('defaults to neutral without a tag', () => {
    expect(extractEmotion('Really.')).toEqual({ emotion: 'neutral', rest: 'Really.' });
  });
  it('ignores unknown tags', () => {
    expect(extractEmotion('[smug] Hi')).toEqual({ emotion: 'neutral', rest: 'Hi' });
  });
});
