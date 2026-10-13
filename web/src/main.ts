import './style.css';
import { zipSync } from 'fflate';
import type { ConvertOptions, ConvertResult, OutputFormat, Variant, VariantResult } from '../../src/types';
import { describeTarget } from '../../src/process/bands';
import { version } from '../../package.json';

// Kept in sync with variantsFor() in src/index.ts; importing it here would pull the codecs into the main bundle.
const VARIANTS: Record<OutputFormat, Variant[]> = {
  png: ['lossless', 'quantized', 'lossy'],
  webp: ['lossless', 'quantized', 'lossy'],
  avif: ['lossless', 'lossy'],
  gif: ['lossless', 'quantized'],
};
const VARIANT_LABEL: Record<Variant, string> = { lossless: 'Lossless', quantized: 'Quantized', lossy: 'Lossy' };
const FORMAT_LABEL: Record<OutputFormat, string> = { png: 'PNG', webp: 'WebP', avif: 'AVIF', gif: 'GIF' };
const FORMAT_HINTS: Record<OutputFormat, string> = {
  png: 'Animations become APNG. Lossy versions: a ≤256-colour palette, and truecolor lossy filtering.',
  webp: 'Animations stay animated. Lossy versions: a ≤256-colour palette stored losslessly, and regular lossy WebP.',
  avif: 'Best for photos; animations become AVIF image sequences. Lossy version: regular lossy AVIF (4:4:4 when 4:2:0 can’t reach the target).',
  gif: 'At most 256 colours and no partial transparency, so lossless only works for images that already fit.',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------- settings ----------

interface Settings {
  format: OutputFormat;
  target: number;
  dither: boolean;
  max: boolean;
  strip: boolean;
}
const DEFAULTS: Settings = { format: 'png', target: 80, dither: true, max: false, strip: false };
const STORE = 'sqz:settings:v2';

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

const settings = loadSettings();

/** Settings that change the output, as a stable key (lossless-only formats ignore nothing, kept simple). */
const settingsKey = (s: Settings) => `${s.format}|${s.target}|${s.dither}|${s.max}|${s.strip}`;

/** Short description of the settings a job ran with, e.g. "WebP · target 80 · max effort". */
function settingsLabel(s: Settings): string {
  const parts = [FORMAT_LABEL[s.format], `target ${s.target}`];
  if (!s.dither) parts.push('no dithering');
  if (s.max) parts.push('max effort');
  if (s.strip) parts.push('stripped');
  return parts.join(' · ');
}

function bindSegmented(id: string, onChange: (value: string) => void, current: () => string) {
  const group = $(id);
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')];
  const paint = () =>
    buttons.forEach((b) => {
      const on = b.dataset.value === current();
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => {
      onChange(b.dataset.value!);
      paint();
    });
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = buttons[(i + d + buttons.length) % buttons.length];
      next.focus();
      next.click();
    });
  });
  paint();
}

function syncSettingsUi() {
  $('format-hint').textContent = FORMAT_HINTS[settings.format];
  $('target-out').textContent = String(settings.target);
  const band = describeTarget(settings.target);
  $('target-band').textContent = band.label + '.';
  $('target-detail').textContent = band.detail;
  syncCompressButton();
}

/** Settings only take effect on the next Compress; existing jobs keep the settings they ran with. */
function settingsChanged() {
  saveSettings();
  syncSettingsUi();
}

function initSettings() {
  bindSegmented(
    'format',
    (v) => {
      settings.format = v as OutputFormat;
      settingsChanged();
    },
    () => settings.format,
  );
  const target = $<HTMLInputElement>('target');
  target.value = String(settings.target);
  target.addEventListener('input', () => {
    settings.target = Number(target.value);
    settingsChanged();
  });
  for (const key of ['dither', 'max', 'strip'] as const) {
    const box = $<HTMLInputElement>(key);
    box.checked = settings[key];
    box.addEventListener('change', () => {
      settings[key] = box.checked;
      settingsChanged();
    });
  }
  syncSettingsUi();
}

// ---------- source images ----------

interface Source {
  file: File;
  input: Uint8Array;
  url: string;
  el: HTMLLIElement;
  /** Removed from the source list; its URL lives on while results still show it. */
  removed: boolean;
}
const sources: Source[] = [];

