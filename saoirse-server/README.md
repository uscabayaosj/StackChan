# saoirse-server

The AI server behind the Saoirse StackChan. It speaks the xiaozhi v1 WebSocket protocol to the robot and answers as Saoirse: ElevenLabs Scribe for speech-to-text, an OpenAI-compatible LLM (OpenRouter → `openai/gpt-oss-20b` on Groq by default), ElevenLabs Flash v2.5 for the voice, streamed back as 60 ms Opus frames. Design: `docs/superpowers/specs/2026-10-27-saoirse-design.md`.

## Endpoints

- `POST /api/ota` — the robot's boot check. Returns the WebSocket URL, the device token, server time and the robot's own firmware version (so no upgrade is offered).
- `WS /api/ws` — one conversation session per connection. Requires `Authorization: Bearer <SAOIRSE_DEVICE_TOKEN>`.

## Run locally

```bash
cp .env.example .env.local   # fill in LLM_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, SAOIRSE_DEVICE_TOKEN
npm install
npm run dev                  # http://0.0.0.0:8765 — OTA at /api/ota, WS at /api/ws
```

Point the robot at `http://<this-mac-ip>:8765/api/ota` (firmware `CONFIG_OTA_URL`) to test on the LAN.

## Test

```bash
npm test             # unit + protocol tests (no keys needed)
npm run typecheck
npm run fake-robot -- --wav test/fixtures/question.wav --token "$SAOIRSE_DEVICE_TOKEN" [--url wss://…/api/ws] [--out reply.wav]
```

The fake robot plays a 16 kHz mono WAV through the whole pipeline like the real device and writes the spoken reply to a WAV. Make a fixture with `say -o q.aiff "what time is it" && afconvert -f WAVE -d LEI16@16000 -c 1 q.aiff test/fixtures/question.wav`.

## Deploy (Vercel)

```bash
vercel link --yes --project saoirse-server
vercel env add <NAME> production      # one per variable in .env.example (never commit keys)
vercel deploy --prod --yes
```

Then set `PUBLIC_WS_URL=wss://<your-host>/api/ws` and redeploy. `vercel.json` disables framework detection (so `api/` builds as functions), serves no static files, bundles the `opusscript` WASM into the WebSocket function, and sets `maxDuration` 300 s (Hobby's cap; sessions close themselves after 60 s of silence).

## Configuration notes

- `OPUS_CODEC`: `wasm` (default) or `native`. The native `@discordjs/opus` crashed the process on quiet audio on macOS arm64, so WASM is the default everywhere.
- `LLM_REASONING_EFFORT` (default `low`) and `LLM_MAX_TOKENS` (default 400): `gpt-oss-20b` is a reasoning model; without these it spends its whole budget thinking and says nothing. Set effort to `none` for non-OpenRouter backends.
- `LLM_FALLBACK_*`: a second OpenAI-compatible model used only when the primary fails before producing any text.
- VAD: `VAD_RMS_THRESHOLD` (0.025), `VAD_SILENCE_MS` (800), `VAD_MIN_SPEECH_MS` (300).
