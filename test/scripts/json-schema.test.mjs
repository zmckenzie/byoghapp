import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonEqual, typeOf, validate } from '../../scripts/lib/json-schema.mjs';

const messages = (schema, value) => validate(schema, value).map((e) => `${e.path} ${e.message}`);

describe('typeOf', () => {
  test('distinguishes JSON types', () => {
    assert.equal(typeOf(null), 'null');
    assert.equal(typeOf([]), 'array');
    assert.equal(typeOf(1), 'integer');
    assert.equal(typeOf(1.5), 'number');
    assert.equal(typeOf('x'), 'string');
    assert.equal(typeOf({}), 'object');
    assert.equal(typeOf(true), 'boolean');
  });
});

describe('jsonEqual', () => {
  test('compares deeply', () => {
    assert.ok(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
    assert.ok(!jsonEqual({ a: 1 }, { a: 2 }));
    assert.ok(!jsonEqual({ a: 1 }, { b: 1 }));
    assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: 2 }));
    assert.ok(!jsonEqual([1, 2], [1, 2, 3]));
    assert.ok(!jsonEqual([1, 2], [2, 1]));
    assert.ok(!jsonEqual([], {}));
    assert.ok(!jsonEqual(1, '1'));
    assert.ok(jsonEqual('a', 'a'));
    assert.ok(!jsonEqual(null, {}));
  });
});

describe('validate', () => {
  test('type', () => {
    assert.deepEqual(messages({ type: 'string' }, 1), ['$ must be string']);
    assert.deepEqual(messages({ type: 'number' }, 1), []);
    assert.deepEqual(messages({ type: 'integer' }, 1.5), ['$ must be integer']);
    assert.deepEqual(messages({ type: ['string', 'null'] }, null), []);
    assert.deepEqual(messages({ type: ['string', 'null'] }, 2), ['$ must be string or null']);
  });

  test('a type mismatch stops further checks', () => {
    assert.deepEqual(messages({ type: 'string', minLength: 3 }, 5), ['$ must be string']);
  });

  test('enum and const', () => {
    assert.deepEqual(messages({ enum: ['a', 'b'] }, 'c'), ['$ must be one of: "a", "b"']);
    assert.deepEqual(messages({ enum: ['a', 'b'] }, 'b'), []);
    assert.deepEqual(messages({ const: 3 }, 4), ['$ must be 3']);
    assert.deepEqual(messages({ const: 3 }, 3), []);
  });

  test('string keywords', () => {
    assert.deepEqual(messages({ pattern: '^a+$' }, 'b'), ['$ must match pattern ^a+$']);
    assert.deepEqual(messages({ pattern: '^a+$' }, 'aa'), []);
    assert.deepEqual(messages({ minLength: 2 }, 'a'), ['$ must be at least 2 characters']);
    assert.deepEqual(messages({ minLength: 2 }, 'ab'), []);
    assert.deepEqual(messages({ maxLength: 2 }, 'abc'), ['$ must be at most 2 characters']);
    assert.deepEqual(messages({ maxLength: 2 }, 'ab'), []);
  });

  test('minimum', () => {
    assert.deepEqual(messages({ minimum: 1 }, 0), ['$ must be at least 1']);
    assert.deepEqual(messages({ minimum: 1 }, 1), []);
    assert.deepEqual(messages({ minimum: 1 }, 0.5), ['$ must be at least 1']);
  });

  test('array keywords', () => {
    assert.deepEqual(messages({ minItems: 1 }, []), ['$ must have at least 1 items']);
    assert.deepEqual(messages({ minItems: 1 }, [1]), []);
    assert.deepEqual(messages({ maxItems: 1 }, [1, 2]), ['$ must have at most 1 items']);
    assert.deepEqual(messages({ maxItems: 1 }, [1]), []);
    assert.deepEqual(messages({ uniqueItems: true }, [1, 1]), ['$ must not contain duplicate items']);
    assert.deepEqual(messages({ uniqueItems: true }, [{ a: 1 }, { a: 2 }]), []);
    assert.deepEqual(messages({ items: { type: 'string' } }, ['a', 2]), ['$[1] must be string']);
  });

  test('object keywords', () => {
    const schema = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    assert.deepEqual(messages(schema, {}), ['$ is missing required property "a"']);
    assert.deepEqual(messages(schema, { a: 'x', b: 1 }), ['$.b is not an allowed property']);
    assert.deepEqual(messages(schema, { a: 1 }), ['$.a must be string']);
    assert.deepEqual(messages(schema, { a: 'x' }), []);
    assert.deepEqual(messages({ additionalProperties: { type: 'integer' } }, { x: 1, y: 'no' }), ['$.y must be integer']);
    assert.deepEqual(messages({ properties: { a: { type: 'string' } } }, { b: 1 }), []);
    assert.deepEqual(messages({ propertyNames: { pattern: '^[a-z]+$' } }, { Bad: 1 }), ['$.Bad (name) must match pattern ^[a-z]+$']);
  });

  test('$ref and oneOf', () => {
    const schema = { $defs: { s: { type: 'string' } }, properties: { a: { $ref: '#/$defs/s' }, b: { oneOf: [{ type: 'string' }, { type: 'null' }] } } };
    assert.deepEqual(messages(schema, { a: 1 }), ['$.a must be string']);
    assert.deepEqual(messages(schema, { a: 'x', b: null }), []);
    assert.deepEqual(messages(schema, { b: 3 }), ['$.b must match exactly one allowed form (matched 0)']);
    assert.deepEqual(messages({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3), ['$ must match exactly one allowed form (matched 2)']);
  });

  test('ignores annotations and rejects unknown keywords', () => {
    assert.deepEqual(messages({ title: 't', description: 'd', $comment: 'c', $id: 'x', $schema: 'y' }, 1), []);
    assert.throws(() => validate({ format: 'uri' }, 'x'), /Unsupported schema keyword "format"/);
  });

  test('rejects unsupported or broken $refs', () => {
    assert.throws(() => validate({ $ref: 'other.json' }, 1), /Unsupported \$ref/);
    assert.throws(() => validate({ $ref: '#/$defs/missing' }, 1), /Unresolvable \$ref/);
  });
});
