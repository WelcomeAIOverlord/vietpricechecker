#!/usr/bin/env python3
"""Synthesise a benchmark corpus of Vietnamese price signs.

Covers the range the app has to survive in the wild: crisp supermarket labels,
restaurant menus, receipts, backlit signage, and marker-on-cardboard market
prices, each degraded the way a phone photo degrades them (perspective, blur,
glare, uneven light, sensor noise, JPEG).

Everything is seeded, so the corpus is identical on every machine.

Usage:  python3 tools/make_fixtures.py [outdir]     (default: test/fixtures)

Writes the images plus an index.json of expected values for test/ocr-bench.mjs.
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAND_DIR = os.path.join(ROOT, "test", "fonts")

PRINT_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
]
HAND_FONTS = [
    os.path.join(HAND_DIR, n)
    for n in ("Caveat.ttf", "Patrick.ttf", "Indie.ttf", "Permanent.ttf", "Rock.ttf", "Shadows.ttf")
]

W, H = 1000, 700


# --------------------------------------------------------------------------
# degradation effects — what a phone camera does to a flat sign
# --------------------------------------------------------------------------

def perspective(img, rng, amount):
    """Tilt the sign as if photographed off-axis."""
    w, h = img.size
    d = amount * w
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [
        (rng.uniform(0, d), rng.uniform(0, d)),
        (w - rng.uniform(0, d), rng.uniform(0, d)),
        (w - rng.uniform(0, d), h - rng.uniform(0, d)),
        (rng.uniform(0, d), h - rng.uniform(0, d)),
    ]
    # Solve the 8 perspective coefficients mapping dst -> src.
    a = []
    b = []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    coeffs = _solve(a, b)
    return img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(128, 128, 130))


def _solve(a, b):
    """Plain Gaussian elimination — avoids a numpy dependency."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        pv = m[col][col]
        if abs(pv) < 1e-12:
            continue
        for r in range(n):
            if r == col:
                continue
            f = m[r][col] / pv
            for c in range(col, n + 1):
                m[r][c] -= f * m[col][c]
    return [m[i][n] / m[i][i] if abs(m[i][i]) > 1e-12 else 0.0 for i in range(n)]


