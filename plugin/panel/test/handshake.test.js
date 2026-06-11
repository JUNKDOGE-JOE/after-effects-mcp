import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handshakeReached } from '../src/cep/useHandshake.js';

test('handshakeReached returns false for missing info', () => {
  assert.equal(handshakeReached(null, 100), false);
});

test('handshakeReached accepts a new health probe', () => {
  assert.equal(handshakeReached({ lastHealthAt: 101 }, 100), true);
});

test('handshakeReached accepts a new client seen signal', () => {
  assert.equal(handshakeReached({ lastClientSeenAt: 101 }, 100), true);
});

test('handshakeReached rejects stale health and client signals', () => {
  assert.equal(handshakeReached({ lastHealthAt: 99, lastClientSeenAt: 100 }, 100), false);
});
