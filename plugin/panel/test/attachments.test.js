import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_MANIFEST_CLOSE,
  ATTACHMENT_MANIFEST_OPEN,
  attachmentFileUrl,
  attachmentManifest,
  displayAttachments,
  normalizeTurnInput,
  withAttachmentManifest,
} from '../../shared/chat-attachments.mjs';

function fixtureAttachment(overrides = {}) {
  return {
    id: 'att-1',
    name: 'clip.bin',
    localPath: '/tmp/private/clip.bin',
    size: 3,
    mediaType: 'application/octet-stream',
    temporary: true,
    ...overrides,
  };
}

test('normalizeTurnInput preserves legacy text turns', () => {
  assert.deepEqual(normalizeTurnInput('hello'), {
    turnId: '',
    text: 'hello',
    attachments: [],
  });
});

test('normalizeTurnInput preserves an attachment-only turn and order', () => {
  const turn = normalizeTurnInput({
    turnId: 'turn-1',
    text: '',
    attachments: [
      fixtureAttachment(),
      fixtureAttachment({
        id: 'att-2',
        name: 'frame.png',
        localPath: '/tmp/private/frame.png',
        size: 9,
        mediaType: 'image/png',
        temporary: false,
      }),
    ],
  });

  assert.equal(turn.turnId, 'turn-1');
  assert.equal(turn.text, '');
  assert.deepEqual(turn.attachments.map((file) => file.id), ['att-1', 'att-2']);
  assert.equal(turn.attachments[0].localPath, '/tmp/private/clip.bin');
  assert.notEqual(turn.attachments, normalizeTurnInput({
    turnId: 'turn-1',
    text: '',
    attachments: [fixtureAttachment()],
  }).attachments);
});

test('normalizeTurnInput rejects malformed attachment turns', () => {
  const invalidTurns = [
    null,
    [],
    { turnId: 7, text: '', attachments: [] },
    { turnId: 'turn-1', text: 7, attachments: [] },
    { turnId: 'turn-1', text: '', attachments: 'nope' },
    { turnId: 'turn-1', text: '', attachments: [{}] },
    {
      turnId: 'turn-1',
      text: '',
      attachments: [fixtureAttachment({ size: -1 })],
    },
    {
      turnId: 'turn-1',
      text: '',
      attachments: [fixtureAttachment({ temporary: 'yes' })],
    },
  ];

  for (const value of invalidTurns) {
    assert.throws(() => normalizeTurnInput(value), TypeError);
  }
});

test('normalizeTurnInput rejects a turn with neither text nor attachments', () => {
  assert.throws(
    () => normalizeTurnInput({ turnId: 'turn-1', text: '', attachments: [] }),
    /text or attachment/i,
  );
});

test('display metadata never contains a local path or ownership flag', () => {
  const value = displayAttachments([fixtureAttachment()]);
  assert.deepEqual(value, [{
    id: 'att-1',
    name: 'clip.bin',
    size: 3,
    mediaType: 'application/octet-stream',
  }]);
  assert.equal(JSON.stringify(value).includes('/tmp/private'), false);
  assert.equal(Object.hasOwn(value[0], 'temporary'), false);
});

test('attachment manifest exposes every selected path in order', () => {
  const manifest = attachmentManifest([
    fixtureAttachment(),
    fixtureAttachment({
      id: 'att-2',
      name: 'frame.png',
      localPath: '/tmp/private/frame.png',
      size: 9,
      mediaType: '',
      temporary: false,
    }),
  ]);

  assert.equal(manifest, [
    ATTACHMENT_MANIFEST_OPEN,
    '{"files":[{"id":"att-1","name":"clip.bin","path":"/tmp/private/clip.bin","size":3,"mediaType":"application/octet-stream"},{"id":"att-2","name":"frame.png","path":"/tmp/private/frame.png","size":9,"mediaType":"application/octet-stream"}]}',
    ATTACHMENT_MANIFEST_CLOSE,
  ].join('\n'));
});

test('withAttachmentManifest leaves text-only turns unchanged', () => {
  assert.equal(withAttachmentManifest('inspect', []), 'inspect');
});

test('withAttachmentManifest appends one manifest after text', () => {
  const value = withAttachmentManifest('inspect', [fixtureAttachment()]);
  assert.equal(value.startsWith('inspect\n\n' + ATTACHMENT_MANIFEST_OPEN), true);
  assert.equal(value.endsWith(ATTACHMENT_MANIFEST_CLOSE), true);
});

test('attachmentFileUrl encodes macOS and Windows path components', () => {
  assert.equal(
    attachmentFileUrl('/Users/Test/AE files/a#b.png', 'macos-arm64'),
    'file:///Users/Test/AE%20files/a%23b.png',
  );
  assert.equal(
    attachmentFileUrl('C:\\Users\\Test\\AE files\\a#b.png', 'windows-x64'),
    'file:///C:/Users/Test/AE%20files/a%23b.png',
  );
  assert.equal(
    attachmentFileUrl('\\\\server\\share\\AE files\\a#b.png', 'windows-x64'),
    'file://server/share/AE%20files/a%23b.png',
  );
});
