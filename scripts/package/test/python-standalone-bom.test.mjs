import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const bom = JSON.parse(fs.readFileSync('packaging/python-standalone-bom.json', 'utf8'));
const evidenceBundle = JSON.parse(
  fs.readFileSync('packaging/evidence/python-standalone/evidence-bundle.json', 'utf8'),
);
const schema = JSON.parse(
  fs.readFileSync('packaging/schemas/python-standalone-bom.schema.json', 'utf8'),
);

function component(platform, name) {
  return bom.platforms[platform].components.find((candidate) => candidate.name === name);
}

function componentNames(platform) {
  return bom.platforms[platform].components.map(({ name }) => name);
}

test('macOS BOM locks Itcl 4.3.5 payload and source-license evidence', () => {
  assert.deepEqual(component('macos-arm64', 'itcl'), {
    name: 'itcl',
    version: '4.3.5',
    relationship: 'DYNAMIC_LINK',
    disposition: 'payload',
    licenseDeclared: 'LicenseRef-Itcl-4.3.5',
    source: {
      kind: 'archive',
      url: 'https://prdownloads.sourceforge.net/tcl/tcl9.0.3-src.tar.gz',
      sha256: '2537ba0c86112c8c953f7c09d33f134dd45c0fb3a71f2d7f7691fd301d2c33a6',
    },
    evidenceOrigins: [{
      url: 'https://prdownloads.sourceforge.net/tcl/tcl9.0.3-src.tar.gz',
      sha256: '2537ba0c86112c8c953f7c09d33f134dd45c0fb3a71f2d7f7691fd301d2c33a6',
    }],
    licenseEvidence: [{
      kind: 'source-archive-member',
      path: 'tcl9.0.3/pkgs/itcl4.3.5/license.terms',
      archiveSha256: '2537ba0c86112c8c953f7c09d33f134dd45c0fb3a71f2d7f7691fd301d2c33a6',
      memberSha256: 'b61edfaeead97546bc62b1f205b046f2e440b83bfc517bc0932b93bc3d505865',
    }],
    payloadEvidence: {
      pkgIndex: {
        path: 'python/lib/itcl4.3.5/pkgIndex.tcl',
        size: 442,
        sha256: 'e4f4f5a9b506e05aafde44cf81bc3cb8f69a957cd54f78a52372c8d903d9dd06',
      },
      subtreeManifest: {
        path: 'python/lib/itcl4.3.5',
        entryCount: 9,
        algorithm: 'c-byte-sort-path-tab-size-tab-sha256-lf-v1',
        sha256: '34dd1364909ac67463de517a9f3727fc966b2c228ae13c082fcb0efb44a74359',
      },
    },
  });
});

test('macOS BOM locks Tcl Thread 3.0.4 payload and source-license evidence', () => {
  assert.deepEqual(component('macos-arm64', 'tcl-thread'), {
    name: 'tcl-thread',
    version: '3.0.4',
    relationship: 'DYNAMIC_LINK',
    disposition: 'payload',
    licenseDeclared: 'LicenseRef-Tcl-Thread-3.0.4',
    source: {
      kind: 'archive',
      url: 'https://prdownloads.sourceforge.net/tcl/tcl9.0.3-src.tar.gz',
      sha256: '2537ba0c86112c8c953f7c09d33f134dd45c0fb3a71f2d7f7691fd301d2c33a6',
    },
    evidenceOrigins: [{
      url: 'https://prdownloads.sourceforge.net/tcl/tcl9.0.3-src.tar.gz',
      sha256: '2537ba0c86112c8c953f7c09d33f134dd45c0fb3a71f2d7f7691fd301d2c33a6',
    }],
    licenseEvidence: [{
      kind: 'source-archive-member',
      path: 'tcl9.0.3/pkgs/thread3.0.4/license.terms',
      archiveSha256: '2537ba0c86112c8c953f7c09d33f134dd45c0fb3a71f2d7f7691fd301d2c33a6',
      memberSha256: '0a03981c40f7813ce6ddbdfce9882020bcfd696ea044b21ef07619ed9b86abae',
    }],
    payloadEvidence: {
      pkgIndex: {
        path: 'python/lib/thread3.0.4/pkgIndex.tcl',
        size: 2163,
        sha256: '518198152af6f9952c9064d5daec110ef81c91f46c2e30fb1a4b12b713f3ed66',
      },
      subtreeManifest: {
        path: 'python/lib/thread3.0.4',
        entryCount: 4,
        algorithm: 'c-byte-sort-path-tab-size-tab-sha256-lf-v1',
        sha256: 'c563ab6148871e424cd79f1a8d28ecf91bac2b1c9786517d89c93f0e062e19a5',
      },
    },
  });
});

