// AVIF codec for sqz: libavif + libaom compiled to wasm with embind.
// Unlike the usual still-image builds, this exposes image sequences (animated AVIF)
// in both directions, carries ICC / EXIF / XMP metadata, high bit depths, CICP colour
// signalling and ISO 21496-1 gain maps, and exposes libavif's gain map maths.
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <cstring>
#include <string>

#include "avif/avif.h"

using namespace emscripten;

namespace {

val bytes(const uint8_t* data, size_t size) {
  // Copy out of wasm memory: the view would dangle once libavif frees the buffer.
  return val(typed_memory_view(size, data)).call<val>("slice");
}

val words(const uint16_t* data, size_t count) { return val(typed_memory_view(count, data)).call<val>("slice"); }

val error(const char* stage, avifResult r, const avifDiagnostics* diag = nullptr) {
  val out = val::object();
  std::string msg = std::string(stage) + ": " + avifResultToString(r);
  if (diag && diag->error[0]) msg += std::string(" (") + diag->error + ")";
  out.set("error", msg);
  return out;
}

const uint8_t* ptr(const std::string& s) { return reinterpret_cast<const uint8_t*>(s.data()); }

val triple(const avifSignedFraction* f) {
  val a = val::array();
  for (int c = 0; c < 3; ++c) a.call<void>("push", f[c].d ? static_cast<double>(f[c].n) / f[c].d : 0.0);
  return a;
}

val triple(const avifUnsignedFraction* f) {
  val a = val::array();
  for (int c = 0; c < 3; ++c) a.call<void>("push", f[c].d ? static_cast<double>(f[c].n) / f[c].d : 0.0);
  return a;
}

double toDouble(avifUnsignedFraction f) { return f.d ? static_cast<double>(f.n) / f.d : 0.0; }

/** Gain map pixels as RGBA8 (grey maps have R = G = B) plus metadata, for JS. */
val gainMapToJs(const avifGainMap* gm) {
  avifImage* img = gm->image;
  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, img);
  rgb.format = AVIF_RGB_FORMAT_RGBA;
  rgb.depth = 8;
  if (avifRGBImageAllocatePixels(&rgb) != AVIF_RESULT_OK || avifImageYUVToRGB(img, &rgb) != AVIF_RESULT_OK) {
    avifRGBImageFreePixels(&rgb);
    return val::null();
  }
  val out = val::object();
  out.set("width", img->width);
  out.set("height", img->height);
  out.set("channels", img->yuvFormat == AVIF_PIXEL_FORMAT_YUV400 ? 1 : 3);
  out.set("data", bytes(rgb.pixels, rgb.rowBytes * rgb.height));
  avifRGBImageFreePixels(&rgb);
  out.set("min", triple(gm->gainMapMin));
  out.set("max", triple(gm->gainMapMax));
  out.set("gamma", triple(gm->gainMapGamma));
  out.set("baseOffset", triple(gm->baseOffset));
  out.set("alternateOffset", triple(gm->alternateOffset));
  out.set("baseHdrHeadroom", toDouble(gm->baseHdrHeadroom));
  out.set("alternateHdrHeadroom", toDouble(gm->alternateHdrHeadroom));
  out.set("useBaseColorSpace", gm->useBaseColorSpace == AVIF_TRUE);
  if (gm->altICC.size) out.set("altIcc", bytes(gm->altICC.data, gm->altICC.size));
  out.set("altPrimaries", static_cast<int>(gm->altColorPrimaries));
  out.set("altTransfer", static_cast<int>(gm->altTransferCharacteristics));
  out.set("altDepth", gm->altDepth);
  out.set("altPlaneCount", gm->altPlaneCount);
  return out;
}

/**
 * Build an avifGainMap from its JS form. `image` is RGBA8; a 1-channel map becomes a
 * monochrome image. Returns nullptr when the metadata cannot be represented.
 */
