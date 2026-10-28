
## Build

### Fetch Dependencies

```bash
python3 ./fetch_repos.py
```

### Tool Chains

[ESP-IDF v5.5.4](https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/index.html)

### Build

```bash
idf.py build
```

### Host-side tests

The motion coordinate helpers can be tested without ESP-IDF hardware:

```bash
cmake -S tests -B build-host-tests
cmake --build build-host-tests
ctest --test-dir build-host-tests --output-on-failure
```

### Flash

```bash
idf.py flash
```

## Saoirse build

- Face: `CONFIG_STACKCHAN_SKIN_SAOIRSE=y` (default). Assets are rendered from `tools/saoirse/saoirse.svg`; see `tools/saoirse/README.md`.
- AI server: copy `sdkconfig.defaults.saoirse.example` to `sdkconfig.defaults.local` (git-ignored, applied automatically by the build) and set `CONFIG_OTA_URL` to your saoirse-server deployment, e.g. `https://<your-saoirse-server-host>/api/ota?k=<OTA_SECRET>`. Everything else keeps using M5Stack's cloud.
- Preview on a Mac without flashing: `./scripts/run-ui-sim.sh --headless --scenario firmware/tools/ui_sim/scenarios/saoirse_emotions.json --screenshot /tmp/saoirse.ppm` (see `tools/ui_sim/README.md`).
- Flash: `. ~/esp/esp-idf/export.sh && idf.py -p /dev/cu.usbmodem<id> flash monitor`.
- Speaking watchdog: if no TTS audio packet arrives for 8 s while the robot is speaking (`kSpeakingAudioTimeoutMs` in `xiaozhi-esp32/main/application.cc`, carried in `patches/xiaozhi-esp32.patch`), it leaves the speaking state as a `tts stop` would, so a Wi-Fi drop mid-reply no longer leaves it blue and mouthing for ~150 s.

`OTA_SECRET` is the value you set on the server (`vercel env add OTA_SECRET production`); the robot sends it as the `k` query parameter and the server refuses the OTA check (which hands out the WebSocket token) without it. `CONFIG_SEND_WAKE_WORD_DATA=y` makes the robot announce the wake word (`listen detect`) so the server can skip its popup chime.

After changing `sdkconfig.defaults.local`, delete `sdkconfig` before building (`rm sdkconfig && idf.py build`): ESP-IDF only applies the defaults when generating a new `sdkconfig`. Order matters for the secret: flash the robot with the `?k=` URL first, then set `OTA_SECRET` on the server; a robot without the secret gets 403 on its OTA check and stops retrying until rebooted. The robot's NVS `ota_url` (set by the M5 app) overrides `CONFIG_OTA_URL` if present, and the OTA failure alert shows the URL, secret included, on the screen.