test('HACL component declares both license families with license-bearing files', () => {
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const hacl = component(platform, 'hacl-star');
    assert.equal(hacl.licenseDeclared, 'MIT AND Apache-2.0');
    assert.deepEqual(hacl.licenseEvidence, [
      {
        kind: 'source-archive-member',
        path: 'hacl-star-bb3d0dc8d9d15a5cd51094d5b69e70aa09005ff0/LICENSE',
        archiveSha256: 'e31e4ca10da91c585793c0eaf1b98aee3cb43e3a58d3d8d478593e5a6bd82927',
        memberSha256: 'c5accbbd8546e94c34aed24afe689a617627d18eed5a6c48277e48db57c23851',
      },
      {
        kind: 'source-archive-member',
        path: 'Python-3.13.14/Modules/_hacl/Hacl_Hash_MD5.c',
        archiveSha256: '639e43243c620a308f968213df9e00f2f8f62332f7adbaa7a7eeb9783057c690',
        memberSha256: 'f71cf6a0e8f09354c2af2c785a1d36e0cba7613a589be01ca8a3d8478f4c8874',
      },
      {
        kind: 'source-archive-member',
        path: 'Python-3.13.14/Modules/_hacl/include/krml/FStar_UInt128_Verified.h',
        archiveSha256: '639e43243c620a308f968213df9e00f2f8f62332f7adbaa7a7eeb9783057c690',
        memberSha256: '455e94f24a0900deda7e6e36f4714e4253d32cea077f97e23f90c569a717bc48',
      },
    ]);
  }
});

test('CPython uses the composite SPDX Python-2.0 identifier', () => {
  for (const platform of ['macos-arm64', 'windows-x64']) {
    assert.equal(
      component(platform, 'cpython').licenseDeclared,
      'Python-2.0',
    );
  }
});

test('Windows models Tcl, Tk, and Tix as separate components', () => {
  assert.ok(!componentNames('windows-x64').includes('tcl-tk-tix-windows-bundle'));
  assert.deepEqual(
    ['tcl', 'tk', 'tix'].map((name) => component('windows-x64', name)),
    [
      {
        name: 'tcl',
        version: '8.6.12',
        relationship: 'DYNAMIC_LINK',
        disposition: 'payload',
        licenseDeclared: 'TCL',
        source: {
          kind: 'archive',
          url: 'https://prdownloads.sourceforge.net/tcl/tcl8.6.12-src.tar.gz',
          sha256: '26c995dd0f167e48b11961d891ee555f680c175f7173ff8cb829f4ebcde4c1a6',
        },
        evidenceOrigins: [{
          url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-pgo-full.tar.zst',
          sha256: 'df646d34e8a0b4aca87b8a253053c7e4994ba94fe2aebd9beb74697cc8e7516b',
        }],
        licenseEvidence: [{
          kind: 'metadata-file',
          path: 'python/licenses/LICENSE.tcl.txt',
          sha256: '41613eabfc08921a7da9c4bfd7f3ce5d5406f55214b253d89f392ed86eebeb8f',
        }],
      },
      {
        name: 'tk',
        version: '8.6.12',
        relationship: 'DYNAMIC_LINK',
        disposition: 'payload',
        licenseDeclared: 'TCL',
        source: {
          kind: 'archive',
          url: 'https://prdownloads.sourceforge.net/tcl/tk8.6.12-src.tar.gz',
          sha256: '12395c1f3fcb6bed2938689f797ea3cdf41ed5cb6c4766eec8ac949560310630',
        },
        evidenceOrigins: [{
          url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-pgo-full.tar.zst',
          sha256: 'df646d34e8a0b4aca87b8a253053c7e4994ba94fe2aebd9beb74697cc8e7516b',
        }],
        licenseEvidence: [{
          kind: 'metadata-file',
          path: 'python/licenses/LICENSE.tcl.txt',
          sha256: '41613eabfc08921a7da9c4bfd7f3ce5d5406f55214b253d89f392ed86eebeb8f',
        }],
      },
      {
        name: 'tix',
        version: '8.4.3.6',
        relationship: 'DYNAMIC_LINK',
        disposition: 'payload',
        licenseDeclared: 'LicenseRef-Tix-8.4.3.6',
        source: {
          kind: 'archive',
          url: 'https://github.com/python/cpython-source-deps/archive/tix-8.4.3.6.tar.gz',
          sha256: 'f7b21d115867a41ae5fd7c635a4c234d3ca25126c3661eb36028c6e25601f85e',
        },
        evidenceOrigins: [{
          url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-pgo-full.tar.zst',
          sha256: 'df646d34e8a0b4aca87b8a253053c7e4994ba94fe2aebd9beb74697cc8e7516b',
        }],
        licenseEvidence: [{
          kind: 'metadata-file',
          path: 'python/licenses/LICENSE.tix.txt',
          sha256: '8cdff3addb9e9eb108c78e2cf5e05f26b216c098304945733bbec382b2eaef66',
        }],
      },
    ],
  );
});

