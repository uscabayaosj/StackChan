# Saoirse Face Firmware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stock Stack-chan face with the approved Saoirse face (a Birman cat, traced from the owner's photo) in the StackChan firmware, and point the robot's AI endpoint at the Saoirse server.

**Architecture:** A new LVGL skin `SaoirseAvatar` (`firmware/main/stackchan/avatar/skins/saoirse/`) draws a static 320×240 PNG (rendered from the approved SVG at build-prep time) and puts live objects on top: per eye a gaze group (iris, shade, pupil, two glints), a socket-coloured lid that slides and tilts, and two small arc images for happy/sleepy; a mouth box with the side-pout image at rest, an opening oval with a tongue while speaking, and smile/frown/flat images for emotions. A `createAvatar()` factory replaces the six `make_unique<DefaultAvatar>()` call sites; a Kconfig switch keeps the stock face buildable. The OTA URL override lives in the git-ignored `sdkconfig.defaults.local` overlay the build already honours.

**Tech Stack:** ESP-IDF 5.5.4, LVGL 9.4 via smooth_ui_toolkit `lvgl_cpp` wrappers (`Container`, `Image`), xiaozhi-esp32 v2.2.4 asset bundle (`assets::get_image("name.png")`), Python 3.12 with `resvg-py` + `pillow` via `uv` for asset rendering. Spec: `docs/superpowers/specs/2026-10-27-saoirse-design.md` §5–§6, §8–§9.

## Global Constraints

- Screen is 320×240; the avatar panel is 320×240 centred on `lv_screen_active()`.
- Eye centres (104,142) and (186,142); eye box **66×66** at (71,109) and (153,109), drawn as a circle (`LV_RADIUS_CIRCLE`) with `lv_obj_set_style_clip_corner(box, true, 0)` so children are clipped to the disc; mouth box 60×40 at (130,186). These come from the approved SVG and must match the rendered base PNG. The socket discs in the base are uniform only within r≤33 (the nose patch and ginger smudge overpaint the rim beyond that), which is why the box is 66 and circular.
- Socket/lid colour `#B4A69B` (the base PNG paints a uniform disc of this colour under each eye so blinks are seamless).
- Weight semantics (from `Feature`): eyes 100 = open, 0 = closed; mouth 0 = closed, 100 = fully open. `setRotation` receives tenths of a degree and may be negative (the stock skin passes −400); LVGL expects 0..3600.
- Every firmware task ends with `idf.py build` succeeding and a commit on branch `saoirse` in `~/Developer/StackChan`.
- Never commit `sdkconfig`, `sdkconfig.defaults.local`, `build/`, or `xiaozhi-esp32/`.
- Emotion strings from the server map through the unchanged `StackChanAvatarDisplay::SetEmotion` (`neutral, happy, laughing, angry, sad, crying, sleepy, doubtful`).

---

### Task 1: Toolchain and baseline build

**Files:**
- No repo changes except verifying `.gitignore` already ignores `sdkconfig.defaults.local` (it does, `firmware/.gitignore:66`).

- [ ] **Step 1: Install ESP-IDF 5.5.4**

```bash
brew list cmake ninja dfu-util >/dev/null 2>&1 || brew install cmake ninja dfu-util
mkdir -p ~/esp && cd ~/esp
git clone -b v5.5.4 --recursive --depth 1 https://github.com/espressif/esp-idf.git esp-idf
cd ~/esp/esp-idf && ./install.sh esp32s3
```
Expected: ends with "All done! You can now run: . ./export.sh". If `install.sh` rejects the system Python 3.9, run `brew install python@3.12` and repeat with `PATH="/opt/homebrew/opt/python@3.12/libexec/bin:$PATH" ./install.sh esp32s3`.

- [ ] **Step 2: Fetch the firmware's vendored repos and build stock**

```bash
. ~/esp/esp-idf/export.sh
cd ~/Developer/StackChan/firmware
python3 ./fetch_repos.py
idf.py build 2>&1 | tail -5
```
Expected: `fetch_repos.py` prints "Applied patch patches/xiaozhi-esp32.patch to …/xiaozhi-esp32"; the build ends with "Project build complete" and a line like `stackchan.bin binary size 0x… bytes`. This is the baseline; nothing is committed.

- [ ] **Step 3: Confirm the assets pipeline includes extra files**

```bash
ls build/generated_assets.bin && python3 - <<'EOF'
import struct
# Sanity: the assets bin must contain the stock icon name, proving extra files from main/assets/assets_bin are packed.
data = open('build/generated_assets.bin','rb').read()
print('icon_ai_agent.bin' in data.decode('latin1'))
EOF
```
Expected: `True`.

---

### Task 2: Render the face assets from the SVG

**Files:**
- Create: `firmware/tools/saoirse/saoirse.svg`, `firmware/tools/saoirse/render_face.py`, `firmware/tools/saoirse/README.md`
- Create (generated, committed): `firmware/main/assets/assets_bin/saoirse_base.png`, `saoirse_pout.png`, `saoirse_eye_happy_l.png`, `saoirse_eye_happy_r.png`, `saoirse_eye_sleepy_l.png`, `saoirse_eye_sleepy_r.png`, `saoirse_mouth_smile.png`, `saoirse_mouth_frown.png`, `saoirse_mouth_flat.png`

**Interfaces:**
- Produces: the asset names above and their placement rectangles, consumed by Tasks 4–5:

| asset | rect (x, y, w, h) |
|---|---|
| `saoirse_base.png` | 0, 0, 320, 240 |
| `saoirse_pout.png` | 140, 196, 40, 20 |
| `saoirse_eye_happy_l.png` / `_r` | 67, 118, 74, 40 / 149, 118, 74, 40 |
| `saoirse_eye_sleepy_l.png` / `_r` | 67, 124, 74, 36 / 149, 124, 74, 36 |
| `saoirse_mouth_smile.png` | 136, 194, 48, 28 |
| `saoirse_mouth_frown.png` | 138, 194, 44, 20 |
| `saoirse_mouth_flat.png` | 138, 196, 44, 16 |

- [ ] **Step 1: Write the master SVG with named groups**

