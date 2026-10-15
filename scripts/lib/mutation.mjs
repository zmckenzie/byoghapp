// Mutation testing core: a small JavaScript tokenizer and the mutation operators.
// No parser dependency: the tokenizer understands comments, strings, template
// literals (including ${} code) and regular-expression literals, which is all
// the operators need.

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];
// After these tokens a "/" starts a regular expression rather than a division.
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '&&', '||', '??', '=>', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '+', '-', '*', '%', '+=', '-=', '*=', '/=', '...', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Splits source into tokens: {type, value, start, end, line}.
 * Types: word, number, string, template (a literal chunk of a template), regex, punct.
 * Comments and whitespace are dropped; "comments" are returned separately.
 */
export function tokenize(src) {
  const tokens = [];
  const comments = [];
  // A "#!" line at the very start is for the shell, not JavaScript.
  let i = src.startsWith('#!') ? src.indexOf('\n') + 1 || src.length : 0;
  const stack = []; // template nesting: brace depth inside each ${ }
  const push = (type, start, end) => tokens.push({ type, value: src.slice(start, end), start, end, line: lineAt(start) });
  const lineStarts = [0];
  for (let k = 0; k < src.length; k += 1) if (src[k] === '\n') lineStarts.push(k + 1);
  function lineAt(pos) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  function regexAllowed() {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'punct') return REGEX_AFTER_PUNCT.has(prev.value);
    if (prev.type === 'word') return REGEX_AFTER_WORD.has(prev.value);
    return false;
  }
  function readTemplateChunk(start) {
    // i points just after ` or }; read until ` or ${
    let j = start;
    while (j < src.length) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') {
        push('template', start, j);
        return { end: j + 1, closed: true };
      } else if (src[j] === '$' && src[j + 1] === '{') {
        push('template', start, j);
        return { end: j + 2, closed: false };
      } else j += 1;
    }
    throw new Error(`Unterminated template literal at line ${lineAt(start)}`);
  }

  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      comments.push({ value: src.slice(i, stop), line: lineAt(i) });
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`Unterminated comment at line ${lineAt(i)}`);
      comments.push({ value: src.slice(i, end + 2), line: lineAt(i) });
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (src[j] !== c) {
        if (src[j] === '\\') j += 1;
        if (j >= src.length || src[j] === '\n') throw new Error(`Unterminated string at line ${lineAt(i)}`);
        j += 1;
      }
      push('string', i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const { end, closed } = readTemplateChunk(i + 1);
      if (!closed) stack.push(0);
      i = end;
      continue;
    }
    if (stack.length > 0 && c === '{') {
      stack[stack.length - 1] += 1;
    } else if (stack.length > 0 && c === '}') {
      if (stack[stack.length - 1] === 0) {
        stack.pop();
        const { end, closed } = readTemplateChunk(i + 1);
        if (!closed) stack.push(0);
        i = end;
        continue;
      }
      stack[stack.length - 1] -= 1;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') { inClass = true; j += 1; }
        else if (src[j] === ']') { inClass = false; j += 1; }
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') throw new Error(`Unterminated regular expression at line ${lineAt(i)}`);
        else j += 1;
      }
      j += 1;
      while (j < src.length && /[a-z]/.test(src[j])) j += 1;
      push('regex', i, j);
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      push('word', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j += 1;
      push('number', i, j);
      i = j;
      continue;
    }
    const p = PUNCTUATORS.find((op) => src.startsWith(op, i));
    if (!p) throw new Error(`Unexpected character "${c}" at line ${lineAt(i)}`);
    push('punct', i, i + p.length);
    i += p.length;
  }
  return { tokens, comments };
}

const SWAPS = {
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '<': '<=', '<=': '<', '>': '>=', '>=': '>',
  '&&': '||', '||': '&&', '??': '&&',
  '+': '-', '-': '+', '*': '/', '/': '*', '%': '*',
  '+=': '-=', '-=': '+=',
};
const WORD_SWAPS = {
  true: 'false', false: 'true',
  some: 'every', every: 'some',
  startsWith: 'endsWith', endsWith: 'startsWith',
  min: 'max', max: 'min',
};
// A "+" or "-" after these is unary (sign), which the operator swap leaves alone.
const OPERAND_END = new Set(['word', 'number', 'string', 'template', 'regex']);

