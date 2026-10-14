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
  jpeg: ['lossy'],
};
const VARIANT_LABEL: Record<Variant, string> = { lossless: 'Lossless', quantized: 'Quantized', lossy: 'Lossy' };
const FORMAT_LABEL: Record<OutputFormat, string> = { png: 'PNG', webp: 'WebP', avif: 'AVIF', gif: 'GIF', jpeg: 'JPEG' };
const EXTENSION: Record<OutputFormat, string> = { png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', jpeg: 'jpg' };
const FORMAT_HINTS: Record<OutputFormat, string> = {
  png: 'Animations become APNG. Lossy versions: a ≤256-colour palette, and truecolor lossy filtering. HDR stays HDR (16-bit PQ) in the lossless version only.',
  webp: 'Animations stay animated. Lossy versions: a ≤256-colour palette stored losslessly, and regular lossy WebP. SDR only: HDR is tone mapped.',
  avif: 'Best for photos; animations become AVIF image sequences. Lossy version: regular lossy AVIF (4:4:4 when 4:2:0 can’t reach the target). HDR stays HDR: gain maps are kept, PQ/HLG uses 10–12 bits.',
  gif: 'At most 256 colours and no partial transparency, so lossless only works for images that already fit.',
  jpeg: 'Lossy only, no animations; transparency is filled with white. HDR images become Ultra HDR JPEGs: an SDR photo plus a gain map.',
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
  stripHdr: boolean;
}
const DEFAULTS: Settings = { format: 'png', target: 80, dither: true, max: false, strip: false, stripHdr: false };
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
const settingsKey = (s: Settings) => `${s.format}|${s.target}|${s.dither}|${s.max}|${s.strip}|${s.stripHdr}`;

/** Short description of the settings a job ran with, e.g. "WebP · target 80 · max effort". */
function settingsLabel(s: Settings): string {
  const parts = [FORMAT_LABEL[s.format], `target ${s.target}`];
  if (!s.dither) parts.push('no dithering');
  if (s.max) parts.push('max effort');
  if (s.strip) parts.push('stripped');
  if (s.stripHdr) parts.push('SDR only');
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
  for (const [key, id] of [['dither', 'dither'], ['max', 'max'], ['strip', 'strip'], ['stripHdr', 'strip-hdr']] as const) {
    const box = $<HTMLInputElement>(id);
    box.checked = settings[key];
    box.addEventListener('change', () => {
      settings[key] = box.checked;
      settingsChanged();
    });
  }
  syncSettingsUi();
}

// ---------- source images ----------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resize, then crop (in resized pixels). Only ever applied to the copy a job compresses. */
interface Edit {
  resize?: { width: number; height: number };
  crop?: Rect;
}

interface Source {
  file: File;
  input: Uint8Array;
  url: string;
  el: HTMLLIElement;
  /** Removed from the source list; its URL lives on while results still show it. */
  removed: boolean;
  /** Size as the browser shows it (EXIF orientation applied, like sqz's decoder); 0 if it can't. */
  width: number;
  height: number;
  edit?: Edit;
  /** Lossless renders of the original with an edit applied, for comparing edited jobs; by editKey. */
  references: Map<string, { url?: string }>;
}
const sources: Source[] = [];

const editKey = (e?: Edit) =>
  e ? `${e.resize ? `${e.resize.width}x${e.resize.height}` : ''}|${e.crop ? `${e.crop.x},${e.crop.y},${e.crop.width},${e.crop.height}` : ''}` : '';

/** Output size of an edit, e.g. "600×400" or "300×200 crop". */
function editLabel(source: Source, e: Edit): string {
  const size = e.crop ?? e.resize ?? { width: source.width, height: source.height };
  return `${size.width}×${size.height}${e.crop ? ' crop' : ''}`;
}

const ICON_CROP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

const ACCEPT = /\.(png|apng|gif|webp|avif|jpe?g)$/i;
async function addFiles(files: Iterable<File>) {
  for (const file of files) {
    if (!ACCEPT.test(file.name) && !/^image\/(png|apng|gif|webp|avif|jpeg)$/.test(file.type)) continue;
    const el = document.createElement('li');
    el.className = 'source';
    el.innerHTML = `<div class="thumb small"><img alt="" /></div><div class="info"><div class="name"></div><div class="meta"></div></div>
      <div class="source-actions">
        <button type="button" class="ghost icon edit" title="Resize or crop" aria-pressed="false" disabled>${ICON_CROP}</button>
        <button type="button" class="ghost icon remove" title="Remove">${ICON_TRASH}</button>
      </div>`;
    const source: Source = {
      file,
      input: new Uint8Array(await file.arrayBuffer()),
      url: URL.createObjectURL(file),
      el,
      removed: false,
      width: 0,
      height: 0,
      references: new Map(),
    };
    el.querySelector('img')!.src = source.url;
    el.querySelector('.name')!.textContent = file.name;
    el.querySelector<HTMLButtonElement>('.edit')!.setAttribute('aria-label', `Resize or crop ${file.name}`);
    el.querySelector<HTMLButtonElement>('.remove')!.setAttribute('aria-label', `Remove ${file.name}`);
    el.querySelector('.edit')!.addEventListener('click', () => openEdit(source));
    el.querySelector('.remove')!.addEventListener('click', () => removeSource(source));
    sources.push(source);
    $('source-list').append(el);
    renderSource(source);
    void measure(source);
  }
  syncCompressButton();
}

/** Learn the image size from the browser, which the resize/crop dialog needs. */
async function measure(source: Source) {
  const probe = new Image();
  try {
    // The load event, not decode(): decode() waits while the tab is in the background.
    await new Promise((resolve, reject) => {
      probe.onload = resolve;
      probe.onerror = reject;
      probe.src = source.url;
    });
    source.width = probe.naturalWidth;
    source.height = probe.naturalHeight;
  } catch {
    source.el.querySelector<HTMLButtonElement>('.edit')!.title = 'This browser cannot preview the image, so it cannot be resized or cropped here';
  }
  renderSource(source);
}

function renderSource(source: Source) {
  const meta = source.el.querySelector<HTMLElement>('.meta')!;
  const dims = source.width ? ` · ${source.width}×${source.height}` : '';
  meta.textContent = formatBytes(source.input.length) + dims;
  if (source.edit) {
    const tag = document.createElement('span');
    tag.className = 'edited';
    tag.textContent = ` → ${editLabel(source, source.edit)}`;
    meta.append(tag);
  }
  const button = source.el.querySelector<HTMLButtonElement>('.edit')!;
  button.disabled = !source.width;
  button.setAttribute('aria-pressed', String(!!source.edit));
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
  if (source.removed && !items.some((i) => i.source === source)) {
    URL.revokeObjectURL(source.url);
    for (const r of source.references.values()) if (r.url) URL.revokeObjectURL(r.url);
  }
}

function syncCompressButton() {
  const button = $<HTMLButtonElement>('compress');
  const n = sources.length;
  $('sources').hidden = n === 0;
  button.disabled = n === 0;
  button.textContent = n ? `Compress ${n === 1 ? '1 image' : `${n} images`} to ${FORMAT_LABEL[settings.format]}` : 'Compress';
  const key = settingsKey(settings);
  const done = sources.filter((s) => items.some((i) => i.source === s && jobKey(i) === key + editKey(s.edit) && i.status !== 'error')).length;
  $('compress-note').textContent = done === n && n ? 'Already compressed with these settings; change a setting to add another version.' : done ? `${done} already done with these settings will be skipped.` : '';
}

const jobKey = (i: Item) => settingsKey(i.settings) + editKey(i.edit);

/** One new job per source image, with a frozen copy of the current settings and edit. Identical jobs are skipped. */
function compress() {
  const snapshot = { ...settings };
  const key = settingsKey(snapshot);
  let added = 0;
  for (const source of sources) {
    if (items.some((i) => i.source === source && jobKey(i) === key + editKey(source.edit) && i.status !== 'error')) continue;
    addItem(source, snapshot, source.edit);
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
  /** The source's resize/crop when the job was made; edits made later don't affect it. */
  edit?: Edit;
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

function addItem(source: Source, s: Settings, edit?: Edit) {
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
  const item: Item = { id: ++itemCounter, source, settings: s, edit, status: 'queued', progress: {}, variants: {}, el, running: new Set(), pending: 0 };
  const label = jobLabel(item);
  el.querySelector('.file')!.textContent = source.file.name;
  el.querySelector('.job-tag')!.textContent = label;
  el.querySelector('.remove')!.setAttribute('aria-label', `Remove ${source.file.name} (${label})`);
  if (edit) ensureReference(source, edit);
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
    item.variants[variant] ??= { variant, format, size: 0, mimeType: '', extension: EXTENSION[format], description: '', keptOriginal: false, warnings: [], error };
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
      stripHdr: s.stripHdr,
      effort: s.max ? 'max' : 'default',
      resize: item.edit?.resize,
      crop: item.edit?.crop,
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

const outputName = (name: string, v: VariantResult) =>
  `${name.replace(/\.[^.]+$/, '')}${v.variant === 'lossless' || VARIANTS[v.format].length === 1 ? '' : `.${v.variant}`}.${v.extension}`;

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
  else {
    const hdr = info?.hdr ? ` · HDR ${info.hdr}${item.settings.stripHdr ? ' (stripped)' : ''}` : '';
    meta.textContent = `${size}${info ? ` · ${info.width}×${info.height}${info.frames > 1 ? ` · ${info.frames} frames` : ''}${hdr}` : ''}`;
  }
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

const jobLabel = (item: Item) => settingsLabel(item.settings) + (item.edit ? ` · ${editLabel(item.source, item.edit)}` : '');

/**
 * A lossless render of the original with an edit applied, so edited jobs can be compared
 * pixel for pixel. Made once per distinct edit, in its own short-lived worker.
 */
function ensureReference(source: Source, edit: Edit) {
  const key = editKey(edit);
  if (source.references.has(key)) return;
  const ref: { url?: string } = {};
  source.references.set(key, ref);
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const v = e.data.variant;
    if (v?.data) {
      ref.url = URL.createObjectURL(new Blob([v.data as BlobPart], { type: v.mimeType }));
      if (compareSource === source) refreshCompare();
      summarize();
    }
    if (e.data.done || e.data.error !== undefined) w.terminate();
  };
  w.onerror = () => w.terminate();
  const options: ConvertOptions = { format: 'png', variants: ['lossless'], effort: 'fast', resize: edit.resize, crop: edit.crop };
  w.postMessage({ id: 0, input: source.input.slice(), options });
}

/** The original, the original as each edit leaves it, and every finished version of every job made from it. */
function compareSources(source: Source): CompareSource[] {
  const out: CompareSource[] = [{ key: 'original', label: `Original · ${formatBytes(source.input.length)}`, url: source.url }];
  const jobs = items.filter((i) => i.source === source);
  for (const [key, ref] of source.references) {
    const job = jobs.find((j) => editKey(j.edit) === key);
    if (ref.url && job?.edit) out.push({ key: `ref:${key}`, label: `Original, ${editLabel(source, job.edit)}`, url: ref.url });
  }
  for (const item of jobs) {
    // Name the job only when another job of the same format could be confused with it.
    const sameFormat = jobs.filter((j) => j.settings.format === item.settings.format).length > 1;
    const which = sameFormat ? ` (${jobLabel(item).split(' · ').slice(1).join(', ')})` : '';
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

/** What to compare a version against by default: the original, edited the same way if it was. */
function defaultLeft(source: Source, rightKey: string | undefined): string {
  const item = items.find((i) => i.source === source && rightKey?.startsWith(`${i.id}:`));
  const ref = item?.edit && `ref:${editKey(item.edit)}`;
  return ref && compareSources(source).some((s) => s.key === ref) ? ref : 'original';
}

function fillCompareSelects(source: Source, left: string, right: string | undefined) {
  const options = compareSources(source);
  for (const [id, initial] of [['compare-left', left], ['compare-right', right]] as const) {
    $<HTMLSelectElement>(id).replaceChildren(...options.map((s) => new Option(s.label, s.key, false, s.key === initial)));
  }
  showCompareSides();
}

function pickCompareImage(source: Source) {
  compareSource = source;
  $('compare-title').textContent = source.file.name;
  const options = compareSources(source);
  // Left defaults to the original, right to the first job's selected version.
  const first = items.find((i) => i.source === source && i.selected && i.variants[i.selected]?.url);
  const right = first ? `${first.id}:${first.selected}` : options[1]?.key;
  fillCompareSelects(source, defaultLeft(source, right), right);
}

/** An edited original became ready: offer it, and switch to it if the plain original was only a stand-in. */
function refreshCompare() {
  if (!compareSource) return;
  const left = $<HTMLSelectElement>('compare-left').value;
  const right = $<HTMLSelectElement>('compare-right').value;
  fillCompareSelects(compareSource, left === 'original' ? defaultLeft(compareSource, right) : left, right);
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

// ---------- resize & crop dialog ----------

const MAX_SIDE = 32768;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The dialog's working state; only Apply copies it onto the source. */
interface Draft {
  width: number;
  height: number;
  keep: boolean;
  crop: Rect;
}
let editSource: Source | null = null;
let draft: Draft = { width: 1, height: 1, keep: true, crop: { x: 0, y: 0, width: 1, height: 1 } };

const fullCrop = (d: { width: number; height: number }): Rect => ({ x: 0, y: 0, width: d.width, height: d.height });
const isFull = (r: Rect, d: { width: number; height: number }) => r.x === 0 && r.y === 0 && r.width === d.width && r.height === d.height;

/** Keep a rectangle whole-pixel, at least 1×1, and inside a width × height image. */
function fitRect(r: Rect, width: number, height: number): Rect {
  const w = clamp(Math.round(r.width), 1, width);
  const h = clamp(Math.round(r.height), 1, height);
  return { x: clamp(Math.round(r.x), 0, width - w), y: clamp(Math.round(r.y), 0, height - h), width: w, height: h };
}

function openEdit(source: Source) {
  if (!source.width) return;
  editSource = source;
  const size = source.edit?.resize ?? { width: source.width, height: source.height };
  const keep = Math.round((size.width * source.height) / source.width) === size.height || Math.round((size.height * source.width) / source.height) === size.width;
  draft = { ...size, keep, crop: source.edit?.crop ?? fullCrop(size) };
  $('edit-title').textContent = `Resize and crop · ${source.file.name}`;
  $<HTMLImageElement>('edit-img').src = source.url;
  $<HTMLInputElement>('rs-keep').checked = keep;
  $<HTMLDialogElement>('edit').showModal();
  syncEdit();
}

/** Change the resize target; the crop scales with it so it keeps framing the same content. */
function setResize(width: number, height: number) {
  const c = draft.crop;
  const sx = width / draft.width;
  const sy = height / draft.height;
  draft.crop = isFull(c, draft) ? fullCrop({ width, height }) : fitRect({ x: c.x * sx, y: c.y * sy, width: c.width * sx, height: c.height * sy }, width, height);
  draft.width = width;
  draft.height = height;
}

/** Fit the preview to the stage at the resized image's aspect ratio. */
function layoutEdit() {
  const stage = $('edit-stage');
  const canvas = $('edit-canvas');
  const pad = 40;
  const availW = Math.max(80, stage.clientWidth - pad);
  const availH = Math.max(80, Math.min(window.innerHeight * 0.62, 620) - pad);
  const scale = Math.min(availW / draft.width, availH / draft.height);
  canvas.style.width = `${Math.max(1, Math.round(draft.width * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.round(draft.height * scale))}px`;
}

/** Push the draft into the preview and every field except the one being typed in. */
function syncEdit(typing?: HTMLInputElement) {
  const src = editSource!;
  layoutEdit();
  const c = draft.crop;
  for (const el of [$('crop'), $('crop-hole')]) {
    el.style.left = `${(c.x / draft.width) * 100}%`;
    el.style.top = `${(c.y / draft.height) * 100}%`;
    el.style.width = `${(c.width / draft.width) * 100}%`;
    el.style.height = `${(c.height / draft.height) * 100}%`;
  }
  const fields: [string, number, number, number][] = [
    ['rs-w', draft.width, 1, MAX_SIDE],
    ['rs-h', draft.height, 1, MAX_SIDE],
    ['cr-x', c.x, 0, draft.width - 1],
    ['cr-y', c.y, 0, draft.height - 1],
    ['cr-w', c.width, 1, draft.width],
    ['cr-h', c.height, 1, draft.height],
  ];
  for (const [id, value, min, max] of fields) {
    const input = $<HTMLInputElement>(id);
    input.min = String(min);
    input.max = String(max);
    if (input !== typing) {
      input.value = String(value);
      input.removeAttribute('aria-invalid');
    }
  }
  const sx = draft.width / src.width;
  const sy = draft.height / src.height;
  const how = (s: number) => (s < 1 ? 'Lanczos' : s > 1 ? 'bicubic' : '');
  const methods = [...new Set([how(sx), how(sy)].filter(Boolean))];
  $('rs-note').textContent = methods.length
    ? `${Math.round(sx * 100)}%${sx !== sy ? ` × ${Math.round(sy * 100)}%` : ''} of ${src.width}×${src.height}, ${methods.join(' and ')}`
    : `Original size, ${src.width}×${src.height}`;
  $('edit-out').textContent = `Output ${c.width}×${c.height}${isFull(c, draft) ? '' : `, cropped from ${draft.width}×${draft.height}`}`;
}

/** A field's whole-number value, or null (marked invalid) when it isn't one in range. */
function readField(input: HTMLInputElement, min: number, max: number): number | null {
  const v = Number(input.value);
  const ok = input.value.trim() !== '' && Number.isInteger(v) && v >= min && v <= max;
  input.setAttribute('aria-invalid', String(!ok));
  return ok ? v : null;
}

function initEdit() {
  const dlg = $<HTMLDialogElement>('edit');
  const close = () => dlg.close();
  $('edit-close').addEventListener('click', close);
  $('edit-cancel').addEventListener('click', close);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener('close', () => (editSource = null));
  window.addEventListener('resize', () => {
    if (editSource) layoutEdit();
  });

  $('edit-apply').addEventListener('click', () => {
    const src = editSource!;
    const resized = draft.width !== src.width || draft.height !== src.height;
    const cropped = !isFull(draft.crop, draft);
    src.edit = resized || cropped ? { resize: resized ? { width: draft.width, height: draft.height } : undefined, crop: cropped ? { ...draft.crop } : undefined } : undefined;
    renderSource(src);
    syncCompressButton();
    close();
  });
  $('edit-reset').addEventListener('click', () => {
    const src = editSource!;
    draft = { width: src.width, height: src.height, keep: true, crop: fullCrop(src) };
    $<HTMLInputElement>('rs-keep').checked = true;
    syncEdit();
  });
  $('rs-reset').addEventListener('click', () => {
    setResize(editSource!.width, editSource!.height);
    syncEdit();
  });
  $('cr-reset').addEventListener('click', () => {
    draft.crop = fullCrop(draft);
    syncEdit();
  });

  const keep = $<HTMLInputElement>('rs-keep');
  keep.addEventListener('change', () => {
    draft.keep = keep.checked;
    // Turning it on snaps the height back to the original proportions.
    if (draft.keep) setResize(draft.width, clamp(Math.round((draft.width * editSource!.height) / editSource!.width), 1, MAX_SIDE));
    syncEdit();
  });
  for (const [id, axis] of [['rs-w', 'width'], ['rs-h', 'height']] as const) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      const v = readField(input, 1, MAX_SIDE);
      if (v === null) return;
      const src = editSource!;
      let { width, height } = draft;
      if (axis === 'width') {
        width = v;
        if (draft.keep) height = clamp(Math.round((v * src.height) / src.width), 1, MAX_SIDE);
      } else {
        height = v;
        if (draft.keep) width = clamp(Math.round((v * src.width) / src.height), 1, MAX_SIDE);
      }
      setResize(width, height);
      syncEdit(input);
    });
    input.addEventListener('change', () => syncEdit());
  }
  for (const [id, field] of [['cr-x', 'x'], ['cr-y', 'y'], ['cr-w', 'width'], ['cr-h', 'height']] as const) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      const c = draft.crop;
      const limit = { x: draft.width - c.width, y: draft.height - c.height, width: draft.width - c.x, height: draft.height - c.y }[field];
      const v = readField(input, field === 'x' || field === 'y' ? 0 : 1, limit);
      if (v === null) return;
      draft.crop = { ...c, [field]: v };
      syncEdit(input);
    });
    input.addEventListener('change', () => syncEdit());
  }

  // Pointer editing: drag inside the area to move it, a handle to resize it, elsewhere to draw a new one.
  const canvas = $('edit-canvas');
  const cropEl = $('crop');
  let mode: string | null = null;
  let pointer = -1;
  let start = { x: 0, y: 0 };
  let startRect: Rect = draft.crop;
  const toImage = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: clamp(((e.clientX - r.left) / r.width) * draft.width, 0, draft.width), y: clamp(((e.clientY - r.top) / r.height) * draft.height, 0, draft.height) };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // While the area is the whole image there's nothing to move, so a drag draws a new one.
    mode = target.dataset.h ?? (target === cropEl && !isFull(draft.crop, draft) ? 'move' : 'new');
    start = toImage(e);
    startRect = { ...draft.crop };
    pointer = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable (e.g. a synthetic event): moves over the canvas still work.
    }
    if (mode !== 'new') cropEl.focus();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!mode || e.pointerId !== pointer) return;
    const p = toImage(e);
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    const r = startRect;
    const W = draft.width;
    const H = draft.height;
    if (mode === 'move') {
      draft.crop = { ...r, x: clamp(Math.round(r.x + dx), 0, W - r.width), y: clamp(Math.round(r.y + dy), 0, H - r.height) };
    } else if (mode === 'new') {
      // A click without a drag leaves the current area alone.
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const x0 = Math.floor(Math.min(start.x, p.x));
      const y0 = Math.floor(Math.min(start.y, p.y));
      const x1 = Math.ceil(Math.max(start.x, p.x));
      const y1 = Math.ceil(Math.max(start.y, p.y));
      draft.crop = fitRect({ x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) }, W, H);
    } else {
      let left = r.x;
      let top = r.y;
      let right = r.x + r.width;
      let bottom = r.y + r.height;
      if (mode.includes('w')) left = clamp(Math.round(r.x + dx), 0, right - 1);
      if (mode.includes('e')) right = clamp(Math.round(right + dx), left + 1, W);
      if (mode.includes('n')) top = clamp(Math.round(r.y + dy), 0, bottom - 1);
      if (mode.includes('s')) bottom = clamp(Math.round(bottom + dy), top + 1, H);
      draft.crop = { x: left, y: top, width: right - left, height: bottom - top };
    }
    syncEdit();
  });
  const stop = () => (mode = null);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  // Keyboard: arrows move the area, Shift for 10 pixels.
  cropEl.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const c = draft.crop;
    draft.crop = { ...c, x: clamp(c.x + d[0], 0, draft.width - c.width), y: clamp(c.y + d[1], 0, draft.height - c.height) };
    syncEdit();
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
    // Copy first: clearing the input empties the live FileList while addFiles awaits.
    if (input.files) void addFiles([...input.files]);
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
    if (e.dataTransfer?.files.length) void addFiles([...e.dataTransfer.files]);
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
initEdit();
initInput();
