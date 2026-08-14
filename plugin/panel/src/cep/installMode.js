// Single source of truth for the development-vs-packaged install decision.
//
// #239 root cause: four call sites answered this question four different ways.
// claudeAuth trusted `.debug` plus one file probe, which mis-selected the
// stage-root sidecar inside the macOS production bundle — that bundle is
// REQUIRED to carry `.debug` by stage-platform-bundle.mjs, so the marker alone
// can never mean "development". Packaged evidence must win over the marker.
//
// Packaged evidence is either the staged bundle manifest (macOS platform
// bundle) or the relocated host runtime payload (Windows ZXP, which ships no
// bundle manifest by contract — see FORBIDDEN_RUNTIME_PATHS in
// verify-windows-zxp-stage.mjs).

export function packagedEvidencePaths({ extRoot, adapter }) {
  return [
    adapter.paths.join([extRoot, 'bundle-manifest.json']),
    adapter.paths.join([
      extRoot, 'runtime', adapter.id, 'node', 'host', 'package.json',
    ]),
  ];
}

export function hasPackagedEvidence({ extRoot, adapter, fsImpl }) {
  const fs = fsImpl || adapter.fs;
  return packagedEvidencePaths({ extRoot, adapter })
    .some((candidate) => fs.existsSync(candidate));
}

export function isDevelopmentInstall({ extRoot, adapter, fsImpl }) {
  const fs = fsImpl || adapter.fs;
  const marker = adapter.paths.join([extRoot, '.debug']);
  if (!fs.existsSync(marker)) return false;
  return !hasPackagedEvidence({ extRoot, adapter, fsImpl: fs });
}
