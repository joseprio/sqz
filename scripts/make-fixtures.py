"""Generate small test images for every supported input flavour (needs Pillow >= 11.3)."""
import math, os, random
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
os.makedirs(OUT, exist_ok=True)
random.seed(1)

def photo(w=96, h=64, alpha=False):
    im = Image.new('RGBA', (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            r = int(128 + 100 * math.sin(x / 9) + random.randint(-12, 12))
            g = int(128 + 100 * math.cos(y / 7) + random.randint(-12, 12))
            b = int((x * 2 + y * 3) % 256)
            a = 255 if not alpha else max(0, min(255, int(255 - abs(x - w / 2) * 6)))
            px[x, y] = (max(0, min(255, r)), max(0, min(255, g)), b, a)
    return im

def frames(n=6, w=64, h=48, mode='RGBA'):
    out = []
    for i in range(n):
        im = Image.new(mode, (w, h), (30, 60, 90, 255) if mode == 'RGBA' else (30, 60, 90))
        d = ImageDraw.Draw(im)
        d.ellipse([i * 8, 10, i * 8 + 20, 30], fill=(250, 200, 20, 255) if mode == 'RGBA' else (250, 200, 20))
        d.rectangle([2, 2, 12, 12], fill=(200, 30, 30, 255) if mode == 'RGBA' else (200, 30, 30))
        out.append(im)
    return out

p = photo()
p.convert('RGB').save(f'{OUT}/photo.png')
photo(alpha=True).save(f'{OUT}/photo-alpha.png')
p.convert('RGB').save(f'{OUT}/photo-interlaced.png', interlace=1)
p.convert('L').save(f'{OUT}/gray.png')
Image.linear_gradient('L').resize((64, 64)).point(lambda v: v // 17 * 17).save(f'{OUT}/gray4.png')
p.convert('P', palette=Image.ADAPTIVE, colors=12).save(f'{OUT}/palette.png')
Image.fromarray if False else None
# 16-bit grayscale with real 16-bit precision
g16 = Image.new('I;16', (40, 30))
g16.putdata([(x * 1601 + y * 37) % 65536 for y in range(30) for x in range(40)])
g16.save(f'{OUT}/gray16.png')

fr = frames()
fr[0].save(f'{OUT}/anim.gif', save_all=True, append_images=fr[1:], duration=80, loop=0, disposal=1)
fr[0].save(f'{OUT}/anim.png', save_all=True, append_images=fr[1:], duration=80, loop=0)
fr[0].save(f'{OUT}/anim.webp', save_all=True, append_images=fr[1:], duration=80, loop=0, lossless=True)
fr[0].save(f'{OUT}/anim-lossy.webp', save_all=True, append_images=fr[1:], duration=80, loop=0, quality=80)
# transparent animated GIF using disposal to background
tf = []
for i in range(4):
    im = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle([i * 6, 8, i * 6 + 8, 16], fill=(0, 128, 255, 255))
    tf.append(im)
tf[0].save(f'{OUT}/anim-transparent.gif', save_all=True, append_images=tf[1:], duration=100, loop=3, disposal=2)

p.convert('RGB').save(f'{OUT}/photo.webp', quality=85)
photo(alpha=True).save(f'{OUT}/photo-alpha.webp', lossless=True)
p.convert('RGB').save(f'{OUT}/photo.avif', quality=80)
photo(alpha=True).save(f'{OUT}/photo-alpha.avif', quality=80)
print('fixtures written to', os.path.abspath(OUT))

# A smooth, photo-like image (gradients, soft shapes, mild noise) for quality-target tests.
from PIL import ImageFilter
nat = Image.new('RGB', (128, 96))
px = nat.load()
for y in range(96):
    for x in range(128):
        px[x, y] = (int(90 + 80 * math.sin(x / 23) + y / 3), int(120 + 60 * math.cos(y / 17)), int(160 - x / 2 + 30 * math.sin((x + y) / 15)))
d = ImageDraw.Draw(nat)
d.ellipse([20, 20, 70, 70], fill=(230, 180, 60))
d.rectangle([80, 40, 120, 90], fill=(40, 90, 160))
d.line([0, 90, 128, 10], fill=(250, 250, 250), width=3)
nat = nat.filter(ImageFilter.GaussianBlur(1.2))
px = nat.load()
for y in range(96):
    for x in range(128):
        r, g, b = px[x, y]
        n = random.randint(-4, 4)
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
nat.save(f'{OUT}/natural.png')
print('natural.png written')

# 10-bit AVIF for high-bit-depth decoding. Pillow ignores bit_depth, so this uses ffmpeg's libaom.
import shutil, subprocess
if shutil.which('ffmpeg'):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', f'{OUT}/photo.png', '-c:v', 'libaom-av1',
                    '-pix_fmt', 'yuv444p10le', '-still-picture', '1', '-crf', '10', '-cpu-used', '6', f'{OUT}/photo-10bit.avif'], check=True)
    print('photo-10bit.avif written')
else:
    print('ffmpeg not found; photo-10bit.avif not regenerated')

# JPEG and HDR fixtures.
import runpy
runpy.run_path(os.path.join(os.path.dirname(__file__), 'make-hdr-fixtures.py'))
