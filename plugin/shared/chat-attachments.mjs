export const MAX_ATTACHMENTS_PER_TURN = 32;
export const MAX_CLIPBOARD_ITEM_BYTES = 256 * 1024 * 1024;
export const MAX_CLIPBOARD_TURN_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_MANIFEST_OPEN = '<ae_mcp_attachments version="1">';
export const ATTACHMENT_MANIFEST_CLOSE = '</ae_mcp_attachments>';

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value)) {
    throw new TypeError(field + ' must be ' + (allowEmpty ? 'a string' : 'a non-empty string'));
  }
  return value;
}

function normalizeAttachment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('attachment must be an object');
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    throw new TypeError('attachment.size must be a non-negative safe integer');
  }
  if (typeof value.temporary !== 'boolean') {
    throw new TypeError('attachment.temporary must be a boolean');
  }
  const attachment = {
    id: requireString(value.id, 'attachment.id'),
    name: requireString(value.name, 'attachment.name'),
    localPath: requireString(value.localPath, 'attachment.localPath'),
    size: value.size,
    mediaType: value.mediaType === undefined
      ? ''
      : requireString(value.mediaType, 'attachment.mediaType', { allowEmpty: true }),
    temporary: value.temporary,
  };
  return Object.freeze(attachment);
}

export function normalizeTurnInput(input) {
  const source = typeof input === 'string'
    ? { turnId: '', text: input, attachments: [] }
    : input;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('turn input must be a string or object');
  }
  const attachments = source.attachments;
  if (!Array.isArray(attachments)) {
    throw new TypeError('turn.attachments must be an array');
  }
  if (attachments.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new TypeError('turn.attachments exceeds the per-turn limit');
  }
  const normalized = {
    turnId: requireString(source.turnId, 'turn.turnId', { allowEmpty: true }),
    text: requireString(source.text, 'turn.text', { allowEmpty: true }),
    attachments: Object.freeze(attachments.map(normalizeAttachment)),
  };
  return Object.freeze(normalized);
}

export function displayAttachments(attachments) {
  return attachments.map((value) => {
    const { id, name, size, mediaType } = normalizeAttachment(value);
    return Object.freeze({
      id,
      name,
      size,
      ...(mediaType ? { mediaType } : {}),
    });
  });
}

export function attachmentManifest(attachments) {
  const files = attachments.map((value) => {
    const { id, name, localPath, size, mediaType } = normalizeAttachment(value);
    return {
      id,
      name,
      path: localPath,
      size,
      mediaType: mediaType || 'application/octet-stream',
    };
  });
  return ATTACHMENT_MANIFEST_OPEN + '\n'
    + JSON.stringify({ files }) + '\n'
    + ATTACHMENT_MANIFEST_CLOSE;
}

export function withAttachmentManifest(text, attachments) {
  const body = String(text || '');
  if (!attachments.length) return body;
  const manifest = attachmentManifest(attachments);
  return body ? body + '\n\n' + manifest : manifest;
}

function encodePathSegments(value) {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function attachmentFileUrl(localPath, platformId) {
  requireString(localPath, 'attachment path');
  if (platformId === 'macos-arm64') {
    if (!localPath.startsWith('/')) throw new TypeError('macOS attachment path must be absolute');
    return 'file://' + encodePathSegments(localPath);
  }
  if (platformId === 'windows-x64') {
    const normalized = localPath.replaceAll('\\', '/');
    if (!/^[A-Za-z]:\//.test(normalized)) {
      throw new TypeError('Windows attachment path must be absolute');
    }
    const drive = normalized.slice(0, 2);
    return 'file:///' + drive + encodePathSegments(normalized.slice(2));
  }
  throw new TypeError('unsupported attachment platform: ' + platformId);
}