test('external dependency scope and audited link sets are explicit and exact', () => {
  assert.equal(
    bom.platforms['macos-arm64'].externalSystemDependenciesScope,
    'locked-payload-native-imports-excluding-baseline-loader-libraries',
  );
  assert.deepEqual(bom.platforms['macos-arm64'].externalSystemDependencies, [
    'AppKit.framework',
    'ApplicationServices.framework',
    'Carbon.framework',
    'Cocoa.framework',
    'CoreFoundation.framework',
    'CoreGraphics.framework',
    'CoreServices.framework',
    'CoreText.framework',
    'Foundation.framework',
    'IOKit.framework',
    'QuartzCore.framework',
    'Security.framework',
    'SystemConfiguration.framework',
    'UniformTypeIdentifiers.framework',
    'libSystem',
    'libedit',
    'libncurses',
    'libobjc',
    'libpanel',
    'libz',
  ]);

  assert.equal(
    bom.platforms['windows-x64'].externalSystemDependenciesScope,
    'PYTHON.json-declared-system-links-excluding-placeholders-and-baseline-loader-libraries',
  );
  assert.deepEqual(bom.platforms['windows-x64'].externalSystemDependencies, [
    'Crypt32',
    'Iphlpapi',
    'Ole32',
    'OleAut32',
    'PathCch',
    'Propsys',
    'Rpcrt4',
    'User32',
    'Version',
    'Wbemuuid',
    'Winmm',
    'Ws2_32',
  ]);
});

test('schema requires explicit external scope and models locked payload evidence', () => {
  const platformSchema = schema.$defs.platform;
  assert.ok(platformSchema.required.includes('externalSystemDependenciesScope'));
  assert.deepEqual(platformSchema.properties.externalSystemDependenciesScope.enum, [
    'locked-payload-native-imports-excluding-baseline-loader-libraries',
    'PYTHON.json-declared-system-links-excluding-placeholders-and-baseline-loader-libraries',
  ]);
  assert.deepEqual(
    schema.$defs.component.properties.payloadEvidence.$ref,
    '#/$defs/payloadEvidence',
  );
  assert.ok(schema.$defs.platform.properties.metadataSource.required.includes('expandedTarBytes'));
  assert.ok(schema.$defs.platform.properties.metadataSource.required.includes('expandedTarSha256'));
  assert.ok(schema.$defs.component.required.includes('evidenceOrigins'));
  assert.deepEqual(schema.$defs.component.properties.evidenceOrigins, {
    type: 'array',
    uniqueItems: true,
    items: { $ref: '#/$defs/evidenceOrigin' },
  });
  assert.deepEqual(
    schema.$defs.licenseEvidence.oneOf.map(({ required }) => required),
    [
      ['kind', 'path', 'sha256'],
      ['kind', 'path', 'archiveSha256', 'memberSha256'],
    ],
  );
});

test('every component evidenceOrigins exactly matches origins used by its bundled evidence', () => {
  for (const platform of ['macos-arm64', 'windows-x64']) {
    for (const componentValue of bom.platforms[platform].components) {
      const origins = new Map();
      for (const record of componentValue.licenseEvidence) {
        if (record.kind === 'payload-file') continue;
        const matches = evidenceBundle.entries.filter((entry) =>
          entry.platforms.includes(platform)
          && entry.kind === record.kind
          && entry.memberPath === record.path);
        assert.equal(
          matches.length,
          1,
          `${platform}:${componentValue.name}:${record.path} must resolve exactly once`,
        );
        const origin = matches[0].origin;
        origins.set(`${origin.url}\0${origin.sha256}`, origin);
      }
      const expected = [...origins.entries()]
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([, origin]) => origin);
      assert.deepEqual(componentValue.evidenceOrigins, expected, `${platform}:${componentValue.name}`);
    }
  }
});

test('component names remain unique after expanding aggregate dependencies', () => {
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const names = componentNames(platform);
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
  }
});
