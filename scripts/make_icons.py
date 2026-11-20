"""Draw the app icon (railroad track in perspective) as PNGs using only the standard library."""
import os, struct, zlib

def png(path, size):
    bg, rail, tie = (15, 27, 45), (255, 255, 255), (96, 165, 250)
    px = [[bg] * size for _ in range(size)]
    S = size / 512
    def fill(poly, col):
        ys = [p[1] for p in poly]
        for y in range(int(min(ys)), int(max(ys)) + 1):
            xs = []
            for i in range(len(poly)):
                (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
                if (y1 <= y + .5 < y2) or (y2 <= y + .5 < y1):
                    xs.append(x1 + (y + .5 - y1) * (x2 - x1) / (y2 - y1))
            xs.sort()
            for a, b in zip(xs[::2], xs[1::2]):
                for x in range(max(0, int(a + .5)), min(size, int(b + .5))):
                    if 0 <= y < size: px[y][x] = col
    top, bot = 110 * S, 440 * S
    lx = lambda t, sgn: 256 * S + sgn * (40 + 120 * t) * S   # rail centre x at depth t (0 top -> 1 bottom)
    for i in range(7):  # ties
        t = (i / 6) ** 1.4; y = top + t * (bot - top); h = (6 + 14 * t) * S
        fill([(lx(t, -1) - 30 * S * (.4 + t), y), (lx(t, 1) + 30 * S * (.4 + t), y), (lx(t, 1) + 30 * S * (.4 + t), y + h), (lx(t, -1) - 30 * S * (.4 + t), y + h)], tie)
    for sgn in (-1, 1):  # rails
        fill([(lx(0, sgn) - 5 * S, top), (lx(0, sgn) + 5 * S, top), (lx(1, sgn) + 14 * S, bot + 20 * S), (lx(1, sgn) - 14 * S, bot + 20 * S)], rail)
    raw = b"".join(b"\0" + bytes(c for p in row for c in p) for row in px)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

root = os.path.join(os.path.dirname(__file__), "..")
for n in (180, 512): png(os.path.join(root, f"icon-{n}.png"), n)
