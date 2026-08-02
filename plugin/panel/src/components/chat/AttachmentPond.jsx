import React from 'react';
import { FilePond, registerPlugin } from 'react-filepond';
import FilePondPluginImagePreview from 'filepond-plugin-image-preview';
import { MAX_ATTACHMENTS_PER_TURN } from '../../../../shared/chat-attachments.mjs';
import { Icon } from '../core/Icon';

registerPlugin(FilePondPluginImagePreview);

const DEFAULT_LABELS = {
  add: '添加文件 Add files',
  drop: '拖放、粘贴或选择文件 Drop, paste, or browse',
  staging: '正在准备 Preparing…',
  ready: '已就绪 Ready',
  retry: '重试 Retry',
  remove: '移除 Remove',
};

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function findItem(items, fileItem) {
  return items.find((item) => item.pondId === fileItem?.id || item.file === fileItem?.file);
}

export const AttachmentPond = React.forwardRef(function AttachmentPond({
  items = [],
  disabled = false,
  labels: suppliedLabels,
  onAddFile,
  onRemoveAttachment,
  onRetryAttachment,
}, forwardedRef) {
  const pondRef = React.useRef(null);
  const labels = { ...DEFAULT_LABELS, ...(suppliedLabels || {}) };
  const pondFiles = items.map((item) => item.file).filter(Boolean);
  const labelIdle = labels.drop
    + ' <span class="filepond--label-action">' + labels.add + '</span>';

  React.useImperativeHandle(forwardedRef, () => ({
    addFiles(files) {
      return pondRef.current?.addFiles(Array.from(files || []));
    },
  }), []);

  const handleAdd = (error, fileItem) => {
    if (error || !fileItem?.file || findItem(items, fileItem)) return;
    onAddFile?.({ pondId: fileItem.id, file: fileItem.file });
  };

  const handleRemove = (error, fileItem) => {
    if (error) return;
    const item = findItem(items, fileItem);
    if (item) onRemoveAttachment?.(item);
  };

  return (
    <div className="ae-attachment-pond">
      <FilePond
        ref={pondRef}
        files={pondFiles}
        allowMultiple
        allowPaste
        allowBrowse={!disabled}
        allowDrop={!disabled}
        allowReorder={false}
        instantUpload={false}
        maxFiles={MAX_ATTACHMENTS_PER_TURN}
        credits={false}
        disabled={disabled}
        labelIdle={labelIdle}
        onaddfile={handleAdd}
        onremovefile={handleRemove}
      />
      {items.length ? (
        <div className="ae-attachment-status-list" aria-live="polite">
          {items.map((item) => (
            <div
              key={item.pondId}
              className={`ae-attachment-status ae-attachment-status--${item.status}`}
            >
              <Icon name="paperclip" size={12} />
              <span className="ae-attachment-status__name">{item.file?.name || item.ref?.name}</span>
              <span className="ae-attachment-status__size">
                {formatBytes(item.file?.size ?? item.ref?.size)}
              </span>
              <span className="ae-attachment-status__state">
                {item.status === 'staging'
                  ? labels.staging
                  : item.status === 'error'
                    ? (item.error?.message || labels.retry)
                    : labels.ready}
              </span>
              {item.status === 'error' ? (
                <button type="button" onClick={() => onRetryAttachment?.(item)}>
                  {labels.retry}
                </button>
              ) : null}
              <button type="button" onClick={() => onRemoveAttachment?.(item)}>
                {labels.remove}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});
