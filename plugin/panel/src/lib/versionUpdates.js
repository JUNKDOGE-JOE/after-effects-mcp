export const UPDATE_CACHE_MS = 86400000;

export function compareVersions(left, right) {
  const parse = (value) => /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(String(value || '').trim());
  const a = parse(left), b = parse(right);
  if (!a || !b || [...a.slice(1), ...b.slice(1)].some((n) => !Number.isSafeInteger(Number(n)))) return null;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) !== Number(b[i])) return Math.sign(Number(a[i]) - Number(b[i]));
  }
  return 0;
}

export function createVersionChecker({ requestJson, url, headers, parseRelease, now = Date.now, timeoutMs = 8000,
  readCache = () => null, writeCache = () => {}, validEntry = () => true }) {
  let entry;
  try { entry = readCache(); } catch {}
  const usable = (value) => value && Number.isFinite(value.checkedAt) && now() >= value.checkedAt
    && now() - value.checkedAt < UPDATE_CACHE_MS && compareVersions(value.latest, value.latest) === 0 && validEntry(value);
  let pending;
  async function refresh() {
    let timer;
    try {
      const result = await Promise.race([
        requestJson({ url, headers, timeoutMs }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs); }),
      ]);
      if (!result.ok) return { reason: [403, 429].includes(result.status) ? 'limited' : 'network' };
      const release = parseRelease(result.json);
      if (!release || compareVersions(release.latest, release.latest) !== 0) return { reason: 'release' };
      entry = { ...release, checkedAt: now() };
      try { writeCache(entry); } catch {}
      return entry;
    } catch (error) {
      return { reason: error?.code === 'ETIMEDOUT' ? 'timeout' : 'network' };
    } finally { clearTimeout(timer); }
  }
  return async (current, { force = false } = {}) => {
    let value = entry;
    if (pending || force || !usable(entry)) {
      if (!pending) pending = refresh().finally(() => { pending = null; });
      value = await pending;
    }
    if (value.reason) return { status: 'unknown', current, reason: value.reason };
    const comparison = compareVersions(current, value.latest);
    return { ...value, current, status: comparison === null ? 'unknown' : comparison < 0 ? 'update' : 'current',
      ...(comparison === null ? { reason: 'version' } : {}) };
  };
}
