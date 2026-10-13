import { convert, type ConvertOptions } from '../../src/index';

self.onmessage = async (e: MessageEvent<{ id: number; input: Uint8Array; options: ConvertOptions }>) => {
  const { id, input, options } = e.data;
  try {
    const result = await convert(input, {
      ...options,
      onProgress: (variant, stage, fraction) => self.postMessage({ id, progress: { variant, stage, fraction } }),
      // Stream each variant as soon as it is ready; the slow ones should not hold back the rest.
      onVariant: (v) => self.postMessage({ id, variant: v }),
    });
    self.postMessage({ id, done: { ...result, variants: [] } });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
