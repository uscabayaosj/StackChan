Wi-Fi component overlay
======================

`wifi_station_overlay.cmake` runs after Component Manager has resolved dependencies.
It applies `patches/esp-wifi-connect-station.patch` to a build-directory copy of
78/esp-wifi-connect 3.1.1's station source, and substitutes that one source in its
CMake target. The managed download and its checksum remain unchanged. An
incompatible dependency update fails configuration instead of skipping the patch.

The overlay uses the application hooks in `network_credentials.cpp` and the
host-tested network ordering policy. It preserves the selected SSID, scans all
matching APs by signal, rescans after beacon/no-AP loss, ignores diagnostic scans
while connected, and restores UCL enterprise credentials on boot. It also uses
bounded copies for the 32-byte SSID / 64-byte password driver fields.
