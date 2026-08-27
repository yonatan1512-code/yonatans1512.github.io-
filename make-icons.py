# -*- coding: utf-8 -*-
"""Generate the PWA icons from scratch.

No imaging library is installed, so this rasterises the mark by hand and writes
the PNGs with zlib. Everything is drawn 4x oversized and boxed down, which is
what keeps the curves and the diagonal from looking like stairs.

Run:  python make-icons.py
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
SS = 4  # supersampling factor

BLUE_TOP = (0x3E, 0x7B, 0xFF)
BLUE_BOT = (0x14, 0x46, 0xD6)
GOLD = (0xE4, 0xCD, 0x94)
WHITE = (0xFF, 0xFF, 0xFF)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_alpha(x, y, w, h, r):
    """1 inside the rounded rectangle, 0 outside. Corners use a circle test."""
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x > w - r and y < r:
        return (x - (w - r)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y > h - r:
        return (x - r) ** 2 + (y - (h - r)) ** 2 <= r * r
    if x > w - r and y > h - r:
        return (x - (w - r)) ** 2 + (y - (h - r)) ** 2 <= r * r
    return True


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def draw(size, maskable):
    """Return an RGBA bytearray for one icon."""
    S = size * SS
    # a maskable icon gets cropped to a circle by the launcher, so the mark
    # has to sit inside the safe zone: 80% of the width, centred
    inset = S * 0.10 if maskable else 0.0
    art = S - inset * 2
    radius = 0 if maskable else art * 0.22

    # chart polyline in 0..1 space, mirroring favicon.svg
    pts = [(0.18, 0.66), (0.38, 0.46), (0.53, 0.58), (0.80, 0.30)]
    stroke = art * 0.085
    dot = (0.80, 0.30)
    dot_r = art * 0.085

    px = bytearray()
    for yy in range(S):
        row = bytearray()
        for xx in range(S):
            lx, ly = xx - inset, yy - inset
            inside = 0 <= lx < art and 0 <= ly < art and rounded_rect_alpha(lx, ly, art, art, radius)
            if not inside:
                if maskable:
                    # fill the whole square: the launcher decides the crop
                    r, g, b = lerp(BLUE_TOP, BLUE_BOT, yy / float(S))
                    row += bytes((r, g, b, 255))
                else:
                    row += b"\x00\x00\x00\x00"
                continue

            r, g, b = lerp(BLUE_TOP, BLUE_BOT, ly / float(art))

            # gold dot sits on top of the line end
            dd = math.hypot(lx - dot[0] * art, ly - dot[1] * art)
            if dd <= dot_r:
                r, g, b = GOLD
            else:
                best = min(
                    dist_to_segment(lx, ly, pts[i][0] * art, pts[i][1] * art,
                                    pts[i + 1][0] * art, pts[i + 1][1] * art)
                    for i in range(len(pts) - 1)
                )
                if best <= stroke / 2:
                    r, g, b = WHITE

            row += bytes((r, g, b, 255))
        px += row

    # box-filter down to the requested size
    out = bytearray()
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                base = ((y * SS + sy) * S + x * SS) * 4
                for sx in range(SS):
                    o = base + sx * 4
                    for c in range(4):
                        acc[c] += px[o + c]
            n = SS * SS
            out += bytes(a // n for a in acc)
    return bytes(out)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


if __name__ == "__main__":
    for size, maskable, name in [
        (192, False, "icon-192.png"),
        (512, False, "icon-512.png"),
        (512, True, "icon-maskable-512.png"),
    ]:
        n = write_png(os.path.join(ROOT, name), size, draw(size, maskable))
        print("%-24s %5d x %-4d %6.1f KB" % (name, size, size, n / 1024.0))