`firmware/tools/saoirse/saoirse.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240">
  <!-- Saoirse face (approved 2026-10-27). Groups are toggled by render_face.py. -->
  <g id="static">
    <rect width="320" height="240" fill="#EFE6DA"/>
    <ellipse cx="160" cy="262" rx="150" ry="70" fill="#FBF7F0"/>
    <path d="M42 96 L58 10 L128 62 Q90 96 42 96 Z" fill="#4A3C36"/>
    <path d="M56 86 L66 32 L112 66 Q86 86 56 86 Z" fill="#E9D9CB"/>
    <path d="M278 96 L262 10 L192 62 Q230 96 278 96 Z" fill="#4A3C36"/>
    <path d="M264 86 L254 32 L208 66 Q234 86 264 86 Z" fill="#E9D9CB"/>
    <path d="M44 150 C40 90 90 56 160 58 C230 56 280 90 276 150 C272 200 230 236 160 236 C90 236 48 200 44 150 Z" fill="#F6EEE2"/>
    <ellipse cx="160" cy="150" rx="92" ry="64" fill="#A89A8E" opacity="0.45"/>
    <ellipse cx="104" cy="146" rx="42" ry="34" fill="#8E7D72" opacity="0.45"/>
    <ellipse cx="190" cy="146" rx="42" ry="34" fill="#8E7D72" opacity="0.45"/>
    <path d="M150 66 L170 66 L178 150 Q160 160 142 150 Z" fill="#5A4B44" opacity="0.8"/>
    <!-- uniform eye sockets: the lids are this exact colour -->
    <circle cx="104" cy="142" r="37" fill="#B4A69B"/>
    <circle cx="186" cy="142" r="37" fill="#B4A69B"/>
    <ellipse cx="78" cy="196" rx="30" ry="22" fill="#FBF6EE" opacity="0.9"/>
    <ellipse cx="242" cy="196" rx="30" ry="22" fill="#FBF6EE" opacity="0.9"/>
    <ellipse cx="74" cy="178" rx="16" ry="8" fill="#F2B3C0" opacity="0.55"/>
    <ellipse cx="246" cy="178" rx="16" ry="8" fill="#F2B3C0" opacity="0.55"/>
    <g stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity="0.9">
      <line x1="118" y1="186" x2="22" y2="168"/><line x1="118" y1="194" x2="18" y2="196"/><line x1="120" y1="202" x2="30" y2="222"/>
      <line x1="202" y1="186" x2="298" y2="168"/><line x1="202" y1="194" x2="302" y2="196"/><line x1="200" y1="202" x2="290" y2="222"/>
    </g>
    <ellipse cx="153" cy="178" rx="17" ry="13" fill="#1C1614"/>
    <ellipse cx="137" cy="171" rx="7" ry="5" fill="#D8A05C"/>
    <path d="M146 176 q7 -5 14 0 q-3 7 -7 7 q-4 0 -7 -7 z" fill="#4A3C38"/>
    <path d="M70 228 Q160 214 250 228 L250 240 L70 240 Z" fill="#F2A7BF"/>
    <circle cx="160" cy="231" r="9" fill="#E8CFE3"/><line x1="152" y1="233" x2="168" y2="233" stroke="#9C7F96" stroke-width="2"/>
  </g>
  <g id="eyes">
    <circle cx="104" cy="142" r="31" fill="#3A302C"/><circle cx="186" cy="142" r="31" fill="#3A302C"/>
    <circle cx="104" cy="142" r="28" fill="#A9CCE6"/><circle cx="186" cy="142" r="28" fill="#A9CCE6"/>
    <circle cx="104" cy="146" r="22" fill="#8FB8D8" opacity="0.6"/><circle cx="186" cy="146" r="22" fill="#8FB8D8" opacity="0.6"/>
    <circle cx="104" cy="144" r="13" fill="#1B1716"/><circle cx="186" cy="144" r="13" fill="#1B1716"/>
    <circle cx="95" cy="132" r="8" fill="#fff"/><circle cx="177" cy="132" r="8" fill="#fff"/>
    <circle cx="112" cy="151" r="4" fill="#fff"/><circle cx="194" cy="151" r="4" fill="#fff"/>
  </g>
  <g id="pout">
    <path d="M146 200 q8 6 16 2 q6 -2 10 6" stroke="#3A302C" stroke-width="4" fill="none" stroke-linecap="round"/>
    <ellipse cx="168" cy="207" rx="7" ry="3.5" fill="#D9A3A3" opacity="0.85"/>
  </g>
  <g id="eye_happy">
    <path d="M78 148 q26 -30 52 0" stroke="#3A302C" stroke-width="8" fill="none" stroke-linecap="round"/>
    <path d="M160 148 q26 -30 52 0" stroke="#3A302C" stroke-width="8" fill="none" stroke-linecap="round"/>
  </g>
  <g id="eye_sleepy">
    <path d="M80 142 q24 22 48 0" stroke="#3A302C" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M162 142 q24 22 48 0" stroke="#3A302C" stroke-width="7" fill="none" stroke-linecap="round"/>
  </g>
  <g id="mouth_smile"><path d="M144 200 q16 18 32 0 z" fill="#3A302C"/></g>
  <g id="mouth_frown"><path d="M146 206 q14 -10 28 0" stroke="#3A302C" stroke-width="4" fill="none" stroke-linecap="round"/></g>
  <g id="mouth_flat"><path d="M144 206 q16 -6 32 0" stroke="#3A302C" stroke-width="4" fill="none" stroke-linecap="round"/></g>
</svg>
```

- [ ] **Step 2: Write the render script**

`firmware/tools/saoirse/render_face.py`:
```python
"""Render Saoirse face assets from saoirse.svg into firmware/main/assets/assets_bin/.

Run:  uv run --python 3.12 --with resvg-py --with pillow python firmware/tools/saoirse/render_face.py
"""
import io
import re
import sys
from pathlib import Path

import resvg_py
from PIL import Image

HERE = Path(__file__).resolve().parent
SVG = (HERE / "saoirse.svg").read_text()
OUT = HERE.parent.parent / "main" / "assets" / "assets_bin"

GROUPS = ["static", "eyes", "pout", "eye_happy", "eye_sleepy", "mouth_smile", "mouth_frown", "mouth_flat"]

# name -> (visible groups, crop rect (x, y, w, h) or None for full canvas, opaque)
ASSETS = {
    "saoirse_base.png": (["static"], None, True),
    "saoirse_pout.png": (["pout"], (140, 196, 40, 20), False),
    "saoirse_eye_happy_l.png": (["eye_happy"], (67, 118, 74, 40), False),
    "saoirse_eye_happy_r.png": (["eye_happy"], (149, 118, 74, 40), False),
    "saoirse_eye_sleepy_l.png": (["eye_sleepy"], (67, 124, 74, 36), False),
    "saoirse_eye_sleepy_r.png": (["eye_sleepy"], (149, 124, 74, 36), False),
    "saoirse_mouth_smile.png": (["mouth_smile"], (136, 194, 48, 28), False),
    "saoirse_mouth_frown.png": (["mouth_frown"], (138, 194, 44, 20), False),
    "saoirse_mouth_flat.png": (["mouth_flat"], (138, 196, 44, 16), False),
}


def svg_with_groups(visible: list[str]) -> str:
    svg = SVG
    for g in GROUPS:
        if g not in visible:
            svg = re.sub(rf'<g id="{g}"', f'<g id="{g}" display="none"', svg)
    return svg


def render(visible: list[str]) -> Image.Image:
    png = bytes(resvg_py.svg_to_bytes(svg_string=svg_with_groups(visible), width=320, height=240))
    return Image.open(io.BytesIO(png)).convert("RGBA")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (groups, rect, opaque) in ASSETS.items():
        im = render(groups)
        if rect:
            x, y, w, h = rect
            im = im.crop((x, y, x + w, y + h))
        if opaque:
            im = im.convert("RGB")
        im.save(OUT / name, optimize=True)
        print(f"{name}: {im.size[0]}x{im.size[1]} {'RGB' if opaque else 'RGBA'}")
    # Verify the socket colour the lids must match.
    base = Image.open(OUT / "saoirse_base.png").convert("RGB")
    socket = base.getpixel((104, 142))
    print("socket colour at left eye centre:", "#%02X%02X%02X" % socket)
    if socket != (0xB4, 0xA6, 0x9B):
        print("ERROR: socket colour must be #B4A69B (update kSocket in saoirse.h if the SVG changes)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: Render and inspect**

```bash
cd ~/Developer/StackChan
uv run --python 3.12 --with resvg-py --with pillow python firmware/tools/saoirse/render_face.py
sips -g pixelWidth -g pixelHeight firmware/main/assets/assets_bin/saoirse_base.png
```
Expected: nine lines like `saoirse_base.png: 320x240 RGB`, then `socket colour at left eye centre: #B4A69B`, exit 0. Open `firmware/main/assets/assets_bin/saoirse_base.png` and check: the face with blank socket discs where the eyes go and no mouth; `saoirse_pout.png` is a small transparent PNG with the pout.

