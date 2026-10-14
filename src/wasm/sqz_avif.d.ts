// Types for the emscripten module built by codecs/avif/build.sh.
import type { GainMap } from '../types.js';

export interface AvifDecodedFrame {
  data: Uint8Array | Uint16Array;
  /** Seconds. */
  duration: number;
}

export interface AvifDecoded {
  error?: string;
  width: number;
  height: number;
  /** 8, or 16 when a >8-bit source was decoded with allowHighDepth. */
  depth: 8 | 16;
  sourceDepth: number;
  frames: AvifDecodedFrame[];
  /** -1 = forever, -2 = unknown, otherwise repetitions after the first play. */
  repetitionCount: number;
  animated: boolean;
  icc?: Uint8Array;
  exif?: Uint8Array;
  xmp?: Uint8Array;
  /** [colour primaries, transfer characteristics, matrix coefficients, full range] */
  cicp: [number, number, number, boolean];
  /** [maxCLL, maxPALL]; zeros when absent. */
  clli: [number, number];
  gainMap?: GainMap;
}

export interface AvifEncoderOptions {
  quality: number;
  speed: number;
  lossless: boolean;
  subsample: boolean;
  frames: number;
  repetitionCount: number;
  icc: Uint8Array | false;
  exif: Uint8Array | false;
  xmp: Uint8Array | false;
  /** 8, or 10/12 with Uint16Array frames. */
  depth: 8 | 10 | 12;
  primaries: number;
  transfer: number;
  clli: [number, number] | false;
  gainMap: GainMap | false;
  qualityGainMap: number;
}

export interface AvifEncoder {
  /** Returns an error message, or "" on success. */
  add(rgba: Uint8Array | Uint16Array, durationMs: number, hasAlpha: boolean): string;
  finish(): Uint8Array | { error: string };
  delete(): void;
}

export interface AvifModule {
  decode(input: Uint8Array, allowHighDepth: boolean): AvifDecoded | { error: string };
  applyGainMap(
    base: Uint8Array,
    width: number,
    height: number,
    basePrimaries: number,
    baseTransfer: number,
    gainMap: GainMap,
    outPrimaries: number,
    outTransfer: number,
  ): { data: Uint16Array; clli: [number, number] } | { error: string };
  computeGainMap(
    sdr: Uint8Array,
    sdrPrimaries: number,
    sdrTransfer: number,
    hdr: Uint16Array,
    hdrPrimaries: number,
    hdrTransfer: number,
    width: number,
    height: number,
    mapWidth: number,
    mapHeight: number,
    channels: 1 | 3,
  ): GainMap | { error: string };
  version(): string;
  Encoder: new (width: number, height: number, options: AvifEncoderOptions) => AvifEncoder;
}

export default function createAvifModule(overrides?: Record<string, unknown>): Promise<AvifModule>;
