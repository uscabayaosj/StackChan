#!/usr/bin/env python3
"""Pack the approved Saoirse poses into lossless RGB565 tiles for the CoreS3."""

import argparse
import math
from pathlib import Path
import struct
import zlib

from PIL import Image, ImageChops, ImageDraw


SIZE = (320, 240)
BOUNDS = (0, 0, *SIZE)
HEAD = (20, 2, 300, 184)
EYES = (106, 88, 214, 128)
MOUTH = (140, 116, 180, 146)
MIC = (104, 145, 152, 175)


def smooth(t):
    t = max(0, min(t, 1))
    return t * t * (3 - 2 * t)


def masked_tile(base, pose, rect, feather):
    left, top, right, bottom = rect
    mask = Image.new("L", (right - left, bottom - top))
    mask.putdata([
        round(255 * smooth(min(x - left, right - 1 - x, y - top, bottom - 1 - y) / feather))
        for y in range(top, bottom) for x in range(left, right)
    ])
    out = base.copy()
    out.paste(pose.crop(rect), (left, top), mask)
    return out


def head_pose(base, pose, tilt, scale, dx=0, dy=0):
    pivot_x, pivot_y = 160, 178
    angle = math.radians(tilt)
    a, b = math.cos(angle) / scale, math.sin(angle) / scale
    moved = pose.transform(SIZE, Image.Transform.AFFINE, (
        a, b, pivot_x - a * (pivot_x + dx) - b * (pivot_y + dy),
        -b, a, pivot_y + b * (pivot_x + dx) - a * (pivot_y + dy),
    ), Image.Resampling.BICUBIC)
    left, top, right, bottom = HEAD
    mask = Image.new("L", (right - left, bottom - top))
    mask.putdata([
        round(255 * smooth(min(x - left, right - 1 - x, y - top) / 8) * smooth((bottom - 1 - y) / 19))
        for y in range(top, bottom) for x in range(left, right)
    ])
    out = base.copy()
    out.paste(moved.crop(HEAD), (left, top), mask)
    return out


def glow(image, x, y, rx, ry, intensity):
    light = Image.new("RGB", SIZE)
    strengths = (168, 237, 255)
    pixels = light.load()
    for py in range(max(0, int(y - ry)), min(SIZE[1], math.ceil(y + ry))):
        for px in range(max(0, int(x - rx)), min(SIZE[0], math.ceil(x + rx))):
            distance = math.hypot((px - x) / rx, (py - y) / ry)
            opacity = intensity * smooth(1 - distance) ** 1.45
            pixels[px, py] = tuple(round(component * opacity) for component in strengths)
    return ImageChops.screen(image, light)


def rgb565(image):
    return b"".join(struct.pack("<H", (r >> 3) << 11 | (g >> 2) << 5 | (b >> 3))
                    for r, g, b in image.getdata())


def render(atlas):
    if atlas.size != (2 * SIZE[0], 2 * SIZE[1]):
        raise ValueError("Expected a 640 × 480 contact sheet in standby/speaking/blink/thinking order")
    base, speaking, blink, thinking = (
        atlas.crop((x, y, x + SIZE[0], y + SIZE[1]))
        for y in (0, SIZE[1]) for x in (0, SIZE[0])
    )
    listen = glow(glow(base, 53, 121, 26, 42, 1), 267, 121, 26, 42, 1)
    listen_pose = head_pose(base, listen, -2.0, 1.019, 0.5, -1.4)
    listen_blink = masked_tile(listen_pose, head_pose(base, blink, -2.0, 1.019, 0.5, -1.4), EYES, 5)

    def reply_pose(face):
        return head_pose(base, face, 2.1, 1.016)

    reply = reply_pose(base)
    curious = reply_pose(thinking)
    think = masked_tile(masked_tile(reply, curious, EYES, 5), curious, MOUTH, 5)

    # Compress only the mouth opening vertically around its centre.
    small = speaking.transform(SIZE, Image.Transform.AFFINE, (1, 0, 0, 0, 1.6, -79.2),
                               Image.Resampling.BICUBIC)
    angry = base.copy()
    draw = ImageDraw.Draw(angry)
    draw.line([(114, 101), (128, 106)], fill=(92, 53, 32), width=2)
    draw.line([(191, 106), (205, 101)], fill=(92, 53, 32), width=2)

    return [
        ("Background", BOUNDS, base),
        ("ListeningHead", HEAD, listen_pose),
        ("ThinkingHead", HEAD, think),
        ("Blink", EYES, masked_tile(base, blink, EYES, 5)),
        ("ListeningBlink", EYES, listen_blink),
        ("CuriousEyes", EYES, masked_tile(base, thinking, EYES, 5)),
        ("AngryEyes", EYES, angry),
        ("Frown", MOUTH, masked_tile(base, thinking, MOUTH, 7)),
        ("Smile", MOUTH, masked_tile(base, small, MOUTH, 7)),
        ("ReplyEyes", EYES, reply),
        ("ReplyBlink", EYES, masked_tile(reply, reply_pose(blink), EYES, 5)),
        ("ClosedMouth", MOUTH, reply),
        ("SmallMouth", MOUTH, masked_tile(reply, reply_pose(small), MOUTH, 7)),
        ("OpenMouth", MOUTH, masked_tile(reply, reply_pose(speaking), MOUTH, 7)),
        ("LowMic", MIC, reply_pose(glow(base, 127, 158, 19, 14, 0.34))),
        ("MediumMic", MIC, reply_pose(glow(base, 127, 158, 19, 14, 0.78))),
        ("BrightMic", MIC, reply_pose(glow(base, 127, 158, 19, 14, 1.0))),
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory for the packed sprite data and its C++ header")
    args = parser.parse_args()
    frames = render(Image.open(Path(__file__).with_name("source.png")).convert("RGB"))
    data = bytearray()
    for _, box, image in frames:
        data.extend(rgb565(image.crop(box)))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "saoirse_plush.bin").write_bytes(zlib.compress(data, level=9))

    lines = ["// Generated by companion/firmware/plush-face/render.py.", "#pragma once", "",
             "#include <cstddef>", "#include <cstdint>", "", "namespace stackchan::avatar::plush {", "",
             "enum Frame {", "    Hidden = -1,"]
    lines.extend(f"    {name}," for name, _, _ in frames)
    lines.extend(["    FrameCount,", "};", "", "struct Tile {", "    uint16_t x, y, width, height;",
                  "    size_t offset;", "};", "", "inline constexpr Tile kTiles[FrameCount] = {"])
    offset = 0
    for name, (x, y, right, bottom), _ in frames:
        width, height = right - x, bottom - y
        lines.append(f"    {{{x}, {y}, {width}, {height}, {offset}}},  // {name}")
        offset += width * height * 2
    lines.extend(["};", f"inline constexpr size_t kPixelBytes = {offset};", "", "}  // namespace stackchan::avatar::plush", ""])
    (args.output / "plush_frames.h").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