- [ ] **Step 4: Write the README and commit**

`firmware/tools/saoirse/README.md`:
```md
# Saoirse face assets

`saoirse.svg` is the source of truth for the face. `render_face.py` renders the static base and the small state images into `firmware/main/assets/assets_bin/`, which the firmware build packs into the assets partition (`assets::get_image("saoirse_base.png")`).

Re-render after editing the SVG:

    uv run --python 3.12 --with resvg-py --with pillow python firmware/tools/saoirse/render_face.py

Keep the eye centres (104,142) / (186,142), the mouth box (130,186,60,40) and the socket colour #B4A69B in sync with `firmware/main/stackchan/avatar/skins/saoirse/saoirse.h`.
```

```bash
git add firmware/tools/saoirse firmware/main/assets/assets_bin/saoirse_*.png
git commit -m "firmware: Saoirse face SVG and rendered assets"
```

---

### Task 3: Avatar factory and call-site switch (still the stock face)

**Files:**
- Modify: `firmware/main/stackchan/avatar/avatar/avatar.h` (add two virtuals)
- Modify: `firmware/main/stackchan/avatar/skins/default/default.h:22-23` (mark `init`/`getPanel` as overrides)
- Create: `firmware/main/stackchan/avatar/skins/skin_factory.h`
- Modify: `firmware/main/stackchan/avatar/avatar.h` (umbrella: include the factory)
- Modify: `firmware/main/hal/board/stackchan_display.cc:254-255`, `firmware/main/apps/app_avatar/app_avatar.cpp:87-88`, `firmware/main/apps/app_dance/app_dance.cpp:56-57`, `firmware/main/apps/app_espnow_ctrl/app_espnow_ctrl.cpp:75-76`, `firmware/main/apps/app_ezdata/app_ezdata.cpp:41-42`, `firmware/main/apps/app_setup/workers/connectivity.cpp:28-29`

**Interfaces:**
- Produces: `Avatar::init(lv_obj_t* parent, const lv_font_t* font)` and `Avatar::getPanel()` virtuals; `std::unique_ptr<Avatar> avatar::createAvatar(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16)` returning an initialised avatar.

- [ ] **Step 1: Add the virtuals to the base class**

In `firmware/main/stackchan/avatar/avatar/avatar.h`, change the includes and add two methods inside `class Avatar` right after `public:`:
```cpp
#pragma once
#include "elements/key_elements.h"
#include "decorator.h"
#include <lvgl.h>
#include <smooth_lvgl.hpp>
#include <memory>

namespace stackchan::avatar {

class Avatar {
public:
    virtual ~Avatar() = default;

    /** Build the LVGL objects under parent. Skins override this. */
    virtual void init(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16) {}

    /** The 320x240 panel that receives taps; may be null for skins without one. */
    virtual uitk::lvgl_cpp::Container* getPanel() const { return nullptr; }
```
(Keep the rest of the class unchanged.)

- [ ] **Step 2: Mark the default skin's methods as overrides**

In `firmware/main/stackchan/avatar/skins/default/default.h` replace
```cpp
    void init(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16);
    uitk::lvgl_cpp::Container* getPanel() const;
```
with
```cpp
    void init(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16) override;
    uitk::lvgl_cpp::Container* getPanel() const override;
```

- [ ] **Step 3: Create the factory**

`firmware/main/stackchan/avatar/skins/skin_factory.h`:
```cpp
/*
 * Saoirse fork: picks the avatar skin at compile time.
 */
#pragma once
#include "../avatar/avatar.h"
#include "default/default.h"
#if __has_include(<sdkconfig.h>)
#include <sdkconfig.h>
#endif
#ifdef CONFIG_STACKCHAN_SKIN_SAOIRSE
#include "saoirse/saoirse.h"
#endif
#include <lvgl.h>
#include <memory>

namespace stackchan::avatar {

/** Create and init the configured skin. Callers only use the Avatar interface. */
inline std::unique_ptr<Avatar> createAvatar(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16)
{
#ifdef CONFIG_STACKCHAN_SKIN_SAOIRSE
    auto avatar = std::make_unique<SaoirseAvatar>();
#else
    auto avatar = std::make_unique<DefaultAvatar>();
#endif
    avatar->init(parent, font);
    return avatar;
}

}  // namespace stackchan::avatar
```

Add to the umbrella header `firmware/main/stackchan/avatar/avatar.h` after the existing `#include "skins/default/default.h"`:
```cpp
#include "skins/skin_factory.h"
```

- [ ] **Step 4: Switch the six call sites**

`firmware/main/hal/board/stackchan_display.cc` (around line 254):
```cpp
    auto avatar = avatar::createAvatar(lv_screen_active());
    avatar->getPanel()->onClick().connect([]() {
```
(remove the old `auto avatar = std::make_unique<DefaultAvatar>();` and `avatar->init(lv_screen_active());` lines; keep everything after). If this file uses `using namespace stackchan::avatar;` the call is `createAvatar(...)`; otherwise `stackchan::avatar::createAvatar(...)`.

