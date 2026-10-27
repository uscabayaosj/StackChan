# Saoirse camera and robot tools: design

Date: 2026-10-27. Extends `2026-10-27-saoirse-design.md`. Approved scope (user): camera, head angles, light colour.

## Goal

Saoirse can look ("what do you see?", "what am I holding?"), turn her head on request ("look 30 degrees to your left", "look up"), and change her light bars on request ("make your lights red"), all in her own voice. No new firmware feature is needed for the camera or head: the robot already exposes `self.camera.take_photo`, `self.robot.set_head_angles`, `self.robot.get_head_angles` and `self.robot.set_led_color` as MCP tools over the conversation WebSocket. What is missing is the server side that M5Stack's cloud normally provides.

## How the robot's tools work (xiaozhi-esp32 v2.2.4, vendored)

- MCP messages travel inside the xiaozhi WebSocket as `{"type":"mcp","session_id":…,"payload":<JSON-RPC 2.0>}` in both directions.
- The server is the MCP *client*. It sends `initialize` (whose `params.capabilities.vision = {url, token}` tells the robot where to upload photos), `tools/list`, and `tools/call` with `{name, arguments}`. The robot replies `{"jsonrpc":"2.0","id":N,"result":…}` or `{"jsonrpc":"2.0","id":N,"error":{"message":…}}`.
- `tools/list` returns `{"tools":[{"name","description","inputSchema"}],"nextCursor":""}`; `inputSchema` is JSON Schema (`type: object`, `properties`, `required`) and is passed to the LLM as the function parameters unchanged.
- `tools/call` result is `{"content":[{"type":"text","text":<string>}],"isError":false}`. For `take_photo` the text is the HTTP response body of the vision upload verbatim.
- `take_photo(question)` captures a 320×240 JPEG (~25 KB) and POSTs it to the vision URL as `multipart/form-data` (fields `question` and `file`, filename `camera.jpg`), `Transfer-Encoding: chunked`, headers `Authorization: Bearer <token>`, `Device-Id`, `Client-Id`. Any non-200 status is an error on the robot.
- `set_head_angles(yaw -128..128, pitch 0..90, speed 100..1000)` in degrees, `-9999` leaves an axis alone; `get_head_angles()` returns `{"yaw","pitch"}`. `set_led_color(red, green, blue 0..168)` sets both light bars.

The robot has ~25 KB of internal RAM free during a session (minimum seen 11 KB). Tool traffic is a few hundred bytes of JSON and is fine; on-device face detection is **not** in scope (see Out of scope).

## Server design

### MCP client (`src/mcp.ts`)

`class DeviceMcp` owned by a `Session`:

- `start()` after the robot's `hello`: sends `initialize` with `capabilities.vision = {url: cfg.publicVisionUrl, token: cfg.deviceToken}` and then `tools/list`. Replies are matched by JSON-RPC id. The tool list is stored as `DeviceTool[] = {name, description, inputSchema}` filtered by `cfg.deviceTools` (default `self.camera.take_photo, self.robot.set_head_angles, self.robot.get_head_angles, self.robot.set_led_color`).
- `callTool(name, args, {timeoutMs, signal}) → Promise<string>`: sends `tools/call`, resolves with the `content[0].text` of the result, rejects on `error`, on `isError`, on timeout (camera 25 s, others 8 s) or when the signal aborts. A rejected call becomes a tool result string `Error: …` for the LLM, never a thrown turn error.
- `handle(payload)` is called by the session for every incoming `mcp` message; unknown ids are logged and ignored.
- Device requests (the robot never sends any today) are ignored.

### LLM tool calling (`src/llm.ts`)

`streamChat` gains an optional `tools` argument (OpenAI function tools built from the device tools) and yields `ChatEvent`:

- `{type:'text', text}` for `delta.content` (as today);
- `{type:'tool_calls', calls:[{id, name, arguments}]}` once, when the stream finishes with tool calls (`delta.tool_calls` fragments are accumulated by `index`; `arguments` is the concatenated JSON string).

A stream that produced neither text nor tool calls is still the 502 `NO_CONTENT` error. `ChatMessage` gains the assistant-with-`tool_calls` and `role:'tool'` (`tool_call_id`, `content`) shapes. `streamChatWithFallback` is unchanged in behaviour (a yielded event disables the fallback).

### Session tool loop (`src/session.ts`)

Inside `process()`, replacing the single LLM pass:

1. `messages = [system, …history]`. Loop up to `MAX_TOOL_ROUNDS = 3`:
2. Stream the LLM. Text is spoken sentence by sentence exactly as today (emotion tag handling unchanged; the tag is only expected on the first round's text).
3. On `tool_calls`: if a call is `self.camera.take_photo` and nothing has been spoken yet this turn, speak the fixed filler `Let me look.` so the robot is not silent for the capture. Execute the calls in order through `DeviceMcp.callTool`. For `take_photo`, if the result text parses as JSON with `success:false`, the tool result is `Error: <message>`; if it has `text`, that text is the result. Append `{role:'assistant', content: textSoFar || null, tool_calls}` and one `{role:'tool'}` message per call, then go to 2. The turn's abort signal cancels waiting calls (barge-in).
4. If the loop ends with tool calls still pending after round 3, speak `I'm going in circles. Ask again.`

History keeps only the user text and the final spoken assistant text (tool messages are not persisted). Emotion: a happy reply after a photo flashes the lights as usual.

### Vision endpoint (`src/vision.ts`, `api/vision.ts`, route in `server.ts`)

`POST /api/vision`:

- Requires `Authorization: Bearer <cfg.deviceToken>` when a token is configured (same rule as `/api/ws`). Otherwise 401 `{"success":false,"message":"unauthorized"}`.
- Reads the body up to `VISION_MAX_BYTES` (default 3 MiB; 413 beyond), parses `multipart/form-data` from the `boundary` in `Content-Type` (own parser: split on `--boundary`, read `Content-Disposition` names `question` and `file`; the file part's bytes are the JPEG). Missing file → 400.
- Calls the vision model (OpenAI-compatible chat completions, non-streaming) with a system prompt (*"You are the eyes of a small desk robot. Describe what the photo shows in two or three concrete sentences (people, animals, objects, text, expressions, setting), then answer the question in one sentence. No preamble."*), the question, and the image as a `data:image/jpeg;base64,…` `image_url` part. `max_tokens` 200, timeout `VISION_TIMEOUT_MS` (15 s).
- Responds 200 `{"success":true,"text":<description>}`; on model failure 502 `{"success":false,"message":…}`.
- Config: `VISION_MODEL` (default `google/gemini-3.5-flash-lite`: 1.4 s and accurate in the probe, ~$0.0005 per photo), `VISION_BASE_URL` / `VISION_API_KEY` (default the LLM's), `PUBLIC_VISION_URL` (default derived from `PUBLIC_WS_URL`: `wss://host/api/ws` → `https://host/api/vision`).
- `vercel.json`: `api/vision.ts` with `maxDuration` 30.

### Persona (`src/persona.ts`)

Added to the system prompt: you have a camera (use `take_photo` with a precise question whenever asked what you see, what something is, how someone looks; answer from the description as if you looked yourself; never say you cannot see); you can turn your head (`set_head_angles`, yaw negative is your left, pitch up to 90 is up; "look left" ≈ −35, "a little" ≈ 15, exact degrees when given; speed 150 unless asked to be quick); you can colour your light bars (`set_led_color`, 0–168 per channel; 0,0,0 returns them to normal). Do these when asked, without narrating the tool; one dry line afterwards is fine.

## Firmware change (one): light colour persists

Today the state indicator (listening green, speaking blue) would overwrite a requested colour within a second. `set_led_color` now records a *user light* in the HAL; `StackChanAvatarDisplay::ApplyStateLight` shows the user light instead of the state colour while it is set; `set_led_color(0,0,0)` clears it and the bars return to the state colours. The happy flash still runs and restores to whichever applies. The tool description says so. Firmware then rebuilt, patch unchanged (the change is in StackChan code, not xiaozhi).

## Testing

- `test/mcp.test.ts`: framing of initialize/tools/list/tools/call; reply matching; error and `isError`; timeout; abort; tool filtering.
- `test/llm.test.ts`: SSE with `tool_calls` deltas split across chunks → one `tool_calls` event with concatenated arguments; text + tool calls in one stream; no-content still 502.
- `test/session.test.ts`: a turn whose first LLM round returns a `take_photo` call speaks `Let me look.`, sends `tools/call`, feeds the robot's reply back, speaks the second round; head/LED calls run without filler; tool error becomes an `Error:` tool message; abort during a pending call sends `tts stop`; round cap.
- `test/vision.test.ts`: multipart parsing (fields in either order, CRLF, binary), auth, size cap, model request shape (data URL), response shape, model failure.
- `test/config.test.ts`: new defaults and the derived vision URL.
- Live: fake robot unchanged (no tools); on the robot: "what do you see", "look left", "make your lights red", "lights back to normal".

## Out of scope (next)

- **Face tracking.** On-device detection (Espressif esp-dl `human_face_detect`, supported on ESP32-S3) is the right architecture but the robot has ~25 KB of internal RAM free mid-conversation; it needs its own investigation (memory budget, camera frame sharing with `take_photo`, servo control loop). A cheaper interim is a *glance*: one photo at the start of a turn, the vision model returns where the face is, one head move. Separate spec.
- Reminders and the other device tools (screen, volume, reboot) stay unexposed.