const ACCEPT = /\.(png|apng|gif|webp|avif)$/i;
async function addFiles(files: Iterable<File>) {
  for (const file of files) {
    if (!ACCEPT.test(file.name) && !/^image\/(png|apng|gif|webp|avif)$/.test(file.type)) continue;
    const el = document.createElement('li');
    el.className = 'source';
    el.innerHTML = `<div class="thumb small"><img alt="" /></div><div class="info"><div class="name"></div><div class="meta"></div></div><button type="button" class="ghost icon remove" aria-label="Remove">✕</button>`;
    const source: Source = { file, input: new Uint8Array(await file.arrayBuffer()), url: URL.createObjectURL(file), el, removed: false };
    el.querySelector('img')!.src = source.url;
    el.querySelector('.name')!.textContent = file.name;
    el.querySelector('.meta')!.textContent = formatBytes(source.input.length);
    el.querySelector<HTMLButtonElement>('.remove')!.setAttribute('aria-label', `Remove ${file.name}`);
    el.querySelector('.remove')!.addEventListener('click', () => removeSource(source));
    sources.push(source);
    $('source-list').append(el);
  }
  syncCompressButton();
}

function removeSource(source: Source) {
  sources.splice(sources.indexOf(source), 1);
  source.el.remove();
  source.removed = true;
  releaseSource(source);
  syncCompressButton();
}

/** Free a source's object URL once neither the source list nor any result uses it. */
function releaseSource(source: Source) {
  if (source.removed && !items.some((i) => i.source === source)) URL.revokeObjectURL(source.url);
}

function syncCompressButton() {
  const button = $<HTMLButtonElement>('compress');
  const n = sources.length;
  $('sources').hidden = n === 0;
  button.disabled = n === 0;
  button.textContent = n ? `Compress ${n === 1 ? '1 image' : `${n} images`} to ${FORMAT_LABEL[settings.format]}` : 'Compress';
  const key = settingsKey(settings);
  const done = sources.filter((s) => items.some((i) => i.source === s && settingsKey(i.settings) === key && i.status !== 'error')).length;
  $('compress-note').textContent = done === n && n ? 'Already compressed with these settings; change a setting to add another version.' : done ? `${done} already done with these settings will be skipped.` : '';
}

/** One new job per source image, with a frozen copy of the current settings. Identical jobs are skipped. */
function compress() {
  const snapshot = { ...settings };
  const key = settingsKey(snapshot);
  let added = 0;
  for (const source of sources) {
    if (items.some((i) => i.source === source && settingsKey(i.settings) === key && i.status !== 'error')) continue;
    addItem(source, snapshot);
    added++;
  }
  syncCompressButton();
  if (added) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- jobs (one per source image × settings) ----------

type Status = 'queued' | 'working' | 'done' | 'error';

interface Item {
  id: number;
  source: Source;
  settings: Settings;
  status: Status;
  progress: Partial<Record<Variant, number>>;
  info?: Omit<ConvertResult, 'variants'>;
  variants: Partial<Record<Variant, VariantResult & { url?: string }>>;
  selected?: Variant;
  /** Set once the user picks a version; until then the smallest one meeting the target is selected. */
  userPicked?: boolean;
  error?: string;
  el: HTMLLIElement;
  /** Versions currently being produced by a worker. */
  running: Set<Variant>;
  /** Versions not finished yet (queued or running). */
  pending: number;
}
const items: Item[] = [];
let itemCounter = 0;

function addItem(source: Source, s: Settings) {
  const el = document.createElement('li');
  el.className = 'row';
  el.innerHTML = `
    <div class="row-head">
      <div class="thumb"><img alt="" /></div>
      <div class="info">
        <div class="name"><span class="file"></span> <span class="job-tag"></span></div>
        <div class="meta"></div>
      </div>
      <div class="row-actions">
        <button type="button" class="ghost copy" disabled title="Copy the selected version as a data: URL">Copy data URL</button>
        <a class="button primary download" aria-disabled="true">Download</a>
        <button type="button" class="ghost icon remove">✕</button>
      </div>
    </div>
    <div class="variants" role="radiogroup"></div>`;
  const item: Item = { id: ++itemCounter, source, settings: s, status: 'queued', progress: {}, variants: {}, el, running: new Set(), pending: 0 };
  el.querySelector('.file')!.textContent = source.file.name;
  el.querySelector('.job-tag')!.textContent = settingsLabel(s);
  el.querySelector('.remove')!.setAttribute('aria-label', `Remove ${source.file.name} (${settingsLabel(s)})`);
  el.querySelector('.variants')!.setAttribute('aria-label', `Versions of ${source.file.name}`);
  el.querySelector('.copy')!.addEventListener('click', (e) => void copyDataUrl(item, e.currentTarget as HTMLButtonElement));
  el.querySelector('.remove')!.addEventListener('click', () => removeItem(item));
  el.querySelector('.variants')!.replaceChildren(
    ...VARIANTS[s.format].map((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'variant';
      b.dataset.variant = v;
      b.setAttribute('role', 'radio');
      b.innerHTML = `<span class="v-name"></span><span class="v-size"></span><span class="v-detail"></span><span class="v-bar"><i></i></span>`;
      b.querySelector('.v-name')!.textContent = VARIANT_LABEL[v];
      b.addEventListener('click', () => {
        if (!item.variants[v]?.data) return;
        item.selected = v;
        item.userPicked = true;
        render(item);
        summarize();
      });
      return b;
    }),
  );
  items.push(item);
  $('list').append(el);
  for (const variant of VARIANTS[s.format]) {
    queue.push({ id: ++taskCounter, item, variant });
    item.pending++;
  }
  render(item);
  summarize();
  pump();
}

function removeItem(item: Item) {
  cancelTasks(item);
  items.splice(items.indexOf(item), 1);
  item.el.remove();
  for (const v of Object.values(item.variants)) if (v?.url) URL.revokeObjectURL(v.url);
  releaseSource(item.source);
  syncCompressButton();
  summarize();
  pump();
}

// ---------- worker pool ----------

// Every version of every job is its own task, so a file's versions run in parallel.
const POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));

