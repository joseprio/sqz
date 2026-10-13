# Third-party notices

sqz is MIT licensed. It bundles WebAssembly builds of the following projects, compiled from
the sources and versions pinned in `codecs/`:

| Component | Used for | License |
| --- | --- | --- |
| [libavif](https://github.com/AOMediaCodec/libavif) v1.4.1 | AVIF encode/decode (`src/wasm/sqz_avif.*`) | BSD-2-Clause |
| [libaom](https://aomedia.googlesource.com/aom) v3.15.1 | AV1 codec for AVIF | BSD-2-Clause, plus the [AOMedia Patent License 1.0](https://aomedia.org/license/patent-license/) |
| [Efficient Compression Tool](https://github.com/fhanau/Efficient-Compression-Tool) (zopfli, commit e711c5e) | deflate (`src/wasm/sqz_zopfli_ect.*`) | Apache-2.0 |
| 7-Zip LzFind (as modified in ECT) | match finder for ECT's zopfli | Public domain |
| zlib (adler32, as bundled in ECT) | zlib checksum | zlib License |
| [fhanau/zopfli](https://github.com/fhanau/zopfli) (commit 3315c43) | deflate at max effort (`src/wasm/sqz_zopfli_fhanau.*`) | Apache-2.0 |

npm dependencies (installed separately, each under its own license): `@jsquash/webp`
(Apache-2.0, libwebp under BSD-3-Clause), `image-q` (MIT), `omggif` (MIT), `fflate` (MIT).
