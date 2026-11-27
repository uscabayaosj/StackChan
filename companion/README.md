# Saoirse for iPhone

The iOS app manages one Saoirse robot. Wi-Fi setup uses the existing nearby Bluetooth setup mode. AI profiles, history, head movement, speaker volume, screen brightness, photos and live camera viewing use a private HTTPS relay that both the iPhone and robot can reach, including over cellular.

## Build the iPhone app

Open [Saoirse.xcodeproj](ios/Saoirse.xcodeproj) in Xcode. Select the Saoirse scheme and an iOS 17 or newer simulator or device. For an iPhone, select your Apple development team in Signing & Capabilities. The checked-in project is generated from [project.yml](ios/project.yml) with `xcodegen generate`.

## Vercel and Neon deployment

The Vercel functions preserve Saoirse's OTA, vision and voice routes and add the companion endpoints. Apply [companion-schema.sql](saoirse-server/companion-schema.sql) to a dedicated Neon database. Set `COMPANION_DATABASE_URL`, `COMPANION_DEVICE_ID` and `COMPANION_TOKEN` on the Vercel project. Use a separate database role with access to the companion tables and the transcript ID sequence. Keep the existing provider and OTA credentials in the Vercel secret store.

Keep the companion functions in one Vercel region near the database. Runtime Cache records recent robot presence and tells the polling firmware when there is work. Neon stores configuration versions, opt-in transcripts and in-flight command state. Camera results are encrypted for the requesting invocation before entering the relay's command table, then removed when delivered. During idle check-ins the relay normally avoids waking Neon.

## Standalone Node relay

The relay is the Saoirse AI server from StackChan revision `88f806ee` with the companion API added. It still serves Saoirse’s existing OTA configuration, voice WebSocket and vision requests. Keep the same AI provider, device time zone and optional integrations by carrying their existing settings over to the relay privately.