avifGainMap* gainMapFromJs(val js, bool lossless) {
  avifGainMap* gm = avifGainMapCreate();
  if (!gm) return nullptr;
  const int w = js["width"].as<int>();
  const int h = js["height"].as<int>();
  const bool grey = js["channels"].as<int>() == 1;
  gm->image = avifImageCreate(w, h, 8, grey ? AVIF_PIXEL_FORMAT_YUV400 : AVIF_PIXEL_FORMAT_YUV444);
  gm->image->colorPrimaries = AVIF_COLOR_PRIMARIES_UNSPECIFIED;
  gm->image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_UNSPECIFIED;
  // Identity keeps an RGB map exact when lossless; a grey map is the same under any matrix.
  gm->image->matrixCoefficients = lossless && !grey ? AVIF_MATRIX_COEFFICIENTS_IDENTITY : AVIF_MATRIX_COEFFICIENTS_BT601;
  gm->image->yuvRange = AVIF_RANGE_FULL;

  std::string px = js["data"].as<std::string>();
  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, gm->image);
  rgb.format = AVIF_RGB_FORMAT_RGBA;
  rgb.depth = 8;
  rgb.ignoreAlpha = AVIF_TRUE;
  rgb.pixels = reinterpret_cast<uint8_t*>(px.data());
  rgb.rowBytes = w * 4;
  bool ok = avifImageRGBToYUV(gm->image, &rgb) == AVIF_RESULT_OK;

  for (int c = 0; c < 3 && ok; ++c) {
    ok = avifDoubleToSignedFraction(js["min"][c].as<double>(), &gm->gainMapMin[c]) &&
         avifDoubleToSignedFraction(js["max"][c].as<double>(), &gm->gainMapMax[c]) &&
         avifDoubleToUnsignedFraction(js["gamma"][c].as<double>(), &gm->gainMapGamma[c]) &&
         avifDoubleToSignedFraction(js["baseOffset"][c].as<double>(), &gm->baseOffset[c]) &&
         avifDoubleToSignedFraction(js["alternateOffset"][c].as<double>(), &gm->alternateOffset[c]);
  }
  ok = ok && avifDoubleToUnsignedFraction(js["baseHdrHeadroom"].as<double>(), &gm->baseHdrHeadroom) &&
       avifDoubleToUnsignedFraction(js["alternateHdrHeadroom"].as<double>(), &gm->alternateHdrHeadroom);
  gm->useBaseColorSpace = js["useBaseColorSpace"].as<bool>() ? AVIF_TRUE : AVIF_FALSE;
  if (ok && js["altIcc"].as<bool>()) {
    std::string icc = js["altIcc"].as<std::string>();
    ok = avifRWDataSet(&gm->altICC, ptr(icc), icc.size()) == AVIF_RESULT_OK;
  }
  gm->altColorPrimaries = static_cast<avifColorPrimaries>(js["altPrimaries"].as<int>());
  gm->altTransferCharacteristics = static_cast<avifTransferCharacteristics>(js["altTransfer"].as<int>());
  gm->altMatrixCoefficients = AVIF_MATRIX_COEFFICIENTS_UNSPECIFIED;
  gm->altYUVRange = AVIF_RANGE_FULL;
  gm->altDepth = js["altDepth"].as<int>();
  gm->altPlaneCount = js["altPlaneCount"].as<int>();
  if (!ok) {
    avifGainMapDestroy(gm);
    return nullptr;
  }
  return gm;
}

/** An avifRGBImage over JS RGBA pixels (8-bit Uint8Array or 16-bit Uint16Array). */
avifRGBImage rgbView(std::string& px, int width, int height, int depth) {
  avifRGBImage rgb;
  memset(&rgb, 0, sizeof(rgb));
  rgb.width = width;
  rgb.height = height;
  rgb.depth = depth;
  rgb.format = AVIF_RGB_FORMAT_RGBA;
  rgb.chromaUpsampling = AVIF_CHROMA_UPSAMPLING_AUTOMATIC;
  rgb.pixels = reinterpret_cast<uint8_t*>(px.data());
  rgb.rowBytes = width * 4 * (depth > 8 ? 2 : 1);
  return rgb;
}

std::string pixels(val typed) {
  // Uint16Array -> raw little-endian bytes, the layout avifRGBImage expects.
  val u8 = val::global("Uint8Array").new_(typed["buffer"], typed["byteOffset"], typed["byteLength"]);
  return u8.as<std::string>();
}

}  // namespace

/**
 * Decode every frame of a still or animated AVIF. Frames come back as RGBA, 8-bit
 * (Uint8Array) or, for >8-bit sources when `allowHighDepth` is set, 16-bit (Uint16Array,
 * full 0–65535 range). A gain map, if present, comes back as `gainMap`.
 */
