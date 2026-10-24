#!/usr/bin/env python3
"""Draws the app's icon from a pixel map into the sizes the Even Hub portal
and the package take: public/icon.png (24 px, 8-bit grey), store/icon-512-
foreground.png (grey with alpha), store/icon-512-background.png (black) and
store/icon-512.png (flattened). Greyscale only, no colour, as the portal's
guidelines require. PNGs are written by hand so nothing beyond Python is
needed."""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# A terminal box with the muxway mark: a prompt and a cursor, 24 x 24.
ICON = """
........................
........................
........................
.######################.
.#....................#.
.#..####..............#.
.#.....####...........#.
.#........####........#.
.#...........####.....#.
.#........####........#.
.#.....####...........#.
.#..####..............#.
.#....................#.
.#.........########...#.
.#....................#.
.#....................#.
.######################.
.#........#..#........#.
.#........#..#........#.
.#........#..#........#.
.######################.
........................
........................
........................
"""


def rows():
    lines = [l for l in ICON.strip("\n").split("\n")]
    assert len(lines) == 24 and all(len(l) == 24 for l in lines), "the map is 24 x 24"
    return [[c == "#" for c in l] for l in lines]


def png(width, height, pixels, color_type):
    """pixels: rows of tuples (grey,) or (grey, alpha)."""
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(bytes(p) for p in row)

    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def scaled(bits, size):
    """The map scaled to size x size with hard edges, as a pixel icon should be."""
    n = len(bits)
    cell = size // n
    pad = (size - cell * n) // 2
    out = []
    for y in range(size):
        sy = (y - pad) // cell
        row = []
        for x in range(size):
            sx = (x - pad) // cell
            row.append(0 <= sy < n and 0 <= sx < n and bits[sy][sx])
        out.append(row)
    return out


def main():
    bits = rows()
    (ROOT / "public").mkdir(exist_ok=True)
    (ROOT / "store").mkdir(exist_ok=True)
    (ROOT / "public" / "icon.png").write_bytes(png(24, 24, [[(255 if b else 0,) for b in row] for row in bits], 0))
    big = scaled(bits, 512)
    (ROOT / "store" / "icon-512-foreground.png").write_bytes(png(512, 512, [[(255, 255 if b else 0) for b in row] for row in big], 4))
    (ROOT / "store" / "icon-512-background.png").write_bytes(png(512, 512, [[(0,) for _ in range(512)] for _ in range(512)], 0))
    (ROOT / "store" / "icon-512.png").write_bytes(png(512, 512, [[(255 if b else 0,) for b in row] for row in big], 0))
    (ROOT / "store" / "icon-24-foreground.png").write_bytes(png(24, 24, [[(255, 255 if b else 0) for b in row] for row in bits], 4))
    print("icons drawn")


if __name__ == "__main__":
    main()