interface Task {
  id: number;
  item: Item;
  variant: Variant;
}
interface Slot {
  worker: Worker;
  task: Task | null;
}
const slots: Slot[] = [];
const queue: Task[] = [];
let taskCounter = 0;

type WorkerMessage = {
  id: number;
  progress?: { variant: Variant | null; stage: string; fraction: number };
  variant?: VariantResult;
  done?: ConvertResult;
  error?: string;
};

function spawn(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e) => onWorkerMessage(w, e.data);
  w.onerror = (e) => {
    const slot = slots.find((s) => s.worker === w);
    if (slot?.task) finishTask(slot, e.message || 'The worker crashed (the image may be too large for this browser)');
  };
  return w;
}

const STAGE_WEIGHT: Record<string, [number, number]> = { tune: [0, 0.45], process: [0, 0.45], analyse: [0.45, 0.25], compress: [0.7, 0.3] };

function onWorkerMessage(w: Worker, msg: WorkerMessage) {
  const slot = slots.find((s) => s.worker === w);
  const task = slot?.task;
  if (!slot || !task || msg.id !== task.id) return;
  const item = task.item;
  if (msg.progress) {
    const { variant, stage, fraction } = msg.progress;
    if (variant) {
      const [base, span] = STAGE_WEIGHT[stage] ?? [0, 0];
      item.progress[variant] = Math.max(item.progress[variant] ?? 0, base + span * fraction);
      renderVariant(item, variant);
    }
  } else if (msg.variant) {
    const v: VariantResult & { url?: string } = msg.variant;
    if (v.data) v.url = URL.createObjectURL(new Blob([v.data as BlobPart], { type: v.mimeType }));
    item.variants[v.variant] = v;
    autoSelect(item);
  } else if (msg.done) {
    item.info ??= msg.done;
    finishTask(slot);
  } else if (msg.error !== undefined) {
    finishTask(slot, msg.error);
  }
}

function finishTask(slot: Slot, error?: string) {
  const { item, variant } = slot.task!;
  slot.task = null;
  item.running.delete(variant);
  item.pending--;
  if (error) {
    const format = item.settings.format;
    item.variants[variant] ??= { variant, format, size: 0, mimeType: '', extension: format, description: '', keptOriginal: false, warnings: [], error };
  }
  if (item.pending === 0) {
    // Decoding failures hit every version alike: report them once, for the whole job.
    const results = Object.values(item.variants);
    const failed = results.length > 0 && results.every((v) => v?.error) && !item.info;
    item.status = failed ? 'error' : 'done';
    item.error = failed ? results[0]!.error : undefined;
    syncCompressButton();
  }
  render(item);
  summarize();
  pump();
}

