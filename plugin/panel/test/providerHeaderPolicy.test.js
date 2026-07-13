import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCredentialShapedProviderLiteral,
  isForbiddenProviderHeaderName,
  isReservedProviderExtraHeaderName,
  isSensitiveProviderHeaderName,
} from '../src/lib/providerHeaderPolicy.js';

test('credential-like provider header names share one conservative classification', () => {
  for (const name of [
    'Authorization',
    'X-Auth',
    'X-Credential',
    'Cookie',
    'X-Session-Id',
    'X-OAuth-Signature',
    'X-Custom-Token',
    'X-Provider-Key',
    'XAuth',
    'clientSecret',
    'accessToken',
    'auth.token',
  ]) {
    assert.equal(isSensitiveProviderHeaderName(name), true, name);
  }
  assert.equal(isSensitiveProviderHeaderName('x-provider-feature'), false);
  assert.equal(isSensitiveProviderHeaderName('monkey'), false);
});

test('credential-shaped literal values require protected storage even under neutral names', () => {
  for (const value of [
    'client_secret=opaque-provider-value',
    '{"accessToken":"opaque-provider-value"}',
    'token: opaque-provider-value',
    '{"client\\u0053ecret":"opaque-provider-value"}',
    '{"auth\\u002etoken":"opaque-provider-value"}',
    'client_secret%3Dopaque-provider-value',
  ]) {
    assert.equal(isCredentialShapedProviderLiteral(value), true, value);
  }
  assert.equal(isCredentialShapedProviderLiteral('feature=enabled'), false);
  assert.equal(isCredentialShapedProviderLiteral('{"mode":"fast"}'), false);
});

test('transport-forbidden and reserved extra headers are rejected before persistence', () => {
  for (const name of ['Cookie', 'Set-Cookie', 'Host', 'Proxy-Authorization', 'X-AE-MCP-Route-Token']) {
    assert.equal(isForbiddenProviderHeaderName(name), true, name);
    assert.equal(isReservedProviderExtraHeaderName(name), true, name);
  }
  assert.equal(isReservedProviderExtraHeaderName('Authorization'), true);
  assert.equal(isReservedProviderExtraHeaderName('x-api-key'), true);
  assert.equal(isReservedProviderExtraHeaderName('x-provider-feature'), false);
});