`firmware/main/apps/app_avatar/app_avatar.cpp` (around line 87):
```cpp
    auto avatar = avatar::createAvatar(lv_screen_active());
    avatar->getPanel()->onClick().connect([&]() { _screen_clicked_flag = true; });
    GetStackChan().attachAvatar(std::move(avatar));
```

`firmware/main/apps/app_dance/app_dance.cpp` (around line 56), `app_espnow_ctrl.cpp` (around line 75), `app_ezdata.cpp` (around line 41): replace the two lines
```cpp
    auto avatar = std::make_unique<avatar::DefaultAvatar>();
    avatar->init(lv_screen_active());
```
with
```cpp
    auto avatar = avatar::createAvatar(lv_screen_active());
```

`firmware/main/apps/app_setup/workers/connectivity.cpp` (around line 28):
```cpp
    auto avatar = avatar::createAvatar(lv_screen_active(), &lv_font_montserrat_24);
    avatar->leftEye().setVisible(false);
    avatar->rightEye().setVisible(false);
    avatar->mouth().setVisible(false);
    GetStackChan().attachAvatar(std::move(avatar));
```

- [ ] **Step 5: Build**

```bash
cd ~/Developer/StackChan/firmware && . ~/esp/esp-idf/export.sh && idf.py build 2>&1 | grep -E "error|Project build complete" | head
```
Expected: `Project build complete`. Typical errors: a call site still referencing `DefaultAvatar` (grep `make_unique<DefaultAvatar>\|make_unique<avatar::DefaultAvatar>` must return nothing), or a missing `override` mismatch in default.h.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/StackChan && git add firmware/main && git commit -m "firmware: avatar skin factory; call sites no longer name DefaultAvatar"
```

---

### Task 4: SaoirseEyes

**Files:**
- Create: `firmware/main/stackchan/avatar/skins/saoirse/saoirse.h`, `firmware/main/stackchan/avatar/skins/saoirse/eyes.cpp`

**Interfaces:**
- Consumes: `Feature`, `Element`, `Emotion`, `assets::get_image`, `uitk::lvgl_cpp::Container/Image`.
- Produces: `class SaoirseEyes : public Feature` (constructor `(lv_obj_t* parent, bool isLeftEye)`), constants in `namespace stackchan::avatar::saoirse`, and the declarations of `SaoirseMouth` and `SaoirseAvatar` (implemented in Task 5).

- [ ] **Step 1: Write the header**

`firmware/main/stackchan/avatar/skins/saoirse/saoirse.h`:
```cpp
/*
 * Saoirse skin: the owner's Birman cat, traced from a photo.
 * Static art is saoirse_base.png; eyes, lids and mouth are live LVGL objects.
 */
#pragma once
#include "../../avatar/avatar.h"
#include "../../avatar/elements/feature.h"
#include <lvgl.h>
#include <smooth_lvgl.hpp>
#include <memory>

namespace stackchan::avatar {

namespace saoirse {
// Geometry (must match firmware/tools/saoirse/saoirse.svg and render_face.py)
constexpr int kEyeBox      = 66;   // eye container size (circular, corner-clipped)
constexpr int kEyeLeftX    = 71;   // top-left of the left eye box
constexpr int kEyeRightX   = 153;
constexpr int kEyeY        = 109;
constexpr int kGazeRange   = 4;    // px of iris travel for gaze = ±100
constexpr int kLidWidth    = 100;  // wider than the box so a tilted lid still covers it
constexpr int kMouthX      = 130, kMouthY = 186, kMouthW = 60, kMouthH = 40;
constexpr int kMouthOpenThreshold = 30;
// Colours
constexpr uint32_t kSocket   = 0xB4A69B;
constexpr uint32_t kRim      = 0x3A302C;
constexpr uint32_t kIris     = 0xA9CCE6;
constexpr uint32_t kShade    = 0x8FB8D8;
constexpr uint32_t kPupil    = 0x1B1716;
constexpr uint32_t kDark     = 0x3A302C;
constexpr uint32_t kTongue   = 0xFF8FA3;
constexpr uint32_t kBubbleBg = 0x3A302C;
constexpr uint32_t kBubbleFg = 0xF8F0E3;
}  // namespace saoirse

class SaoirseEyes : public Feature {
public:
    SaoirseEyes(lv_obj_t* parent, bool isLeftEye);
    ~SaoirseEyes();

    void setPosition(const uitk::Vector2i& position) override;
    void setWeight(int weight) override;
    void setRotation(int rotation) override;
    void setEmotion(const Emotion& emotion) override;
    void setVisible(bool visible) override;
    void setSize(int size) override;

private:
    void applyLid();
    void showArc(bool happy, bool sleepy);

    bool _is_left_eye = false;
    int _lid_rotation = 0;  // tenths of a degree, LVGL range 0..3600

    lv_image_dsc_t _happy_dsc{};
    lv_image_dsc_t _sleepy_dsc{};

    std::unique_ptr<uitk::lvgl_cpp::Container> _box;    // 74x74, clips children
    std::unique_ptr<uitk::lvgl_cpp::Container> _gaze;   // moves with gaze
    std::unique_ptr<uitk::lvgl_cpp::Container> _rim;
    std::unique_ptr<uitk::lvgl_cpp::Container> _iris;
    std::unique_ptr<uitk::lvgl_cpp::Container> _shade;
    std::unique_ptr<uitk::lvgl_cpp::Container> _pupil;
    std::unique_ptr<uitk::lvgl_cpp::Container> _glint1;
    std::unique_ptr<uitk::lvgl_cpp::Container> _glint2;
    std::unique_ptr<uitk::lvgl_cpp::Container> _lid;
    std::unique_ptr<uitk::lvgl_cpp::Image> _happy;
    std::unique_ptr<uitk::lvgl_cpp::Image> _sleepy;
};

class SaoirseMouth : public Feature {
public:
    explicit SaoirseMouth(lv_obj_t* parent);
    ~SaoirseMouth();

    void setPosition(const uitk::Vector2i& position) override;
    void setWeight(int weight) override;
    void setRotation(int rotation) override;
    void setEmotion(const Emotion& emotion) override;
    void setVisible(bool visible) override;

private:
    void refresh();

    Emotion _emotion = Emotion::Neutral;
    lv_image_dsc_t _pout_dsc{}, _smile_dsc{}, _frown_dsc{}, _flat_dsc{};

    std::unique_ptr<uitk::lvgl_cpp::Container> _box;
    std::unique_ptr<uitk::lvgl_cpp::Container> _oval;
    std::unique_ptr<uitk::lvgl_cpp::Container> _tongue;
    std::unique_ptr<uitk::lvgl_cpp::Image> _pout;
    std::unique_ptr<uitk::lvgl_cpp::Image> _smile;
    std::unique_ptr<uitk::lvgl_cpp::Image> _frown;
    std::unique_ptr<uitk::lvgl_cpp::Image> _flat;
};

class SaoirseAvatar : public Avatar {
public:
    void init(lv_obj_t* parent, const lv_font_t* font = &lv_font_montserrat_16) override;
    uitk::lvgl_cpp::Container* getPanel() const override;

private:
    lv_image_dsc_t _base_dsc{};
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Image> _base;
};

}  // namespace stackchan::avatar
```

- [ ] **Step 2: Write eyes.cpp**

`firmware/main/stackchan/avatar/skins/saoirse/eyes.cpp`:
```cpp
#include "saoirse.h"
#include <assets/assets.h>

