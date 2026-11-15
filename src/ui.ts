import crypto from 'node:crypto';
import type { Size } from './orient.js';

/**
 * The phone's UI for an agent: WebDriverAgent's /source tree (format=json) flattened to a short list of the things on
 * screen, in normalized upright coordinates (0..1 of the picture as a person sees it), plus every visible string in
 * reading order. Pure: the server fetches the tree (src/agent.ts) and this turns it into something small enough to
 * read and precise enough to tap.
 */

export interface UiElement {
  /** Where it sits in the tree ("0.2.1": the root's 3rd child's 2nd child). Stable while the screen's structure is. */
  id: string;
  /** XCUIElementType without the prefix: Button, StaticText, TextField, Cell, Switch... */
  type: string;
  label: string | null;
  /** The accessibility identifier (or name). */
  name: string | null;
  value: string | null;
  /** Normalized upright rectangle: x, y its top left, w, h its size (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
  visible: boolean;
  /** WDA's word when its tree has one; else visible, enabled and its middle on the screen. */
  hittable: boolean;
}

export interface UiTree {
  elements: UiElement[];
  /** Every visible string, top to bottom then left to right, one per line. */
  text: string;
  lines: string[];
  /** Elements in the tree before filtering and the cap. */
  total: number;
  /** The list or the text was cut at the cap. */
  truncated: boolean;
  /** Changes when what's on screen does (types, strings and places). */
  hash: string;
}

export interface FlattenOptions {
  /** Every element, the invisible and the nameless containers too (still capped). */
  all?: boolean;
  /** At most this many elements (default 400). */
  max?: number;
  /** At most this many characters of text (default 6000). */
  maxText?: number;
}

export const UI_MAX_ELEMENTS = 400;
export const UI_MAX_TEXT = 6000;
const MAX_STRING = 200;
const MAX_DEPTH = 80;
const ROW_TOLERANCE = 0.012; // middles this close (of the screen's height) read as one line

const INTERACTIVE = new Set([
  'button', 'link', 'textfield', 'securetextfield', 'searchfield', 'textview', 'switch', 'toggle', 'slider', 'cell', 'icon', 'key',
  'tab', 'menuitem', 'stepper', 'picker', 'pickerwheel', 'segmentedcontrol', 'checkbox', 'radiobutton', 'pageindicator', 'datepicker',
]);

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');
const round4 = (v: number) => Math.round(v * 10000) / 10000;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_STRING) : null;
}

function typeOf(v: unknown): string {
  return String(v ?? 'Other').replace(/^XCUIElementType/, '') || 'Other';
}

/** A node's rectangle in points: `rect` {x, y, width, height}, else the `frame` string "{{x, y}, {w, h}}". */
function rectOf(n: Record<string, unknown>): { x: number; y: number; width: number; height: number } | null {
  const r = n.rect as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    const [x, y, w, h] = [Number(r.x), Number(r.y), Number(r.width), Number(r.height)];
    if ([x, y, w, h].every(Number.isFinite)) return { x, y, width: w, height: h };
  }
  if (typeof n.frame === 'string') {
    const m = n.frame.match(/-?\d+(?:\.\d+)?/g);
    if (m && m.length >= 4) return { x: Number(m[0]), y: Number(m[1]), width: Number(m[2]), height: Number(m[3]) };
  }
  return null;
}

/** Top to bottom, then left to right; middles within ROW_TOLERANCE of a row's first count as that row. */
export function readingOrder<T extends { x: number; y: number; w: number; h: number }>(list: T[]): T[] {
  const sorted = [...list].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const out: T[] = [];
  let row: T[] = [];
  let rowY = -Infinity;
  const flush = () => {
    row.sort((a, b) => a.x - b.x || a.y - b.y);
    out.push(...row);
    row = [];
  };
  for (const e of sorted) {
    const cy = e.y + e.h / 2;
    if (row.length && cy - rowY > ROW_TOLERANCE) flush();
    if (!row.length) rowY = cy;
    row.push(e);
  }
  flush();
  return out;
}

const overlaps = (a: UiElement, b: UiElement) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Flatten WDA's source tree. `screen` is the upright screen in points (the backend's); without it the root's own
 * rectangle is the screen.
 */
