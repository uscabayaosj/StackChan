# Saoirse face assets

`saoirse.svg` is the source of truth for the face. `render_face.py` renders the static base and the small state images into `firmware/main/assets/assets_bin/`, which the firmware build packs into the assets partition (`assets::get_image("saoirse_base.png")`).

Re-render after editing the SVG:

    uv run --python 3.12 --with resvg-py --with pillow python firmware/tools/saoirse/render_face.py

Keep the eye centres (104,142) / (186,142), the mouth box (130,186,60,40) and the socket colour #B4A69B in sync with `firmware/main/stackchan/avatar/skins/saoirse/saoirse.h`.
