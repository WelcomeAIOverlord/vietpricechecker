#!/usr/bin/env python3
"""Render fake Vietnamese price tags so the OCR path can be tested end to end.

Run: python3 tools/make_test_images.py [outdir]
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = "/usr/share/fonts/truetype"
SANS = f"{FONT_DIR}/dejavu/DejaVuSans-Bold.ttf"
SERIF = f"{FONT_DIR}/liberation/LiberationSerif-Bold.ttf"

CASES = [
    ("tag_120k", [("Cà phê sữa đá", 44, SANS), ("120.000 đ", 96, SANS)], "white"),
    ("tag_35k", [("Bánh mì", 44, SANS), ("35.000đ", 92, SERIF)], "white"),
    ("tag_menu", [
        ("THỰC ĐƠN", 40, SANS),
        ("Phở bò tái      65.000", 44, SANS),
        ("Bún chả         55.000", 44, SANS),
        ("Cà phê sữa      25.000", 44, SANS),
    ], "white"),
    ("tag_dark", [("KHUYẾN MÃI", 40, SANS), ("250.000 VNĐ", 84, SANS)], "dark"),
    ("tag_1tr2", [("Áo dài lụa", 44, SANS), ("1.250.000 đ", 84, SANS)], "white"),
]


def render(name, lines, mode, outdir):
    w, h = 900, 640
    bg = (18, 18, 22) if mode == "dark" else (248, 246, 240)
    fg = (245, 245, 245) if mode == "dark" else (20, 20, 24)
    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)

    total = sum(size + 26 for _, size, _ in lines)
    y = (h - total) / 2
    for text, size, path in lines:
        font = ImageFont.truetype(path, size)
        box = d.textbbox((0, 0), text, font=font)
        d.text(((w - (box[2] - box[0])) / 2 - box[0], y), text, font=font, fill=fg)
        y += size + 26

    out = os.path.join(outdir, name + ".png")
    img.save(out)
    print("wrote", out)


if __name__ == "__main__":
    outdir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(outdir, exist_ok=True)
    for name, lines, mode in CASES:
        render(name, lines, mode, outdir)
