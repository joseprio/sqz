// Types for the emscripten module built by codecs/avif/build.sh.

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
}

export interface AvifEncoder {
  /** Returns an error message, or "" on success. */
  add(rgba: Uint8Array, durationMs: number, hasAlpha: boolean): string;
  finish(): Uint8Array | { error: string };
  delete(): void;
}

export interface AvifModule {
  decode(input: Uint8Array, allowHighDepth: boolean): AvifDecoded | { error: string };
  version(): string;
  Encoder: new (width: number, height: number, options: AvifEncoderOptions) => AvifEncoder;
}

export default function createAvifModule(overrides?: Record<string, unknown>): Promise<AvifModule>;
