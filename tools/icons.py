#!/usr/bin/env python3
"""Generate app icons into src/public/icons/: the "I/L" mark (ink I and L, accent slash) on the app's off-white.
Run once, or after changing the mark: python3 tools/icons.py"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

BG, INK, ACC = (244, 244, 242), (17, 17, 17), (43, 75, 255)
FONT = '/usr/share/fonts/opentype/inter/Inter-Bold.otf'
out = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'public' / 'icons'
out.mkdir(parents=True, exist_ok=True)

def mark(size, scale):
    """scale: share of the canvas the mark's height takes (smaller for maskable safe zone)."""
    big = size * 4                                  # draw large, downsample for clean edges
    im = Image.new('RGB', (big, big), BG)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, int(big * scale))
    parts = [('I', INK), ('/', ACC), ('L', INK)]
    gap = int(big * 0.012)
    widths = [d.textbbox((0, 0), t, font=f)[2] - d.textbbox((0, 0), t, font=f)[0] for t, _ in parts]
    total = sum(widths) + gap * (len(parts) - 1)
    top, bottom = d.textbbox((0, 0), 'IL', font=f)[1], d.textbbox((0, 0), 'IL', font=f)[3]
    y = (big - (bottom - top)) // 2 - top
    x = (big - total) // 2
    for (t, col), w in zip(parts, widths):
        bx = d.textbbox((0, 0), t, font=f)[0]
        d.text((x - bx, y), t, font=f, fill=col)
        x += w + gap
    return im.resize((size, size), Image.LANCZOS)

for name, size, scale in [('icon-192.png', 192, 0.46), ('icon-512.png', 512, 0.46),
                          ('apple-touch-icon.png', 180, 0.46), ('maskable-512.png', 512, 0.34),
                          ('favicon-32.png', 32, 0.56)]:
    mark(size, scale).save(out / name, optimize=True)
    print('wrote', out / name)
