import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => fs.readFileSync(
  path.join(root, 'Sources', 'PlatformHelperService', name),
  'utf8',
);

test('production authorization uses only public connection identity and BSD process APIs', () => {
  const authorization = source('Authorization.swift');
  const service = source('ServiceRegistration.swift');

  assert.match(authorization, /sysctl/);
  assert.match(authorization, /KERN_PROC_PID/);
  assert.match(authorization, /P_TRANSLATED/);
  assert.doesNotMatch(authorization, /proc_pidinfo|PROC_PIDARCHINFO/);
  assert.doesNotMatch(`${authorization}\n${service}`, /\.auditToken\b|_auditToken|getAuditToken/);
});

test('rejected XPC peers cannot instantiate or reach production backends', () => {
  const service = source('ServiceRegistration.swift');
  const rejectionStart = service.indexOf('final class RejectionOnlyPlatformHelperExport');
  const listenerStart = service.indexOf('final class PlatformHelperListenerDelegate');
  const rejection = service.slice(rejectionStart, listenerStart);

  assert.ok(rejectionStart >= 0 && listenerStart > rejectionStart);
  assert.match(service, /setCodeSigningRequirement/);
  assert.match(rejection, /boundedRequestIdentifier/);
  assert.doesNotMatch(rejection, /KeychainSecretStore|ScreenCapture|ProtocolRequestValidator/);
});

test('authorized connections share one lazily-created serial credential store', () => {
  const service = source('ServiceRegistration.swift');
  assert.match(service, /final class AuthorizedBackendRegistry/);
  assert.match(service, /private let backendRegistry/);
  assert.match(service, /backendRegistry\.secretStore\(\)/);
  assert.doesNotMatch(service, /AuthorizedPlatformHelperExport[\s\S]*secrets: KeychainSecretStore\(\)/);
});

test('credential rollback never swallows errors and exposes uncertain state explicitly', () => {
  const keychain = source('KeychainSecretStore.swift');
  const protocol = source('ProtocolDispatcher.swift');
  assert.doesNotMatch(keychain, /try\?/);
  assert.match(keychain, /restoreAndVerify/);
  assert.match(protocol, /state is uncertain/);
});

test('standalone Mach service remains alive after activating its listener', () => {
  const service = source('ServiceRegistration.swift');
  assert.match(service, /static var retainedDelegate/);
  assert.match(service, /retainedDelegate = delegate/);
  assert.match(service, /listener\.activate\(\)[\s\S]*dispatchMain\(\)/);
  assert.doesNotMatch(service, /listener returned unexpectedly/);
});

test('Phase 0 documents exact helper commands, environment, and CEP identity limitation', () => {
  const phase0 = fs.readFileSync(
    path.join(root, '../../../docs/platform/PHASE0.md'),
    'utf8',
  );
  for (const required of [
    'AE_MCP_NODE_HEADERS_ARCHIVE',
    'AE_MCP_MACOS_SDK',
    'AE_MCP_SWIFT_INTERFACE_COMPILER_VERSION',
    'launchctl bootstrap "$domain" "$probe_plist"',
    'launchctl bootout "$domain/com.junkdoge.ae-mcp.platform-helper"',
    '256-bit',
    'single-use',
    'state is uncertain',
  ]) {
    assert.match(phase0, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(phase0, /other\s+Adobe CEP extensions/);
  assert.match(phase0, /argv, environment variables, or current\s+working directory/);
  assert.match(phase0, /does not\s+(?:solve|close)/);
});