val decode(std::string input, bool allowHighDepth) {
  avifDecoder* dec = avifDecoderCreate();
  dec->maxThreads = 1;
  dec->strictFlags = AVIF_STRICT_DISABLED;
  dec->ignoreExif = AVIF_FALSE;
  dec->ignoreXMP = AVIF_FALSE;
  dec->imageContentToDecode = AVIF_IMAGE_CONTENT_ALL;

  avifResult r = avifDecoderSetIOMemory(dec, ptr(input), input.size());
  if (r == AVIF_RESULT_OK) r = avifDecoderParse(dec);
  if (r != AVIF_RESULT_OK) {
    avifDecoderDestroy(dec);
    return error("parse", r);
  }

  val frames = val::array();
  int depth = 8;
  val gainMap = val::null();
  while ((r = avifDecoderNextImage(dec)) == AVIF_RESULT_OK) {
    avifImage* img = dec->image;
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, img);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = allowHighDepth && img->depth > 8 ? 16 : 8;
    depth = rgb.depth;
    if (avifRGBImageAllocatePixels(&rgb) != AVIF_RESULT_OK || avifImageYUVToRGB(img, &rgb) != AVIF_RESULT_OK) {
      avifRGBImageFreePixels(&rgb);
      avifDecoderDestroy(dec);
      return error("convert", AVIF_RESULT_UNKNOWN_ERROR);
    }
    val frame = val::object();
    if (rgb.depth == 16) {
      frame.set("data", words(reinterpret_cast<const uint16_t*>(rgb.pixels), rgb.width * rgb.height * 4));
    } else {
      frame.set("data", bytes(rgb.pixels, rgb.rowBytes * rgb.height));
    }
    frame.set("duration", dec->imageTiming.duration);
    frames.call<void>("push", frame);
    avifRGBImageFreePixels(&rgb);
    // Gain maps only exist on stills; the first image carries it.
    if (gainMap.isNull() && img->gainMap && img->gainMap->image && dec->imageCount == 1) gainMap = gainMapToJs(img->gainMap);
  }
  if (r != AVIF_RESULT_NO_IMAGES_REMAINING && frames["length"].as<int>() == 0) {
    avifDecoderDestroy(dec);
    return error("decode", r);
  }

  const avifImage* img = dec->image;
  val out = val::object();
  out.set("width", img->width);
  out.set("height", img->height);
  out.set("depth", depth);
  out.set("sourceDepth", img->depth);
  out.set("frames", frames);
  // -1 = infinite, otherwise the number of repetitions after the first play.
  out.set("repetitionCount", dec->repetitionCount);
  out.set("animated", dec->imageCount > 1);
  if (img->icc.size) out.set("icc", bytes(img->icc.data, img->icc.size));
  if (img->exif.size) out.set("exif", bytes(img->exif.data, img->exif.size));
  if (img->xmp.size) out.set("xmp", bytes(img->xmp.data, img->xmp.size));
  val cicp = val::array();
  cicp.call<void>("push", static_cast<int>(img->colorPrimaries));
  cicp.call<void>("push", static_cast<int>(img->transferCharacteristics));
  cicp.call<void>("push", static_cast<int>(img->matrixCoefficients));
  cicp.call<void>("push", img->yuvRange == AVIF_RANGE_FULL);
  out.set("cicp", cicp);
  val clli = val::array();
  clli.call<void>("push", img->clli.maxCLL);
  clli.call<void>("push", img->clli.maxPALL);
  out.set("clli", clli);
  if (!gainMap.isNull()) out.set("gainMap", gainMap);
  avifDecoderDestroy(dec);
  return out;
}

/**
 * Incremental encoder: add RGBA frames one by one, then finish(). One frame gives a
 * still AVIF; more give an image sequence.
 *
 * options: { quality 0–100, speed 0–10, lossless, subsample (true = 4:2:0),
 *            frames (expected count), repetitionCount (-1 = forever), icc, exif, xmp,
 *            depth (8 | 10 | 12; frames are Uint16Array when > 8), primaries, transfer,
 *            clli ([maxCLL, maxPALL] or false), gainMap (or false), qualityGainMap }
 */
class Encoder {
 public:
  Encoder(int width, int height, val options) : width_(width), height_(height) {
    lossless_ = options["lossless"].as<bool>();
    subsample_ = !lossless_ && options["subsample"].as<bool>();
    expected_ = options["frames"].as<int>();
    depth_ = options["depth"].as<int>();
    primaries_ = static_cast<avifColorPrimaries>(options["primaries"].as<int>());
    transfer_ = static_cast<avifTransferCharacteristics>(options["transfer"].as<int>());
    enc_ = avifEncoderCreate();
    enc_->maxThreads = 1;
    enc_->speed = options["speed"].as<int>();
    enc_->quality = lossless_ ? AVIF_QUALITY_LOSSLESS : options["quality"].as<int>();
    // Alpha is kept lossless: binary transparency must stay binary.
    enc_->qualityAlpha = AVIF_QUALITY_LOSSLESS;
    enc_->qualityGainMap = lossless_ ? AVIF_QUALITY_LOSSLESS : options["qualityGainMap"].as<int>();
    enc_->timescale = 1000;  // durations are passed in milliseconds
    enc_->repetitionCount = options["repetitionCount"].as<int>();
    if (options["icc"].as<bool>()) icc_ = options["icc"].as<std::string>();
    if (options["exif"].as<bool>()) exif_ = options["exif"].as<std::string>();
    if (options["xmp"].as<bool>()) xmp_ = options["xmp"].as<std::string>();
    if (options["clli"].as<bool>()) {
      clli_.maxCLL = options["clli"][0].as<int>();
      clli_.maxPALL = options["clli"][1].as<int>();
    }
    if (options["gainMap"].as<bool>()) {
      gainMap_ = gainMapFromJs(options["gainMap"], lossless_);
      gainMapError_ = gainMap_ == nullptr;
    }
  }

