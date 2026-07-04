import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStableJsonValue } from '../src/lib/stableValue.js';

test('reconcileStableJsonValue keeps identity for unchanged JSON content', () => {
  let snapshot = reconcileStableJsonValue(null, {
    model: 'gpt-5.5',
    providerId: 'mediastorm',
    provider: {
      baseUrl: 'https://api.example.com/v1',
      envKey: 'MEDIASTORM_GLM_API_KEY',
    },
  });
  const first = snapshot.value;

  snapshot = reconcileStableJsonValue(snapshot, {
    model: 'gpt-5.5',
    providerId: 'mediastorm',
    provider: {
      baseUrl: 'https://api.example.com/v1',
      envKey: 'MEDIASTORM_GLM_API_KEY',
    },
  });

  assert.equal(snapshot.value, first);

  snapshot = reconcileStableJsonValue(snapshot, {
    model: 'gpt-5.5',
    providerId: 'mediastorm',
    provider: {
      baseUrl: 'https://api.example.com/v1',
      envKey: 'MEDIASTORM_GLM_API_KEY_2',
    },
  });

  assert.notEqual(snapshot.value, first);
});
