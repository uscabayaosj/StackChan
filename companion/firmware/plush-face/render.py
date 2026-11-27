#!/usr/bin/env python3
"""Pack the approved Saoirse poses into lossless RGB565 tiles for the CoreS3."""

import argparse
import math
from pathlib import Path
import struct
import zlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from render_giggle import BEATS, DURATION_MS


SIZE = (320, 240)
BOUNDS = (0, 0, *SIZE)
HEAD = (20, 2, 300, 184)
EYES = (96, 84, 224, 130)
MOUTH = (140, 116, 180, 146)
MIC = (104, 145, 152, 175)
CHEEK = (92, 116, 136, 148)
HEART = (260, 50, 308, 98)


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


def blush():
    tile = Image.new("RGBA", (44, 32))
    tile.putdata([
        (243, 82, 114, round(162 * smooth(1 - math.hypot((x - 22) / 22, (y - 16) / 16)) ** 1.3))
        for y in range(32) for x in range(44)
    ])
    return tile


def glazed_heart():
    # Shade a rounded extrusion using a height map, then downsample the silhouette and highlights.
    size = 144
    mask = Image.new("L", (size, size))
    path = []
    for i in range(360):
        t = math.radians(i)
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        path.append((int(71 + 3.65 * x), int(61 - 3.72 * y)))
    ImageDraw.Draw(mask).polygon(path, fill=255)
    height = mask.filter(ImageFilter.GaussianBlur(13)).load()
    silhouette = mask.load()
    heart = Image.new("RGBA", (size, size))
    rgba = heart.load()
    for y in range(2, size - 2):
        for x in range(2, size - 2):
            if not silhouette[x, y]:
                continue
            dx = (height[x + 1, y] - height[x - 1, y]) / 40
            dy = (height[x, y + 1] - height[x, y - 1]) / 40
            nz = 1 / math.sqrt(dx * dx + dy * dy + 1)
            diffuse = max(0, nz * (0.41 * dx + 0.55 * dy + 0.72))
            specular = max(0, nz * (0.26 * dx + 0.35 * dy + 0.90)) ** 25
            top_glint = math.exp(-(((x - 46) / 13) ** 2 + ((y - 36) / 9) ** 2))
            light = min(1, 0.85 * diffuse + 0.4 * specular + 0.53 * top_glint)
            rgba[x, y] = (round(151 + 104 * light), round(17 + 155 * light), round(46 + 142 * light), 255)

    shadow = Image.new("RGBA", heart.size, (54, 6, 25))
    offset = Image.new("L", heart.size)
    offset.paste(mask, (1, 6))
    shadow.putalpha(offset.filter(ImageFilter.GaussianBlur(5)).point(lambda v: v * 3 // 5))
    return Image.alpha_composite(shadow, heart).resize((48, 48), Image.Resampling.LANCZOS)


def delighted_eyes(blink):
    delighted = blink.copy()
    ink = (55, 31, 20)
    for x0, y0, x1, y1 in ((108, 104, 138, 123), (181, 104, 211, 123)):
        for x in range(x0, x1):
            top, bottom = blink.getpixel((x, y0)), blink.getpixel((x, y1))
            skin = [tuple(round(t + (b - t) * (y - y0) / (y1 - y0)) for t, b in zip(top, bottom))
                    for y in range(y0, y1)]
            pixels = [blink.getpixel((x, y)) for y in range(y0, y1)]
            # Remove the closed lids, then flip only the drawn curves. The peach shading stays in place.
            alpha = [max(0, min(1, (b[0] - p[0] - 10) / max(1, b[0] - ink[0] - 10)))
                     for p, b in zip(pixels, skin)]
            for y, (pixel, tone, lid, smile) in enumerate(zip(pixels, skin, alpha, reversed(alpha)), y0):
                clean = tone if lid > 0 else pixel
                delighted.putpixel((x, y), tuple(round(b + smile * (a - b)) for a, b in zip(ink, clean)))
    return delighted


def open_gaze(face, dx=0, dy=0, height=1.0, width=1.0):
    """Move the dark bead eyes while retaining the original catchlights and fabric shading."""
    result = face.copy()
    for box in ((109, 99, 137, 128), (182, 99, 211, 128)):
        x0, y0, x1, y1 = box
        pupil = face.crop(box)
        alpha = pupil.getchannel("R").point(lambda v: round(255 * smooth((183 - v) / 114)))
        # Close the small holes caused by the white catchlights inside the eye.
        alpha = alpha.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
        skin = Image.new("RGB", pupil.size)
        skin.putdata([
            tuple(round(top + (bottom - top) * (y - y0) / (y1 - y0)) for top, bottom in
                  zip(face.getpixel((x, y0)), face.getpixel((x, y1))))
            for y in range(y0, y1) for x in range(x0, x1)
        ])
        erase = alpha.point(lambda v: 255 if v > 10 else 0).filter(ImageFilter.MaxFilter(3))
        result.paste(skin, (x0, y0), erase.filter(ImageFilter.GaussianBlur(0.55)))

        size = round(pupil.width * width), round(pupil.height * height)
        pupil.putalpha(alpha)
        lifted = pupil.resize(size, Image.Resampling.BICUBIC)
        target = x0 + dx + (pupil.width - lifted.width) // 2, y0 + dy + (pupil.height - lifted.height) // 2
        result.paste(lifted, target, lifted.getchannel("A"))
    return result


def render(atlas):
    if atlas.size != (2 * SIZE[0], 2 * SIZE[1]):
        raise ValueError("Expected a 640 × 480 contact sheet in standby/speaking/blink/thinking order")
    base, speaking, blink, thinking = (
        atlas.crop((x, y, x + SIZE[0], y + SIZE[1]))
        for y in (0, SIZE[1]) for x in (0, SIZE[0])
    )
    focused = open_gaze(base, dy=-1, height=1.20, width=1.04)
    listen = glow(glow(focused, 53, 121, 26, 42, 1), 267, 121, 26, 42, 1)
    listen_pose = head_pose(base, listen, -2.0, 1.019, 0.5, -1.4)
    listen_blink = masked_tile(listen_pose, head_pose(base, blink, -2.0, 1.019, 0.5, -1.4), EYES, 5)

    def reply_pose(face):
        return head_pose(base, face, 2.1, 1.016)

    reply = reply_pose(base)
    happy = open_gaze(base, dy=-1, height=0.78, width=1.08)
    curious = reply_pose(thinking)
    think = masked_tile(masked_tile(reply, curious, EYES, 5), curious, MOUTH, 5)

    # Compress only the mouth opening vertically around its centre.
    small = speaking.transform(SIZE, Image.Transform.AFFINE, (1, 0, 0, 0, 1.6, -79.2),
                               Image.Resampling.BICUBIC)
    angry = base.copy()
    draw = ImageDraw.Draw(angry)
    draw.line([(114, 101), (128, 106)], fill=(92, 53, 32), width=2)
    draw.line([(191, 106), (205, 101)], fill=(92, 53, 32), width=2)
    delighted = delighted_eyes(blink)
    rose = Image.new("RGBA", SIZE)
    rose.paste(blush(), CHEEK[:2])
    love = Image.new("RGBA", SIZE)
    love.paste(glazed_heart(), HEART[:2])

    return [
        ("Background", BOUNDS, base),
        ("ListeningHead", HEAD, listen_pose),
        ("ThinkingHead", HEAD, think),
        ("Blink", EYES, masked_tile(base, blink, EYES, 5)),
        ("ListeningBlink", EYES, listen_blink),
        ("CuriousEyes", EYES, masked_tile(base, thinking, EYES, 5)),
        ("GlanceLeft", EYES, open_gaze(base, dx=-9, dy=-1)),
        ("GlanceRight", EYES, open_gaze(base, dx=9, dy=-1)),
        ("GlanceUp", EYES, open_gaze(base, dy=-7, height=1.06)),
        ("SoftEyes", EYES, open_gaze(base, dy=1, height=0.58)),
        ("HappyEyes", EYES, happy),
        ("AngryEyes", EYES, angry),
        ("Frown", MOUTH, masked_tile(base, thinking, MOUTH, 7)),
        ("Smile", MOUTH, masked_tile(base, small, MOUTH, 7)),
        ("ReplyEyes", EYES, reply),
        ("ReplySmileEyes", EYES, reply_pose(happy)),
        ("ReplyBlink", EYES, masked_tile(reply, reply_pose(blink), EYES, 5)),
        ("ClosedMouth", MOUTH, reply),
        ("SmallMouth", MOUTH, masked_tile(reply, reply_pose(small), MOUTH, 7)),
        ("OpenMouth", MOUTH, masked_tile(reply, reply_pose(speaking), MOUTH, 7)),
        ("LowMic", MIC, reply_pose(glow(base, 127, 158, 19, 14, 0.34))),
        ("MediumMic", MIC, reply_pose(glow(base, 127, 158, 19, 14, 0.78))),
        ("BrightMic", MIC, reply_pose(glow(base, 127, 158, 19, 14, 1.0))),
        ("GiggleEyes", EYES, masked_tile(base, delighted, EYES, 5)),
        ("GiggleMouth", MOUTH, masked_tile(base, speaking, MOUTH, 7)),
        ("PetBlush", CHEEK, rose),
        ("PetHeart", HEART, love),
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory for the packed sprite data and its C++ header")
    args = parser.parse_args()
    frames = render(Image.open(Path(__file__).with_name("source.png")).convert("RGB"))
    data = bytearray()
    manifest = []
    for name, box, image in frames:
        tile = image.crop(box)
        has_alpha = tile.mode == "RGBA"
        manifest.append((name, box, len(data), has_alpha))
        data.extend(rgb565(tile.convert("RGB")))
        if has_alpha:
            data.extend(tile.getchannel("A").tobytes())
        data.extend(b"\0" * (-len(data) % 16))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "saoirse_plush.bin").write_bytes(zlib.compress(data, level=9))

    lines = ["// Generated by companion/firmware/plush-face/render.py.", "#pragma once", "",
             "#include <cstddef>", "#include <cstdint>", "", "namespace stackchan::avatar::plush {", "",
             "enum Frame {", "    Hidden = -1,"]
    lines.extend(f"    {name}," for name, _, _ in frames)
    lines.extend(["    FrameCount,", "};", "", "struct Tile {", "    uint16_t x, y, width, height;",
                  "    size_t offset;", "    bool hasAlpha;", "};", "", "inline constexpr Tile kTiles[FrameCount] = {"])
    for name, (x, y, right, bottom), offset, has_alpha in manifest:
        width, height = right - x, bottom - y
        lines.append(f"    {{{x}, {y}, {width}, {height}, {offset}, {str(has_alpha).lower()}}},  // {name}")
    # Match the face's timing to the three vocal bursts, with a small allowance for speaker startup.
    step_ms = 66
    openings = []
    for ms in range(0, DURATION_MS, step_ms):
        phase = [max(0, min(1, (ms + step_ms / 2 - onset - 25) / duration)) for onset, duration, _, _ in BEATS]
        strength = max(math.sin(math.pi * t) ** 1.75 for t in phase)
        openings.append("GiggleMouth" if strength > 0.64 else "Smile" if strength > 0.21 else "Hidden")
    lines.extend(["};", f"inline constexpr size_t kPixelBytes = {len(data)};", "",
                  f"inline constexpr uint32_t kGiggleAudioMs = {DURATION_MS};",
                  f"inline constexpr uint32_t kFrameMs = {step_ms};",
                  "inline constexpr Frame kGiggleMouths[] = {" + ", ".join(openings) + "};", "",
                  "}  // namespace stackchan::avatar::plush", ""])
    (args.output / "plush_frames.h").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
