
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
- AI server: copy `sdkconfig.defaults.saoirse.example` to `sdkconfig.defaults.local` (git-ignored, applied automatically by the build) and set `CONFIG_OTA_URL` to your saoirse-server deployment, e.g. `https://saoirse-server.vercel.app/api/ota`. Everything else keeps using M5Stack's cloud.
- Preview on a Mac without flashing: `./scripts/run-ui-sim.sh --headless --scenario firmware/tools/ui_sim/scenarios/saoirse_emotions.json --screenshot /tmp/saoirse.ppm` (see `tools/ui_sim/README.md`).
- Flash: `. ~/esp/esp-idf/export.sh && idf.py -p /dev/cu.usbmodem<id> flash monitor`.