using namespace uitk;
using namespace uitk::lvgl_cpp;
using namespace stackchan::avatar;
using namespace stackchan::avatar::saoirse;

namespace {

std::unique_ptr<Container> make_circle(lv_obj_t* parent, int diameter, uint32_t color, int x, int y, lv_opa_t opa = LV_OPA_COVER)
{
    auto c = std::make_unique<Container>(parent);
    c->setSize(diameter, diameter);
    c->setRadius(LV_RADIUS_CIRCLE);
    c->setBorderWidth(0);
    c->setBgColor(lv_color_hex(color));
    c->setBgOpa(opa);
    c->setPadding(0, 0, 0, 0);
    c->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    c->align(LV_ALIGN_CENTER, x, y);
    return c;
}

// The arc PNGs were cropped from the full canvas at x = 67 (left) / 149 (right), 74 px wide;
// the circular box starts 4 px further right, so shift them back by 4.
int kEyeLeftX_or_RightX(bool isLeftEye)
{
    return isLeftEye ? kEyeLeftX : kEyeRightX;
}

int wrap_rotation(int tenths)
{
    tenths %= 3600;
    if (tenths < 0) tenths += 3600;
    return tenths;
}

}  // namespace

SaoirseEyes::SaoirseEyes(lv_obj_t* parent, bool isLeftEye) : _is_left_eye(isLeftEye)
{
    // Clipping box at the eye socket. Children outside it (the raised lid) are hidden.
    _box = std::make_unique<Container>(parent);
    _box->setAlign(LV_ALIGN_TOP_LEFT);
    _box->setPos(isLeftEye ? kEyeLeftX : kEyeRightX, kEyeY);
    _box->setSize(kEyeBox, kEyeBox);
    _box->setRadius(LV_RADIUS_CIRCLE);  // the socket is a disc: clip lids and gaze to it
    lv_obj_set_style_clip_corner(_box->get(), true, 0);
    _box->setBorderWidth(0);
    _box->setBgOpa(LV_OPA_TRANSP);
    _box->setPadding(0, 0, 0, 0);
    _box->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    // Gaze group: everything that moves when she looks around.
    _gaze = std::make_unique<Container>(_box->get());
    _gaze->setAlign(LV_ALIGN_TOP_LEFT);
    _gaze->setPos(0, 0);
    _gaze->setSize(kEyeBox, kEyeBox);
    _gaze->setRadius(0);
    _gaze->setBorderWidth(0);
    _gaze->setBgOpa(LV_OPA_TRANSP);
    _gaze->setPadding(0, 0, 0, 0);
    _gaze->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    _rim    = make_circle(_gaze->get(), 58, kRim, 0, 0);
    _iris   = make_circle(_gaze->get(), 52, kIris, 0, 0);
    _shade  = make_circle(_gaze->get(), 40, kShade, 0, 4, LV_OPA_60);
    _pupil  = make_circle(_gaze->get(), 24, kPupil, 0, 2);
    _glint1 = make_circle(_gaze->get(), 14, 0xFFFFFF, -8, -9);
    _glint2 = make_circle(_gaze->get(), 8, 0xFFFFFF, 7, 7);

    // Lid: socket-coloured, pivots at its bottom centre so it can tilt for emotions.
    _lid = std::make_unique<Container>(_box->get());
    _lid->setAlign(LV_ALIGN_TOP_LEFT);
    _lid->setSize(kLidWidth, kEyeBox);
    _lid->setRadius(0);
    _lid->setBorderWidth(0);
    _lid->setBgColor(lv_color_hex(kSocket));
    _lid->setBgOpa(LV_OPA_COVER);
    _lid->setPadding(0, 0, 0, 0);
    _lid->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    _lid->setTransformPivot(kLidWidth / 2, kEyeBox);

    // Emotion arcs drawn over the closed lid.
    _happy_dsc  = assets::get_image(isLeftEye ? "saoirse_eye_happy_l.png" : "saoirse_eye_happy_r.png");
    _sleepy_dsc = assets::get_image(isLeftEye ? "saoirse_eye_sleepy_l.png" : "saoirse_eye_sleepy_r.png");
    _happy = std::make_unique<Image>(_box->get());
    _happy->setSrc(&_happy_dsc);
    _happy->setAlign(LV_ALIGN_TOP_LEFT);
    _happy->setPos(67 - kEyeLeftX_or_RightX(isLeftEye), 118 - kEyeY);
    _sleepy = std::make_unique<Image>(_box->get());
    _sleepy->setSrc(&_sleepy_dsc);
    _sleepy->setAlign(LV_ALIGN_TOP_LEFT);
    _sleepy->setPos(67 - kEyeLeftX_or_RightX(isLeftEye), 124 - kEyeY);
    showArc(false, false);

    setSize(0);
    setWeight(100);
    setPosition(_position);
    setRotation(0);
}

SaoirseEyes::~SaoirseEyes()
{
    _happy.reset();
    _sleepy.reset();
    _lid.reset();
    _glint2.reset();
    _glint1.reset();
    _pupil.reset();
    _shade.reset();
    _iris.reset();
    _rim.reset();
    _gaze.reset();
    _box.reset();
}

void SaoirseEyes::setPosition(const Vector2i& position)
{
    Element::setPosition(position);
    const int dx = map_range(_position.x, -100, 100, -kGazeRange, kGazeRange);
    const int dy = map_range(_position.y, -100, 100, -kGazeRange, kGazeRange);
    _gaze->setPos(dx, dy);
}

void SaoirseEyes::applyLid()
{
    // weight 100 = open: lid fully above the box (clipped). weight 0 = closed: lid covers the box.
    const int y = -kEyeBox + map_range(100 - _weight, 0, 100, 0, kEyeBox);
    _lid->setPos(-(kLidWidth - kEyeBox) / 2, y);
    _lid->setRotation(_lid_rotation);
}

void SaoirseEyes::setWeight(int weight)
{
    Feature::setWeight(weight);
    applyLid();
}

void SaoirseEyes::setRotation(int rotation)
{
    Element::setRotation(rotation);
    _lid_rotation = wrap_rotation(rotation);
    applyLid();
}

void SaoirseEyes::showArc(bool happy, bool sleepy)
{
    _happy->setHidden(!happy);
    _sleepy->setHidden(!sleepy);
}

