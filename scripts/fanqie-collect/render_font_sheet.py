# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools", "pillow"]
# ///
"""render_font_sheet.py —— 把番茄混淆字体的 PUA 码点逐个渲染成字形表 PNG，供人工识读建映射表。

用法：uv run render_font_sheet.py <font.otf> <out_dir>
产物：<out_dir>/font-sheet-N.png（每张 10×10 格，格内大字形+PUA 码点标签）
后续：识读后把「码点=真字」对写进 font-map.json（decode.py 消费）。
"""
import sys
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

font_path, out_dir = sys.argv[1], sys.argv[2]

font = TTFont(font_path)
cmap = font.getBestCmap()
pua_sorted = sorted(cp for cp in cmap if 0xE000 <= cp <= 0xF8FF)
print(f"PUA entries: {len(pua_sorted)}", file=sys.stderr)

COLS, ROWS = 10, 10
CELL = 110
GLYPH_SIZE = 72
PER_SHEET = COLS * ROWS

glyph_font = ImageFont.truetype(font_path, GLYPH_SIZE)
label_font = ImageFont.load_default(16)

for sheet_idx in range(0, len(pua_sorted), PER_SHEET):
    chunk = pua_sorted[sheet_idx : sheet_idx + PER_SHEET]
    img = Image.new("RGB", (COLS * CELL, ROWS * CELL), "white")
    draw = ImageDraw.Draw(img)
    for i, cp in enumerate(chunk):
        col, row = i % COLS, i // COLS
        x0, y0 = col * CELL, row * CELL
        draw.rectangle([x0, y0, x0 + CELL - 1, y0 + CELL - 1], outline="#cccccc")
        ch = chr(cp)
        bbox = draw.textbbox((0, 0), ch, font=glyph_font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.text(
            (x0 + (CELL - w) / 2 - bbox[0], y0 + (CELL - 24 - h) / 2 - bbox[1] + 4),
            ch, font=glyph_font, fill="black",
        )
        label = f"{cp:04X}"
        lb = draw.textbbox((0, 0), label, font=label_font)
        draw.text((x0 + (CELL - (lb[2] - lb[0])) / 2, y0 + CELL - 20), label, font=label_font, fill="#666666")
    out = f"{out_dir}/font-sheet-{sheet_idx // PER_SHEET}.png"
    img.save(out)
    print(out, file=sys.stderr)
