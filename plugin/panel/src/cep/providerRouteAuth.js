export function generateRouteToken({ randomBytes } = {}) {
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes is required');
  const bytes = randomBytes(32);
  if (!bytes || bytes.length !== 32) throw new TypeError('randomBytes must return exactly 32 bytes');
  return Buffer.from(bytes).toString('base64url');
}

export function parseRouteTokenHeader(rawHeaders = []) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === LOCAL_ROUTE_TOKEN_HEADER) {
      values.push(String(rawHeaders[index + 1]));
    }
  }
  if (values.length !== 1) return null;
  return /^[A-Za-z0-9_-]+$/.test(values[0]) ? values[0] : null;
}

export function parseRouteAuthorization(rawHeaders = []) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === 'authorization') {
      values.push(String(rawHeaders[index + 1]));
    }
  }
  if (values.length !== 1) return null;
  const match = values[0].match(/^Bearer ([A-Za-z0-9_-]+)$/i);
  return match ? match[1] : null;
}

export function parseRouteToken(rawHeaders = []) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;
  let dedicatedCount = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === LOCAL_ROUTE_TOKEN_HEADER) dedicatedCount += 1;
  }
  if (dedicatedCount > 0) return parseRouteTokenHeader(rawHeaders);
  return parseRouteAuthorization(rawHeaders);
}

export function routeTokenMatches(candidate, expected, { createHash, timingSafeEqual } = {}) {
  if (typeof createHash !== 'function' || typeof timingSafeEqual !== 'function') {
    throw new TypeError('createHash and timingSafeEqual are required');
  }
  const left = createHash('sha256').update(String(candidate), 'utf8').digest();
  const right = createHash('sha256').update(String(expected), 'utf8').digest();
  return timingSafeEqual(left, right);
}
import { LOCAL_ROUTE_TOKEN_HEADER } from '../lib/providerHeaders.js';
