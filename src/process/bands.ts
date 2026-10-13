/** What a SSIMULACRA2 score means. Kept dependency-free so UIs can import it cheaply. */
export interface TargetBand {
  min: number;
  label: string;
  detail: string;
}

/** Plain-language meaning of a score, for UIs and CLI output. */
export const TARGET_BANDS: TargetBand[] = [
  { min: 90, label: 'Visually indistinguishable', detail: 'Even side by side at 1:1, nobody will spot a difference.' },
  { min: 80, label: 'Excellent', detail: 'Differences only show when flipping between images or zooming in.' },
  { min: 70, label: 'Generally acceptable', detail: 'Fine for most photos and content; close inspection reveals slight artifacts.' },
  { min: 60, label: 'Web and game assets', detail: 'Acceptable for web graphics, sprites and textures; artifacts are visible if you look.' },
  { min: 50, label: 'Previews', detail: 'Noticeable artifacts. Good enough for thumbnails and placeholders.' },
  { min: 30, label: 'Low quality', detail: 'Obvious banding, blur or blockiness.' },
  { min: -Infinity, label: 'Very low quality', detail: 'Heavily degraded; mostly useful for tiny previews.' },
];

export const describeTarget = (score: number): TargetBand => TARGET_BANDS.find((b) => score >= b.min)!;
