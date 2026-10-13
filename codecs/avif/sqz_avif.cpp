// AVIF codec for sqz: libavif + libaom compiled to wasm with embind.
// Unlike the usual still-image builds, this exposes image sequences (animated AVIF)
// in both directions, and carries ICC / EXIF / XMP metadata.
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <string>

#include "avif/avif.h"

using namespace emscripten;

namespace {

val bytes(const uint8_t* data, size_t size) {
  // Copy out of wasm memory: the view would dangle once libavif frees the buffer.
  return val(typed_memory_view(size, data)).call<val>("slice");
}

val error(const char* stage, avifResult r) {
  val out = val::object();
  out.set("error", std::string(stage) + ": " + avifResultToString(r));
  return out;
}

}  // namespace

/**
 * Decode every frame of a still or animated AVIF. Frames come back as RGBA, 8-bit
 * (Uint8Array) or, for >8-bit sources when `allowHighDepth` is set, 16-bit (Uint16Array,
 * full 0–65535 range).
 */
val decode(std::string input, bool allowHighDepth) {
  avifDecoder* dec = avifDecoderCreate();
  dec->maxThreads = 1;
  dec->strictFlags = AVIF_STRICT_DISABLED;
  dec->ignoreExif = AVIF_FALSE;
  dec->ignoreXMP = AVIF_FALSE;

  avifResult r = avifDecoderSetIOMemory(dec, reinterpret_cast<const uint8_t*>(input.data()), input.size());
  if (r == AVIF_RESULT_OK) r = avifDecoderParse(dec);
  if (r != AVIF_RESULT_OK) {
    avifDecoderDestroy(dec);
    return error("parse", r);
  }

  val frames = val::array();
  int depth = 8;
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
      frame.set("data", val(typed_memory_view(rgb.width * rgb.height * 4, reinterpret_cast<const uint16_t*>(rgb.pixels))).call<val>("slice"));
    } else {
      frame.set("data", bytes(rgb.pixels, rgb.rowBytes * rgb.height));
    }
    frame.set("duration", dec->imageTiming.duration);
    frames.call<void>("push", frame);
    avifRGBImageFreePixels(&rgb);
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
  avifDecoderDestroy(dec);
  return out;
}

/**
 * Incremental encoder: add RGBA8 frames one by one, then finish(). One frame gives a
 * still AVIF; more give an image sequence.
 *
 * options: { quality 0–100, speed 0–10, lossless, subsample (true = 4:2:0),
 *            frames (expected count), repetitionCount (-1 = forever), icc, exif, xmp }
 */
class Encoder {
 public:
  Encoder(int width, int height, val options) : width_(width), height_(height) {
    lossless_ = options["lossless"].as<bool>();
    subsample_ = !lossless_ && options["subsample"].as<bool>();
    expected_ = options["frames"].as<int>();
    enc_ = avifEncoderCreate();
    enc_->maxThreads = 1;
    enc_->speed = options["speed"].as<int>();
    enc_->quality = lossless_ ? AVIF_QUALITY_LOSSLESS : options["quality"].as<int>();
    // Alpha is kept lossless: binary transparency must stay binary.
    enc_->qualityAlpha = AVIF_QUALITY_LOSSLESS;
    enc_->timescale = 1000;  // durations are passed in milliseconds
    enc_->repetitionCount = options["repetitionCount"].as<int>();
    if (options["icc"].as<bool>()) icc_ = options["icc"].as<std::string>();
    if (options["exif"].as<bool>()) exif_ = options["exif"].as<std::string>();
    if (options["xmp"].as<bool>()) xmp_ = options["xmp"].as<std::string>();
  }

  ~Encoder() { avifEncoderDestroy(enc_); }

  /** Returns an error message, or an empty string on success. */
  std::string add(std::string rgba, double durationMs, bool hasAlpha) {
    avifImage* img = avifImageCreate(width_, height_, 8, subsample_ ? AVIF_PIXEL_FORMAT_YUV420 : AVIF_PIXEL_FORMAT_YUV444);
    img->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
    img->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
    // Lossless needs the identity matrix so RGB survives the YUV round trip exactly.
    img->matrixCoefficients = lossless_ ? AVIF_MATRIX_COEFFICIENTS_IDENTITY : AVIF_MATRIX_COEFFICIENTS_BT601;
    img->yuvRange = AVIF_RANGE_FULL;

    avifResult r = AVIF_RESULT_OK;
    if (count_ == 0) {
      // Metadata lives on the first frame, which becomes the primary item.
      auto p = [](const std::string& s) { return reinterpret_cast<const uint8_t*>(s.data()); };
      if (!icc_.empty()) r = avifImageSetProfileICC(img, p(icc_), icc_.size());
      if (r == AVIF_RESULT_OK && !exif_.empty()) r = avifImageSetMetadataExif(img, p(exif_), exif_.size());
      if (r == AVIF_RESULT_OK && !xmp_.empty()) r = avifImageSetMetadataXMP(img, p(xmp_), xmp_.size());
    }

    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, img);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = 8;
    rgb.ignoreAlpha = hasAlpha ? AVIF_FALSE : AVIF_TRUE;
    rgb.pixels = reinterpret_cast<uint8_t*>(rgba.data());
    rgb.rowBytes = width_ * 4;

    if (r == AVIF_RESULT_OK) r = avifImageRGBToYUV(img, &rgb);
    if (r == AVIF_RESULT_OK) {
      avifAddImageFlags flags = expected_ == 1 ? AVIF_ADD_IMAGE_FLAG_SINGLE : AVIF_ADD_IMAGE_FLAG_NONE;
      uint64_t duration = durationMs < 1 ? 1 : static_cast<uint64_t>(durationMs + 0.5);
      r = avifEncoderAddImage(enc_, img, duration, flags);
    }
    avifImageDestroy(img);
    if (r != AVIF_RESULT_OK) return std::string("encode: ") + avifResultToString(r);
    ++count_;
    return "";
  }

  val finish() {
    avifRWData out = AVIF_DATA_EMPTY;
    avifResult r = avifEncoderFinish(enc_, &out);
    if (r != AVIF_RESULT_OK) return error("finish", r);
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
  int count_ = 0;
  std::string icc_;
  std::string exif_;
  std::string xmp_;
};

std::string version() { return avifVersion(); }

EMSCRIPTEN_BINDINGS(sqz_avif) {
  function("decode", &decode);
  function("version", &version);
  class_<Encoder>("Encoder").constructor<int, int, val>().function("add", &Encoder::add).function("finish", &Encoder::finish);
}
