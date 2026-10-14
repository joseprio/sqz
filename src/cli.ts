#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, stat, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ConvertOptions, ConvertResult, Mode, OutputFormat, Variant } from './types.js';
import { describeTarget } from './process/bands.js';
import { version } from '../package.json';

const HELP = `sqz ${version} — convert between PNG/APNG, GIF, WebP, AVIF and JPEG and squeeze the result

Usage: sqz [options] <file|dir|->...

Output:
  -t, --to <format>      png (default, APNG for animations) | webp | avif | gif | jpeg
  -m, --mode <mode>      lossless (default) | lossy
                         lossy writes two files: NAME.quantized.EXT (palette, ≤256
                         colours) and NAME.lossy.EXT (the format's own lossy coding).
                         GIF only has the quantized one, AVIF only the lossy one.
                         JPEG is always lossy, whatever the mode.
  -T, --target <0-100>   lossy: SSIMULACRA2 score to aim for (default 80)
                           90+ visually indistinguishable · 80 excellent
                           70–80 generally acceptable · 60–70 web/game assets
      --no-dither        quantized: map to nearest colour without dithering
      --max              maximum effort: slower, a little smaller
  -s, --strip            remove all metadata (ICC, EXIF, XMP, text, time, …)
      --strip-hdr        SDR output only: drop gain maps, tone map PQ/HLG to sRGB

HDR: Ultra HDR JPEG and AVIF gain maps stay gain maps in AVIF and JPEG, and become
16-bit PQ in lossless PNG. PQ/HLG images stay HDR in AVIF (10/12-bit) and lossless
PNG, and become Ultra HDR in JPEG. Other outputs are 8-bit SDR.

Files:
  -o, --out <path>       output file (single input), directory, or - for stdout
  -f, --force            overwrite existing files, including the input itself
  -r, --recursive        descend into directories
  -n, --dry-run          report sizes without writing anything
  -j, --jobs <n>         parallel workers; each version of each file is a job (default: CPU count)
      --quiet            only print errors

  -h, --help             show this help
  -v, --version          show version

Without --out, a.gif is written next to it as a.png (or a.webp, …). Existing files,
including the input, are only replaced with --force. A lossless output is never bigger
than an input that is already a lossless file of the same format.

Examples:
  sqz animation.gif                         # → animation.png (APNG)
  sqz -t webp -m lossy photo.png            # → photo.quantized.webp + photo.lossy.webp
  sqz -t avif -m lossy -T 70 -r photos -o out/
  sqz -t jpeg -T 85 hdr.avif                # → hdr.jpg (Ultra HDR)
  sqz -f --max *.png                        # recompress PNGs in place
  cat in.webp | sqz - -o - > out.png

Run without installing: npx @joseprio/sqz …   Install: npm i -g @joseprio/sqz
`;

const EXTENSIONS = new Set(['.png', '.apng', '.gif', '.webp', '.avif', '.jpg', '.jpeg']);
const FORMATS: OutputFormat[] = ['png', 'webp', 'avif', 'gif', 'jpeg'];
const EXT: Record<OutputFormat, string> = { png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', jpeg: 'jpg' };
const color = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s: string) => paint(31, s);
const yellow = (s: string) => paint(33, s);
const green = (s: string) => paint(32, s);
const dim = (s: string) => paint(2, s);

function fail(msg: string): never {
  process.stderr.write(`${red('error')} ${msg}\n`);
  process.exit(2);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

interface Input {
  file: string;
  base: string;
}

async function collect(paths: string[], recursive: boolean): Promise<Input[]> {
  const out: Input[] = [];
  const walk = async (dir: string, base: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(p, base);
      } else if (EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push({ file: p, base });
    }
  };
  for (const p of paths) {
    if (p === '-') {
      out.push({ file: '-', base: '' });
      continue;
    }
    let s;
    try {
      s = await stat(p);
    } catch {
      fail(`${p}: no such file or directory`);
    }
    if (s.isDirectory()) await walk(p, p);
    else out.push({ file: p, base: dirname(p) });
  }
  return out;
}

