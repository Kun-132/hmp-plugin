import test from 'node:test';
import assert from 'node:assert/strict';
import { strictSchema, stripOptionalNulls, matches } from '../plugins/hmp/scripts/structured-output.mjs';

test('strictSchema requires every property and makes only optional properties nullable without mutating the schema', () => {
  const schema = { type: 'object', additionalProperties: true, required: ['text'], properties: {
    text: { type: 'string', minLength: 1 }, reason: { type: 'string', maxLength: 30 },
    kind: { type: 'string', enum: ['synthetic'] }, inferred: { enum: ['synthetic'] },
    nullable: { type: ['string', 'null'], enum: ['synthetic', null] },
    untyped: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
  } };
  const before = structuredClone(schema);
  const result = strictSchema(schema);
  assert.deepEqual(result, { type: 'object', additionalProperties: false,
    required: ['text', 'reason', 'kind', 'inferred', 'nullable', 'untyped'], properties: {
      text: { type: 'string', minLength: 1 }, reason: { type: ['string', 'null'], maxLength: 30 },
      kind: { type: ['string', 'null'], enum: ['synthetic', null] },
      inferred: { anyOf: [{ enum: ['synthetic', null] }, { type: 'null' }] },
      nullable: { type: ['string', 'null'], enum: ['synthetic', null] },
      untyped: { anyOf: [{ anyOf: [{ type: 'string' }, { type: 'integer' }] }, { type: 'null' }] },
    } });
  result.properties.kind.enum.push('changed');
  assert.deepEqual(schema, before);
});

test('strictSchema recurses through nested objects and array items, including objects without required', () => {
  const schema = { type: 'object', properties: {
    nested: { type: 'object', properties: { reason: { type: 'string' } } },
    rows: { type: 'array', items: { type: 'object', required: ['text'], properties: {
      text: { type: 'string' }, kind: { type: 'string', enum: ['synthetic'] },
    } } },
    empty: { type: 'object' },
  } };
  const before = structuredClone(schema);
  assert.deepEqual(strictSchema(schema), { type: 'object', additionalProperties: false,
    required: ['nested', 'rows', 'empty'], properties: {
      nested: { type: ['object', 'null'], additionalProperties: false, required: ['reason'], properties: {
        reason: { type: ['string', 'null'] },
      } },
      rows: { type: ['array', 'null'], items: { type: 'object', additionalProperties: false,
        required: ['text', 'kind'], properties: {
          text: { type: 'string' }, kind: { type: ['string', 'null'], enum: ['synthetic', null] },
        } } },
      empty: { type: ['object', 'null'], properties: {}, required: [], additionalProperties: false },
    } });
  assert.deepEqual(schema, before);
});

test('stripOptionalNulls removes only declared optional null fields recursively and preserves input', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['text', 'rows'], properties: {
    text: { type: 'string' }, reason: { type: 'string' }, kind: { type: 'string', enum: ['synthetic'] },
    count: { type: 'integer' }, nested: { type: 'object', properties: { reason: { type: 'string' } } },
    rows: { type: 'array', items: { type: 'object', required: ['text'], properties: {
      text: { type: 'string' }, reason: { type: 'string' },
    } } },
  } };
  const value = { text: '合成の文', reason: null, kind: 'synthetic', count: 0, nested: { reason: null },
    rows: [{ text: '合成の行', reason: null }, { text: null, reason: '合成の理由' }], unknown: null };
  const before = structuredClone(value), schemaBefore = structuredClone(schema);
  const result = stripOptionalNulls(value, schema);
  assert.deepEqual(result, { text: '合成の文', kind: 'synthetic', count: 0, nested: {},
    rows: [{ text: '合成の行' }, { text: null, reason: '合成の理由' }], unknown: null });
  assert.equal(matches(result, schema), false);
  assert.equal(matches(stripOptionalNulls({ text: '合成の文', rows: [
    { text: '合成の行', reason: null },
  ], reason: null, kind: null }, schema), schema), true);
  assert.deepEqual(stripOptionalNulls({ text: null, rows: [], reason: null, kind: null }, schema), { text: null, rows: [] });
  assert.deepEqual(stripOptionalNulls([null, '合成'], { type: 'array', items: { type: 'string' } }), [null, '合成']);
  assert.deepEqual(value, before);
  assert.deepEqual(schema, schemaBefore);
});
