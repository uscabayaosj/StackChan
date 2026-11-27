#!/usr/bin/env python3
"""Synthesize Saoirse's short, breathy giggle and encode it for ESP-IDF."""

import argparse
from array import array
import math
from pathlib import Path
import random
import subprocess
import sys


RATE = 24000
DURATION_MS = 1020
# Onset, duration, pitch, and relative intensity of the three vocal bursts.
BEATS = ((65, 202, 440, 0.86), (339, 198, 505, 1.0), (603, 245, 469, 0.67))


def synthesize():
    rng = random.Random(42)
    audio = [0.0] * (RATE * DURATION_MS // 1000)
    for onset, duration, pitch, gain in BEATS:
        start = onset * RATE // 1000
        length = duration * RATE // 1000
        phase = breath = 0.0
        for i in range(length):
            t = i / length
            # Raise the pitch into the vowel, then let it fall as the breath runs out.
            frequency = pitch * (0.90 + 0.24 * math.sin(math.pi * t) - 0.13 * t)
            frequency *= 1 + 0.021 * math.sin(i * 2 * math.pi * 7 / RATE)
            phase = (phase + 2 * math.pi * frequency / RATE) % (2 * math.pi)
            sample = 0.0
            for harmonic in range(1, 10):
                hz = harmonic * frequency
                resonance = (
                    0.65 * math.exp(-((hz - (575 - 170 * t)) / 220) ** 2)
                    + 0.87 * math.exp(-((hz - (1950 + 460 * t)) / 435) ** 2)
                    + 0.38 * math.exp(-((hz - 2980) / 510) ** 2)
                )
                sample += resonance * math.sin(harmonic * phase + 0.17 * harmonic) / harmonic ** 0.75
            noise = rng.uniform(-1, 1)
            breath = 0.78 * breath + 0.22 * noise
            airy = (noise - breath) * (0.40 - 0.23 * math.sin(math.pi * t))
            voice = math.sin(math.pi * min(1, max(0, (t - 0.09) / 0.91))) ** 1.75
            window = math.sin(math.pi * t) ** 1.15
            audio[start + i] += gain * (voice * sample + window * airy)

    peak = max(abs(v) for v in audio)
    pcm = array("h", (round(v * 11300 / peak) for v in audio))
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Path to the generated Ogg Opus clip")
    args = parser.parse_args()
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(RATE), "-ac", "1",
        "-i", "pipe:0", "-map_metadata", "-1", "-bitexact", "-c:a", "libopus", "-b:a", "30k",
        "-frame_duration", "60", "-application", "audio", str(args.output),
    ], input=synthesize(), check=True)


if __name__ == "__main__":
    main()