void SaoirseEyes::setEmotion(const Emotion& emotion)
{
    if (getIgnoreEmotion()) {
        return;
    }
    // tilt > 0 lowers the inner (nose-side) corner of the lid; mirrored per eye.
    auto apply = [this](int weight, int tilt_tenths, bool happy, bool sleepy) {
        setRotation(_is_left_eye ? tilt_tenths : -tilt_tenths);
        setWeight(weight);
        showArc(happy, sleepy);
    };
    switch (emotion) {
        case Emotion::Neutral: apply(100, 0, false, false); break;
        case Emotion::Happy:   apply(0, 0, true, false); break;
        case Emotion::Angry:   apply(45, 180, false, false); break;
        case Emotion::Sad:     apply(45, -180, false, false); break;
        case Emotion::Doubt:   apply(_is_left_eye ? 100 : 50, 0, false, false); break;
        case Emotion::Sleepy:  apply(0, 0, false, true); break;
        default: break;
    }
}

void SaoirseEyes::setVisible(bool visible)
{
    Element::setVisible(visible);
    _box->setHidden(!visible);
}

void SaoirseEyes::setSize(int size)
{
    Feature::setSize(size);
    // -100..100 -> pupil 18..34 px: wide pupils when excited, pinned when annoyed.
    const int pupil = map_range(_size, -100, 100, 16, 30);
    _pupil->setSize(pupil, pupil);
}
```

- [ ] **Step 3: Build (the header declares SaoirseMouth/SaoirseAvatar; they are not referenced yet, so this compiles)**

```bash
cd ~/Developer/StackChan/firmware && idf.py build 2>&1 | grep -E "error|Project build complete" | head
```
Expected: `Project build complete`. If `map_range` is not found, add `#include <uitk/short_namespace.hpp>` (it is what `DefaultEyes` relies on via `using namespace uitk`).

- [ ] **Step 4: Commit**

```bash
cd ~/Developer/StackChan && git add firmware/main/stackchan/avatar/skins/saoirse && git commit -m "firmware: SaoirseEyes (gaze group, sliding/tilting lid, emotion arcs)"
```

---

### Task 5: SaoirseMouth, SaoirseAvatar, Kconfig switch

**Files:**
- Create: `firmware/main/stackchan/avatar/skins/saoirse/mouth.cpp`, `firmware/main/stackchan/avatar/skins/saoirse/saoirse.cpp`
- Modify: `firmware/main/Kconfig.projbuild:1-12` (new menu entry)

**Interfaces:**
- Consumes: Task 4 header, `DefaultSpeechBubble` (from `skins/default/default.h`), `assets::get_image`.
- Produces: a buildable `SaoirseAvatar`; `CONFIG_STACKCHAN_SKIN_SAOIRSE` (default y) selecting it in the factory.

- [ ] **Step 1: Write mouth.cpp**

`firmware/main/stackchan/avatar/skins/saoirse/mouth.cpp`:
```cpp
#include "saoirse.h"
#include <assets/assets.h>

using namespace uitk;
using namespace uitk::lvgl_cpp;
using namespace stackchan::avatar;
using namespace stackchan::avatar::saoirse;

namespace {
std::unique_ptr<Image> make_image(lv_obj_t* parent, lv_image_dsc_t& dsc, const char* name, int x, int y)
{
    dsc = assets::get_image(name);
    auto img = std::make_unique<Image>(parent);
    img->setSrc(&dsc);
    img->setAlign(LV_ALIGN_TOP_LEFT);
    img->setPos(x - kMouthX, y - kMouthY);
    return img;
}
}  // namespace

SaoirseMouth::SaoirseMouth(lv_obj_t* parent)
{
    _box = std::make_unique<Container>(parent);
    _box->setAlign(LV_ALIGN_TOP_LEFT);
    _box->setPos(kMouthX, kMouthY);
    _box->setSize(kMouthW, kMouthH);
    _box->setRadius(0);
    _box->setBorderWidth(0);
    _box->setBgOpa(LV_OPA_TRANSP);
    _box->setPadding(0, 0, 0, 0);
    _box->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    // State images, positioned by their render rects (see render_face.py).
    _pout  = make_image(_box->get(), _pout_dsc, "saoirse_pout.png", 140, 196);
    _smile = make_image(_box->get(), _smile_dsc, "saoirse_mouth_smile.png", 136, 194);
    _frown = make_image(_box->get(), _frown_dsc, "saoirse_mouth_frown.png", 138, 194);
    _flat  = make_image(_box->get(), _flat_dsc, "saoirse_mouth_flat.png", 138, 196);

    // Opening: dark oval with a tongue, sized by weight while speaking.
    _oval = std::make_unique<Container>(_box->get());
    _oval->setRadius(LV_RADIUS_CIRCLE);
    _oval->setBorderWidth(0);
    _oval->setBgColor(lv_color_hex(kDark));
    _oval->setPadding(0, 0, 0, 0);
    _oval->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    _oval->align(LV_ALIGN_CENTER, 2, 2);

    _tongue = std::make_unique<Container>(_oval->get());
    _tongue->setRadius(LV_RADIUS_CIRCLE);
    _tongue->setBorderWidth(0);
    _tongue->setBgColor(lv_color_hex(kTongue));
    _tongue->setPadding(0, 0, 0, 0);
    _tongue->removeFlag(LV_OBJ_FLAG_SCROLLABLE);
    _tongue->setAlign(LV_ALIGN_BOTTOM_MID);

    setPosition(_position);
    setWeight(0);
}

SaoirseMouth::~SaoirseMouth()
{
    _tongue.reset();
    _oval.reset();
    _flat.reset();
    _frown.reset();
    _smile.reset();
    _pout.reset();
    _box.reset();
}

void SaoirseMouth::setPosition(const Vector2i& position)
{
    Element::setPosition(position);
    _box->setPos(kMouthX + map_range(_position.x, -100, 100, -4, 4), kMouthY + map_range(_position.y, -100, 100, -4, 4));
}

void SaoirseMouth::setWeight(int weight)
{
    Feature::setWeight(weight);
    refresh();
}

void SaoirseMouth::setRotation(int rotation)
{
    Element::setRotation(rotation);  // the pout does not rotate
}

void SaoirseMouth::setEmotion(const Emotion& emotion)
{
    if (getIgnoreEmotion()) {
        return;
    }
    _emotion = emotion;
    refresh();
}

void SaoirseMouth::refresh()
{
    const bool open = _weight >= kMouthOpenThreshold;
    _oval->setHidden(!open);
    _pout->setHidden(true);
    _smile->setHidden(true);
    _frown->setHidden(true);
    _flat->setHidden(true);

    if (open) {
        const int w = map_range(_weight, kMouthOpenThreshold, 100, 18, 30);
        const int h = map_range(_weight, kMouthOpenThreshold, 100, 14, 24);
        _oval->setSize(w, h);
        _oval->align(LV_ALIGN_CENTER, 2, 2);
        _tongue->setHidden(_weight < 60);
        _tongue->setSize((w * 6) / 10, (h * 45) / 100);
        _tongue->align(LV_ALIGN_BOTTOM_MID, 0, -2);
        return;
    }
    switch (_emotion) {
        case Emotion::Happy: _smile->setHidden(false); break;
        case Emotion::Sad:   _frown->setHidden(false); break;
        case Emotion::Angry: _flat->setHidden(false); break;
        default:             _pout->setHidden(false); break;
    }
}

void SaoirseMouth::setVisible(bool visible)
{
    Element::setVisible(visible);
    _box->setHidden(!visible);
}
```

