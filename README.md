# sqz

Convert between PNG/APNG, GIF, WebP and AVIF, and squeeze the result as small as it can go.

```sh
npx sqz animation.gif                  # → animation.png (animated APNG)
npx sqz -t webp -m lossy photo.png     # → photo.quantized.webp + photo.lossy.webp
```

The same engine runs on the website at **https://joseprio.github.io/sqz/**. Everything happens in your browser and nothing is uploaded. Pick an output format, and the site produces every version below side by side, with sizes and quality scores, so you can choose which one to download.

## Versions

| Version | What it is | Formats |
| --- | --- | --- |
| **Lossless** | Every visible pixel stays exactly the same. | PNG, WebP, AVIF, GIF (GIF only if the image already fits 256 colours with no partial transparency) |
| **Quantized** | Reduced to a ≤256-colour palette (shared across animation frames), then stored losslessly. | PNG, WebP, GIF |
| **Lossy** | The format's own lossy coding. For PNG that's truecolor lossy filtering, which rounds each pixel's filter prediction error so deflate compresses better. | PNG, WebP, AVIF |

In the CLI, `-m lossless` writes one file and `-m lossy` writes every lossy version as `NAME.quantized.EXT` and `NAME.lossy.EXT`. AVIF has no palette coding, so it has no quantized version; GIF is always a palette, so it has no separate lossy version.

### Quality targets (SSIMULACRA2)

Lossy versions aren't driven by an encoder "quality" number. You choose a target **SSIMULACRA2** score (`-T`, default 80), and sqz searches for the cheapest setting whose output still reaches it: the fewest palette colours, the largest PNG lossy step, or the lowest WebP/AVIF quality.

| Score | Meaning |
| --- | --- |
| 90–100 | Visually indistinguishable |
| 80–90 | Excellent: differences only show when flipping between images or zooming in |
| 70–80 | Generally acceptable |
| 60–70 | Acceptable for web and game assets |
| 50–60 | Noticeable artifacts; fine for previews |
| < 50 | Low quality |

If a version can't reach the target (e.g. a photo in 256 colours), sqz says so and reports the best score it got. Images with transparency are scored on dark and light backgrounds, and the worse score counts. Animations are scored on up to four sample frames, and the worst frame counts.

The SSIMULACRA2 implementation is a TypeScript port of the libjxl reference. It agrees with the Rust `ssimulacra2` crate to within about 0.4 points.

## How it gets small

- **PNG/APNG.** sqz has its own encoder. It picks the smallest exact colour type (palette at 1–8 bits, grayscale at 1–16 bits, `tRNS` keys, alpha dropped when unused), searches filter strategies (fixed, minimum-sum, entropy, Bigrams, BigEnt, brute force at several depths, lossy hints) and palette orders, then recompresses the winners with ECT's zopfli, which matches stock zopfli's size 2–4× faster. Max effort also tries fhanau/zopfli and keeps the smaller stream. Fully transparent pixels take whatever colour each filter predicts.
- **WebP and AVIF.** libwebp (wasm, via jSquash) and sqz's own libavif + libaom wasm build, which supports animated AVIF (image sequences) in both directions, 10/12-bit input, and ICC/EXIF/XMP. Animated WebP is muxed by sqz from per-frame encodes. Lossy AVIF falls back to 4:4:4 when 4:2:0 can't reach the target.
- **Animations** (APNG, WebP, AVIF, GIF). Identical frames are merged and their delays summed.
  For APNG, WebP and GIF, each later frame is also cropped to what changed, and unchanged pixels become transparent wherever that's valid. AVIF sequences use inter-frame prediction instead.
- **Never bigger.** If the input is already a lossless file of the target format and sqz can't beat it, you get the original back (stripped if you asked).

## CLI

```
sqz [options] <file|dir|->...

  -t, --to <format>      png (default) | webp | avif | gif
  -m, --mode <mode>      lossless (default) | lossy (writes the quantized and lossy versions)
  -T, --target <0-100>   lossy: SSIMULACRA2 score to aim for (default 80)
      --no-dither        quantized: map to nearest colour without dithering
      --max              maximum effort: slower, a little smaller
  -s, --strip            remove all metadata (ICC, EXIF, XMP, text, time, …)
  -o, --out <path>       output file (single input), directory, or - for stdout
  -f, --force            overwrite existing files, including the input itself
  -r, --recursive        descend into directories
  -n, --dry-run          report sizes without writing anything
  -j, --jobs <n>         parallel workers; each version of each file is a job (default: CPU count)
      --quiet            only print errors
```

