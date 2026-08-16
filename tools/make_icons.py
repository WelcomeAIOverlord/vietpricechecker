#!/usr/bin/env python3
"""Generate the PWA icon set. Run: python3 tools/make_icons.py"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

BG_TOP = (13, 21, 38)
BG_BOTTOM = (24, 46, 74)
ACCENT = (255, 196, 61)
TEAL = (94, 234, 212)


def rounded_bg(size, radius_ratio, pad_ratio):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    grad = grad.resize((size, size))

    pad = int(size * pad_ratio)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [pad, pad, size - pad - 1, size - pad - 1],
        radius=int((size - 2 * pad) * radius_ratio),
        fill=255,
    )
    img.paste(grad, (0, 0), mask)
    return img


def draw_mark(img, size, pad_ratio):
    d = ImageDraw.Draw(img)
    inner = size * (1 - 2 * pad_ratio)
    cx = size / 2

    dong = ImageFont.truetype(FONT, int(inner * 0.55))
    label = ImageFont.truetype(FONT, int(inner * 0.17))

    box = d.textbbox((0, 0), "₫", font=dong)
    d.text(
        (cx - (box[0] + box[2]) / 2, size * 0.5 - (box[1] + box[3]) / 2 - inner * 0.13),
        "₫",
        font=dong,
        fill=ACCENT,
    )

    box = d.textbbox((0, 0), "NT$", font=label)
    d.text(
        (cx - (box[0] + box[2]) / 2, size / 2 + inner * 0.18),
        "NT$",
        font=label,
        fill=TEAL,
    )
    return img


def build(size, path, pad_ratio=0.0, radius_ratio=0.22):
    img = rounded_bg(size, radius_ratio, pad_ratio)
    draw_mark(img, size, pad_ratio)
    img.save(path)
    print("wrote", os.path.relpath(path, ROOT), f"{os.path.getsize(path)}B")


def build_opaque(size, path):
    """Apple home-screen icons must be square and opaque (iOS masks them itself)."""
    img = rounded_bg(size, 0.0, 0.0)
    draw_mark(img, size, 0.0)
    img.convert("RGB").save(path)
    print("wrote", os.path.relpath(path, ROOT), f"{os.path.getsize(path)}B")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    build(192, os.path.join(OUT, "icon-192.png"))
    build(512, os.path.join(OUT, "icon-512.png"))
    # Maskable icons need the safe zone: keep the mark inside the middle 80%.
    build(512, os.path.join(OUT, "icon-maskable-512.png"), pad_ratio=0.0, radius_ratio=0.5)
    build_opaque(180, os.path.join(OUT, "apple-touch-icon.png"))
    build(32, os.path.join(OUT, "favicon-32.png"), radius_ratio=0.2)