- [ ] **Step 2: Write saoirse.cpp**

`firmware/main/stackchan/avatar/skins/saoirse/saoirse.cpp`:
```cpp
#include "saoirse.h"
#include "../default/default.h"
#include <assets/assets.h>

using namespace uitk::lvgl_cpp;
using namespace stackchan::avatar;
using namespace stackchan::avatar::saoirse;

void SaoirseAvatar::init(lv_obj_t* parent, const lv_font_t* font)
{
    _panel = std::make_unique<Container>(parent);
    _panel->align(LV_ALIGN_CENTER, 0, 0);
    _panel->setSize(320, 240);
    _panel->setRadius(0);
    _panel->setBorderWidth(0);
    _panel->setBgColor(lv_color_hex(0xEFE6DA));
    _panel->setPadding(0, 0, 0, 0);
    _panel->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    _base_dsc = assets::get_image("saoirse_base.png");
    _base     = std::make_unique<Image>(_panel->get());
    _base->setSrc(&_base_dsc);
    _base->setAlign(LV_ALIGN_TOP_LEFT);
    _base->setPos(0, 0);

    _key_elements.leftEye  = std::make_unique<SaoirseEyes>(_panel->get(), true);
    _key_elements.rightEye = std::make_unique<SaoirseEyes>(_panel->get(), false);
    _key_elements.mouth    = std::make_unique<SaoirseMouth>(_panel->get());
    _key_elements.speechBubble = std::make_unique<DefaultSpeechBubble>(
        _panel->get(), lv_color_hex(kBubbleBg), lv_color_hex(kBubbleFg), font);
}

Container* SaoirseAvatar::getPanel() const
{
    return _panel ? _panel.get() : nullptr;
}
```

- [ ] **Step 3: Add the Kconfig switch**

In `firmware/main/Kconfig.projbuild`, insert before `menu "Xiaozhi Assistant"`:
```
menu "StackChan Skin"

config STACKCHAN_SKIN_SAOIRSE
    bool "Use the Saoirse face skin"
    default y
    help
        Draws the Saoirse (Birman cat) face instead of the stock Stack-chan face.
        Assets: main/assets/assets_bin/saoirse_*.png, source: tools/saoirse/saoirse.svg.

endmenu
```

- [ ] **Step 4: Build with the new skin**