def uneven_light(img, rng, strength):
    """A soft bright/dark gradient, like a window or a shop lamp to one side."""
    w, h = img.size
    small = Image.new("L", (w // 20, h // 20))
    px = small.load()
    cx, cy = rng.uniform(0, small.width), rng.uniform(0, small.height)
    maxd = math.hypot(small.width, small.height)
    for y in range(small.height):
        for x in range(small.width):
            t = math.hypot(x - cx, y - cy) / maxd
            px[x, y] = int(255 - strength * 255 * t)
    mask = small.resize((w, h), Image.BICUBIC)
    dark = Image.new("RGB", (w, h), (0, 0, 0))
    return Image.composite(img, dark, mask)


def glare(img, rng):
    """A blown-out highlight from a flash or a plastic sleeve."""
    w, h = img.size
    layer = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(layer)
    cx, cy = rng.uniform(w * 0.2, w * 0.8), rng.uniform(h * 0.2, h * 0.8)
    r = rng.uniform(w * 0.10, w * 0.20)
    d.ellipse([cx - r, cy - r * 0.6, cx + r, cy + r * 0.6], fill=190)
    layer = layer.filter(ImageFilter.GaussianBlur(r * 0.45))
    white = Image.new("RGB", (w, h), (255, 255, 255))
    return Image.composite(white, img, layer)


def noise(img, rng, amount):
    px = img.load()
    w, h = img.size
    for _ in range(int(w * h * amount)):
        x, y = rng.randrange(w), rng.randrange(h)
        n = rng.randint(-42, 42)
        r, g, b = px[x, y]
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    return img


def jpeg(img, quality, tmpdir):
    path = os.path.join(tmpdir, "_j.jpg")
    img.save(path, "JPEG", quality=quality)
    out = Image.open(path).convert("RGB")
    os.remove(path)
    return out


# --------------------------------------------------------------------------
# handwriting: per-character jitter on top of a handwriting face
# --------------------------------------------------------------------------

def draw_handwritten(base, text, font, xy, fill, rng, jitter=1.0):
    """Draw text one glyph at a time with rotation/offset wobble."""
    x, y = xy
    for ch in text:
        if ch == " ":
            x += font.size * 0.32
            continue
        box = font.getbbox(ch)
        cw, chh = max(1, box[2] - box[0]), max(1, box[3] - box[1])
        pad = int(font.size * 0.5) + 6
        glyph = Image.new("RGBA", (cw + pad * 2, chh + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(glyph).text((pad - box[0], pad - box[1]), ch, font=font, fill=fill + (255,))
        glyph = glyph.rotate(rng.uniform(-5, 5) * jitter, Image.BICUBIC, expand=False)
        base.alpha_composite(glyph, (int(x - pad), int(y - pad + rng.uniform(-4, 4) * jitter)))
        x += cw + font.size * rng.uniform(0.05, 0.14)
    return x


def marker_stroke(img, rng):
    """Blur then re-threshold so strokes bleed like a felt-tip pen."""
    return img.filter(ImageFilter.GaussianBlur(rng.uniform(0.6, 1.4)))


# --------------------------------------------------------------------------
# scene builders
# --------------------------------------------------------------------------

def scene_printed(lines, bg, fg, rng, align="center"):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    total = sum(sz + 26 for _, sz, _ in lines)
    y = (H - total) / 2
    for text, size, fpath in lines:
        font = ImageFont.truetype(fpath, size)
        box = d.textbbox((0, 0), text, font=font)
        x = (W - (box[2] - box[0])) / 2 - box[0] if align == "center" else W * 0.12
        d.text((x, y), text, font=font, fill=fg)
        y += size + 26
    return img


def scene_handwritten(lines, bg, fg, rng, jitter=1.0):
    img = Image.new("RGBA", (W, H), bg + (255,))
    total = sum(sz + 34 for _, sz, _ in lines)
    y = (H - total) / 2
    for text, size, fpath in lines:
        font = ImageFont.truetype(fpath, size)
        # rough width estimate so the line lands near the middle
        est = sum(max(1, font.getbbox(c)[2] - font.getbbox(c)[0]) + size * 0.09 for c in text)
        draw_handwritten(img, text, font, ((W - est) / 2, y), fg, rng, jitter)
        y += size + 34
    out = img.convert("RGB")
    return marker_stroke(out, rng)


def draw_price_with_superscript_dong(d, xy, price, size, fg, font_path=None):
    """Draw "25.000" followed by a small raised đ, the way menus print it."""
    font = ImageFont.truetype(font_path or PRINT_FONTS[0], size)
    small = ImageFont.truetype(font_path or PRINT_FONTS[0], int(size * 0.52))
    x, y = xy
    d.text((x, y), price, font=font, fill=fg)
    box = d.textbbox((0, 0), price, font=font)
    # Raised to sit against the top of the digits, which is what makes the
    # glyph look like part of the number to a line-based recogniser.
    d.text((x + (box[2] - box[0]) + size * 0.06, y - size * 0.06), "đ", font=small, fill=fg)
    return x + (box[2] - box[0]) + size * 0.5


def scene_superscript_dong(label, price, size, rng):
    """A single white menu row on a blue board, price + raised đ."""
    img = Image.new("RGB", (W, H), (28, 92, 168))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([40, 40, W - 40, H - 40], radius=28, fill=(252, 252, 250))

    name_font = ImageFont.truetype(PRINT_FONTS[0], int(size * 0.72))
    d.text((90, H / 2 - size * 0.95), label, font=name_font, fill=(18, 62, 122))
    d.line([90, H / 2 - size * 0.1, W - 90, H / 2 - size * 0.1], fill=(200, 206, 214), width=2)
    draw_price_with_superscript_dong(d, (90, H / 2 + size * 0.2), price, size, (26, 26, 30))
    return img


def scene_dong_menu(rng):
    """A column of menu rows, every price closed by a raised đ."""
    img = Image.new("RGB", (W, H), (28, 92, 168))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([30, 30, W - 30, H - 30], radius=28, fill=(252, 252, 250))

    head = ImageFont.truetype(PRINT_FONTS[0], 52)
    d.text((70, 60), "CƠM  ·  RICE", font=head, fill=(18, 62, 122))

    rows = [("Sườn nướng", "25.000"), ("Phở bò tái", "30.000"), ("Bánh mì ốp la", "15.000")]
    name_font = ImageFont.truetype(PRINT_FONTS[0], 46)
    y = 175
    for label, price in rows:
        d.text((70, y), label, font=name_font, fill=(26, 26, 30))
        draw_price_with_superscript_dong(d, (W - 320, y - 4), price, 56, (26, 26, 30))
        y += 130
        d.line([70, y - 40, W - 70, y - 40], fill=(206, 212, 220), width=2)
    return img


def cardboard(rng):
    """A muted brown board with fibre speckle."""
    img = Image.new("RGB", (W, H), (198, 170, 132))
    px = img.load()
    for _ in range(W * H // 60):
        x, y = rng.randrange(W), rng.randrange(H)
        n = rng.randint(-24, 18)
        r, g, b = px[x, y]
        px[x, y] = (max(0, r + n), max(0, g + n), max(0, b + n))
    return img


# --------------------------------------------------------------------------
# the corpus
# --------------------------------------------------------------------------

def build(outdir):
    os.makedirs(outdir, exist_ok=True)
    rng = random.Random(20260816)
    index = []

    def add(name, img, expect, category, note, must_include=None):
        path = os.path.join(outdir, name + ".jpg")
        img.convert("RGB").save(path, "JPEG", quality=88)
        index.append({
            "file": name + ".jpg",
            "expect": expect,
            "mustInclude": must_include or [],
            "category": category,
            "note": note,
        })

    sans = PRINT_FONTS[0]

    # ---- 1. clean printed price tags -----------------------------------
    clean = [
        ("print_tag_120k", [("Cà phê sữa đá", 46, sans), ("120.000 đ", 104, sans)], 120000),
        ("print_tag_35k", [("Bánh mì thịt", 46, PRINT_FONTS[3]), ("35.000đ", 100, PRINT_FONTS[3])], 35000),
        ("print_tag_vnd", [("Áo thun cotton", 44, PRINT_FONTS[2]), ("250.000 VNĐ", 88, PRINT_FONTS[2])], 250000),
        ("print_tag_comma", [("Nón lá", 44, sans), ("85,000 VND", 92, sans)], 85000),
        ("print_tag_space", [("Trà đá", 44, sans), ("10 000 ₫", 96, sans)], 10000),
        ("print_tag_million", [("Áo dài lụa", 44, sans), ("1.250.000 đ", 84, sans)], 1250000),
        ("print_tag_mono", [("SIM 4G", 44, PRINT_FONTS[5]), ("199.000d", 88, PRINT_FONTS[5])], 199000),
        ("print_tag_prefix", [("Giá: 45.000 đ", 88, sans)], 45000),
    ]
    for name, lines, expect in clean:
        img = scene_printed(lines, (250, 248, 243), (22, 22, 26), rng)
        add(name, img, expect, "printed-clean", "flat, well lit")

    # ---- 2. shorthand notation -----------------------------------------
    shorthand = [
        ("short_35k", [("Bún bò", 46, sans), ("35k", 128, sans)], 35000),
        ("short_120k", [("Combo", 46, sans), ("120K", 124, sans)], 120000),
        ("short_1tr2", [("Vòng tay bạc", 44, sans), ("1tr2", 120, sans)], 1200000),
        ("short_15tr", [("Xe máy cũ", 44, sans), ("15 triệu", 92, sans)], 15000000),
        ("short_nghin", [("Kẹo dừa", 44, sans), ("25 nghìn", 88, sans)], 25000),
    ]
    for name, lines, expect in shorthand:
        img = scene_printed(lines, (252, 250, 246), (20, 20, 24), rng)
        add(name, img, expect, "printed-shorthand", "k / triệu shorthand")

    # ---- 3. menus (several prices; every one must be found) ------------
    menu_lines = [
        ("THỰC ĐƠN", 44, sans),
        ("Phở bò tái          65.000", 46, sans),
        ("Bún chả Hà Nội      55.000", 46, sans),
        ("Cà phê sữa đá       25.000", 46, sans),
        ("Bia Hà Nội          20.000", 46, sans),
    ]
    add("menu_printed", scene_printed(menu_lines, (252, 251, 247), (18, 18, 22), rng, align="left"),
        65000, "menu", "four prices in a column", [65000, 55000, 25000, 20000])

    menu2 = [
        ("Cơm tấm sườn     45k", 50, PRINT_FONTS[2]),
        ("Cơm gà xối mỡ    50k", 50, PRINT_FONTS[2]),
        ("Canh chua        30k", 50, PRINT_FONTS[2]),
    ]
    add("menu_k_notation", scene_printed(menu2, (250, 249, 245), (20, 20, 24), rng, align="left"),
        50000, "menu", "k notation menu", [45000, 50000, 30000])

    # ---- 4. receipt ------------------------------------------------------
    receipt = [
        ("SIEU THI COOP", 40, PRINT_FONTS[5]),
        ("Sua tuoi 1L        32.000", 38, PRINT_FONTS[5]),
        ("Banh mi            15.000", 38, PRINT_FONTS[5]),
        ("Nuoc mam           48.500", 38, PRINT_FONTS[5]),
        ("TONG CONG          95.500", 42, PRINT_FONTS[5]),
    ]
    img = scene_printed(receipt, (247, 246, 242), (40, 40, 44), rng, align="left")
    img = uneven_light(img, rng, 0.30)
    add("receipt_thermal", img, 95500, "receipt", "low-contrast thermal print", [32000, 15000, 48500, 95500])

    # ---- 5. hard printed: tilt, blur, glare, dark signage ---------------
    base = scene_printed([("Nem nướng", 46, sans), ("75.000 đ", 100, sans)], (250, 248, 243), (22, 22, 26), rng)
    add("hard_perspective", perspective(base, rng, 0.10), 75000, "printed-hard", "photographed off-axis")

    base = scene_printed([("Chả giò", 46, sans), ("60.000 đ", 100, sans)], (250, 248, 243), (22, 22, 26), rng)
    add("hard_blur", base.filter(ImageFilter.GaussianBlur(2.1)), 60000, "printed-hard", "soft focus")

    base = scene_printed([("Sinh tố bơ", 46, sans), ("40.000 đ", 100, sans)], (250, 248, 243), (22, 22, 26), rng)
    add("hard_glare", glare(base, rng), 40000, "printed-hard", "flash glare")

    base = scene_printed([("KHUYẾN MÃI", 44, sans), ("250.000 VNĐ", 88, sans)], (16, 16, 20), (242, 242, 246), rng)
    add("hard_dark_sign", base, 250000, "printed-hard", "light text on a dark sign")

    base = scene_printed([("Trà sữa", 44, sans), ("45.000đ", 96, sans)], (238, 236, 231), (108, 108, 116), rng)
    add("hard_low_contrast", base, 45000, "printed-hard", "faded grey on grey")

    base = scene_printed([("Bánh xèo", 46, sans), ("55.000 đ", 100, sans)], (250, 248, 243), (22, 22, 26), rng)
    base = base.rotate(-7, Image.BICUBIC, fillcolor=(240, 238, 234))
    add("hard_rotated", base, 55000, "printed-hard", "sign rotated 7 degrees")

    base = scene_printed([("Xoài cát", 46, sans), ("65.000 /kg", 92, sans)], (250, 248, 243), (22, 22, 26), rng)
    base = noise(uneven_light(base, rng, 0.42), rng, 0.06)
    add("hard_night_noise", base, 65000, "printed-hard", "dim light, sensor noise, per-kg price")

    base = scene_printed([("Combo gia đình", 42, sans), ("399.000 VND", 84, sans)], (250, 248, 243), (22, 22, 26), rng)
    base = perspective(base.filter(ImageFilter.GaussianBlur(1.1)), rng, 0.07)
    add("hard_combo", jpeg(base, 45, outdir), 399000, "printed-hard", "tilted, soft, heavy JPEG")

    # ---- 6. handwritten --------------------------------------------------
    hand = [
        ("hand_marker_50k", [("50.000", 130, HAND_FONTS[3])], 50000, (250, 249, 244), (18, 18, 22), 0.8),
        ("hand_marker_120k", [("120.000đ", 108, HAND_FONTS[3])], 120000, (252, 250, 245), (16, 16, 20), 0.8),
        ("hand_patrick_35k", [("35k", 150, HAND_FONTS[1])], 35000, (250, 248, 244), (20, 20, 60), 0.9),
        ("hand_patrick_tag", [("Xoai", 70, HAND_FONTS[1]), ("45.000", 116, HAND_FONTS[1])], 45000, (250, 248, 244), (20, 20, 24), 0.9),
        ("hand_caveat_80k", [("80.000 d", 120, HAND_FONTS[0])], 80000, (252, 251, 247), (24, 24, 70), 1.0),
        ("hand_indie_25k", [("25.000", 126, HAND_FONTS[2])], 25000, (251, 249, 245), (22, 22, 26), 1.0),
        ("hand_shadows_1tr", [("1tr2", 140, HAND_FONTS[5])], 1200000, (250, 249, 246), (20, 20, 24), 1.0),
        ("hand_rock_60k", [("60.000", 116, HAND_FONTS[4])], 60000, (250, 248, 243), (18, 18, 22), 0.7),
    ]
    for name, lines, expect, bg, fg, jitter in hand:
        img = scene_handwritten(lines, bg, fg, rng, jitter)
        add(name, img, expect, "handwritten", "hand-lettered on paper")

    # cardboard market signs — the classic street-stall case
    for name, text, expect, font in [
        ("hand_cardboard_30k", "30.000", 30000, HAND_FONTS[3]),
        ("hand_cardboard_15k", "15k", 15000, HAND_FONTS[3]),
        ("hand_cardboard_200k", "200.000", 200000, HAND_FONTS[1]),
    ]:
        board = cardboard(rng).convert("RGBA")
        font_obj = ImageFont.truetype(font, 140)
        est = sum(max(1, font_obj.getbbox(c)[2] - font_obj.getbbox(c)[0]) + 140 * 0.09 for c in text)
        draw_handwritten(board, text, font_obj, ((W - est) / 2, H / 2 - 90), (18, 18, 22), rng, 0.8)
        img = marker_stroke(board.convert("RGB"), rng)
        add(name, img, expect, "handwritten", "marker on cardboard")

    # chalk on a blackboard — light on dark, the invert path
    board = Image.new("RGBA", (W, H), (26, 32, 28, 255))
    font_obj = ImageFont.truetype(HAND_FONTS[1], 120)
    text = "40.000 d"
    est = sum(max(1, font_obj.getbbox(c)[2] - font_obj.getbbox(c)[0]) + 120 * 0.09 for c in text)
    draw_handwritten(board, text, font_obj, ((W - est) / 2, H / 2 - 70), (238, 240, 236), rng, 0.9)
    add("hand_chalkboard_40k", marker_stroke(board.convert("RGB"), rng), 40000, "handwritten", "chalk on a blackboard")

    # handwritten, photographed badly
    board = cardboard(rng).convert("RGBA")
    font_obj = ImageFont.truetype(HAND_FONTS[3], 150)
    text = "70.000"
    est = sum(max(1, font_obj.getbbox(c)[2] - font_obj.getbbox(c)[0]) + 150 * 0.09 for c in text)
    draw_handwritten(board, text, font_obj, ((W - est) / 2, H / 2 - 95), (16, 16, 20), rng, 0.8)
    img = perspective(marker_stroke(board.convert("RGB"), rng), rng, 0.08)
    add("hand_cardboard_tilted", uneven_light(img, rng, 0.30), 70000, "handwritten", "cardboard, tilted and dim")

    # ---- 7. negatives: nothing here is a price --------------------------
    for name, lines, note in [
        ("neg_phone", [("Liên hệ", 46, sans), ("0987 654 321", 76, sans)], "phone number"),
        ("neg_date", [("Hạn dùng", 46, sans), ("16/08/2026", 80, sans)], "expiry date"),
        ("neg_weight", [("Khối lượng tịnh", 44, sans), ("500 g", 88, sans)], "net weight"),
        ("neg_hours", [("Mở cửa", 46, sans), ("08:00 - 22:00", 72, sans)], "opening hours"),
    ]:
        add(name, scene_printed(lines, (250, 248, 243), (22, 22, 26), rng), None, "negative", note)

    # ---- 8. the superscript đồng sign -----------------------------------
    # Printed menus set "đ" small and raised right after the price. Tesseract
    # reads that glyph as a digit — usually 4 — which silently multiplies the
    # price by ten and adds four. Reported from a real Phở Hà Nội menu board.
    for name, label, price, size, expect in [
        ("dong_super_25k", "Sườn nướng", "25.000", 74, 25000),
        ("dong_super_30k", "Phở bò", "30.000", 88, 30000),
        ("dong_super_15k", "Bánh mì ốp la", "15.000", 74, 15000),
        ("dong_super_8k", "Cà phê đen", "8.000", 74, 8000),
        ("dong_super_120k", "Lẩu thập cẩm", "120.000", 74, 120000),
    ]:
        add(name, scene_superscript_dong(label, price, size, rng), expect,
            "currency-glyph", "đồng sign set small and raised")

    # The same board with a whole column of them, as photographed.
    add("dong_super_menu", scene_dong_menu(rng), 25000, "currency-glyph",
        "menu column with raised đồng signs",
        [25000, 30000, 15000])

    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    by_cat = {}
    for row in index:
        by_cat[row["category"]] = by_cat.get(row["category"], 0) + 1
    print("wrote", len(index), "fixtures to", outdir)
    for k, v in sorted(by_cat.items()):
        print(f"  {k:18s} {v}")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "test", "fixtures"))