function pump() {
  for (const slot of slots) {
    if (slot.task || !queue.length) continue;
    const task = queue.shift()!;
    slot.task = task;
    const { item } = task;
    item.status = 'working';
    item.running.add(task.variant);
    render(item);
    const s = item.settings;
    const options: ConvertOptions = {
      format: s.format,
      variants: [task.variant],
      target: s.target,
      dither: s.dither,
      strip: s.strip,
      effort: s.max ? 'max' : 'default',
    };
    slot.worker.postMessage({ id: task.id, input: item.source.input.slice(), options });
  }
}

/** Drop a job's queued tasks and replace any worker still busy with one (terminating is the only way to stop wasm). */
function cancelTasks(item: Item) {
  for (const slot of slots) {
    if (slot.task?.item !== item) continue;
    slot.worker.terminate();
    slot.worker = spawn();
    slot.task = null;
  }
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].item === item) queue.splice(i, 1);
  item.running.clear();
  item.pending = 0;
}

const missedTarget = (v: VariantResult) => v.warnings.some((w) => w.startsWith('Could not reach'));

/** Until the user picks, select the smallest finished version that meets the target (lossless always does). */
function autoSelect(item: Item) {
  if (item.userPicked) return;
  let best: VariantResult | undefined;
  for (const v of Object.values(item.variants)) {
    if (v?.data && !missedTarget(v) && (!best || v.size < best.size)) best = v;
  }
  item.selected = best?.variant;
}

// ---------- rendering ----------

const outputName = (name: string, v: VariantResult) => `${name.replace(/\.[^.]+$/, '')}${v.variant === 'lossless' ? '' : `.${v.variant}`}.${v.extension}`;

function render(item: Item) {
  const el = item.el;
  el.dataset.status = item.status;
  const meta = el.querySelector<HTMLElement>('.meta')!;
  const thumb = el.querySelector<HTMLImageElement>('.thumb img')!;
  const sel = item.selected ? item.variants[item.selected] : undefined;
  const thumbUrl = sel?.url ?? item.source.url;
  if (thumb.src !== thumbUrl) thumb.src = thumbUrl;

  const size = formatBytes(item.source.input.length);
  const info = item.info;
  if (item.status === 'error') meta.textContent = item.error ?? 'Failed';
  else if (item.status === 'queued') meta.textContent = `${size} · waiting…`;
  else meta.textContent = `${size}${info ? ` · ${info.width}×${info.height}${info.frames > 1 ? ` · ${info.frames} frames` : ''}` : ''}`;
  if (info?.warnings.length) meta.title = info.warnings.join('\n');

  const dl = el.querySelector<HTMLAnchorElement>('.download')!;
  const copy = el.querySelector<HTMLButtonElement>('.copy')!;
  if (sel?.url) {
    dl.href = sel.url;
    dl.download = outputName(item.source.file.name, sel);
    dl.removeAttribute('aria-disabled');
    dl.textContent = `Download ${VARIANT_LABEL[sel.variant].toLowerCase()}`;
  } else {
    dl.removeAttribute('href');
    dl.setAttribute('aria-disabled', 'true');
    dl.textContent = 'Download';
  }
  copy.disabled = !sel?.url;

  el.querySelector<HTMLElement>('.variants')!.hidden = item.status === 'error';
  for (const v of VARIANTS[item.settings.format]) renderVariant(item, v);
}

