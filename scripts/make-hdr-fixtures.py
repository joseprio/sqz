"""JPEG and HDR test images (needs Pillow >= 11.3). Run on its own or from make-fixtures.py.

hdr-pq.png      16-bit BT.2020 PQ PNG (cICP) with highlights up to 1000 nits
ultrahdr.jpg    Ultra HDR JPEG built by hand: SDR base, grey gain map, hdrgm XMP, MPF index
photo.jpg       plain JPEG
rotated.jpg     JPEG stored sideways with EXIF orientation 6 (rotate 90° clockwise)
"""
import io, math, os, struct, zlib
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
W, H = 96, 64
SDR_WHITE = 203.0


def scene(x, y):
    """Linear light in nits, BT.2020 primaries: a coloured gradient, a bright sun, a vivid green patch."""
    r = 40 + 120 * x / W
    g = 60 + 80 * y / H
    b = 120 - 60 * x / W
    d = math.hypot(x - 70, y - 20)
    sun = 900 * math.exp(-(d / 9) ** 2)
    r, g, b = r + sun, g + sun * 0.95, b + sun * 0.8
    if 8 <= x < 28 and 36 <= y < 56:
        r, g, b = 10, 150, 10
    return r, g, b


def pq(nits):
    m1, m2, c1, c2, c3 = 0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875
    y = max(0.0, nits / 10000) ** m1
    return ((c1 + c2 * y) / (1 + c3 * y)) ** m2


def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)


rows = b''
peak = 0
for y in range(H):
    row = b'\0'
    for x in range(W):
        c = scene(x, y)
        peak = max(peak, *c)
        row += struct.pack('>HHH', *(round(pq(v) * 65535) for v in c))
    rows += row
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 16, 2, 0, 0, 0))
png += chunk(b'cICP', bytes([9, 16, 0, 1])) + chunk(b'cLLI', struct.pack('>II', round(peak * 10000), 0))
png += chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')
open(f'{OUT}/hdr-pq.png', 'wb').write(png)

# BT.2020 → BT.709, both linear.
M = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]]
srgb = lambda v: 255 * (12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055)

base = Image.new('RGB', (W, H))
gain = Image.new('L', (W, H))
MAX_LOG2 = math.log2(1000 / SDR_WHITE)
OFFSET = 1 / 64
for y in range(H):
    for x in range(W):
        c = [v / SDR_WHITE for v in scene(x, y)]
        lin = [sum(M[i][k] * c[k] for k in range(3)) for i in range(3)]
        sdr = [min(1.0, max(0.0, v)) for v in lin]
        base.putpixel((x, y), tuple(round(srgb(v)) for v in sdr))
        hy = 0.2627 * c[0] + 0.678 * c[1] + 0.0593 * c[2]
        sy = 0.2126 * sdr[0] + 0.7152 * sdr[1] + 0.0722 * sdr[2]
        g = math.log2((hy + OFFSET) / (sy + OFFSET))
        gain.putpixel((x, y), round(255 * min(1.0, max(0.0, g / MAX_LOG2))))

gm_xmp = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
          '<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" '
          f'hdrgm:GainMapMin="0" hdrgm:GainMapMax="{MAX_LOG2:.6f}" hdrgm:Gamma="1" hdrgm:OffsetSDR="{OFFSET}" '
          f'hdrgm:OffsetHDR="{OFFSET}" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="{MAX_LOG2:.6f}" '
          'hdrgm:BaseRenditionIsHDR="False"/></rdf:RDF></x:xmpmeta>')
buf = io.BytesIO()
gain.save(buf, 'JPEG', quality=95, xmp=gm_xmp.encode())
gm_jpeg = buf.getvalue()

primary_xmp = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
               '<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" '
               'xmlns:Container="http://ns.google.com/photos/1.0/container/" '
               'xmlns:Item="http://ns.google.com/photos/1.0/container/item/" hdrgm:Version="1.0">'
               '<Container:Directory><rdf:Seq>'
               '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>'
               f'<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="{len(gm_jpeg)}"/></rdf:li>'
               '</rdf:Seq></Container:Directory></rdf:Description>'
               '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>sqz fixtures</rdf:li></rdf:Seq></dc:creator></rdf:Description>'
               '</rdf:RDF></x:xmpmeta>')
buf = io.BytesIO()
base.save(buf, 'JPEG', quality=92, xmp=primary_xmp.encode())
primary = buf.getvalue()

# MPF index, inserted right after SOI; offsets count from its TIFF header.
mpf_len = 2 + 4 + 82
tiff_at = 2 + 4 + 4
primary_size = len(primary) + 4 + 4 + 82
tiff = b'MM\0*' + struct.pack('>I', 8) + struct.pack('>H', 3)
tiff += struct.pack('>HHI', 0xB000, 7, 4) + b'0100'
tiff += struct.pack('>HHII', 0xB001, 4, 1, 2)
tiff += struct.pack('>HHII', 0xB002, 7, 32, 50) + struct.pack('>I', 0)
tiff += struct.pack('>IIIHH', 0x030000, primary_size, 0, 0, 0)
tiff += struct.pack('>IIIHH', 0, len(gm_jpeg), primary_size - tiff_at, 0, 0)
mpf = b'\xff\xe2' + struct.pack('>H', mpf_len) + b'MPF\0' + tiff
open(f'{OUT}/ultrahdr.jpg', 'wb').write(primary[:2] + mpf + primary[2:] + gm_jpeg)

photo = Image.open(f'{OUT}/natural.png').convert('RGB')
photo.save(f'{OUT}/photo.jpg', quality=90)

side = Image.new('RGB', (48, 32), (20, 40, 200))
side.paste((220, 30, 30), (0, 0, 12, 8))  # red marker in the stored top-left corner
exif = Image.Exif()
exif[0x0112] = 6
side.save(f'{OUT}/rotated.jpg', quality=95, exif=exif)
print('JPEG and HDR fixtures written')
