// Typing into the focused field (2026-11-18, cache/phones-type-contract.md in Lotus): the request, emptying the field
// in one go, and the read-back after typing. Pure parts here; the backends read and clear the field on the phone.
import { HttpError } from './types.js';

/** What `type` (POST /type, a socket message, an /act step) asks for. */
export interface TypeRequest {
  /** The text as it is ('' with `clear`: clear only). */
  text: string;
  /** Press Return after the text (after the read-back, so the check reads the field before a form is sent). */
  enter: boolean;
  /** Empty the focused field first, in one go. */
  clear: boolean;
}

/** The longest text one `type` takes. */
export const MAX_TYPE_TEXT = 20_000;

/** `{text, enter?, clear?}` from a `type` message; `{type: "clear"}` is `clear: true` with no text. */
export function parseTypeRequest(msg: Record<string, unknown>): TypeRequest {
  const clearOnly = msg.type === 'clear';
  const clear = clearOnly || msg.clear === true;
  const raw = clearOnly ? (msg.text ?? '') : msg.text;
  if (typeof raw !== 'string' && !(clear && raw === undefined)) throw new HttpError(400, '"text" must be a string');
  const text = typeof raw === 'string' ? raw : '';
  if (text.length > MAX_TYPE_TEXT) throw new HttpError(400, `"text" is longer than ${MAX_TYPE_TEXT} characters`);
  const enter = msg.enter === true;
  if (!text && !clear && !enter) throw new HttpError(400, '"text" is empty');
  return { text, enter, clear };
}

/**
 * The focused field as the phone reads it. `value` only for a field that isn't secure (a password field's text never
 * leaves the phone); `len` counts what the field holds (a placeholder shown in an empty field counts 0).
 */
export interface FieldState {
  found: boolean;
  secure: boolean;
  len: number | null;
  value?: string;
  /** After a clear: how it was emptied ("empty" = it already was), and whether it is empty now. */
  method?: string;
  cleared?: boolean;
}

/** The read-back after typing (the contract's `check`). */
export interface TypeCheck {
  /** The field holds what was typed (null: the field couldn't be read). */
  match: boolean | null;
  expected_len: number;
  value_len: number | null;
  secure: boolean;
}

/** The field's text in a response: never a secure field's, at most 200 characters. */
export const VALUE_CAP = 200;

/** Characters as the person sees them (an emoji or an accented letter counts once). */
export function visualLength(s: string): number {
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) n++;
  return n;
}

/** A field whose text is only bullets is a password field, whatever the phone called it. */
export function looksSecure(value: string | undefined): boolean {
  return !!value && /^[•●·*]+$/.test(value);
}

/** What the phone said of the field, made safe: a secure field (or one that looks like it) loses its text. */
export function safeField(f: FieldState | null): FieldState | null {
  if (!f) return null;
  const secure = f.secure || looksSecure(f.value);
  const out: FieldState = { found: f.found, secure, len: f.len };
  if (!secure && typeof f.value === 'string') out.value = f.value;
  if (f.method !== undefined) out.method = f.method;
  if (f.cleared !== undefined) out.cleared = f.cleared;
  return out;
}

/**
 * Whether the field holds what was typed, from the field before typing (`before`: after the clear, or as it was) and
 * after. Exact for an empty field (or one just cleared); with text already there, the typed text went in at the caret,
 * so it must be inside and the length must have grown by exactly its length. A secure field: lengths only.
 */
export function typeCheck(text: string, before: FieldState | null, after: FieldState | null): TypeCheck {
  const expected = visualLength(text);
  const b = safeField(before);
  const a = safeField(after);
  const secure = !!(a?.secure || b?.secure);
  if (!a || !a.found || a.len === null) return { match: null, expected_len: expected, value_len: null, secure };
  const base = b && b.found && b.len !== null ? b.len : null;
  let match: boolean | null;
  if (base === null) {
    // nothing known of before: only an exact field can be told
    match = secure ? (a.len === expected ? true : null) : a.value === text ? true : null;
  } else if (secure) {
    match = a.len === base + expected;
  } else if (base === 0) {
    match = a.value === text;
  } else {
    match = a.len === base + expected && typeof a.value === 'string' && a.value.includes(text);
  }
  return { match, expected_len: expected, value_len: a.len, secure };
}

/** The field for a response: `value` (not secure) at most VALUE_CAP characters. */
export function fieldValueOut(f: FieldState | null): { value: string } | Record<string, never> {
  const s = safeField(f);
  if (!s || s.secure || typeof s.value !== 'string') return {};
  const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s.value)].map((x) => x.segment);
  return { value: chars.length > VALUE_CAP ? chars.slice(0, VALUE_CAP).join('') : s.value };
}

/** The ways a field is emptied, in the order they're tried (never one Delete per character from here). */
export type ClearStep = 'element-clear' | 'select-all';

/**
 * The next way to empty the field (a WebDriverAgent without our build's /lotus/field), or null to stop: WDA's element
 * clear first; then select all and one Delete when the field still holds something, or when it's a secure field whose
 * length can't be trusted (a web view's password field may read empty while it isn't). Each is tried once.
 */
export function nextClearStep(now: FieldState | null, done: readonly ClearStep[]): ClearStep | null {
  if (!done.includes('element-clear')) {
    if (now && now.found && now.len === 0 && !now.secure) return null; // already empty
    return 'element-clear';
  }
  if (done.includes('select-all')) return null;
  if (!now || !now.found) return null; // no field to select in
  if (now.len === null || now.len > 0 || now.secure) return 'select-all';
  return null;
}

/** XCUIElementTypeSecureTextField, as WDA names it (`type` attribute) or our build says (`secure`). */
const SECURE_TYPES = /SecureTextField/i;

/**
 * A field from what the phone answered: our build's /lotus/field `{found, secure, len, value?, method?, cleared?}`, or
 * a stock element's `{found, type, value, placeholder}` (a placeholder shown in an empty field is no text). A secure
 * field keeps only its length. Null for anything else.
 */
export function fieldFrom(v: unknown): FieldState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.found === false) return { found: false, secure: false, len: null };
  let value = typeof o.value === 'string' ? o.value : o.value === null ? '' : undefined;
  if (value !== undefined && typeof o.placeholder === 'string' && o.placeholder && value === o.placeholder) value = '';
  const secure = o.secure === true || (typeof o.type === 'string' && SECURE_TYPES.test(o.type)) || looksSecure(value);
  const len = typeof o.len === 'number' && Number.isFinite(o.len) && o.len >= 0 ? Math.round(o.len) : value !== undefined ? visualLength(value) : null;
  const f: FieldState = { found: true, secure, len };
  if (!secure && value !== undefined) f.value = value;
  if (typeof o.method === 'string') f.method = o.method;
  if (typeof o.cleared === 'boolean') f.cleared = o.cleared;
  return f;
}

/**
 * An error from the phone with the typed text taken out: XCTest names its event record after the text's first
 * letters ("Type 'abc…'"), and a password must never reach an answer or a log.
 */
export function scrubTyped(message: string, text: string): string {
  let m = message.replace(/Type '[^']*(?:'|…)/g, "Type '…'");
  for (const part of [text, text.slice(0, 12)]) if (part.length >= 2) m = m.split(part).join('…');
  return m;
}
