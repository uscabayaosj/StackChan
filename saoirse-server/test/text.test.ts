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

describe('SentenceAccumulator clock abbreviations', () => {
  it('does not split "a.m." / "p.m." from the words after them', () => {
    const acc = new SentenceAccumulator();
    expect(acc.push("It's 4:51 a.m. today. ")).toEqual(["It's 4:51 a.m. today."]);
    expect(acc.push('Lunch is at 12 p.m. sharp, apparently. Go. ')).toEqual(['Lunch is at 12 p.m. sharp, apparently.', 'Go.']);
  });
  it('keeps "a.m." joined to a following capitalised word, like the other abbreviations', () => {
    const acc = new SentenceAccumulator();
    expect(acc.push("Wake me at 6 a.m. That's all.")).toEqual([]);
    expect(acc.flush()).toBe("Wake me at 6 a.m. That's all.");
  });
});