sqz never overwrites existing files, including the input itself, unless you pass `--force`.

```sh
npx sqz -t gif -m lossy clip.webp               # animated WebP → quantized GIF
npx sqz -t avif -m lossy -T 70 -r photos -o out/
npx sqz -f --max *.png                          # recompress PNGs in place
cat in.webp | npx sqz - -o - > out.png
```

## Metadata

By default sqz keeps metadata. PNG output keeps colour information (`iCCP`, `sRGB`, `gAMA`, `cHRM`, `cICP`, …), EXIF, XMP, text and physical size, and converts WebP `ICCP`/`EXIF`/`XMP`, AVIF ICC/CICP/Exif/XMP and GIF comments into their PNG equivalents. WebP and AVIF output keep the ICC profile, EXIF and XMP. GIF output doesn't carry metadata, and sqz warns when something is dropped. `--strip` removes everything. Stripping an ICC profile can change how colours look in colour-managed viewers.

## Library

```js
import { convert } from 'sqz';

const { variants } = await convert(bytes, { format: 'webp', target: 75 });
for (const v of variants) console.log(v.variant, v.size, v.score, v.setting, v.error);
```

`variants` defaults to every version the format supports. Pass `variants: ['lossless']` (or `variantsFor(format, 'lossy')`) to make fewer. The `ssimulacra2(reference, distorted, width, height)` metric is exported too.

Works in Node (20 or later) and in browsers or workers through any bundler that handles `new URL(…, import.meta.url)` assets. `squeeze` is CPU-bound, so run it in a worker when a UI or server has to stay responsive.

## Limitations

- Quantized and lossy versions, and every non-PNG output, work at 8 bits per channel. Only lossless PNG keeps more (16-bit PNG input, and 10/12-bit AVIF input).
- The quality search costs time: each step re-encodes (WebP/AVIF) or re-quantizes the image and scores it.
- Frame delays under 20 ms (GIF) or 10 ms or less (WebP) are set to 100 ms, matching how browsers play them.

## Development

```sh
npm install
npm test             # vitest
npm run build        # CLI + library → dist/
npm run dev:web      # website on http://localhost:5173
npm run build:web    # website → web/dist (deployed to GitHub Pages by .github/workflows/pages.yml)
npm run fixtures     # regenerate test/fixtures (needs Pillow 11.3 or later, and ffmpeg for the 10-bit AVIF)
```

The wasm codecs in `src/wasm/` are built from `codecs/` with pinned versions: libavif/libaom for AVIF, and ECT's zopfli plus fhanau/zopfli for deflate. The output is committed, so you only need this to change a codec, on Linux or WSL, with no root. Third-party licenses are listed in `THIRD_PARTY_NOTICES.md`.

```sh
bash codecs/toolchain.sh     # emsdk, CMake and Ninja into ~/.cache/sqz-toolchain
bash codecs/avif/build.sh    # → src/wasm/sqz_avif.js + .wasm
bash codecs/zopfli/build.sh  # → src/wasm/sqz_zopfli_{ect,fhanau}.js + .wasm
```

Built on [SSIMULACRA2](https://github.com/cloudinary/ssimulacra2) (ported), [zopfli](https://github.com/google/zopfli) as improved in [ECT](https://github.com/fhanau/Efficient-Compression-Tool) and [fhanau/zopfli](https://github.com/fhanau/zopfli) (built for sqz), [libwebp](https://chromium.googlesource.com/webm/libwebp) (via jSquash), [libavif](https://github.com/AOMediaCodec/libavif) + [libaom](https://aomedia.googlesource.com/aom) (built for sqz), [image-q](https://github.com/ibezkrovnyi/image-quantization), [omggif](https://github.com/deanm/omggif) and [fflate](https://github.com/101arrowz/fflate).

MIT © Josep del Rio
