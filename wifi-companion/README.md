# StackChan Wi-Fi

A small native iPhone companion for changing StackChan's Wi-Fi without a
computer. It uses the existing Bluetooth setup service and works alongside
StackChan World. No M5Stack login, cloud account lookup, or firmware update is
required to send Wi-Fi settings.

## Use on your iPhone

1. Open **StackChan Wi-Fi** and allow Bluetooth access.
2. On the robot, open **Settings → Wi-Fi → Change Wi-Fi**, then tap **Next**
   on the app-download screen. Leave it on the setup screen.
3. Tap **Find StackChan**, then choose your robot. The ID under its name matches
   the robot's factory ID when it is included in the Bluetooth advertisement.
4. Enter the new network name and password, then tap **Connect StackChan**.
   StackChan supports **2.4 GHz** Wi-Fi. An open network uses an empty password.
5. Wait for the green success message and the robot's automatic restart.

The app queries iOS for peripherals already connected to the setup service as
well as scanning for advertisements. This covers a robot showing **Ready to
Configure** while it is connected to another app on the same iPhone. If a
different phone is holding the robot's Bluetooth connection, close its StackChan
app or disconnect that phone first.

The network name is remembered after success. Passwords stay in memory and are
cleared from the form on success; they are never saved to preferences, files, or
logs. Credentials go directly to the robot over the existing BLE service. This
does not add encryption or authentication beyond the firmware's BLE behavior.

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
response formats. The codec is shared by these tests and the iPhone target.

For hardware acceptance, verify discovery, one incorrect-password failure, a
successful connection, the robot's restart, and rediscovery after reopening
Change Wi-Fi. A build or protocol test alone does not establish phone/robot
acceptance.