  ~Encoder() {
    if (gainMap_) avifGainMapDestroy(gainMap_);
    avifEncoderDestroy(enc_);
  }

  /** Returns an error message, or an empty string on success. */
  std::string add(val frame, double durationMs, bool hasAlpha) {
    if (gainMapError_) return "encode: invalid gain map";
    avifImage* img = avifImageCreate(width_, height_, depth_, subsample_ ? AVIF_PIXEL_FORMAT_YUV420 : AVIF_PIXEL_FORMAT_YUV444);
    img->colorPrimaries = primaries_;
    img->transferCharacteristics = transfer_;
    // Lossless needs the identity matrix so RGB survives the YUV round trip exactly.
    img->matrixCoefficients = lossless_ ? AVIF_MATRIX_COEFFICIENTS_IDENTITY
                              : primaries_ == AVIF_COLOR_PRIMARIES_BT2020 ? AVIF_MATRIX_COEFFICIENTS_BT2020_NCL
                                                                          : AVIF_MATRIX_COEFFICIENTS_BT601;
    img->yuvRange = AVIF_RANGE_FULL;
    img->clli = clli_;

    avifResult r = AVIF_RESULT_OK;
    if (count_ == 0) {
      // Metadata lives on the first frame, which becomes the primary item.
      if (!icc_.empty()) r = avifImageSetProfileICC(img, ptr(icc_), icc_.size());
      if (r == AVIF_RESULT_OK && !exif_.empty()) r = avifImageSetMetadataExif(img, ptr(exif_), exif_.size());
      if (r == AVIF_RESULT_OK && !xmp_.empty()) r = avifImageSetMetadataXMP(img, ptr(xmp_), xmp_.size());
      if (gainMap_) {
        // The image takes ownership.
        img->gainMap = gainMap_;
        gainMap_ = nullptr;
      }
    }

    std::string px = depth_ > 8 ? pixels(frame) : frame.as<std::string>();
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, img);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = depth_ > 8 ? 16 : 8;
    rgb.ignoreAlpha = hasAlpha ? AVIF_FALSE : AVIF_TRUE;
    rgb.pixels = reinterpret_cast<uint8_t*>(px.data());
    rgb.rowBytes = width_ * 4 * (depth_ > 8 ? 2 : 1);

    if (r == AVIF_RESULT_OK) r = avifImageRGBToYUV(img, &rgb);
    if (r == AVIF_RESULT_OK) {
      avifAddImageFlags flags = expected_ == 1 ? AVIF_ADD_IMAGE_FLAG_SINGLE : AVIF_ADD_IMAGE_FLAG_NONE;
      uint64_t duration = durationMs < 1 ? 1 : static_cast<uint64_t>(durationMs + 0.5);
      r = avifEncoderAddImage(enc_, img, duration, flags);
    }
    avifImageDestroy(img);
    if (r != AVIF_RESULT_OK) {
      std::string msg = std::string("encode: ") + avifResultToString(r);
      if (enc_->diag.error[0]) msg += std::string(" (") + enc_->diag.error + ")";
      return msg;
    }
    ++count_;
    return "";
  }

  val finish() {
    avifRWData out = AVIF_DATA_EMPTY;
    avifResult r = avifEncoderFinish(enc_, &out);
    if (r != AVIF_RESULT_OK) return error("finish", r, &enc_->diag);
    val data = bytes(out.data, out.size);
    avifRWDataFree(&out);
    return data;
  }

 private:
  avifEncoder* enc_;
  int width_;
  int height_;
  bool lossless_;
  bool subsample_;
  int expected_;
  int depth_;
  avifColorPrimaries primaries_;
  avifTransferCharacteristics transfer_;
  avifContentLightLevelInformationBox clli_ = {0, 0};
  avifGainMap* gainMap_ = nullptr;
  bool gainMapError_ = false;
  int count_ = 0;
  std::string icc_;
  std::string exif_;
  std::string xmp_;
};

