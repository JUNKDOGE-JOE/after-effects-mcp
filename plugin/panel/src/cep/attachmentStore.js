import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_CLIPBOARD_ITEM_BYTES,
  MAX_CLIPBOARD_TURN_BYTES,
  attachmentMediaType,
} from '../../../shared/chat-attachments.mjs';

function attachmentError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function browserBlobChunk(slice) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(slice);
  });
}

function requireSegment(value, field) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw attachmentError('ATTACHMENT_INVALID', field + ' must be a safe path segment');
  }
  return text;
}

function safeBasename(value, fallback = 'attachment') {
  const normalized = String(value || '').replace(/\\/g, '/');
  const name = normalized.split('/').filter(Boolean).pop() || fallback;
  return name === '.' || name === '..' ? fallback : name;
}

function mediaTypeOf(file) {
  return attachmentMediaType(file?.name, file?.type);
}

function writeAll(fs, descriptor, bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  while (offset < view.byteLength) {
    const written = fs.writeSync(descriptor, view, offset, view.byteLength - offset);
    if (!written) throw new Error('attachment write made no progress');
    offset += written;
  }
}

function removeEmptyDirectory(fs, directory) {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
  }
}

export function createAttachmentStore({
  platform,
  randomUUID,
  readBlobChunk = browserBlobChunk,
  chunkBytes = 1024 * 1024,
  now = Date.now,
}) {
  if (!platform?.paths || !platform?.fs) throw new TypeError('attachment store requires a platform adapter');
  if (typeof randomUUID !== 'function') throw new TypeError('attachment store requires randomUUID');
  if (typeof readBlobChunk !== 'function') throw new TypeError('attachment store requires readBlobChunk');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new TypeError('chunkBytes must be positive');

  const { fs } = platform;
  const root = platform.paths.join([
    platform.paths.tempRoot,
    'ae-mcp-panel-attachments',
  ]);
  const records = new Map();
  let disposed = false;

  function sessionRecords(sessionId) {
    return [...records.values()].filter((record) => record.sessionId === sessionId);
  }

  function reserve({ sessionId, pondId, size, temporary }) {
    if (disposed) throw attachmentError('ATTACHMENT_STORE_DISPOSED', 'Attachment store is disposed');
    const safeSessionId = requireSegment(sessionId, 'sessionId');
    requireSegment(pondId, 'pondId');
    const existing = [...records.values()];
    if (existing.length >= MAX_ATTACHMENTS_PER_TURN) {
      throw attachmentError('ATTACHMENT_COUNT_LIMIT', 'Attachment count exceeds the per-turn limit');
    }
    if (temporary && size > MAX_CLIPBOARD_ITEM_BYTES) {
      throw attachmentError('ATTACHMENT_ITEM_TOO_LARGE', 'Clipboard attachment exceeds the per-item limit');
    }
    const reservedBytes = existing.reduce(
      (total, record) => total + (record.temporary ? record.size : 0),
      0,
    );
    if (temporary && reservedBytes + size > MAX_CLIPBOARD_TURN_BYTES) {
      throw attachmentError('ATTACHMENT_TURN_TOO_LARGE', 'Clipboard attachments exceed the per-turn limit');
    }
    const id = requireSegment(randomUUID(), 'attachment id');
    if (records.has(id)) throw attachmentError('ATTACHMENT_ID_COLLISION', 'Attachment id already exists');
    const record = {
      id,
      pondId,
      sessionId: safeSessionId,
      size,
      temporary,
      createdAt: Number(now()),
      ref: null,
    };
    records.set(id, record);
    return record;
  }

  function protectDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(directory, 0o700);
    } catch (error) {
      if (platform.id !== 'windows-x64') throw error;
    }
    if (fs.lstatSync(directory).isSymbolicLink()) {
      throw attachmentError('ATTACHMENT_STAGING_FAILED', 'Attachment directory must not be a symbolic link');
    }
  }

  function cleanupTemporary(record, candidate = record?.ref?.localPath) {
    if (!record?.temporary || !candidate || !platform.paths.contains(root, candidate)) return;
    try {
      fs.unlinkSync(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const sessionDirectory = platform.paths.join([root, record.sessionId]);
    if (platform.paths.contains(root, sessionDirectory)) removeEmptyDirectory(fs, sessionDirectory);
    removeEmptyDirectory(fs, root);
  }

  async function preparePathless(file, context) {
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || typeof file?.slice !== 'function') {
      throw attachmentError('ATTACHMENT_INVALID', 'Pathless attachment must be a Blob-like file');
    }
    const record = reserve({
      ...context,
      size: file.size,
      temporary: true,
    });
    const name = safeBasename(file.name);
    const sessionDirectory = platform.paths.join([root, record.sessionId]);
    const partPath = platform.paths.join([sessionDirectory, record.id + '.part']);
    const finalPath = platform.paths.join([sessionDirectory, record.id + '-' + name]);
    let descriptor = null;
    try {
      protectDirectory(root);
      protectDirectory(sessionDirectory);
      if (!platform.paths.contains(root, partPath) || !platform.paths.contains(root, finalPath)) {
        throw attachmentError('ATTACHMENT_STAGING_FAILED', 'Attachment staging path escaped the managed root');
      }
      descriptor = fs.openSync(partPath, 'wx', 0o600);
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        const slice = file.slice(offset, Math.min(file.size, offset + chunkBytes));
        const chunk = await readBlobChunk(slice);
        writeAll(fs, descriptor, chunk);
      }
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(partPath, finalPath);
      const ref = Object.freeze({
        id: record.id,
        name,
        localPath: finalPath,
        size: file.size,
        mediaType: mediaTypeOf(file),
        temporary: true,
      });
      record.ref = ref;
      return ref;
    } catch (cause) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // The staging error remains primary.
        }
      }
      cleanupTemporary(record, partPath);
      records.delete(record.id);
      if (cause?.code?.startsWith?.('ATTACHMENT_')) throw cause;
      throw attachmentError('ATTACHMENT_STAGING_FAILED', 'Failed to stage local attachment', cause);
    }
  }

  async function preparePathBacked(file, context) {
    if (!platform.paths.isAbsolute(file.path)) {
      throw attachmentError('ATTACHMENT_INVALID', 'Attachment path must be absolute');
    }
    const localPath = platform.paths.resolve([file.path]);
    let stat;
    try {
      stat = fs.statSync(localPath);
      if (!stat.isFile()) throw new Error('not a regular file');
      fs.accessSync(localPath, fs.constants.R_OK);
    } catch (cause) {
      throw attachmentError('ATTACHMENT_UNREADABLE', 'Attachment path is not a readable file', cause);
    }
    const record = reserve({
      ...context,
      size: stat.size,
      temporary: false,
    });
    const name = safeBasename(file.name || platform.paths.basename(localPath));
    const ref = Object.freeze({
      id: record.id,
      name,
      localPath,
      size: stat.size,
      mediaType: mediaTypeOf(file),
      temporary: false,
    });
    record.ref = ref;
    return ref;
  }

  return Object.freeze({
    validate(attachments) {
      for (const ref of attachments) {
        try {
          if (!fs.statSync(ref.localPath).isFile()) throw new Error('not a file');
          fs.accessSync(ref.localPath, fs.constants.R_OK);
        } catch (cause) {
          throw attachmentError('ATTACHMENT_UNREADABLE', 'Attachment file is no longer readable. Remove it and select it again.', cause);
        }
      }
    },
    prepare(file, context = {}) {
      if (file?.path) return preparePathBacked(file, context);
      return preparePathless(file, context);
    },
    release(attachmentId) {
      const record = records.get(attachmentId);
      if (!record) return;
      cleanupTemporary(record);
      records.delete(attachmentId);
    },
    releaseSession(sessionId) {
      for (const record of sessionRecords(String(sessionId || ''))) {
        cleanupTemporary(record);
        records.delete(record.id);
      }
    },
    releaseAll() {
      for (const record of [...records.values()]) {
        cleanupTemporary(record);
        records.delete(record.id);
      }
    },
    dispose() {
      if (disposed) return;
      for (const record of [...records.values()]) {
        cleanupTemporary(record);
        records.delete(record.id);
      }
      disposed = true;
    },
  });
}
