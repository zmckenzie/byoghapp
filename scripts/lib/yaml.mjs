// A strict YAML subset for registry files: parse, write and edit.
//
// Supported: block mappings and sequences (including "- key: value" items),
// plain, 'single'- and "double"-quoted strings, true/false, null, integers,
// literal (|) and folded (>) block text with clip or strip (-) chomping, the
// empty collections [] and {}, and # comments.
//
// Rejected with a line number: tabs in indentation, duplicate keys, anchors,
// aliases, tags, directives, document markers, flow collections, keys with no
// value, and plain scalars whose type YAML tools disagree on (yes/no/on/off,
// True, 1.5, 1e3, 0x1f, ...). Quote those to make them strings.
//
// Plain scalars that aren't true/false/null/an integer are strings, so dates
// such as 2026-10-15 and versions such as 1.0.0 stay strings.

export class YAMLError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.name = 'YAMLError';
    this.line = line;
  }
}

const AMBIGUOUS_WORD = /^(y|n|yes|no|on|off|true|false|null|~)$/i;
const NUMBER_LIKE = /^[-+]?(\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|0b[01]+|\.(inf|nan))$/i;
const INTEGER = /^-?(0|[1-9]\d*)$/;
const PLAIN_KEY = /^[A-Za-z_$][\w$.-]*$/;
const SPECIAL_START = /^[[\]{}&*!|>%@`"'#?,:]|^-(\s|$)/;
const DOUBLE_ESCAPES = /\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g;

/** Splits text into line records: {n, indent, text, blank}. */
function splitLines(src) {
  return src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map((raw, k) => {
    const n = k + 1;
    const indentMatch = raw.match(/^[ \t]*/)[0];
    const trimmed = raw.trim();
    const blank = trimmed === '' || trimmed.startsWith('#');
    if (!blank && indentMatch.includes('\t')) throw new YAMLError(n, 'tabs are not allowed in indentation; use spaces');
    return { n, raw, indent: indentMatch.length, text: raw.slice(indentMatch.length), blank };
  });
}

/** Reads a double- or single-quoted scalar at the start of s; returns {value, rest}. */
function readQuoted(s, n) {
  const quote = s[0];
  if (quote === '"') {
    let j = 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; // mutation-ignore: <= reaches the same end-of-string error
    if (j >= s.length) throw new YAMLError(n, 'unterminated double-quoted string');
    const body = s.slice(1, j);
    if (body.replace(DOUBLE_ESCAPES, '').includes('\\')) throw new YAMLError(n, 'unsupported escape in double-quoted string (use \\" \\\\ \\n \\t \\uXXXX)');
    return { value: JSON.parse(`"${body}"`), rest: s.slice(j + 1) };
  }
  let j = 1;
  let value = '';
  for (;;) {
    if (j >= s.length) throw new YAMLError(n, 'unterminated single-quoted string'); // mutation-ignore: > throws one character later, same error
    if (s[j] === "'") {
      if (s[j + 1] === "'") {
        value += "'";
        j += 2;
        continue;
      }
      return { value, rest: s.slice(j + 1) };
    }
    value += s[j];
    j += 1;
  }
}

/** Removes a trailing " # comment" from a plain value. */
function stripComment(s) {
  const at = s.search(/(^|\s)#/);
  return (at === -1 ? s : s.slice(0, at)).trim();
}

/** Parses an inline scalar (the text after "key:" or "- "). */
export function parseScalar(s, n = 1) {
  const text = s.trim();
  if (text.startsWith('"') || text.startsWith("'")) {
    const { value, rest } = readQuoted(text, n);
    if (rest.trim() !== '' && !/^\s+#/.test(rest)) throw new YAMLError(n, 'unexpected text after a quoted string');
    return value;
  }
  const plain = stripComment(text);
  if (plain === '[]') return [];
  if (plain === '{}') return {};
  if (plain === '') throw new YAMLError(n, 'missing value: write null, "" or []');
  if (/^[[{]/.test(plain)) throw new YAMLError(n, 'flow collections are not supported; use block style, or [] / {} for empty ones');
  if (/^[&*]/.test(plain)) throw new YAMLError(n, 'anchors and aliases are not supported');
  if (plain.startsWith('!')) throw new YAMLError(n, 'tags are not supported');
  if (SPECIAL_START.test(plain)) throw new YAMLError(n, `"${plain}" starts with a YAML indicator; quote it`);
  if (plain === 'true') return true;
  if (plain === 'false') return false;
  if (plain === 'null' || plain === '~') return null;
  if (INTEGER.test(plain)) {
    const num = Number(plain);
    if (!Number.isSafeInteger(num)) throw new YAMLError(n, `integer ${plain} is too large; quote it`);
    return num;
  }
  if (AMBIGUOUS_WORD.test(plain)) throw new YAMLError(n, `"${plain}" is ambiguous in YAML; use true, false or null, or quote it`);
  if (NUMBER_LIKE.test(plain)) throw new YAMLError(n, `"${plain}" looks like a number; only integers are supported, so quote it`);
  if (/:(\s|$)/.test(plain)) throw new YAMLError(n, `"${plain}" contains ": "; quote it`);
  return plain;
}

class Parser {
  constructor(src) {
    this.lines = splitLines(src);
    this.i = 0;
  }

  /** The next non-blank line, or null at the end. */
  peek() {
    while (this.i < this.lines.length && this.lines[this.i].blank) this.i += 1;
    return this.lines[this.i] ?? null;
  }

  parseDocument() {
    for (const line of this.lines) {
      if (!line.blank && line.indent === 0 && /^(---|\.\.\.)(\s|$)/.test(line.text)) throw new YAMLError(line.n, 'document markers (--- / ...) are not supported');
      if (!line.blank && line.indent === 0 && line.text.startsWith('%')) throw new YAMLError(line.n, 'directives are not supported');
    }
    const first = this.peek();
    if (!first) throw new YAMLError(1, 'the document is empty');
    if (first.indent !== 0) throw new YAMLError(first.n, 'the document must start at column 1');
    const value = this.parseBlock(0);
    // Every block stops at the first line it can't use; anything left over is misplaced.
    const extra = this.peek();
    if (extra) {
      throw new YAMLError(extra.n, extra.indent > 0 ? 'unexpected indentation' : 'a document holds one mapping or one list, not both');
    }
    return value;
  }

  /** A mapping or sequence whose lines start at exactly `indent`. */
  parseBlock(indent) {
    const line = this.peek();
    return isSeqItem(line.text) ? this.parseSequence(indent) : this.parseMapping(indent);
  }

  parseMapping(indent) {
    const map = {};
    for (let line = this.peek(); line && line.indent === indent && !isSeqItem(line.text); line = this.peek()) {
      const { key, rest } = splitKey(line.text, line.n);
      if (Object.hasOwn(map, key)) throw new YAMLError(line.n, `duplicate key "${key}"`);
      this.i += 1;
      map[key] = this.parseValue(rest, indent, line.n, true);
    }
    return map;
  }

  parseSequence(indent) {
    const list = [];
    for (let line = this.peek(); line && line.indent === indent && isSeqItem(line.text); line = this.peek()) {
      const after = line.text.slice(1);
      const rest = after.trimStart();
      const column = indent + 1 + (after.length - rest.length);
      if (looksLikeKey(rest)) {
        // "- key: value" starts a mapping whose keys align with "key".
        this.lines[this.i] = { ...line, indent: column, text: rest };
        list.push(this.parseMapping(column));
      } else {
        this.i += 1;
        list.push(this.parseValue(rest, indent, line.n, false));
      }
    }
    return list;
  }

  /** The value after "key:" or "- ": inline scalar, block scalar, or a nested block. */
  parseValue(rest, parentIndent, n, inMapping) {
    const inline = rest.trim();
    if (/^[|>]/.test(inline)) return this.parseBlockScalar(inline, parentIndent, n);
    if (inline !== '' && !inline.startsWith('#')) return parseScalar(inline, n);
    const next = this.peek();
    if (next && next.indent > parentIndent) return this.parseBlock(next.indent);
    // YAML allows a sequence under a key at the key's own indentation.
    if (inMapping && next && next.indent === parentIndent && isSeqItem(next.text)) return this.parseSequence(parentIndent);
    throw new YAMLError(n, 'missing value: write null, "" or [], or indent the nested block');
  }

  parseBlockScalar(header, parentIndent, n) {
    const m = header.match(/^([|>])(-?)\s*(#.*)?$/);
    if (!m) throw new YAMLError(n, 'block scalars support only |, |-, > and >-');
    const [, style, chomp] = m;
    const body = [];
    let contentIndent = null;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      const isBlank = line.raw.trim() === '';
      if (!isBlank && line.indent <= parentIndent) break;
      if (!isBlank) {
        contentIndent ??= line.indent;
        if (line.indent < contentIndent) throw new YAMLError(line.n, 'block text is indented less than its first line');
      }
      body.push(isBlank ? '' : line.raw.slice(contentIndent));
      this.i += 1;
    }
    while (body.at(-1) === '') body.pop();
    let text;
    if (style === '|') {
      text = body.join('\n');
    } else {
      text = body.reduce((acc, l, k) => {
        if (k === 0) return l;
        if (l === '') return `${acc}\n`;
        return acc.endsWith('\n') ? acc + l : `${acc} ${l}`;
      }, '');
    }
    return chomp === '-' || text === '' ? text : `${text}\n`;
  }
}

function isSeqItem(text) {
  return text === '-' || text.startsWith('- ');
}

function looksLikeKey(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    try {
      return readQuoted(text, 0).rest.startsWith(':');
    } catch {
      return false;
    }
  }
  return /^[^\s#'"[\]{},][^#]*?:(\s|$)/.test(text);
}

/** Splits "key: rest" into the key and the text after the colon. */
function splitKey(text, n) {
  let key;
  let after;
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = readQuoted(text, n);
    key = q.value;
    after = q.rest;
  } else {
    const m = text.match(/^([^:#]*?):(?=\s|$)/);
    if (!m) throw new YAMLError(n, 'expected "key: value" or a "- " list item');
    key = m[1];
    after = text.slice(m[0].length - 1);
    if (/^[&*!?]/.test(key)) throw new YAMLError(n, 'anchors, aliases, tags and complex keys are not supported');
  }
  if (!/^:(\s|$)/.test(after)) throw new YAMLError(n, 'expected ": " after the key');
  if (key === '') throw new YAMLError(n, 'empty key');
  return { key, rest: after.replace(/^:/, '') };
}

/** Parses a document in the supported subset. */
export function parse(src) {
  return new Parser(String(src)).parseDocument();
}

/** True when a string can be written without quotes and reads back unchanged. */
export function isPlainSafe(s) {
  // Line breaks would be split by the parser; everything else unsafe either
  // throws in parseScalar or reads back differently (trimmed, comment cut off).
  if (/[\n\r]/.test(s)) return false;
  try {
    return parseScalar(s) === s;
  } catch {
    return false;
  }
}

function scalarText(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`only safe integers can be written, got ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return isPlainSafe(value) ? value : JSON.stringify(value);
  throw new TypeError(`cannot write ${typeof value}`);
}

