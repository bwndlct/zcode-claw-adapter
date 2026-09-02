import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, registryShape } from '../adapter/lib/zcode-client.mjs';

test('redact masks credential-looking keys at any depth', () => {
  const input = {
    apiKey: 'sk-secret',
    nested: { authorization: 'Bearer x', token: 't', safe: 'ok' },
    list: [{ password: 'p' }, { plain: 'v' }],
  };
  const out = redact(input);
  assert.equal(out.apiKey, '<redacted>');
  assert.equal(out.nested.authorization, '<redacted>');
  assert.equal(out.nested.token, '<redacted>');
  assert.equal(out.nested.safe, 'ok');
  assert.equal(out.list[0].password, '<redacted>');
  assert.equal(out.list[1].plain, 'v');
  assert.ok(!JSON.stringify(out).includes('sk-secret'));
});

test('redact truncates long strings and caps depth', () => {
  assert.equal(redact('x'.repeat(300)).length, 201); // 200 chars + ellipsis char
  assert.equal(redact({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }).a.b.c.d.e.f.g, '<deep>');
});

test('registryShape summarizes providers without exposing key material', () => {
  const registry = {
    revision: 'r1',
    providers: [
      { providerId: 'z', kind: 'anthropic', apiKey: { source: 'env', name: 'K' }, models: [{ modelId: 'M' }] },
    ],
  };
  const shape = registryShape(registry);
  assert.equal(shape.providerCount, 1);
  assert.equal(shape.providers[0].apiKey.source, 'env');
  assert.ok(!('name' in shape.providers[0].apiKey)); // env NAME is not echoed
  assert.ok(!JSON.stringify(shape).match(/sk-|Bearer/));
});
