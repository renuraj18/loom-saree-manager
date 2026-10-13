# Usage: python3 scripts/build-logo.py "public/Thari Logo.png" public/img   (needs Pillow)
# Builds the web logo/icon set in public/img from the transparent master logo.
import sys, os
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
im = im.crop(im.getbbox())                      # trim empty margins
W, H = im.size
def save_png(img, name, colors=None):
    p = os.path.join(out, name)
    if colors:  # palette PNG keeps alpha and is much smaller
        img.quantize(colors=colors, method=Image.Quantize.FASTOCTREE).save(p, optimize=True)
    else:
        img.save(p, optimize=True)
    return p
for w in (640, 1280):
    save_png(im.resize((w, round(H * w / W)), Image.LANCZOS), f"thari-logo-{w}.png", colors=256)
# Emblem = the loom circle on the left; its width is about the full height.
side = round(H * 1.14)  # include the leaves on the right of the ring
mark = im.crop((0, 0, side, side))
mark = mark.crop(mark.getbbox())
m = max(mark.size); pad = round(m * 0.06)
sq = Image.new("RGBA", (m + 2 * pad, m + 2 * pad), (0, 0, 0, 0))
sq.paste(mark, ((sq.width - mark.width) // 2, (sq.height - mark.height) // 2), mark)
save_png(sq.resize((64, 64), Image.LANCZOS), "thari-icon-64.png")
# Home-screen and app icons need a solid background (iOS shows transparency as black).
white = Image.new("RGBA", sq.size, (255, 255, 255, 255)); white.alpha_composite(sq)
save_png(white.resize((180, 180), Image.LANCZOS).convert("RGB"), "thari-icon-180.png")
save_png(white.resize((512, 512), Image.LANCZOS).convert("RGB"), "thari-icon-512.png")
sq.save(os.path.join(out, "thari.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
for f in sorted(os.listdir(out)):
    p = os.path.join(out, f); i = Image.open(p)
    print(f"{f:22} {i.size[0]}x{i.size[1]} {i.mode:5} {os.path.getsize(p)//1024} KB")