1. On a machine with Node 22.13 or newer in the Node 22 series, run `npm ci --omit=optional` and `npm run build` in [saoirse-server](saoirse-server). The running service uses compiled JavaScript. After building, `npm prune --omit=dev --omit=optional` leaves only the packages needed by the default WASM codec and relay.
2. Copy [companion.env.example](saoirse-server/companion.env.example) to `saoirse-server/.env.local`. Supply the current AI keys and model settings. Generate a separate random token for each missing companion, OTA or device secret using `openssl rand -hex 32`. Use the robot’s Wi-Fi MAC address for `COMPANION_DEVICE_ID`; it is the ID sent in its OTA and voice requests.
3. Create the parent directory for `COMPANION_DB` on persistent private storage writable by the service account. Restrict access to the directory and its backups. Run one instance of `npm start` under your service manager. The command relay and active robot poll live in that process. SQLite stores profile versions and optional transcripts on disk.
4. Put the server behind a trusted HTTPS reverse proxy which forwards HTTP and WebSocket traffic to port 8765. For example, point your domain at the host and use a [Caddy HTTPS reverse proxy](https://caddyserver.com/docs/quick-starts/https).

   ```caddyfile
   saoirse.example.com {
       reverse_proxy 127.0.0.1:8765
   }
   ```

   Set `PUBLIC_WS_URL=wss://saoirse.example.com/api/ws` on the relay. Keep access logs from recording the query string of `/api/ota`, which contains the OTA secret. The app uses `https://saoirse.example.com` and the **companion token**.

## Prepare Saoirse

Build the [firmware patch](firmware/saoirse-companion.patch) against the StackChan `saoirse` branch at revision `88f806ee` with ESP-IDF 5.5.4. Use a clean copy. The firmware dependency setup applies the baseline Xiaozhi patch first.

```sh
cd /path/to/StackChan/firmware
python3 ./fetch_repos.py
patch --dry-run -p1 < /path/to/saoirse-companion.patch
patch -p1 < /path/to/saoirse-companion.patch
patch --dry-run -p1 < /path/to/saoirse-speaker-follow.patch
patch -p1 < /path/to/saoirse-speaker-follow.patch
patch --dry-run -p1 < /path/to/saoirse-plush-face.patch
patch -p1 < /path/to/saoirse-plush-face.patch
cp /path/to/plush-face/saoirse_plush.bin main/assets/
cp /path/to/plush-face/saoirse_giggle.ogg main/assets/sfx/
idf.py reconfigure build
```

The second [firmware patch](firmware/saoirse-speaker-follow.patch) adds speaker following and the current audio, Wi-Fi and settings readback updates. Start with a clean build directory so ESP-IDF uses the patched memory defaults. The dependency lock pins Espressif’s two-stage MSR/MNP human face detector for the ESP32-S3.

The [plush face patch](firmware/saoirse-plush-face.patch) brings the 3D-rendered avatar to the CoreS3 in firmware 1.6.25. Its earcups light up in Listening. In Speaking, the mouth and mic glow follow the speaker’s playback level. The head tilts between poses while the shoulders stay level. The sprite pack expands once into PSRAM when the avatar opens. During speech, the display redraws small face and headset regions as their appearance changes. The previous Phosphor face is the fallback if the pack fails to load.

Firmware 1.6.26 adds a reaction to a stroke or a hand resting on the head. In AI Agent standby, her cheeks flush while she giggles and a glossy heart floats up and fades. Rapid repeat strokes share a short cooldown. During a conversation the cheeks and heart give quiet feedback. A new voice connection clears the idle giggle before it starts listening.

Firmware 1.6.27 uses the standby gaze animation to look left, right and up. In Listening, the eyes open wider and hold a forward gaze as speaker tracking aims the head. In Speaking, a smile in the eyes follows the playback emphasis. Blinks are shorter and less frequent. The sleepy expression keeps the eyes partly open, and the giggle uses one brief eye squeeze.

To regenerate the sprites from the approved [source poses](firmware/plush-face/source.png), run `python3 companion/firmware/plush-face/render.py /path/to/output` with Pillow installed. Copy `saoirse_plush.bin` to `firmware/main/assets/` and `plush_frames.h` to `firmware/main/stackchan/avatar/skins/saoirse/`. To regenerate the embedded giggle, run `python3 companion/firmware/plush-face/render_giggle.py /path/to/saoirse_giggle.ogg` with FFmpeg and libopus installed.

On boot and reconnect, Saoirse ranks compatible saved Wi-Fi networks and mesh access points by their measured signal. An exact tie can retain the saved preference. While idle, Saoirse checks every 45 seconds. If another saved access point is stronger, she checks again after five seconds before switching. Voice sessions and camera streams defer these background checks to preserve playback.

Firmware 1.6.24 gives voice playback priority over the display and face tracking. The voice connection feeds the speaker decoder ahead of display work. Saoirse’s production relay uses 900 ms of quiet to mark the end of an utterance. Individual installations can set this with `VAD_SILENCE_MS`. The robot records when the first audio frame reaches the output task and how many gaps occur during a reply. These diagnostics contain timing and frame counts.

When Saoirse hears her wake phrase or a fresh speech turn, she checks a 160 × 120 view. A reliable microphone direction helps her decide where to look first and distinguish between visible faces. An automatic search can check both sides. When a view is dark or strongly backlit, the tracker can lift the shadows before checking for a face. The “face me” command gives her time to examine the full 320 × 240 frame and more viewpoints. The detector proposes faces at a score of 0.25 and verifies them at 0.50. Two consistent sightings from a settled head position guide each correction. If she finds no face, she returns to the pose where the search began.

Camera work yields when a reply starts. After the reply, a new speech turn can start a search immediately if she recently saw a face. If the first camera check in a follow-up finds no face, sustained speech can extend the check to a side search even after a previous miss. After 1.5 seconds of measured quiet, sustained speech can trigger one more look during the same listening turn. A manual head command clears the last sighting and pauses ordinary follow-up tracking for 5.5 seconds. A new wake phrase or an explicit “face me” command can request a check during that pause.

While **AI Agent** is on standby, Saoirse holds her head position until a manual command or another search moves it. The detector runs on the robot. Camera frames for centering stay in temporary memory and are cleared after each check. For conversation audio, the firmware aligns and combines the two microphones when it has a reliable delay estimate and runs WebRTC noise suppression. The wake detector keeps its existing microphone and echo reference. Say “face me” for a local speaker check or “face 20 degrees to your right” for a manual turn. The relay confirms an explicit turn only after the robot acknowledges it.

Configure the new robot OTA URL as `https://saoirse.example.com/api/ota?k=YOUR_OTA_SECRET` using the existing Saoirse firmware configuration. If `ota_url` is already set in the robot’s saved settings, change that override as well. Make a backup and use your existing Saoirse app-partition update procedure to install the firmware. The robot learns the relay address on its next successful OTA check. Keep it powered and connected to Wi-Fi for away-from-home access. Open **AI Agent** on the robot to start the relay. Enable **Start AI Agent on boot** in the robot’s AI Agent settings to start it automatically after a restart.

## Use the companion

- **Saoirse** shows the connection state and gives you head, speaker volume and display brightness controls. Firmware 1.6.24 reports its current volume and applied brightness. The app shows new values when the robot reports them and updates after changes on the robot itself.
- **Camera** takes a JPEG and opens the iOS share sheet to save or share it. Live view streams successive JPEGs without audio while the camera screen is active. Turn on **Camera steering** for eight-direction aiming and a center button. Each tap moves by up to 10 degrees within the head’s travel. The robot displays a remote-camera indicator. Its camera is available while Saoirse is idle. Actual frame rate depends on the device and both network links.
- **Latest directions** appears on the Saoirse tab for up to 15 minutes after a successful spoken route request. It shows the route preview, steps, distance when available, and an **Open in Maps** button for guidance. Saoirse shows the route time and first steps on her own screen. Say “Walking directions from Trafalgar Square to Covent Garden, London.” If you give only the destination, name the starting point when she asks. Walking, cycling, and driving use OpenStreetMap data. London public transport uses the TfL Journey Planner.
- **History** archives new voice transcripts when you enable it. Entries are grouped by conversation. Search covers loaded conversations, and older entries load on demand. Calendar exchanges are omitted. The relay has no way to backfill conversations held before archiving was enabled.
- **Settings → AI profiles** saves named, reusable versions of the model, backend selection, ElevenLabs voice and speech model, gain, and persona instructions. Use the existing primary or configured fallback connection. Provider URLs and keys are set on the relay. An activated profile applies at the next voice connection.
- **Settings → Wi-Fi networks** adds arbitrary 2.4 GHz network profiles and reuses the existing UCL eduroam preset. The iPhone stores saved credentials in its Keychain and sends them directly by Bluetooth when the robot is in Change Wi-Fi setup mode.

## Verify on hardware

Pair using the relay’s address and companion token. Confirm Saoirse shows online while idle. Test head movement, speaker volume and a still photo. Turn Wi-Fi off on the iPhone and repeat the command with cellular data, then start and stop Live View. Check the indicator and frame rate on the robot. Activate an AI profile, start a fresh voice conversation and enable transcript archiving to verify both settings and history. Confirm Wi-Fi provisioning separately with the phone next to Saoirse.

To check speaker following on your own, open **AI Agent**, stand at eye level on one side and say “Hi, Stack Chan.” Ask a short question and let Saoirse finish speaking. Move to the opposite side and ask a follow-up while she is listening. Check whether her face points toward you at both positions and whether you can hear both replies. To check selection between two visible faces, have another person ask the follow-up. With the lens covered, Saoirse should return to her starting position after searching.

On Saoirse running 1.6.18, one person tested both positions at eye level. She settled 31° left 3.1 seconds after the wake phrase and 26° right 4.3 seconds after the first follow-up camera check. The person confirmed she faced them both times. Her final horizontal face centers were 77 and 82 on a 160-pixel-wide frame. Both replies completed with zero dropped audio packets. This trial used one visible speaker moving between positions.

On 1.6.22 with the 900 ms end-of-speech setting, a Mac played two spoken requests to the physical robot. The short question included a 610 ms mid-sentence pause. From the end of the test clip to the first PCM frame sent to the speaker, Saoirse took 2.13 seconds for the short question and 2.94 seconds for the story request. She dispatched all 158 and 524 frames respectively. The short reply played 9.48 seconds of audio with zero measured gaps. The story played 31.44 seconds of audio over 31.56 seconds, with three estimated gaps of at least 20 ms and a maximum of 33 ms. These are device-output timings for two replies. In a separate live side-switch check, the user reported smooth voice and missed aim. Both short replies had zero measured playback gaps. The camera confirmed faces during the preceding playback test and recorded zero candidates in its searches during the side switch.

In a physical test of the 1.6.23 tracking changes, Saoirse confirmed a face 1.57 seconds after wake and settled at 35° left after 3.68 seconds. She confirmed a face 2.68 seconds into a later side search and settled at 31° right after 4.36 seconds. One intervening search found no face and returned the head to its starting position. All four replies played without packet loss. Their longest estimated speaker dispatch gaps were 133 ms, 13 ms, 20 ms and 0 ms.

On 1.6.24, the live relay reported 75% volume and 100% brightness. A device test applied and read back 78% volume and 97% brightness, then restored both original settings. The signed iPhone update was installed and launched. Four subsequent replies played 27.90 seconds of audio in total with zero measured dispatch gaps.

A live spoken walking request from London Waterloo Station to Big Ben produced a 24-minute, 1.98 km route with 42 steps. The paired app endpoint returned the same route ID as the status endpoint. Saoirse began replying 4.15 seconds after the end of the spoken test and played all 82 audio frames with zero measured gaps.
