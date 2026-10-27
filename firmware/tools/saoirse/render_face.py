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
