import { parentPort } from 'node:worker_threads';
import { convert, type ConvertOptions } from '../index.js';
import { registerNodeCodecs } from './codecs.js';

registerNodeCodecs();

parentPort!.on('message', async (msg: { id: number; input: Uint8Array; options: ConvertOptions }) => {
  try {
    const result = await convert(msg.input, msg.options);
    const transfer = [...new Set(result.variants.map((v) => v.data?.buffer).filter(Boolean))] as ArrayBuffer[];
    parentPort!.postMessage({ id: msg.id, result }, transfer);
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: (e as Error).message ?? String(e) });
  }
});
