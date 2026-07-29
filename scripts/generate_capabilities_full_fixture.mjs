#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  capabilityDigest,
  nativeCapabilityRegistry,
} from '../native/ae-plugin/protocol/conformance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = path.join(ROOT, 'native', 'ae-plugin', 'protocol');
const SCHEMA = path.join(PROTOCOL, 'aegp-rpc.schema.json');
const FULL_FIXTURE = path.join(PROTOCOL, 'fixtures', 'capability-registry-full.json');

function buildFixture() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const registry = nativeCapabilityRegistry(schema);
  return {
    _fixture: {
      classification: 'synthetic-non-wire-full-capability-registry',
      runtimeEvidence: false,
      compatibilityEvidence: false,
    },
    capabilitiesDigest: capabilityDigest(registry),
    items: registry,
  };
}

const expected = JSON.stringify(buildFixture(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(FULL_FIXTURE) || fs.readFileSync(FULL_FIXTURE, 'utf8') !== expected) {
    console.error(path.relative(ROOT, FULL_FIXTURE));
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(FULL_FIXTURE, expected);
}
