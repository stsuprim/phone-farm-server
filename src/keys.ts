// The PC keyboard on the phone (2026-11-24, POST /keyboard and /clipboard): the request, the keys' names, and what a
// cut took. Pure parts here; the backends press the keys. What's typed is the owner's: never logged, kept or put in an
// error (a refusal here names the op's place, never what it held).
import { HttpError } from './types.js';

export type Mod = 'cmd' | 'shift' | 'alt' | 'ctrl';
/** XCUIKeyModifierFlags. */
export const MOD_FLAGS: Record<Mod, number> = { shift: 1 << 1, ctrl: 1 << 2, alt: 1 << 3, cmd: 1 << 4 };

export type NamedKey = 'enter' | 'backspace' | 'delete' | 'tab' | 'escape' | 'space' | 'left' | 'right' | 'up' | 'down' | 'pageup' | 'pagedown';

/** Each named key: XCTest's name for it (WDA's keyboardInput), its HID usage (page 7), and what types it as text. */
export const NAMED: Record<NamedKey, { xcui: string; usage: number; text?: string }> = {
  enter: { xcui: 'XCUIKeyboardKeyReturn', usage: 0x28, text: '\n' },
  backspace: { xcui: 'XCUIKeyboardKeyDelete', usage: 0x2a, text: '\b' },
  delete: { xcui: 'XCUIKeyboardKeyForwardDelete', usage: 0x4c },
  tab: { xcui: 'XCUIKeyboardKeyTab', usage: 0x2b },
  escape: { xcui: 'XCUIKeyboardKeyEscape', usage: 0x29 },
  space: { xcui: 'XCUIKeyboardKeySpace', usage: 0x2c, text: ' ' },
  left: { xcui: 'XCUIKeyboardKeyLeftArrow', usage: 0x50 },
  right: { xcui: 'XCUIKeyboardKeyRightArrow', usage: 0x4f },
  up: { xcui: 'XCUIKeyboardKeyUpArrow', usage: 0x52 },
  down: { xcui: 'XCUIKeyboardKeyDownArrow', usage: 0x51 },
  pageup: { xcui: 'XCUIKeyboardKeyPageUp', usage: 0x4b },
  pagedown: { xcui: 'XCUIKeyboardKeyPageDown', usage: 0x4e },
};

/** Other names a client may say (a browser's KeyboardEvent.key among them), lower case. */
const ALIASES: Record<string, NamedKey | 'home' | 'end'> = {
  return: 'enter', back: 'backspace', del: 'delete', forwarddelete: 'delete', esc: 'escape', ' ': 'space', spacebar: 'space',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  leftarrow: 'left', rightarrow: 'right', uparrow: 'up', downarrow: 'down',
  home: 'home', end: 'end',
};

const MOD_ALIASES: Record<string, Mod> = {
  cmd: 'cmd', command: 'cmd', meta: 'cmd', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', ctrl: 'ctrl', control: 'ctrl',
};

/** A key with its modifiers, pressed `n` times (a named key, or one character with a shortcut's modifiers). */
export interface KeyPress {
  key: string;
  mods: Mod[];
  n: number;
}
/** One thing to press, in order: a run of text ("\b" is Backspace, "\n" Return), or a key. */
export type KeyStep = { text: string } | KeyPress;
export const isText = (s: KeyStep): s is { text: string } => 'text' in s;
export const isNamed = (k: string): k is NamedKey => Object.hasOwn(NAMED, k);

export const MAX_KEY_OPS = 64;
export const MAX_KEY_REPEAT = 100;
/** Characters and key presses of one request. */
export const MAX_KEY_PRESSES = 10_000;
export const MAX_PASTE_TEXT = 10_000;

/** Text as it's typed: line ends as one "\n", no other control characters (a "\b" in text would delete). */
export function typable(text: string): string {
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c !== 0x7f) || c === 0x0a || c === 0x09) out += ch;
  }
  return out;
}

/** One key as the phone is asked for it: Home and End as iOS has them (the line's, with Cmd the whole text's). */
function keyStep(key: string, mods: Mod[], n: number): KeyStep {
  if (key === 'home' || key === 'end') {
    const whole = mods.includes('cmd');
    if (whole) return { key: key === 'home' ? 'up' : 'down', mods, n };
    return { key: key === 'home' ? 'left' : 'right', mods: [...mods, 'cmd'], n };
  }
  if (isNamed(key)) {
    const text = NAMED[key].text;
    if (text !== undefined && !mods.length) return { text: text.repeat(n) };
    if (key === 'space' && mods.length === 1 && mods[0] === 'shift') return { text: ' '.repeat(n) };
    return { key, mods, n };
  }
  // a printable character: just typed, unless a shortcut is held with it
  if (!mods.length) return { text: key.repeat(n) };
  if (mods.length === 1 && mods[0] === 'shift') return { text: key.toUpperCase().repeat(n) };
  return { key: key.toLowerCase(), mods, n };
}