const KEYWORDS_BEFORE_UNARY = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'void', 'throw', 'await', 'yield']);

function isBinaryPosition(tokens, k) {
  const prev = tokens[k - 1];
  if (!prev) return false;
  if (OPERAND_END.has(prev.type)) return !KEYWORDS_BEFORE_UNARY.has(prev.value);
  return prev.value === ')' || prev.value === ']';
}

/** Indexes of string tokens that are module specifiers (never mutated). */
function moduleSpecifiers(tokens) {
  const specs = new Set();
  tokens.forEach((t, k) => {
    if (t.type !== 'string') return;
    const prev = tokens[k - 1];
    if (prev?.value === 'from' || (prev?.value === 'import' && prev.type === 'word')) specs.add(k);
    if (prev?.value === '(' && tokens[k - 2]?.value === 'import') specs.add(k);
  });
  return specs;
}

/** Lines that carry a "mutation-ignore" comment. */
function ignoredLines(comments) {
  return new Set(comments.filter((c) => c.value.includes('mutation-ignore')).map((c) => c.line));
}

/** Finds the token index of the parenthesis that closes the one at k. */
function closingParen(tokens, k) {
  let depth = 0;
  for (let j = k; j < tokens.length; j += 1) {
    if (tokens[j].value === '(') depth += 1;
    else if (tokens[j].value === ')') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * All mutants for a source file: {id, line, start, end, original, replacement, operator}.
 * Applying one is src.slice(0, start) + replacement + src.slice(end).
 */
export function generateMutants(src) {
  const { tokens, comments } = tokenize(src);
  const skip = ignoredLines(comments);
  const mutants = [];
  const add = (start, end, replacement, operator, line) => {
    if (skip.has(line)) return;
    mutants.push({ id: mutants.length, line, start, end, original: src.slice(start, end), replacement, operator });
  };
  const specifiers = moduleSpecifiers(tokens);
  tokens.forEach((t, k) => {
    if (t.type === 'punct' && Object.hasOwn(SWAPS, t.value)) {
      const needsBinary = ['+', '-', '*', '/', '%'].includes(t.value);
      if (!needsBinary || isBinaryPosition(tokens, k)) add(t.start, t.end, SWAPS[t.value], 'operator', t.line);
    } else if (t.type === 'punct' && t.value === '!' && tokens[k + 1]?.value !== '!') {
      add(t.start, t.end, '', 'negation-removal', t.line);
    } else if (t.type === 'word' && Object.hasOwn(WORD_SWAPS, t.value)) {
      const isMethod = !['true', 'false'].includes(t.value);
      if (!isMethod || tokens[k - 1]?.value === '.' || tokens[k - 1]?.value === '?.') add(t.start, t.end, WORD_SWAPS[t.value], isMethod ? 'method' : 'boolean', t.line);
    } else if (t.type === 'word' && t.value === 'if' && tokens[k + 1]?.value === '(') {
      const close = closingParen(tokens, k + 1);
      if (close > k + 2) {
        const start = tokens[k + 2].start;
        const end = tokens[close - 1].end;
        add(start, end, 'true', 'condition-true', t.line);
        add(start, end, 'false', 'condition-false', t.line);
      }
    } else if (t.type === 'number' && /^\d+$/.test(t.value.replaceAll('_', ''))) {
      add(t.start, t.end, String(Number(t.value.replaceAll('_', '')) + 1), 'number', t.line);
    } else if (t.type === 'string' && !specifiers.has(k) && t.value.length > 2) {
      add(t.start, t.end, `${t.value[0]}${t.value[0]}`, 'string-empty', t.line);
    } else if (t.type === 'word' && t.value === 'return' && tokens[k + 1] && ![';', '}'].includes(tokens[k + 1].value)) {
      // Drop the returned value: "return x;" becomes "return undefined;" in effect.
      const next = tokens[k + 1];
      add(t.start, next.start, 'return void ', 'return-void', t.line);
    }
  });
  return mutants;
}

/** Applies a mutant to the source. */
export function applyMutant(src, mutant) {
  return src.slice(0, mutant.start) + mutant.replacement + src.slice(mutant.end);
}

/** Mutation score as a percentage; 100 when there are no mutants. */
export function mutationScore({ killed, survived }) {
  const total = killed + survived;
  return total === 0 ? 100 : (killed / total) * 100;
}