/**
 * Render the HDR version of an SDR image with its gain map: 16-bit RGBA in the requested
 * primaries and transfer (e.g. BT.2020 + PQ), fully applying the map.
 */
val applyGainMap(val base, int width, int height, int basePrimaries, int baseTransfer, val gainMapJs, int outPrimaries, int outTransfer) {
  avifGainMap* gm = gainMapFromJs(gainMapJs, true);
  if (!gm) return error("gain map", AVIF_RESULT_INVALID_ARGUMENT);
  std::string px = base.as<std::string>();
  avifRGBImage in = rgbView(px, width, height, 8);
  avifRGBImage out;
  memset(&out, 0, sizeof(out));
  out.format = AVIF_RGB_FORMAT_RGBA;
  out.depth = 16;
  out.chromaUpsampling = AVIF_CHROMA_UPSAMPLING_AUTOMATIC;
  avifContentLightLevelInformationBox clli = {0, 0};
  avifDiagnostics diag;
  diag.error[0] = 0;
  const float headroom = static_cast<float>(toDouble(gm->alternateHdrHeadroom));
  avifResult r = avifRGBImageApplyGainMap(&in, static_cast<avifColorPrimaries>(basePrimaries), static_cast<avifTransferCharacteristics>(baseTransfer), gm,
                                          headroom, static_cast<avifColorPrimaries>(outPrimaries), static_cast<avifTransferCharacteristics>(outTransfer), &out,
                                          &clli, &diag);
  avifGainMapDestroy(gm);
  if (r != AVIF_RESULT_OK) {
    avifRGBImageFreePixels(&out);
    return error("apply gain map", r, &diag);
  }
  val result = val::object();
  result.set("data", words(reinterpret_cast<const uint16_t*>(out.pixels), static_cast<size_t>(width) * height * 4));
  val c = val::array();
  c.call<void>("push", clli.maxCLL);
  c.call<void>("push", clli.maxPALL);
  result.set("clli", c);
  avifRGBImageFreePixels(&out);
  return result;
}

/**
 * Compute the gain map that turns `sdr` (RGBA8) into `hdr` (RGBA16), both full size.
 * The map is mapWidth × mapHeight with 1 or 3 channels.
 */
val computeGainMap(val sdr, int sdrPrimaries, int sdrTransfer, val hdr, int hdrPrimaries, int hdrTransfer, int width, int height, int mapWidth, int mapHeight,
                   int channels) {
  std::string sdrPx = sdr.as<std::string>();
  std::string hdrPx = pixels(hdr);
  avifRGBImage base = rgbView(sdrPx, width, height, 8);
  avifRGBImage alt = rgbView(hdrPx, width, height, 16);
  avifGainMap* gm = avifGainMapCreate();
  gm->image = avifImageCreate(mapWidth, mapHeight, 8, channels == 1 ? AVIF_PIXEL_FORMAT_YUV400 : AVIF_PIXEL_FORMAT_YUV444);
  gm->image->matrixCoefficients = channels == 1 ? AVIF_MATRIX_COEFFICIENTS_BT601 : AVIF_MATRIX_COEFFICIENTS_IDENTITY;
  gm->image->yuvRange = AVIF_RANGE_FULL;
  avifDiagnostics diag;
  diag.error[0] = 0;
  avifResult r = avifRGBImageComputeGainMap(&base, static_cast<avifColorPrimaries>(sdrPrimaries), static_cast<avifTransferCharacteristics>(sdrTransfer), &alt,
                                            static_cast<avifColorPrimaries>(hdrPrimaries), static_cast<avifTransferCharacteristics>(hdrTransfer), gm, &diag);
  if (r != AVIF_RESULT_OK) {
    avifGainMapDestroy(gm);
    return error("compute gain map", r, &diag);
  }
  gm->altColorPrimaries = static_cast<avifColorPrimaries>(hdrPrimaries);
  gm->altTransferCharacteristics = static_cast<avifTransferCharacteristics>(hdrTransfer);
  gm->altDepth = 10;
  gm->altPlaneCount = 3;
  val out = gainMapToJs(gm);
  avifGainMapDestroy(gm);
  if (out.isNull()) return error("compute gain map", AVIF_RESULT_UNKNOWN_ERROR);
  return out;
}

std::string version() { return avifVersion(); }

EMSCRIPTEN_BINDINGS(sqz_avif) {
  function("decode", &decode);
  function("applyGainMap", &applyGainMap);
  function("computeGainMap", &computeGainMap);
  function("version", &version);
  class_<Encoder>("Encoder").constructor<int, int, val>().function("add", &Encoder::add).function("finish", &Encoder::finish);
}