function renderVariant(item: Item, v: Variant) {
  const b = item.el.querySelector<HTMLButtonElement>(`.variant[data-variant="${v}"]`);
  if (!b) return;
  const r = item.variants[v];
  const size = b.querySelector<HTMLElement>('.v-size')!;
  const detail = b.querySelector<HTMLElement>('.v-detail')!;
  const bar = b.querySelector<HTMLElement>('.v-bar > i')!;
  b.setAttribute('aria-checked', String(item.selected === v));
  b.classList.toggle('selected', item.selected === v);
  const worse = r?.data ? worseReason(item, r) : null;
  b.classList.toggle('worse', !!worse);
  if (r?.error) {
    b.dataset.state = 'error';
    b.disabled = true;
    size.textContent = 'Not possible';
    detail.textContent = r.error;
    b.title = r.error;
  } else if (r?.data) {
    b.dataset.state = 'done';
    b.disabled = false;
    const pct = (r.size / item.source.input.length - 1) * 100;
    size.innerHTML = `${formatBytes(r.size)} <span class="pct ${pct <= 0 ? 'good' : 'bad'}">${pct <= 0 ? '' : '+'}${pct.toFixed(0)}%</span>`;
    const quality = v === 'lossless' || r.score === undefined ? (r.keptOriginal ? 'original kept' : 'exact') : `score ${r.score.toFixed(1)}`;
    const missed = missedTarget(r);
    // A palette that misses the target ran out of colours (256 max), so say that rather than a generic miss.
    const why = v === 'quantized' ? 'too many colours' : 'below target';
    detail.textContent = missed ? `${quality} · ${why}` : [quality, r.setting].filter(Boolean).join(' · ');
    b.title = [worse, r.description, r.setting, ...r.warnings].filter(Boolean).join('\n');
    if (missed) b.dataset.state = 'warn';
  } else {
    const working = item.running.has(v);
    b.dataset.state = working ? 'working' : 'queued';
    b.disabled = true;
    size.textContent = working ? 'Working…' : 'Waiting';
    detail.textContent = '';
    bar.style.width = `${Math.round((item.progress[v] ?? 0) * 100)}%`;
  }
}

/** Why a finished version is pointless (bigger than the lossless one, or than the original), or null. */
function worseReason(item: Item, r: VariantResult): string | null {
  if (r.size > item.source.input.length) return 'Bigger than the original file';
  const lossless = item.variants.lossless;
  if (r.variant !== 'lossless' && lossless?.data && r.size > lossless.size) return 'Bigger than the lossless version';
  return null;
}

function summarize() {
  const chosen = items.filter((i) => i.selected && i.variants[i.selected]?.data);
  const busy = items.some((i) => i.status === 'queued' || i.status === 'working');
  $('results').hidden = items.length === 0;
  const zip = $<HTMLButtonElement>('zip');
  zip.disabled = !chosen.length;
  zip.textContent = chosen.length > 1 ? `Download selected (${chosen.length})` : 'Download selected';
  $<HTMLButtonElement>('compare-open').disabled = !comparableSources().length;
  const s = $('summary');
  const jobs = `${items.length} ${items.length === 1 ? 'job' : 'jobs'}`;
  s.textContent = busy ? `${jobs} · working…` : jobs;
}

// ---------- data URL ----------

function toDataUrl(v: VariantResult): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([v.data as BlobPart], { type: v.mimeType }));
  });
}

async function copyDataUrl(item: Item, button: HTMLButtonElement) {
  const v = item.selected ? item.variants[item.selected] : undefined;
  if (!v?.data) return;
  const label = 'Copy data URL';
  let message: string;
  try {
    const url = await toDataUrl(v);
    await navigator.clipboard.writeText(url);
    message = `Copied ${formatBytes(url.length)}`;
  } catch {
    message = 'Copy failed';
  }
  button.textContent = message;
  setTimeout(() => (button.textContent = label), 1600);
}

// ---------- compare dialog ----------

interface CompareSource {
  key: string;
  label: string;
  url: string;
}

/** The original plus every finished version of every job made from the same source image. */
function compareSources(source: Source): CompareSource[] {
  const out: CompareSource[] = [{ key: 'original', label: `Original · ${formatBytes(source.input.length)}`, url: source.url }];
  const jobs = items.filter((i) => i.source === source);
  for (const item of jobs) {
    // Name the job only when another job of the same format could be confused with it.
    const sameFormat = jobs.filter((j) => j.settings.format === item.settings.format).length > 1;
    const which = sameFormat ? ` (${settingsLabel(item.settings).split(' · ').slice(1).join(', ')})` : '';
    for (const variant of VARIANTS[item.settings.format]) {
      const v = item.variants[variant];
      if (!v?.url) continue;
      const score = variant !== 'lossless' && v.score !== undefined ? ` · ${v.score.toFixed(1)}` : '';
      out.push({
        key: `${item.id}:${variant}`,
        label: `${FORMAT_LABEL[item.settings.format]} ${VARIANT_LABEL[variant].toLowerCase()}${which} · ${formatBytes(v.size)}${score}`,
        url: v.url,
      });
    }
  }
  return out;
}

let compareSource: Source | null = null;

/** Source images that have at least one finished version, in the order their jobs appear. */
function comparableSources(): Source[] {
  const out: Source[] = [];
  for (const i of items) if (!out.includes(i.source) && Object.values(i.variants).some((v) => v?.url)) out.push(i.source);
  return out;
}