class Pool {
  private idle: Worker[] = [];
  private queue: (() => void)[] = [];
  private seq = 0;
  private all: Worker[] = [];

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url));
      this.all.push(w);
      this.idle.push(w);
    }
  }

  run(input: Uint8Array, options: ConvertOptions): Promise<ConvertResult> {
    return new Promise((res, rej) => {
      const start = () => {
        const w = this.idle.pop()!;
        const id = ++this.seq;
        const onMsg = (m: { id: number; result?: ConvertResult; error?: string }) => {
          if (m.id !== id) return;
          w.off('message', onMsg);
          this.idle.push(w);
          this.queue.shift()?.();
          if (m.error) rej(new Error(m.error));
          else res(m.result!);
        };
        w.on('message', onMsg);
        w.postMessage({ id, input, options }, [input.buffer as ArrayBuffer]);
      };
      if (this.idle.length) start();
      else this.queue.push(start);
    });
  }

  close() {
    for (const w of this.all) void w.terminate();
  }
}

async function readStdin(): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      allowNegative: true,
      options: {
        to: { type: 'string', short: 't', default: 'png' },
        mode: { type: 'string', short: 'm', default: 'lossless' },
        target: { type: 'string', short: 'T', default: '80' },
        dither: { type: 'boolean', default: true },
        max: { type: 'boolean', default: false },
        strip: { type: 'boolean', short: 's', default: false },
        'strip-hdr': { type: 'boolean', default: false },
        out: { type: 'string', short: 'o' },
        force: { type: 'boolean', short: 'f', default: false },
        recursive: { type: 'boolean', short: 'r', default: false },
        'dry-run': { type: 'boolean', short: 'n', default: false },
        jobs: { type: 'string', short: 'j' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\nRun sqz --help for usage.`);
  }
  const v = args.values;
  if (v.help) return void process.stdout.write(HELP);
  if (v.version) return void process.stdout.write(`${version}\n`);
  if (!args.positionals.length) {
    process.stdout.write(HELP);
    process.exit(process.stdin.isTTY ? 2 : 0);
  }

  const format = v.to.toLowerCase().replace(/^apng$/, 'png').replace(/^jpg$/, 'jpeg') as OutputFormat;
  if (!FORMATS.includes(format)) fail('--to must be png, webp, avif, gif or jpeg');
  const ext = EXT[format];
  const mode = v.mode as Mode;
  if (mode !== 'lossless' && mode !== 'lossy') fail('--mode must be lossless or lossy');
  const target = Number(v.target);
  if (!(target >= 0 && target <= 100)) fail('--target must be between 0 and 100');
  const { variantsFor } = await import('./index.js');
  const variants = variantsFor(format, mode);
  const options: ConvertOptions = { format, variants, target, dither: v.dither, strip: v.strip, stripHdr: v['strip-hdr'], effort: v.max ? 'max' : 'default' };

  const files = await collect(args.positionals, v.recursive);
  if (!files.length) fail('no PNG, APNG, GIF, WebP, AVIF or JPEG files found');

  const toStdout = v.out === '-';
  if (toStdout && files.length !== 1) fail('--out - needs exactly one input');
  if (toStdout && variants.length !== 1) fail('--out - writes one file, but lossy mode produces two; use --out <file> instead');
  if (files.some((f) => f.file === '-') && !toStdout && !v.out && !v['dry-run']) fail('reading from stdin needs --out <file> or --out -');
  const outIsDir = v.out !== undefined && !toStdout && (files.length > 1 || /[\\/]$/.test(v.out) || (existsSync(v.out) && (await stat(v.out)).isDirectory()));

  // a.gif and a.png in one batch would both become a.png; keep the source extension for the others.
  const stems = new Map<string, number>();
  for (const f of files) {
    const k = join(dirname(f.file), basename(f.file, extname(f.file))).toLowerCase();
    stems.set(k, (stems.get(k) ?? 0) + 1);
  }
  const suffix = (variant: Variant) => (variants.length > 1 ? `.${variant}.${ext}` : `.${ext}`);
  const destination = (f: Input, variant: Variant): string => {
    if (f.file === '-' && v.out && !outIsDir) {
      return variants.length > 1 ? v.out.replace(/(\.[^.\\/]+)?$/, (e) => `.${variant}${e || '.' + ext}`) : v.out;
    }
    const own = extname(f.file);
    const clash = (stems.get(join(dirname(f.file), basename(f.file, own)).toLowerCase()) ?? 0) > 1;
    const stem = clash && own.slice(1).toLowerCase() !== ext ? basename(f.file) : basename(f.file, own);
    const name = stem + suffix(variant);
    if (!v.out) return join(dirname(f.file), name);
    if (!outIsDir) return variants.length > 1 ? v.out.replace(/(\.[^.\\/]+)?$/, (e) => `.${variant}${e || '.' + ext}`) : v.out;
    const rel = relative(f.base, dirname(f.file));
    return join(v.out, rel.startsWith('..') ? '' : rel, name);
  };

  // Refuse to clobber anything before doing any work.
  const targets = new Map<string, string>();
  if (!toStdout && !v['dry-run']) {
    for (const f of files) {
      for (const variant of variants) {
        const dest = destination(f, variant);
        const key = resolve(dest).toLowerCase();
        if (targets.has(key)) fail(`${targets.get(key)} and ${f.file} would both be written to ${dest}`);
        targets.set(key, f.file);
        if (!v.force && existsSync(dest)) {
          const same = f.file !== '-' && resolve(dest) === resolve(f.file);
          fail(`${dest} ${same ? 'is the input file' : 'already exists'}; pass --force to overwrite${same ? ' it in place' : ''} or --out to write elsewhere`);
        }
      }
    }
  }

  const jobs = Math.max(1, Math.min(files.length * variants.length, v.jobs ? Number(v.jobs) || 1 : availableParallelism()));
  const pool = new Pool(jobs);
  const log = (s: string) => {
    if (!v.quiet) process.stderr.write(s + '\n');
  };

  let failed = 0;
  let totalIn = 0;
  let totalOut = 0;
  await Promise.all(
    files.map(async (f) => {
      const started = performance.now();
      const label = f.file === '-' ? 'stdin' : normalize(f.file);
      try {
        const input = f.file === '-' ? await readStdin() : new Uint8Array(await readFile(f.file));
        // One job per version so a file's versions run on separate workers in parallel.
        const parts = await Promise.all(variants.map((variant) => pool.run(input.slice(), { ...options, variants: [variant] })));
        const res: ConvertResult = { ...parts[0], variants: parts.flatMap((p) => p.variants) };
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        const hdr = res.hdr ? `, HDR ${res.hdr}${v['strip-hdr'] ? ' (stripped)' : ''}` : '';
        log(`${label}  ${formatBytes(res.inputSize)}  ${dim(`${res.width}×${res.height}${res.frames > 1 ? `, ${res.frames} frames` : ''}${hdr}, ${secs}s`)}`);
        for (const w of res.warnings) log(`  ${yellow('warning')} ${w}`);
        let best = Infinity;
        for (const r of res.variants) {
          if (r.error || !r.data) {
            failed++;
            log(`  ${red('✗')} ${r.variant}: ${r.error}`);
            continue;
          }
          const dest = toStdout ? '-' : destination(f, r.variant);
          if (toStdout) process.stdout.write(r.data);
          else if (!v['dry-run']) {
            await mkdir(dirname(dest), { recursive: true });
            await writeFile(dest, r.data);
          }
          best = Math.min(best, r.size);
          const pct = ((r.size / res.inputSize - 1) * 100).toFixed(1);
          const delta = r.size <= res.inputSize ? green(`${pct}%`) : yellow(`+${pct}%`);
          const quality = r.variant === 'lossless' ? '' : r.score !== undefined ? `SSIMULACRA2 ${r.score.toFixed(1)} (${describeTarget(r.score).label.toLowerCase()})${r.setting ? `, ${r.setting}` : ''}, ` : '';
          const what = r.keptOriginal ? 'already optimal, kept original' : r.description;
          log(`  → ${dest === '-' ? 'stdout' : normalize(dest)}  ${formatBytes(r.size)}  ${delta}  ${dim(quality + what)}`);
          for (const w of r.warnings) log(`    ${yellow('warning')} ${w}`);
        }
        if (best < Infinity) {
          totalIn += res.inputSize;
          totalOut += best;
        }
      } catch (e) {
        failed++;
        process.stderr.write(`${red('error')} ${label}: ${(e as Error).message}\n`);
      }
    }),
  );
  pool.close();

  if (files.length > 1 && totalIn) {
    const pct = ((totalOut / totalIn - 1) * 100).toFixed(1);
    log(`${files.length} file(s): ${formatBytes(totalIn)} → ${formatBytes(totalOut)} (${pct}%${variants.length > 1 ? ', smallest variant each' : ''})${v['dry-run'] ? ' — dry run, nothing written' : ''}`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
