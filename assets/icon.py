"""ClaudeAnywhere icon: a conversation, broadcasting.

Rendered here rather than drawn in an editor so the geometry is the source
of truth and any size can be regenerated. 4x supersampling for antialiasing;
no dependencies, which is the same rule the rest of the project follows.
"""
import math, struct, zlib, sys

BG   = (0xD9, 0x77, 0x57)   # Claude terracotta
FG   = (0xFF, 0xFF, 0xFF)
S    = 4                     # supersample factor

def rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def arc(x, y, cx, cy, radius, width, a0, a1):
    dx, dy = x - cx, y - cy
    d = math.hypot(dx, dy)
    if abs(d - radius) > width / 2:
        return False
    ang = math.degrees(math.atan2(dy, dx))
    return a0 <= ang <= a1

def tail(x, y):
    # A short flag hanging off the bubble's lower-left, clipped to the
    # bubble's baseline so the two read as one shape.
    pts = [(62.0, 152.0), (62.0, 190.0), (100.0, 156.0)]
    (ax, ay), (bx, by), (cx_, cy_) = pts
    d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    d2 = (cx_ - bx) * (y - by) - (cy_ - by) * (x - bx)
    d3 = (ax - cx_) * (y - cy_) - (ay - cy_) * (x - cx_)
    return (d1 <= 0 and d2 <= 0 and d3 <= 0) or (d1 >= 0 and d2 >= 0 and d3 >= 0)

def sample(x, y):
    """Foreground coverage test at a point, in 256-space."""
    if rounded_rect(x, y, 30, 64, 140, 156, 24) or tail(x, y):
        return True
    # Three arcs radiating from the bubble's upper-right, the signal
    # leaving the conversation.
    for radius in (38, 62, 86):
        if arc(x, y, 150, 162, radius, 14, -88, -6):
            return True
    return False

def render(size):
    n = size * S
    scale = 256.0 / n
    rows = []
    for py in range(n):
        row = []
        for px in range(n):
            x = (px + 0.5) * scale
            y = (py + 0.5) * scale
            inside_bg = rounded_rect(x, y, 0, 0, 256, 256, 56)
            if not inside_bg:
                row.append((0, 0, 0, 0))
            elif sample(x, y):
                row.append(FG + (255,))
            else:
                row.append(BG + (255,))
        rows.append(row)
    # Box downsample to the requested size.
    out = []
    for oy in range(size):
        line = bytearray([0])
        for ox in range(size):
            r = g = b = a = 0
            for dy in range(S):
                for dx in range(S):
                    pr, pg, pb, pa = rows[oy * S + dy][ox * S + dx]
                    r += pr * pa; g += pg * pa; b += pb * pa; a += pa
            if a == 0:
                line += bytes((0, 0, 0, 0))
            else:
                line += bytes((r // a, g // a, b // a, a // (S * S)))
        out.append(bytes(line))
    return b"".join(out)

def write_png(path, size):
    raw = render(size)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)
    print(f"{path}  {size}x{size}  {len(png)} bytes")

for size, path in [(256, "assets/icon.png"), (180, "server/static/icon-180.png")]:
    write_png(path, size)