function openCompare() {
  const choices = comparableSources();
  if (!choices.length) return;
  const picker = $<HTMLSelectElement>('compare-image');
  picker.replaceChildren(...choices.map((s, i) => new Option(s.file.name, String(i))));
  picker.hidden = choices.length === 1;
  $('compare-title').hidden = choices.length > 1;
  pickCompareImage(choices[0]);
  setCompare(50);
  $<HTMLDialogElement>('compare').showModal();
}

function pickCompareImage(source: Source) {
  compareSource = source;
  $('compare-title').textContent = source.file.name;
  const options = compareSources(source);
  // Left defaults to the original, right to the first job's selected version.
  const first = items.find((i) => i.source === source && i.selected && i.variants[i.selected]?.url);
  const right = first ? `${first.id}:${first.selected}` : options[1]?.key;
  for (const [id, initial] of [['compare-left', 'original'], ['compare-right', right]] as const) {
    $<HTMLSelectElement>(id).replaceChildren(...options.map((s) => new Option(s.label, s.key, false, s.key === initial)));
  }
  showCompareSides();
}

function showCompareSides() {
  if (!compareSource) return;
  const options = compareSources(compareSource);
  const url = (id: string) => options.find((s) => s.key === $<HTMLSelectElement>(id).value)?.url ?? compareSource!.url;
  $<HTMLImageElement>('compare-before').src = url('compare-left');
  $<HTMLImageElement>('compare-after').src = url('compare-right');
}

let comparePct = 50;
function setCompare(pct: number) {
  comparePct = Math.max(0, Math.min(100, pct));
  $('compare-before-wrap').style.clipPath = `inset(0 ${100 - comparePct}% 0 0)`;
  const handle = $('compare-handle');
  handle.style.left = `${comparePct}%`;
  handle.setAttribute('aria-valuenow', String(Math.round(comparePct)));
}

function initCompare() {
  const dlg = $<HTMLDialogElement>('compare');
  $('compare-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => (compareSource = null));
  $('compare-image').addEventListener('change', (e) => pickCompareImage(comparableSources()[Number((e.target as HTMLSelectElement).value)]));
  $('compare-left').addEventListener('change', showCompareSides);
  $('compare-right').addEventListener('change', showCompareSides);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  // The divider line itself is what you drag.
  const stage = $('compare-stage');
  const handle = $('compare-handle');
  const move = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    setCompare(((e.clientX - r.left) / r.width) * 100);
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (handle.hasPointerCapture(e.pointerId)) move(e);
  });
  const stop = () => handle.classList.remove('dragging');
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const next = { ArrowLeft: comparePct - step, ArrowRight: comparePct + step, Home: 0, End: 100 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setCompare(next);
  });
}

// ---------- input ----------

function initInput() {
  const drop = $('drop');
  const input = $<HTMLInputElement>('file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files) void addFiles(input.files);
    input.value = '';
  });
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) void addFiles(files.map((f, i) => (f.name ? f : new File([f], `pasted-${i + 1}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type }))));
  });

  $('compress').addEventListener('click', compress);
  $('compare-open').addEventListener('click', openCompare);
  $('clear-sources').addEventListener('click', () => [...sources].forEach(removeSource));
  $('clear').addEventListener('click', () => [...items].forEach(removeItem));
  $('zip').addEventListener('click', () => {
    const chosen = items.flatMap((i) => {
      const v = i.selected ? i.variants[i.selected] : undefined;
      return v?.data ? [{ name: outputName(i.source.file.name, v), v, el: i.el }] : [];
    });
    if (chosen.length === 1) {
      chosen[0].el.querySelector<HTMLAnchorElement>('.download')!.click();
      return;
    }
    const files: Record<string, Uint8Array> = {};
    for (const c of chosen) {
      let name = c.name;
      for (let n = 2; files[name]; n++) name = c.name.replace(/(\.[^.]+)$/, `-${n}$1`);
      files[name] = c.v.data!;
    }
    const zip = zipSync(files, { level: 0 });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    a.download = 'sqz.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });
}

// ---------- boot ----------

$('version').textContent = version;
for (let i = 0; i < POOL_SIZE; i++) slots.push({ worker: spawn(), task: null });
initSettings();
initCompare();
initInput();
