export type VadEvent = 'silence' | 'speech' | 'end' | 'too-short';

export interface VadOptions {
  rmsThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  frameMs: number;
}

export class EnergyVad {
  speechMs = 0;
  private silenceMsSinceSpeech = 0;
  private inSpeech = false;

  constructor(private readonly opts: VadOptions) {}

  reset(): void {
    this.speechMs = 0;
    this.silenceMsSinceSpeech = 0;
    this.inSpeech = false;
  }

  push(frameRms: number): VadEvent {
    const { frameMs } = this.opts;
    if (frameRms >= this.opts.rmsThreshold) {
      if (!this.inSpeech) this.speechMs = 0; // start of a new utterance
      this.inSpeech = true;
      this.speechMs += frameMs;
      this.silenceMsSinceSpeech = 0;
      return 'speech';
    }
    if (!this.inSpeech) return 'silence';
    this.silenceMsSinceSpeech += frameMs;
    if (this.silenceMsSinceSpeech < this.opts.silenceMs) return 'silence';
    const result: VadEvent = this.speechMs >= this.opts.minSpeechMs ? 'end' : 'too-short';
    // Keep speechMs so callers can read the finished utterance's length.
    this.inSpeech = false;
    this.silenceMsSinceSpeech = 0;
    return result;
  }
}