export function flattenUi(root: unknown, screen: Size | null, opts: FlattenOptions = {}): UiTree {
  const max = Math.max(1, Math.min(5000, opts.max ?? UI_MAX_ELEMENTS));
  const maxText = Math.max(100, opts.maxText ?? UI_MAX_TEXT);
  const elements: UiElement[] = [];
  let total = 0;
  let truncated = false;
  const top = root && typeof root === 'object' ? (root as Record<string, unknown>) : null;
  const rootRect = top ? rectOf(top) : null;
  const W = screen && screen.width > 0 ? screen.width : rootRect && rootRect.width > 0 ? rootRect.width : 0;
  const H = screen && screen.height > 0 ? screen.height : rootRect && rootRect.height > 0 ? rootRect.height : 0;

  const walk = (n: Record<string, unknown>, id: string, depth: number): void => {
    total++;
    const r = rectOf(n);
    const type = typeOf(n.type);
    const label = str(n.label);
    const name = str(n.name) ?? str(n.rawIdentifier) ?? str(n.identifier);
    const value = str(n.value);
    const visible = n.isVisible === undefined && n.visible === undefined ? true : truthy(n.isVisible ?? n.visible);
    const enabled = n.isEnabled === undefined && n.enabled === undefined ? true : truthy(n.isEnabled ?? n.enabled);
    if (r && W > 0 && H > 0) {
      const x = round4(r.x / W);
      const y = round4(r.y / H);
      const w = round4(r.width / W);
      const h = round4(r.height / H);
      const cx = x + w / 2;
      const cy = y + h / 2;
      const onScreen = w > 0 && h > 0 && cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1;
      const said = n.isHittable ?? n.hittable;
      const hittable = said !== undefined ? truthy(said) : visible && enabled && onScreen;
      const worth = visible && w > 0 && h > 0 && (!!label || !!value || !!name || INTERACTIVE.has(type.toLowerCase()));
      const container = type === 'Application' || type === 'Window';
      if (opts.all || (worth && !container)) {
        if (elements.length < max) elements.push({ id, type, label, name, value, x, y, w, h, enabled, visible, hittable });
        else truncated = true;
      }
    }
    const kids = Array.isArray(n.children) ? n.children : [];
    if (depth >= MAX_DEPTH) return;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k && typeof k === 'object') walk(k as Record<string, unknown>, `${id}.${i}`, depth + 1);
    }
  };
  if (top) walk(top, '0', 0);

  // the strings, in reading order; the same string again over the same spot (a cell and its label) reads once
  const lines: string[] = [];
  const seen = new Map<string, UiElement[]>();
  let chars = 0;
  for (const e of readingOrder(elements.filter((e) => e.visible && e.w > 0 && e.h > 0))) {
    const strings = [e.label, e.value].filter((s): s is string => !!s);
    if (!strings.length && e.name && !/^[\w.-]+$/.test(e.name)) strings.push(e.name); // a name that reads like words, not an identifier
    for (const s of new Set(strings)) {
      const before = seen.get(s);
      if (before?.some((b) => overlaps(b, e))) continue;
      if (before) before.push(e);
      else seen.set(s, [e]);
      if (chars + s.length + 1 > maxText) {
        truncated = true;
        continue;
      }
      chars += s.length + 1;
      lines.push(s);
    }
  }
  const h = crypto.createHash('sha1');
  for (const e of elements) h.update(`${e.type}|${e.label ?? ''}|${e.value ?? ''}|${e.x.toFixed(3)}|${e.y.toFixed(3)}|${e.w.toFixed(3)}|${e.h.toFixed(3)}|${e.enabled ? 1 : 0}\n`);
  return { elements, text: lines.join('\n'), lines, total, truncated, hash: h.digest('hex').slice(0, 16) };
}

/** Which element: `id` (from GET /ui), or its `label`, `name` or any of its strings (`text`); `index` picks among several. */
export interface ElementQuery {
  id?: string;
  label?: string;
  name?: string;
  text?: string;
  type?: string;
  /** Which match, 0-based, in reading order (default 0). */
  index?: number;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The first rung that has matches: equal, then starts with, then contains. */
function tiers(elements: UiElement[], want: string, fields: (e: UiElement) => (string | null)[]): UiElement[] {
  const w = norm(want);
  if (!w) return [];
  const tests: ((s: string) => boolean)[] = [(s) => s === w, (s) => s.startsWith(w), (s) => s.includes(w)];
  for (const t of tests) {
    const hit = elements.filter((e) => fields(e).some((f) => f !== null && t(norm(f))));
    if (hit.length) return hit;
  }
  return [];
}

/**
 * The elements a query means, best first: hittable ones when any are, a control rather than the text inside it when
 * both match at one spot, then reading order. Empty when nothing matches.
 */
export function findElements(elements: UiElement[], q: ElementQuery): UiElement[] {
  let hit: UiElement[];
  if (typeof q.id === 'string' && q.id) hit = elements.filter((e) => e.id === q.id);
  else if (typeof q.label === 'string' && q.label) hit = tiers(elements, q.label, (e) => [e.label]);
  else if (typeof q.name === 'string' && q.name) hit = tiers(elements, q.name, (e) => [e.name]);
  else if (typeof q.text === 'string' && q.text) hit = tiers(elements, q.text, (e) => [e.label, e.value, e.name]);
  else return [];
  if (typeof q.type === 'string' && q.type) {
    const t = q.type.replace(/^XCUIElementType/i, '').toLowerCase();
    hit = hit.filter((e) => e.type.toLowerCase() === t);
  }
  if (q.id) return hit;
  if (hit.some((e) => e.hittable)) hit = hit.filter((e) => e.hittable);
  // one thing on screen is often several nodes (a cell, its button, the button's text): keep the control, else the smallest
  const rank = (e: UiElement) => (INTERACTIVE.has(e.type.toLowerCase()) ? 0 : 1);
  const kept: UiElement[] = [];
  for (const e of [...hit].sort((a, b) => rank(a) - rank(b) || a.w * a.h - b.w * b.h)) {
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    const dup = kept.some((k) => (cx >= k.x && cx <= k.x + k.w && cy >= k.y && cy <= k.y + k.h) || (k.x + k.w / 2 >= e.x && k.x + k.w / 2 <= e.x + e.w && k.y + k.h / 2 >= e.y && k.y + k.h / 2 <= e.y + e.h));
    if (!dup) kept.push(e);
  }
  return readingOrder(kept);
}

/** The middle of an element, normalized upright, kept on the screen. */
export function centerOf(e: UiElement): [number, number] {
  const c = (v: number) => Math.min(0.999, Math.max(0.001, v));
  return [c(e.x + e.w / 2), c(e.y + e.h / 2)];
}

/** A query in words, for error messages. */
export function describeQuery(q: ElementQuery): string {
  const by = q.id ? `id ${JSON.stringify(q.id)}` : q.label ? `label ${JSON.stringify(q.label)}` : q.name ? `name ${JSON.stringify(q.name)}` : q.text ? `text ${JSON.stringify(q.text)}` : 'nothing';
  return `${by}${q.type ? ` of type ${q.type}` : ''}${q.index ? ` (index ${q.index})` : ''}`;
}
