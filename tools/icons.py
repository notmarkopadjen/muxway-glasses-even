#!/usr/bin/env python3
"""Draws the app's icon from a pixel map the way the Even Hub portal
validates it: 24 x 24, every pixel either #F4F4F4 at full opacity or fully
transparent, no anti-aliasing, and every lit pixel part of a 2 x 2 block
(the thinnest stroke the portal accepts). Writes public/icon.png for the
package and store/icon-24-foreground.png and store/icon-24-background.png
for the portal. PNGs are written by hand so nothing beyond Python is
needed."""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIT = (0xF4, 0xF4, 0xF4, 0xFF)
OFF = (0, 0, 0, 0)

# A terminal box with the muxway mark: a prompt and a cursor, 24 x 24,
# strokes two pixels wide.
ICON = """
........................
........................
.######################.
.######################.
.##..................##.
.##..................##.
.##..................##.
.##..###.............##.
.##..###.............##.
.##....###...........##.
.##....###...........##.
.##......###.........##.
.##......###.........##.
.##....###....####...##.
.##....###....####...##.
.##..###......####...##.
.##..###......####...##.
.##..................##.
.##..................##.
.##..................##.
.######################.
.######################.
........................
........................
"""


def rows():
    lines = ICON.strip("\n").split("\n")
    assert len(lines) == 24 and all(len(l) == 24 for l in lines), "the map is 24 x 24"
    bits = [[c == "#" for c in l] for l in lines]
    for y, row in enumerate(bits):
        for x, lit in enumerate(row):
            if lit and not any(block(bits, x - dx, y - dy) for dx in (0, 1) for dy in (0, 1)):
                raise SystemExit(f"pixel {x},{y} is not part of a 2 x 2 block")
    return bits


def block(bits, x, y):
    return 0 <= x < 23 and 0 <= y < 23 and bits[y][x] and bits[y][x + 1] and bits[y + 1][x] and bits[y + 1][x + 1]


def png(width, height, pixels):
    """pixels: rows of RGBA tuples."""
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in pixels)

    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    bits = rows()
    (ROOT / "public").mkdir(exist_ok=True)
    (ROOT / "store").mkdir(exist_ok=True)
    foreground = png(24, 24, [[LIT if b else OFF for b in row] for row in bits])
    (ROOT / "public" / "icon.png").write_bytes(foreground)
    (ROOT / "store" / "icon-24-foreground.png").write_bytes(foreground)
    (ROOT / "store" / "icon-24-background.png").write_bytes(png(24, 24, [[OFF] * 24 for _ in range(24)]))
    print("icons drawn")


if __name__ == "__main__":
    main()
