import { compareVersions, createVersionChecker } from './versionUpdates.js';
import { REPO_URL } from './externalLinks.js';

export const PANEL_UPDATE_CACHE = 'ae-mcp.panel-release-cache';
export const PANEL_UPDATE_DISMISSED = 'ae-mcp.panel-release-dismissed';
export const PANEL_RELEASE_API = 'https://api.github.com/repos/JUNKDOGE-JOE/after-effects-mcp/releases/latest';
const releasePage = (tag) => `${REPO_URL}/releases/tag/${encodeURIComponent(tag)}`;

export function createPanelUpdateChecker({ readPref, writePref, ...options }) {
  return createVersionChecker({
    ...options, url: PANEL_RELEASE_API,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ae-mcp-panel' },
    readCache: () => JSON.parse(readPref(PANEL_UPDATE_CACHE, 'null')),
    writeCache: (value) => writePref(PANEL_UPDATE_CACHE, JSON.stringify(value)),
    validEntry: (value) => value.url === releasePage(value.latest),
    parseRelease: (release) => release?.draft === false && release?.prerelease === false
      ? { latest: release.tag_name, url: releasePage(release.tag_name) } : null,
  });
}

export function showPanelUpdate(update, dismissed) {
  return update?.status === 'update' && compareVersions(update.latest, dismissed) !== 0;
}
