export type InputFormat = 'png' | 'apng' | 'gif' | 'webp' | 'avif' | 'jpeg';
export type OutputFormat = 'png' | 'webp' | 'avif' | 'gif' | 'jpeg';
/** `lossless` keeps every visible pixel; `quantized` reduces to a ≤256 colour palette and stores that losslessly; `lossy` uses the format's own lossy coding. */
export type Variant = 'lossless' | 'quantized' | 'lossy';
/** What a user asks for: `lossy` produces both the `quantized` and the `lossy` variant. */
export type Mode = 'lossless' | 'lossy';
/** `max` tries more candidates and a second zopfli implementation; `fast` (skips zopfli) exists for tests and previews. */
export type Effort = 'fast' | 'default' | 'max';

export interface ConvertOptions {
  /** Output format. Default `png` (PNG or APNG). */
  format?: OutputFormat;
  /** Which variants to produce. Default: every variant the format supports (see `variantsFor`). */
  variants?: Variant[];
  /** Remove all metadata (ICC profiles, EXIF, XMP, text, timestamps…). Default `false`. HDR signalling is kept. */
  strip?: boolean;
  /**
   * Output SDR only: drop gain maps (keeping the SDR image they sit on) and tone map
   * PQ / HLG images to sRGB. Default `false`.
   */
  stripHdr?: boolean;
  /**
   * Scale to this size first. Lanczos3 for an axis that shrinks, bicubic for one that
   * grows. Animation frames and HDR gain maps scale along.
   */
  resize?: { width: number; height: number };
  /** Then keep only this rectangle, in (resized) pixels. */
  crop?: { x: number; y: number; width: number; height: number };
  /** How hard to search for the smallest encoding. Default `default`. */
  effort?: Effort;
  /**
   * Lossy variants (`quantized` and `lossy`) aim for this SSIMULACRA2 score: sqz picks
   * the cheapest setting whose output still scores at least this much. 100 = identical,
   * 90 = visually indistinguishable, 70–80 = generally acceptable. Default 80.
   */
  target?: number;
  /** `quantized`: Floyd–Steinberg dithering. Default `true`. */
  dither?: boolean;
  /** Progress callback, `fraction` in 0..1. `variant` is null while decoding. */
  onProgress?: (variant: Variant | null, stage: string, fraction: number) => void;
  /** Called as soon as each variant is ready, before `convert` resolves. */
  onVariant?: (result: VariantResult) => void;
}

export interface VariantResult {
  variant: Variant;
  format: OutputFormat;
  /** Missing when the variant failed; see `error`. */
  data?: Uint8Array;
  size: number;
  mimeType: string;
  /** File extension without the dot. */
  extension: string;
  /** e.g. "palette 4-bit", "WebP lossless", "AVIF lossy q75" */
  description: string;
  /** true when the input was already smaller than anything sqz produced and was kept. */
  keptOriginal: boolean;
  /** SSIMULACRA2 score of the output against the input (100 for lossless). Animations: worst sampled frame. */
  score?: number;
  /** The setting the target search settled on, e.g. "48 colours" or "quality 63". */
  setting?: string;
  warnings: string[];
  error?: string;
}

export interface ConvertResult {
  inputFormat: InputFormat;
  inputSize: number;
  width: number;
  height: number;
  frames: number;
  /** HDR content of the input, reported even when `stripHdr` removed it. */
  hdr?: 'gain map' | 'PQ' | 'HLG';
  warnings: string[];
  variants: VariantResult[];
}

/** A frame is always a full-canvas RGBA snapshot of what a viewer displays. */
export interface Frame {
  data: Uint8Array | Uint16Array;
  /** Delay as a fraction of a second, APNG style. */
  delayNum: number;
  delayDen: number;
}

export interface MetaChunk {
  type: string;
  data: Uint8Array;
}

export interface RasterImage {
  width: number;
  height: number;
  /** 8 → frames hold Uint8Array, 16 → Uint16Array. */
  depth: 8 | 16;
  frames: Frame[];
  /** 0 = loop forever. */
  loops: number;
  /** Ancillary PNG chunks carrying metadata; other formats translate from these. */
  chunks: MetaChunk[];
  format: InputFormat;
  warnings: string[];
  /** Turns the (SDR) frames into an HDR rendition; only on stills. */
  gainMap?: GainMap;
}

/**
 * An ISO 21496-1 gain map. Log2 values throughout, per RGB channel (all three equal
 * for a single-channel map); see libavif's avifGainMap for the exact semantics.
 */
export interface GainMap {
  width: number;
  height: number;
  /** 1 = one gain for all channels, 3 = per channel. */
  channels: 1 | 3;
  /** RGBA8; a single-channel map has R = G = B. */
  data: Uint8Array;
  min: number[];
  max: number[];
  gamma: number[];
  baseOffset: number[];
  alternateOffset: number[];
  baseHdrHeadroom: number;
  alternateHdrHeadroom: number;
  useBaseColorSpace: boolean;
  /** Colorimetry of the HDR rendition the map was made for. */
  altIcc?: Uint8Array;
  altPrimaries: number;
  altTransfer: number;
  altDepth: number;
  altPlaneCount: number;
}