```bash
cd ~/Developer/StackChan/firmware && idf.py build 2>&1 | grep -E "error|warning: unused|Project build complete" | head
```
Expected: `Project build complete`. If Kconfig does not pick up the new symbol, run `idf.py reconfigure` first. Check the assets were packed: `python3 -c "d=open('build/generated_assets.bin','rb').read().decode('latin1'); print(all(n in d for n in ['saoirse_base.png','saoirse_pout.png','saoirse_eye_happy_l.png']))"` → `True`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/StackChan && git add firmware/main && git commit -m "firmware: Saoirse skin (mouth, avatar, Kconfig switch)"
```

---

### Task 6: Preview on the Mac with the UI simulator (best effort)

**Files:**
- Create (copied from the Hermes-StackChan fork): `firmware/tools/ui_sim/**`, `scripts/run-ui-sim.sh`
- Create: `firmware/tools/ui_sim/assets_stub.cpp`, `firmware/tools/ui_sim/scenarios/saoirse_emotions.json`

Time box: if the simulator does not build within about two hours of fixes, stop, note what failed in the commit message of whatever compiles, and go to Task 7; the device is the real test.

- [ ] **Step 1: Bring in the simulator from the Hermes fork**

```bash
cd ~/Developer/StackChan
git remote add hermes https://github.com/circlemouth/Hermes-StackChan 2>/dev/null; git fetch --depth 1 hermes main
git checkout hermes/main -- firmware/tools/ui_sim scripts/run-ui-sim.sh
git restore --staged firmware/tools/ui_sim scripts/run-ui-sim.sh
ls firmware/tools/ui_sim
```

- [ ] **Step 2: Make the simulator create the configured skin and load PNG assets from disk**

Find where it creates the stock skin and switch to the factory:
```bash
grep -rn "DefaultAvatar" firmware/tools/ui_sim/*.cpp
```
Replace each `std::make_unique<DefaultAvatar>()` + `->init(...)` pair with `createAvatar(parent)` (include `"stackchan/avatar/skins/skin_factory.h"`) and add `-DCONFIG_STACKCHAN_SKIN_SAOIRSE=1` to the simulator's `target_compile_definitions` in `firmware/tools/ui_sim/CMakeLists.txt`.

`firmware/tools/ui_sim/assets_stub.cpp` (replaces the firmware's `assets.cpp` in the simulator; PNG bytes are read from the repo):
```cpp
#include <assets/assets.h>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

// Minimal stand-in for firmware/main/assets/assets.cpp: serves PNGs from main/assets/assets_bin.
namespace assets {

static std::map<std::string, std::vector<uint8_t>> cache;

lv_image_dsc_t get_image(std::string_view name)
{
    lv_image_dsc_t dsc = {0};
    std::string key(name);
    if (!cache.count(key)) {
        std::string path = std::string(UI_SIM_ASSETS_DIR) + "/" + key;
        FILE* f = fopen(path.c_str(), "rb");
        if (!f) { fprintf(stderr, "[assets_stub] missing %s\n", path.c_str()); return dsc; }
        std::vector<uint8_t> bytes;
        uint8_t buf[4096];
        size_t n;
        while ((n = fread(buf, 1, sizeof buf, f)) > 0) bytes.insert(bytes.end(), buf, buf + n);
        fclose(f);
        cache[key] = std::move(bytes);
    }
    auto& bytes = cache[key];
    dsc.header.magic = LV_IMAGE_HEADER_MAGIC;
    dsc.header.cf    = LV_COLOR_FORMAT_RAW_ALPHA;
    dsc.data_size    = bytes.size();
    dsc.data         = bytes.data();
    return dsc;
}

}  // namespace assets
```
In `firmware/tools/ui_sim/CMakeLists.txt`: add `assets_stub.cpp` to the simulator sources, remove any firmware `assets/assets.cpp` from them, and add `target_compile_definitions(stackchan_ui_sim PRIVATE UI_SIM_ASSETS_DIR="${FIRMWARE_MAIN}/assets/assets_bin")`. In `firmware/tools/ui_sim/lv_conf.h` set `#define LV_USE_LODEPNG 1`. The ogg sound symbols declared in `assets.h` (`_binary_camera_shutter_ogg_start` etc.) must exist for the link: add to `assets_stub.cpp`:
```cpp
extern "C" {
const char _binary_camera_shutter_ogg_start[1] = {0};
const char _binary_camera_shutter_ogg_end[1] = {0};
const char _binary_new_notification_ogg_start[1] = {0};
const char _binary_new_notification_ogg_end[1] = {0};
}
```

- [ ] **Step 3: Add an emotion scenario and run headless**

`firmware/tools/ui_sim/scenarios/saoirse_emotions.json` — copy `emotion_cycle.json` and keep its structure; it must step through `neutral, happy, angry, sad, doubtful, sleepy` with a screenshot after each (follow the keys used in `emotion_cycle.json`).

```bash
cd ~/Developer/StackChan
./scripts/run-ui-sim.sh --headless --scenario firmware/tools/ui_sim/scenarios/avatar_smoke.json --screenshot /tmp/saoirse-smoke.ppm && sips -s format png /tmp/saoirse-smoke.ppm --out /tmp/saoirse-smoke.png
./scripts/run-ui-sim.sh --headless --scenario firmware/tools/ui_sim/scenarios/saoirse_emotions.json --screenshot /tmp/saoirse-emotions.ppm && sips -s format png /tmp/saoirse-emotions.ppm --out /tmp/saoirse-emotions.png
```
Expected: PNGs showing the Saoirse face (base art, blue eyes, pout) and the last emotion of the cycle. Compare against `docs/superpowers/specs/assets/saoirse-face.svg`; fix lid offsets or image positions in `eyes.cpp`/`mouth.cpp` if anything is misaligned, re-run.

- [ ] **Step 4: Commit**

```bash
git add firmware/tools/ui_sim scripts/run-ui-sim.sh && git commit -m "firmware: desktop UI simulator for the Saoirse skin (from Hermes-StackChan)"
```

---

### Task 7: Point the robot at the server, flash, verify

**Files:**
- Create (git-ignored): `firmware/sdkconfig.defaults.local`
- Create: `firmware/sdkconfig.defaults.saoirse.example`
- Modify: `firmware/README.md` (new "Saoirse" section)

- [ ] **Step 1: Write the overlay with the deployed server's OTA URL**

`firmware/sdkconfig.defaults.saoirse.example` (committed template):
```
# Copy to sdkconfig.defaults.local (git-ignored) and fill in your saoirse-server host.
CONFIG_OTA_URL="https://<your-deployment-host>/api/ota"
CONFIG_STACKCHAN_SKIN_SAOIRSE=y
```
```bash
cd ~/Developer/StackChan/firmware
sed 's#<your-deployment-host>#saoirse-server-xxxx.vercel.app#' sdkconfig.defaults.saoirse.example > sdkconfig.defaults.local
rm -f sdkconfig && idf.py build 2>&1 | grep -E "detected sdkconfig.defaults.local|Project build complete"
grep '^CONFIG_OTA_URL' sdkconfig
```
Expected: "StackChan: detected sdkconfig.defaults.local, applying overlay", "Project build complete", and `CONFIG_OTA_URL="https://saoirse-server-xxxx.vercel.app/api/ota"`.

- [ ] **Step 2: Flash and watch the boot**

Connect the robot over USB-C, power it on, then:
```bash
ls /dev/cu.usbmodem*
idf.py -p /dev/cu.usbmodem<id> flash monitor
```
Expected in the monitor: the Saoirse face on the robot after boot; a log line from xiaozhi's OTA check containing your Vercel host and "websocket" config received; no "Failed to get asset"/"get image asset … failed" errors. Exit the monitor with Ctrl+].

- [ ] **Step 3: Live checks**

1. Say "Hi Stack Chan", then ask a question. Expected: listening state, a spoken reply in the ElevenLabs voice, the caption bubble shows the sentence, and the face shows the tagged emotion. On the server: `vercel logs <deployment-url>` shows `[session] connected <mac>` and the transcript.
2. Blink and idle motion run on the Saoirse face; petting the head shows the heart decorator.
3. The StackChan app still binds, shows the camera stream and plays a dance (M5Stack cloud unchanged).
4. Ask something tedious; expect `[sleepy]` eyes; ask something she'd doubt; expect the raised-lid "really?" look.

- [ ] **Step 4: Document and commit**

Add to `firmware/README.md`:
```md
## Saoirse build

- Face: `CONFIG_STACKCHAN_SKIN_SAOIRSE=y` (default). Assets are rendered from `tools/saoirse/saoirse.svg`; see `tools/saoirse/README.md`.
- AI server: copy `sdkconfig.defaults.saoirse.example` to `sdkconfig.defaults.local` and set `CONFIG_OTA_URL` to your saoirse-server deployment. Everything else keeps using M5Stack's cloud.
- Preview on a Mac: `./scripts/run-ui-sim.sh --scenario firmware/tools/ui_sim/scenarios/saoirse_emotions.json`.
```
```bash
cd ~/Developer/StackChan && git add firmware/README.md firmware/sdkconfig.defaults.saoirse.example && git commit -m "firmware: Saoirse build notes and OTA overlay template"
```

---

## Self-review (done while writing)

- Spec coverage: §5.1 look and palette (Task 2 SVG), §5.2 base image + live eyes/lids/mouth/bubble/decorators (Tasks 2, 4, 5), §5.3 integration (factory, six call sites, Kconfig, render script: Tasks 2–3, 5), §5.4 simulator (Task 6, best effort), §6 endpoint change (Task 7; the URL lives in the git-ignored overlay the build already honours, with a committed `.example`, instead of editing the shared `sdkconfig.defaults`), §8–§9 checks (Tasks 6–7). Decorator position tuning is left at stock values; adjust `HeartDecorator::setPosition` calls in `head_pet.h` only if the heart lands off the face on device.
- Types: `saoirse.h` (Task 4) declares all three classes used by `mouth.cpp`/`saoirse.cpp` (Task 5) and `skin_factory.h` (Task 3); `Avatar::init`/`getPanel` virtuals (Task 3) are what `createAvatar` and `stackchan_display.cc` call; asset names and rects in Task 2 match the `assets::get_image` calls and `setPos` offsets in Tasks 4–5.
- Known risk: `Container::setHidden` must exist in the toolkit's `Object` (the stock `DefaultEyes::setVisible` uses it, so it does).
