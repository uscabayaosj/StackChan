# StackChan Wi-Fi

A small native iPhone companion for changing StackChan's Wi-Fi without a
computer. It uses the existing Bluetooth setup service and works alongside
StackChan World. No M5Stack login or cloud account lookup is required. Ordinary Wi-Fi works
with the existing setup service; UCL eduroam requires the companion firmware
changes in this repository (version 1.6.1 or later).

## Use on your iPhone

1. Open **StackChan Wi-Fi** and allow Bluetooth access.
2. On the robot, open **Settings → Wi-Fi → Change Wi-Fi**, then tap **Next**
   on the app-download screen. Leave it on the setup screen.
3. The saved presets are **Saoirse**, **ClaphamSJ**, **Christs-IoT**, and
   **eduroam**. Tap a pencil to enter each password once and save it. For UCL,
   enter your UCL user ID followed by `@ucl.ac.uk`, which may differ from your email.
4. Tap the saved network to connect. The app finds and reconnects to the robot
   you selected previously. On first use, choose the robot from the device list.
   For Saoirse, enable Personal Hotspot and Maximise Compatibility first.
   StackChan supports **2.4 GHz** Wi-Fi. The Other network form also remains
   available for a temporary network; its details are not saved.
5. Wait for the green success message and the robot's automatic restart.

The app queries iOS for peripherals already connected to the setup service as
well as scanning for advertisements. This covers a robot showing **Ready to
Configure** while it is connected to another app on the same iPhone. If a
different phone is holding the robot's Bluetooth connection, close its StackChan
app or disconnect that phone first.

Saved profile details, including passwords and the UCL user ID, are stored as
Keychain generic passwords with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
They are not synced to other phones, written to preferences, or printed in logs.
The edit sheet can forget each saved profile. The robot stores the selected
network after it obtains an IP address, and prefers it on subsequent boots.

UCL uses PEAP/MSCHAPv2. Its current CAT profile's CA set and expected server
`eduroam.ucl.ac.uk` are compiled into the firmware, with certificate date checks
enabled. The phone supplies time during provisioning; the robot retains a known
time for cold starts before networking is available. See the firmware's
`main/hal/utils/wifi_connect/certs/README.md` for source and fingerprints.

Credentials go directly to the robot over the existing BLE setup service.
The companion does not change that service's Bluetooth pairing/security model.

## Build and install

Requires Xcode, XcodeGen, and an Apple development signing identity. iOS 17 or
later is supported. The generated Xcode project and build products are ignored.

```sh
cd wifi-companion
xcodegen generate
xcodebuild -project StackChanWiFi.xcodeproj -scheme StackChanWiFi \
  -configuration Release -destination 'id=YOUR_IPHONE_UDID' \
  -derivedDataPath /private/tmp/stackchan-wifi-build \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID -allowProvisioningUpdates build
xcrun devicectl device install app --device YOUR_IPHONE_UDID \
  /private/tmp/stackchan-wifi-build/Build/Products/Release-iphoneos/StackChanWiFi.app
xcrun devicectl device process launch --device YOUR_IPHONE_UDID \
  com.uscabayao.StackChanWiFi
```

Use a local build directory outside a cloud file-provider folder: Finder metadata
on `.app` bundles in those folders can prevent code signing. The development
team in `project.yml` is the local maintainer's default; override it as above for
another account. A development-signed installation remains subject to its
provisioning profile's expiry. It is separate from the App Store app.

## Verification

```sh
swift test --build-system native
```

The protocol tests cover credential byte limits, open networks, Unicode and
escaping, multiple BLE write sizes, reordered or missing packets, stale packet
timeouts, oversized/truncated messages, and the firmware's success/failure
response formats, the four presets, UCL identity validation, and enterprise
payloads. The codec is shared by these tests and the iPhone target.

For hardware acceptance, verify discovery, one incorrect-password failure, a
successful connection, the robot's restart, and rediscovery after reopening
Change Wi-Fi. A build or protocol test alone does not establish phone/robot
acceptance.
