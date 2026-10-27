# Saoirse: a custom StackChan (face, persona, voice, LLM)

Date: 2026-10-27. Status: approved design, pre-implementation.

## 1. Goal

Turn the stock M5Stack StackChan into **Saoirse**: the owner's Birman cat as a kawaii vector face on the robot's screen, a deadpan hyper-perceptive persona, an ElevenLabs voice, and the fastest cheap LLM reachable with the owner's existing API keys. Everything else the robot does today (M5Stack account, app binding, app store, dances, video relay, "Hi Stack Chan" wake word) keeps working unchanged.

## 2. Non-goals

- A "Saoirse" wake word. There is no self-serve way to train an ESP WakeNet model; Espressif sells it as a service. The stock `wn9_histackchan_tts3` model stays. (Decided with the owner.)
- Changes to the Flutter app or to M5Stack's Go server.
- Robot-control tools for the LLM (servos, LEDs) in this round. The protocol hook exists (`mcp` messages) and can be added later.

## 3. How the stock robot works (facts the design rests on)

- Firmware is ESP-IDF 5.5.4 on the CoreS3 (ESP32-S3), with **xiaozhi-esp32 v2.2.4** vendored and patched as the AI agent (`firmware/repos.json`, `firmware/patches/xiaozhi-esp32.patch`).
- The robot talks to two services over Wi-Fi:
  1. `CONFIG_STACKCHAN_SERVER_URL` (M5Stack's Go server): account, binding, app store, dances, app WebSocket relay. **Unchanged.**
  2. `CONFIG_OTA_URL` (default `https://api.tenclass.net/xiaozhi/ota/`): the xiaozhi OTA check. Its JSON reply carries the WebSocket URL and token the robot then uses for every conversation. **This is the only endpoint we redirect.**
- The conversation channel is the xiaozhi WebSocket protocol v1 (`docs/websocket.md` in xiaozhi-esp32 v2.2.4): JSON control frames plus binary Opus audio, 16 kHz mono, 60 ms frames.
- The robot opens the channel on wake word and keeps it until the server closes it or the conversation idles. Vercel closes any WebSocket at the function's max duration (300 s on Hobby), so the server must end idle sessions well before that.
- The face is an LVGL "skin": `firmware/main/stackchan/avatar/skins/default/` (eyes, mouth, speech bubble) created with `std::make_unique<DefaultAvatar>()` at six sites (`hal/board/stackchan_display.cc`, `apps/app_avatar`, `app_dance`, `app_espnow_ctrl`, `app_ezdata`, `app_setup/workers/connectivity.cpp`). Emotions arrive from the server as `llm` messages and are mapped in `StackChanAvatarDisplay::SetEmotion` to `Emotion::{Neutral,Happy,Angry,Sad,Doubt,Sleepy}`. Blink, breath, idle motion, head-pet, speaking (mouth toggles every ~180 ms with a random opening) are "modifiers" that drive `Feature::setWeight/setPosition/setRotation` on the eyes and mouth; a skin only has to implement those.
- Static images ship in the firmware's asset bundle (`firmware/main/assets/assets_bin/`, loaded with `assets::get_image("name")`); PNG is supported (`CONFIG_LV_USE_LODEPNG=y`).

## 4. Architecture

```
"Hi Stack Chan" ──► StackChan (CoreS3)
                      │  boot: POST CONFIG_OTA_URL ──► saoirse-server /api/ota  (Vercel)
                      │        ◄── { websocket: { url, token }, server_time }
                      │
                      │  conversation: wss://…/api/ws  (xiaozhi v1, Opus 16 kHz)
                      ▼
               saoirse-server (TypeScript, Vercel Functions, Fluid compute)
                      ├── STT: ElevenLabs Scribe v2
                      ├── LLM: OpenAI-compatible (default OpenRouter → openai/gpt-oss-20b on Groq)
                      └── TTS: ElevenLabs eleven_flash_v2_5 → PCM 16 kHz → Opus 60 ms frames
```

M5Stack's cloud is still used for everything the phone app does. Only conversation audio goes to saoirse-server.

## 5. Firmware: the Saoirse face

### 5.1 Look

The approved drawing is `docs/superpowers/specs/assets/saoirse-face.svg` (320×240, traced from the owner's photo `IMG_6975`). Palette: wall `#EFE6DA`, fur `#F6EEE2`, seal mask `#A89A8E`/`#8E7D72` at 45 % over fur, forehead stripe `#5A4B44` at 80 %, ears `#4A3C36` with `#E9D9CB` tufts, eye rim `#3A302C`, iris `#A9CCE6`, pupil `#1B1716`, nose patch `#1C1614`, ginger smudge `#D8A05C`, blush `#F2B3C0`, collar `#F2A7BF`, bell `#E8CFE3`, caption bubble `#3A302C` with `#F8F0E3` text.

### 5.2 Split between image and objects

- **Base image** (`saoirse_base.png`, 320×240, in `assets_bin`): everything static in the SVG: wall, body fluff, ears, head, mask shading, stripe, cheek fluff, blush, whiskers, nose patch, smudge, nose, collar, bell. The eye sockets are painted in the local mask colour (`#B3A396`) with **no eyes and no mouth**; those are objects.
- **Eyes** (`SaoirseEyes : Feature`, one per side): rim circle r31, iris r28, inner shade r22, pupil r13, glints r8 at (−9,−10) and r4 at (+8,+7), centred at (104,142) and (186,142). `setPosition` moves iris+pupil+glints within the rim by up to ±6 px (gaze). `setWeight` drives a **lid**: a `#B3A396` container above the eye that slides down (weight 100 = open, 0 = closed), same mechanism as `DefaultEyes`. `setRotation` tilts the lid for emotions. `setEmotion` applies, per emotion: Neutral (lid up, 0°), Happy (lid fully down + a dark "content" arc, left/right mirrored), Angry (lid 55 % down, ±18° inward tilt), Sad (lid 55 % down, ±18° outward tilt), Doubt (right lid 50 % down only), Sleepy (lid fully down + a shallow closed-eye arc). Ignores emotion while `getIgnoreEmotion()` (blink modifier contract).
- **Mouth** (`SaoirseMouth : Feature`): weight < 30 shows the **side pout** (small PNG from the SVG, right of centre); weight ≥ 30 shows an opening: a dark `#3A302C` rounded container sized 20×16 … 30×24 by weight, with a pink `#FF8FA3` tongue container inside at the larger sizes. Angry/Sad override the pout with a flat/frown line; Happy with a wide smile wedge. The speaking modifier already toggles weight; nothing else changes.
- **Speech bubble**: reuse `DefaultSpeechBubble` with primary `#3A302C`, secondary `#F8F0E3`.
- **Decorators**: the existing heart/shy/sweat/dizzy/angry decorators keep working (positions tuned to the new eye centres). Sad adds the sweat decorator as a tear; Doubt adds a "?" label top-right; Sleepy keeps the stock "Zzz…" caption.

### 5.3 Integration

- `firmware/main/stackchan/avatar/skins/saoirse/{saoirse.h, saoirse.cpp, eyes.cpp, mouth.cpp}`.
- `firmware/main/stackchan/avatar/skins/skin_factory.h`: `std::unique_ptr<Avatar> createAvatar()` returning `SaoirseAvatar` when `CONFIG_STACKCHAN_SKIN_SAOIRSE=y` (Kconfig, default y) else `DefaultAvatar`. The six call sites use the factory.
- `firmware/tools/saoirse/render_face.py`: renders `saoirse_base.png` and `saoirse_pout.png` from the SVG (removing the eye and mouth groups), so the face stays editable as SVG.
- `StackChanAvatarDisplay::SetEmotion` is unchanged; its emotion strings (`neutral, happy, laughing, angry, sad, crying, sleepy, doubtful`) are what the server sends.

### 5.4 Preview before flashing

Best effort: port the desktop UI simulator from the Hermes-StackChan fork (`firmware/tools/ui_sim`, LVGL on macOS, reuses the real skin, blink and breath modifiers) so the face is checked on the Mac, including blink, talking and all six emotions, before the first flash.

## 6. Firmware: endpoint change

- `firmware/sdkconfig.defaults`: `CONFIG_OTA_URL="https://<vercel-deployment>/api/ota"` (filled in after the first deploy). Nothing else changes; `CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3=y` stays.
- The robot also accepts the URL at runtime from NVS (`wifi` namespace, key `ota_url`); the build-time default is enough here.

## 7. saoirse-server (TypeScript on Vercel)

### 7.1 Layout

```
saoirse-server/
  api/ota.ts        POST: xiaozhi OTA check → websocket url + token + server_time
  api/ws.ts         WebSocket: xiaozhi v1 session (exports a node http server, `ws` library)
  src/session.ts    per-connection state machine
  src/vad.ts        energy VAD over decoded PCM
  src/stt.ts        ElevenLabs Scribe v2
  src/llm.ts        OpenAI-compatible streaming + sentence splitter + emotion tag
  src/tts.ts        ElevenLabs stream → PCM16k → Opus frames
  src/opus.ts       @discordjs/opus (native) with opusscript (WASM) fallback
  src/persona.ts    system prompt
  src/config.ts     env parsing
  scripts/dev.ts    local server (same handlers) on :8765
  scripts/fake-robot.ts  streams a WAV as a xiaozhi device, prints transcript/reply, saves reply audio
  test/             unit tests (vitest)
  vercel.json       Node 22, maxDuration 300
```

### 7.2 OTA endpoint

Request: POST with headers `Device-Id`, `Client-Id`, `User-Agent`, body = device JSON (ignored except for logging). Response:

```json
{ "websocket": { "url": "wss://<host>/api/ws", "token": "<SAOIRSE_DEVICE_TOKEN>", "version": 1 },
  "server_time": { "timestamp": <ms>, "timezone_offset": <minutes> },
  "firmware": { "version": "<current>", "url": "" } }
```

No `activation` object (the StackChan patch treats `activation.code` as "bind in the app"; omitting it means "activated"). `firmware.version` echoes the device's own version so no upgrade is offered.

### 7.3 WebSocket session

- Verify `Authorization: Bearer <token>` equals `SAOIRSE_DEVICE_TOKEN` (when set); `Protocol-Version: 1`.
- On device `hello`: reply `{"type":"hello","transport":"websocket","session_id":<uuid>,"audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}`.
- `listen` `start`/`detect`: begin capturing binary frames (decode to PCM for VAD; keep the Opus packets). `listen` `stop`: process immediately. Otherwise process when the energy VAD sees ≥ 800 ms of silence after speech (ticker 100 ms, RMS threshold ~0.025, pre-roll 300 ms). Discard captures with no speech or < 300 ms of speech.
- `abort`: stop any TTS in flight, flush, go back to listening.
- Processing: STT → send `stt` text → LLM stream → per sentence: `tts sentence_start` then Opus frames paced at 60 ms (allowed to run up to ~3 s ahead; the firmware buffers 80 packets) → `tts stop` after the last frame has had time to play. `tts start` is sent once at the first sentence. Emotion: the LLM reply must start with one tag from `[neutral] [happy] [angry] [sad] [doubtful] [sleepy]`; it is stripped and sent as `{"type":"llm","emotion":"…","text":""}` before the first sentence. Missing tag → `neutral`.
- Echo guard: ignore device audio for 1.5 s after `tts stop`.
- Idle: no speech for 60 s → close the socket (the robot returns to idle; next wake word reconnects). Hard stop at 280 s regardless.
- Context: last 10 exchanges per device MAC, in memory (Fluid instances can be reused; losing it on a cold start is acceptable).

### 7.4 Models and keys (env vars)

| Var | Default |
|---|---|
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_API_KEY` | (OpenRouter key) |
| `LLM_MODEL` | `openai/gpt-oss-20b` with `provider: {order: ["groq"], allow_fallbacks: true}` |
| `LLM_FALLBACK_BASE_URL/KEY/MODEL` | DeepSeek `deepseek-flash` |
| `ELEVENLABS_API_KEY` | (key) |
| `ELEVENLABS_VOICE_ID` | chosen from the account's library at setup |
| `ELEVENLABS_TTS_MODEL` | `eleven_flash_v2_5` |
| `ELEVENLABS_STT_MODEL` | `scribe_v2` |
| `SAOIRSE_DEVICE_TOKEN` | random; also returned by `/api/ota` |
| `PUBLIC_WS_URL` | `wss://<host>/api/ws` |

Verified prices (2026-10-27): gpt-oss-20b on Groq $0.075 / $0.30 per 1M tokens, ~1,000 tok/s; DeepSeek Flash $0.15–0.30 / $0.60–1.20; Claude Haiku 5.5 $0.10 / $0.50 (one-line swap if quality is wanted). ElevenLabs Flash $0.04 per 1K characters, Scribe v2 $0.22 per hour.

### 7.5 Persona (system prompt, abridged; full text in `src/persona.ts`)

Saoirse: a hyper-perceptive, deadpan cat-shaped desk companion. Sherlock-grade observation, Daria/Wednesday delivery, Veronica Mars curiosity, Lisa Simpson's moral compass underneath. Reads hesitation and euphemism and names it flatly; prefers one precise question to an argument; bored by small talk; secretly values honesty and the owner. Spoken style: one to three short sentences, no lists, no emoji, no stage directions, never cruel, answers the real question. First token of every reply is the emotion tag.

### 7.6 Vercel deployment

Project `saoirse-server` on the owner's account, Node 22, Fluid compute on, `maxDuration: 300`, env vars set as Production secrets, one URL used in `CONFIG_OTA_URL`. Deployed with the Vercel CLI from the repo subfolder. Local development: `npm run dev` serves both routes on `http://<mac-ip>:8765` for LAN testing with `CONFIG_OTA_URL` pointed there.

## 8. Testing

- Unit (vitest): hello/listen/abort parsing, sentence splitter (abbreviations, quotes, numbers), emotion-tag extraction, Opus framing (960 samples per frame, zero-padded tail), VAD onset/offset on synthetic audio.
- `scripts/fake-robot.ts`: speaks the full protocol against local or deployed server using a WAV file; asserts `stt`, `llm` emotion, `tts start/stop`, and writes the reply audio to a WAV for listening.
- Firmware: face in the UI simulator (blink, talk, six emotions, bubble); then flash and check: boot reaches the Vercel OTA, "Hi Stack Chan" opens a session, a question gets a spoken reply with the matching face, the app still binds and plays dances.

## 9. Rollout

1. Server built and unit-tested; deployed to Vercel; fake-robot passes against the deployment.
2. Face built; simulator check; firmware built with the new OTA URL; flashed over USB-C (M5Burner can restore the factory image if needed).
3. First live conversation; tune VAD silence, voice choice and persona wording from real use.

## 10. Risks and mitigations

- Vercel cold start adds ~0.5–1 s before the first "listening" after a quiet spell. Acceptable; a cloud VPS is the escape hatch (same code, plain `node`).
- Native Opus module on Vercel: `@discordjs/opus` ships Linux x64 prebuilds; `opusscript` WASM fallback if loading fails.
- Energy VAD vs. noisy rooms: thresholds in env; `listen stop` from the device still works if a future firmware sends it.
- LLM ignores the emotion tag: default to neutral; the face still works.
- Flash recovery: the bootloader is untouched; M5Burner restores stock firmware.
