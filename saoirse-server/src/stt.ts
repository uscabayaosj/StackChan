import type { Config } from './config.js';

export async function transcribe(
  cfg: Config['elevenlabs'],
  pcm16k: Buffer,
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const form = new FormData();
  form.set('model_id', cfg.sttModel);
  form.set('file_format', 'pcm_s16le_16');
  form.set('tag_audio_events', 'false');
  form.set('file', new Blob([new Uint8Array(pcm16k)], { type: 'application/octet-stream' }), 'audio.pcm');
  const res = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey },
    body: form,
    signal: opts?.signal,
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}
