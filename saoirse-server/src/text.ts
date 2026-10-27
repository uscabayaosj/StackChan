export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'doubtful', 'sleepy'] as const;
export type Emotion = (typeof EMOTIONS)[number];

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'mr.', 'mrs.', 'ms.', 'dr.', 'vs.', 'st.', 'a.m.', 'p.m.'];

/** Accumulates streamed LLM text and yields complete sentences. */
export class SentenceAccumulator {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let i = 0;
    while (i < this.buf.length) {
      const ch = this.buf[i];
      if (ch === '\n') {
        const s = this.buf.slice(0, i).trim();
        if (s) out.push(s);
        this.buf = this.buf.slice(i + 1);
        i = 0;
        continue;
      }
      if (ch === '.' || ch === '!' || ch === '?') {
        // consume trailing quotes/brackets and the following whitespace
        let j = i + 1;
        while (j < this.buf.length && '"\')]'.includes(this.buf[j])) j++;
        const boundary = j < this.buf.length && /\s/.test(this.buf[j]);
        if (!boundary) { i++; continue; }
        const candidate = this.buf.slice(0, j).trim();
        const lower = candidate.toLowerCase();
        const lastWord = lower.split(/\s+/).pop() ?? '';
        const isDecimal = ch === '.' && /\d$/.test(this.buf.slice(0, i)) && /^\d/.test(this.buf.slice(j).trimStart());
        if (ABBREVIATIONS.includes(lastWord) || isDecimal) { i = j; continue; }
        if (candidate) out.push(candidate);
        this.buf = this.buf.slice(j).trimStart();
        i = 0;
        continue;
      }
      i++;
    }
    return out;
  }

  flush(): string | null {
    const s = this.buf.trim();
    this.buf = '';
    return s ? s : null;
  }
}

/**
 * Respellings for the TTS voice only; the text shown on the robot keeps the real spelling.
 * ElevenLabs reads "Saoirse" as written; "Seersha" gets SEER-shuh.
 */
export function speechText(text: string): string {
  return text.replace(/saoirse/gi, m => (m[0] === 'S' ? 'Seersha' : 'seersha'));
}

export function extractEmotion(text: string): { emotion: Emotion; rest: string } {
  const m = /^\s*\[([a-z]+)\]\s*/i.exec(text);
  if (!m) return { emotion: 'neutral', rest: text.trim() };
  const tag = m[1].toLowerCase();
  const emotion = (EMOTIONS as readonly string[]).includes(tag) ? (tag as Emotion) : 'neutral';
  return { emotion, rest: text.slice(m[0].length).trim() };
}
