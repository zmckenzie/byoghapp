// A small JSON Schema (draft 2020-12) checker for the subset of keywords that
// schema/entry.schema.json uses. Unsupported keywords throw, so the schema can't
// silently rely on something this checker ignores.

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', '$defs']);
const KEYWORDS = new Set([
  'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'minItems',
  'maxItems', 'uniqueItems', 'items', 'properties', 'required', 'additionalProperties',
  'propertyNames', '$ref', 'oneOf',
]);

/** JSON type name of a value, distinguishing integer, array and null. */
export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part];
    if (node === undefined) throw new Error(`Unresolvable $ref: ${ref}`);
  }
  return node;
}

/** Deep equality for JSON values. */
export function jsonEqual(a, b) {
  if (a === b) return true;
  const ta = typeOf(a);
  if (ta !== typeOf(b) || (ta !== 'array' && ta !== 'object')) return false;
  // Arrays and objects compare the same way: same keys (indexes), equal values.
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

function check(schema, value, path, root, errors) {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`Unsupported schema keyword "${key}" at ${path}`);
  }
  const fail = (message) => errors.push({ path, message });

  if (schema.$ref) check(resolveRef(root, schema.$ref), value, path, root, errors);

  if (schema.oneOf) {
    const passing = schema.oneOf.filter((sub) => validate(sub, value, root).length === 0).length;
    if (passing !== 1) fail(`must match exactly one allowed form (matched ${passing})`);
  }
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some((t) => typeMatches(value, t))) {
      fail(`must be ${types.join(' or ')}`);
      return; // further keywords would only add noise
    }
  }
  if (schema.enum && !schema.enum.some((v) => jsonEqual(v, value))) {
    fail(`must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if ('const' in schema && !jsonEqual(schema.const, value)) fail(`must be ${JSON.stringify(schema.const)}`);

  const type = typeOf(value);
  if (type === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail(`must match pattern ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
  }
  if ((type === 'integer' || type === 'number') && schema.minimum !== undefined && value < schema.minimum) {
    fail(`must be at least ${schema.minimum}`);
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems && value.some((v, i) => value.findIndex((w) => jsonEqual(v, w)) !== i)) {
      fail('must not contain duplicate items');
    }
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, root, errors));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`is missing required property "${key}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (schema.propertyNames) check(schema.propertyNames, key, `${childPath} (name)`, root, errors);
      if (Object.hasOwn(props, key)) check(props[key], child, childPath, root, errors);
      else if (schema.additionalProperties === false) errors.push({ path: childPath, message: 'is not an allowed property' });
      else if (typeOf(schema.additionalProperties) === 'object') check(schema.additionalProperties, child, childPath, root, errors);
    }
  }
}

/**
 * Validates a value against a schema.
 * @returns {{path: string, message: string}[]} empty when valid
 */
export function validate(schema, value, root = schema) {
  const errors = [];
  check(schema, value, '$', root, errors);
  return errors;
}