/** The key's name as this server knows it (a named key, home, end, or one printable character); null for none. */
function keyName(said: string): string | null {
  const low = said.toLowerCase();
  const alias = Object.hasOwn(ALIASES, low) ? ALIASES[low]! : null;
  if (alias) return alias;
  if (isNamed(low)) return low;
  return [...said].length === 1 && said !== '\n' && said !== '\t' && typable(said) === said ? said : null;
}

function modsOf(v: unknown, at: string): Mod[] {
  const bad = () => new HttpError(400, `${at}.mods must be an array of cmd, shift, alt, ctrl`);
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad();
  const mods = v.map((m: unknown) => {
    const name = typeof m === 'string' ? m.toLowerCase() : '';
    if (!Object.hasOwn(MOD_ALIASES, name)) throw bad();
    return MOD_ALIASES[name]!;
  });
  return [...new Set(mods)];
}

/** `ops` of POST /keyboard: `{text}` or `{key, mods?, n?}`; neighbouring text is put together (one request to the phone). */
export function parseKeyOps(v: unknown): KeyStep[] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_KEY_OPS) {
    throw new HttpError(400, `"ops" must be an array of 1 to ${MAX_KEY_OPS} of {text} or {key, mods, n}`);
  }
  const out: KeyStep[] = [];
  let presses = 0;
  v.forEach((raw: unknown, i) => {
    const at = `ops[${i}]`;
    const op = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    let step: KeyStep;
    if (typeof op.text === 'string' && op.key === undefined) {
      presses += op.text.length;
      step = { text: typable(op.text) };
    } else if (typeof op.key === 'string' && op.text === undefined) {
      const name = keyName(op.key);
      if (name === null) throw new HttpError(400, `${at}.key is not a key this server knows`);
      const n = op.n === undefined || op.n === null ? 1 : op.n;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_KEY_REPEAT) throw new HttpError(400, `${at}.n must be 1 to ${MAX_KEY_REPEAT}`);
      presses += n;
      step = keyStep(name, modsOf(op.mods, at), n);
    } else throw new HttpError(400, `${at} must be {text} or {key, mods, n}`);
    if (presses > MAX_KEY_PRESSES) throw new HttpError(413, `"ops" is more than ${MAX_KEY_PRESSES} key presses`);
    const last = out[out.length - 1];
    if (isText(step) && !step.text) return;
    if (isText(step) && last && isText(last)) last.text += step.text;
    else out.push(step);
  });
  return out;
}

/** The modifiers as XCTest's flags. */
export const modFlags = (mods: readonly Mod[]): number => mods.reduce((f, m) => f | MOD_FLAGS[m], 0);

/** Whether a step is Cmd+A (the whole field is selected after it). */
export const isSelectAll = (s: KeyStep | undefined): boolean => !!s && !isText(s) && s.key === 'a' && s.mods.length === 1 && s.mods[0] === 'cmd';

/** Key presses of the steps (for how long they may take). */
export const pressCount = (steps: readonly KeyStep[]): number => steps.reduce((n, s) => n + (isText(s) ? s.text.length : s.n), 0);

export type ClipAction = 'copy' | 'cut' | 'paste';

/** `{action, text?}` of POST /clipboard. */
export function parseClipboard(body: Record<string, unknown>): { action: ClipAction; text: string | null } {
  const a = body.action;
  if (a !== 'copy' && a !== 'cut' && a !== 'paste') throw new HttpError(400, '"action" must be copy, cut or paste');
  if (a !== 'paste' || body.text === undefined || body.text === null) return { action: a, text: null };
  if (typeof body.text !== 'string') throw new HttpError(400, '"text" must be a string');
  if (body.text.length > MAX_PASTE_TEXT) throw new HttpError(413, `"text" is longer than ${MAX_PASTE_TEXT} characters`);
  const text = typable(body.text);
  if (!text) throw new HttpError(400, '"text" is empty');
  return { action: a, text };
}

/** What POST /clipboard answers: `text` is the copied text when it could be had, `exact` whether it's just the selection. */
export interface ClipResult {
  action: ClipAction;
  /** copy, cut: "field" (read from the focused field) or "phone-only"; paste: "typed", or "phone" (the phone's own clipboard). */
  how: 'field' | 'phone-only' | 'typed' | 'phone';
  text?: string;
  exact?: boolean;
  why?: string;
}

/**
 * What a cut took, from the field before and after: the one run of text that's gone. Null when the field doesn't read
 * as "the same with a piece missing". `exact` is false when equal letters leave more than one place it may have been.
 */
export function cutText(before: string, after: string): { text: string; exact: boolean } | null {
  const gone = before.length - after.length;
  if (gone <= 0) return null;
  let pre = 0;
  while (pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (suf < after.length && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  if (pre + suf < after.length) return null;
  const late = before.slice(pre, pre + gone);
  const early = before.slice(before.length - suf - gone, before.length - suf);
  return { text: late, exact: late === early };
}

/** A long text in pieces the phone types one after the other (never through the middle of an emoji). */
export function pieces(text: string, size = 400): string[] {
  const out: string[] = [];
  let cur = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (cur && cur.length + segment.length > size) {
      out.push(cur);
      cur = '';
    }
    cur += segment;
  }
  if (cur) out.push(cur);
  return out;
}
