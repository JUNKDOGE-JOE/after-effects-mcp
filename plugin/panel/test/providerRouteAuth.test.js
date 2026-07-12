import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  generateRouteToken,
  parseRouteTokenHeader,
  routeTokenMatches,
} from '../src/cep/providerRouteAuth.js';

test('generateRouteToken uses exactly 32 random bytes and base64url', () => {
  let requested = 0;
  const token = generateRouteToken({
    randomBytes(size) {
      requested = size;
      return Buffer.alloc(size, 0xab);
    },
  });
  assert.equal(requested, 32);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token.includes('='), false);
});

test('parseRouteTokenHeader accepts one dedicated base64url field only', () => {
  assert.equal(parseRouteTokenHeader(['X-AE-MCP-Route-Token', 'token_1']), 'token_1');
  assert.equal(parseRouteTokenHeader(['x-ae-mcp-route-token', 'token-2']), 'token-2');
  for (const rawHeaders of [
    [],
    ['Authorization', 'Bearer token'],
    ['X-AE-MCP-Route-Token', ' token'],
    ['X-AE-MCP-Route-Token', 'token '],
    ['X-AE-MCP-Route-Token', 'one,two'],
    ['X-AE-MCP-Route-Token', 'one', 'X-AE-MCP-Route-Token', 'two'],
  ]) assert.equal(parseRouteTokenHeader(rawHeaders), null);
});

test('routeTokenMatches compares equal-size SHA-256 digests for every candidate length', () => {
  const sizes = [];
  const deps = {
    createHash,
    timingSafeEqual(left, right) {
      sizes.push([left.length, right.length]);
      return left.equals(right);
    },
  };
  assert.equal(routeTokenMatches('same', 'same', deps), true);
  assert.equal(routeTokenMatches('x', 'a-much-longer-token', deps), false);
  assert.deepEqual(sizes, [[32, 32], [32, 32]]);
});