function keyText(key) {
  return PLAIN_KEY.test(key) && isPlainSafe(key) ? key : JSON.stringify(key);
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const FOLD_AT = 80;
const WRAP_WIDTH = 100;

/** Long single-line prose is written as a folded block that reads back identically. */
function foldable(value) {
  return typeof value === 'string' && value.length > FOLD_AT && !/[\n\r\t]|\s\s|^\s|\s$/.test(value);
}

function foldedBlock(value, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  let current = '';
  for (const word of value.split(' ')) {
    if (current && current.length + 1 + word.length > WRAP_WIDTH - indent) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  lines.push(current);
  return `>-\n${lines.map((l) => pad + l).join('\n')}`;
}

function emitMapping(map, indent) {
  const pad = ' '.repeat(indent);
  return Object.entries(map).map(([k, v]) => {
    const head = `${pad}${keyText(k)}:`;
    if (Array.isArray(v)) return v.length === 0 ? `${head} []` : `${head}\n${emitSequence(v, indent + 2)}`;
    if (isMap(v)) return Object.keys(v).length === 0 ? `${head} {}` : `${head}\n${emitMapping(v, indent + 2)}`;
    if (foldable(v)) return `${head} ${foldedBlock(v, indent + 2)}`;
    return `${head} ${scalarText(v)}`;
  }).join('\n');
}

function emitSequence(list, indent) {
  const pad = ' '.repeat(indent);
  return list.map((v) => {
    if (Array.isArray(v)) return v.length === 0 ? `${pad}- []` : `${pad}-\n${emitSequence(v, indent + 2)}`;
    if (isMap(v)) {
      if (Object.keys(v).length === 0) return `${pad}- {}`;
      const body = emitMapping(v, indent + 2);
      return `${pad}- ${body.slice(indent + 2)}`;
    }
    if (foldable(v)) return `${pad}- ${foldedBlock(v, indent + 2)}`;
    return `${pad}- ${scalarText(v)}`;
  }).join('\n');
}

/** Writes a mapping as YAML in the supported subset, ending with a newline. */
export function stringify(value) {
  if (!isMap(value)) throw new TypeError('the top level must be a mapping');
  return Object.keys(value).length === 0 ? '{}\n' : `${emitMapping(value, 0)}\n`;
}

/**
 * Replaces (or appends) top-level keys in a document while keeping every other
 * line, comments included. Used to record verification without losing a
 * contributor's comments.
 */
export function setTopLevel(src, updates) {
  const lines = String(src).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    const replacement = emitMapping({ [key]: value }, 0).split('\n');
    const keyRe = new RegExp(`^(${escapeRegExp(key)}|${escapeRegExp(JSON.stringify(key))}):(\\s|$)`);
    const start = lines.findIndex((l) => keyRe.test(l));
    if (start === -1) {
      lines.push(...replacement);
      continue;
    }
    let end = start + 1;
    // The key's block: following indented or blank lines. A comment at column 1 ends it.
    while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end += 1;
    // Blank lines after the block belong to the gap before the next key.
    while (lines[end - 1].trim() === '' && end - 1 > start) end -= 1;
    lines.splice(start, end - start, ...replacement);
  }
  const out = `${lines.join('\n')}\n`;
  parse(out); // never write something we can't read back
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
