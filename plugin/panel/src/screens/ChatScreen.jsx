import React from 'react';
import { Icon } from '../components/core/Icon';
import { Button } from '../components/core/Button';
import { Spinner } from '../components/core/Spinner';
import { ChatBubble } from '../components/chat/ChatBubble';
import { ToolCallCard } from '../components/chat/ToolCallCard';
import { ApprovalCard } from '../components/chat/ApprovalCard';
import { QuestionCard } from '../components/chat/QuestionCard';
import { PromptCard } from '../components/chat/PromptCard';
import { Composer } from '../components/chat/Composer';
import { ComposerChip } from '../components/chat/ComposerChip';
import { AIAvatar } from '../components/chat/AIAvatar';
import { eventTitle } from '../lib/activityModel';
import { errorHint } from '../lib/errorCodes.js';
import { formatErrorDetail } from '../lib/errorDetail.js';
import { buildComposerChips } from '../lib/composerOptions';
import { turnProgressText } from '../lib/turnProgress.js';
import {
  createAttachmentDraftState,
  draftCanSend,
  readyAttachments,
} from '../lib/attachmentDraft';
import {
  COMPOSER_MIN_HEIGHT,
  composerAvailableHeight,
  createComposerHeightState,
  reduceComposerHeight,
} from '../lib/composerResize';

const C = {
  zh: {
    hello: '你好！我可以直接操作当前打开的 AE 工程。试试这些：',
    keyTitle: '在设置的 Provider 管理中选择可用渠道',
    keyCaption: '凭据由所选 CLI 的登录态或凭据存储保管。',
    newSession: '新会话',
    placeholder: '描述你想在 AE 里做什么…',
    noticeAction: '新会话',
    modelChip: '模型',
    effortChip: '思考',
    fastChip: '快速',
    approvalChip: '权限',
    errorTitle: '对话出错',
    modelErrorTitle: '模型不可用——换一个试试',
    denied: '已拒绝',
    running: '执行中',
    ok: '完成',
    failed: '失败',
    awaiting: '等待批准',
    thinking: '思考中…',
    progressTokens: (tokens) => `预计 ${tokens} tokens`,
    progressElapsed: (seconds) => `耗时 ${seconds}s`,
    progressWarning: '超过 3 分钟没有新的进度，任务仍在运行；不会自动停止或重试。',
    attachmentAdd: '添加文件',
    attachmentDrop: '拖放或粘贴文件',
    attachmentStaging: '正在准备…',
    attachmentReady: '已就绪',
    attachmentRetry: '重试',
    attachmentRemove: '移除',
    uncertainTurn: '发送结果不确定。请新建会话核对后再试。',
    details: '详情',
  },
  en: {
    hello: 'Hi! I can operate the open AE project directly. Try one of these:',
    keyTitle: 'Choose an available channel in Provider Manager',
    keyCaption: 'Credentials stay in the selected CLI login or credential store.',
    newSession: 'New session',
    placeholder: 'Describe what to do in AE…',
    noticeAction: 'New session',
    modelChip: 'Model',
    effortChip: 'Effort',
    fastChip: 'Fast',
    approvalChip: 'Approval',
    errorTitle: 'Chat error',
    modelErrorTitle: 'Model unavailable — pick another',
    denied: 'Denied',
    running: 'Running',
    ok: 'Done',
    failed: 'Failed',
    awaiting: 'Awaiting approval',
    thinking: 'Thinking…',
    progressTokens: (tokens) => `~${tokens} tokens`,
    progressElapsed: (seconds) => `${seconds}s elapsed`,
    progressWarning: 'No new progress for 3 minutes. The task is still running; it will not be stopped or retried automatically.',
    attachmentAdd: 'Add files',
    attachmentDrop: 'Drop or paste files',
    attachmentStaging: 'Preparing…',
    attachmentReady: 'Ready',
    attachmentRetry: 'Retry',
    attachmentRemove: 'Remove',
    uncertainTurn: 'Send outcome is uncertain. Start a new session before retrying.',
    details: 'Details',
  },
};

const DEFAULT_PROMPTS = {
  zh: [
    { icon: 'type', title: '创建一个标题动画', caption: '新建文本图层并加入位置关键帧' },
    { icon: 'layers', title: '整理工程素材', caption: '按类型把素材归进文件夹' },
    { icon: 'clapperboard', title: '给画面加电影感调色', caption: '添加调整图层与 Lumetri 预设' },
  ],
  en: [
    { icon: 'type', title: 'Create a title animation', caption: 'New text layer with position keyframes' },
    { icon: 'layers', title: 'Organize project assets', caption: 'Sort footage into folders by type' },
    { icon: 'clapperboard', title: 'Cinematic color grade', caption: 'Adjustment layer + Lumetri preset' },
  ],
};

function Notice({ text, actionLabel, onAction }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'var(--bg-well)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)' }}>
      <Icon name="plug" size={12} color="var(--text-tertiary)" />
      <span style={{ flex: 1, minWidth: 0, font: '400 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>{text}</span>
      {onAction ? <Button size="sm" variant="secondary" onClick={onAction}>{actionLabel}</Button> : null}
    </div>
  );
}

function statusForTool(state) {
  if (state === 'running' || state === 'awaiting-approval') return 'running';
  if (state === 'error' || state === 'denied') return 'error';
  return 'success';
}

function toolTarget(entry, t) {
  if (entry.state === 'awaiting-approval') return t.awaiting;
  if (entry.state === 'running') return t.running;
  if (entry.state === 'denied') return t.denied;
  if (entry.state === 'error') return t.failed;
  return t.ok;
}

function titleForTool(entry, lang) {
  return eventTitle({ undoGroup: `MCP ${entry.name || ''}` }, lang);
}

function Entry({ entry, lang, onApprove, onAnswerQuestion }) {
  const t = C[lang] || C.zh;
  if (entry.type === 'user-text') {
    return <ChatBubble role="user" attachments={entry.attachments}>{entry.text}</ChatBubble>;
  }
  if (entry.type === 'ai-text') {
    return <ChatBubble role="ai">{entry.text}</ChatBubble>;
  }
  if (entry.type === 'question') {
    return (
      <div style={{ paddingLeft: 28 }}>
        <QuestionCard
          lang={lang}
          title={entry.title}
          questions={entry.questions}
          state={entry.state}
          answers={entry.answers}
          onSubmit={(values) => onAnswerQuestion
            && onAnswerQuestion(entry.toolUseId, { action: 'submit', values })}
          onCancel={() => onAnswerQuestion
            && onAnswerQuestion(entry.toolUseId, { action: 'cancel' })}
        />
      </div>
    );
  }
  if (entry.type === 'tool-call') {
    const highRisk = entry.risk === 'destructive' || entry.risk === 'external';
    return (
      <div style={{ paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ToolCallCard
          verb={titleForTool(entry, lang)}
          target={toolTarget(entry, t)}
          status={statusForTool(entry.state)}
          params={entry.input}
          errorMessage={entry.state === 'error' ? entry.text : null}
        />
        {entry.state === 'awaiting-approval' ? (
          <ApprovalCard
            risk={highRisk ? 'high' : 'normal'}
            lang={lang}
            title={titleForTool(entry, lang)}
            description={entry.name}
            params={entry.input}
            onAllow={() => onApprove && onApprove(entry.toolUseId, 'allow')}
            onDeny={() => onApprove && onApprove(entry.toolUseId, 'deny')}
            onAllowSession={highRisk ? null : () => onApprove && onApprove(entry.toolUseId, 'allow-session')}
          />
        ) : null}
      </div>
    );
  }
  if (entry.type === 'error') {
    const details = formatErrorDetail(entry.detail);
    return (
      <div style={{ paddingLeft: 28 }}>
        <ToolCallCard
          verb={entry.kind === 'model' ? t.modelErrorTitle : t.errorTitle}
          target={entry.code || entry.kind}
          status="error"
          errorMessage={entry.message}
          hint={errorHint(entry.code || 'BACKEND_ERROR', lang)}
          details={details || null}
          detailsLabel={t.details}
        />
      </div>
    );
  }
  return null;
}

function menuItems(items, currentId, onSelect) {
  return (items || []).map((item) => ({
    label: item.label,
    hint: item.caption,
    checked: item.id === currentId,
    onSelect: () => onSelect && onSelect(item.id),
  }));
}

function progressSeconds(ms) {
  return Math.max(0, Math.round(Number(ms || 0) / 1000));
}

/* Chat tab. entries are folded from backend events by lib/chatEntries.js. */
export function ChatScreen({
  lang = 'zh',
  entries = [],
  streaming = false,
  thinking = false,
  turnStage = null,
  turnProgress = null,
  turnBackend = 'subscription',
  sessionTitle = '',
  onOpenSessions,
  composerDisabled = false,
  disabledHint = '',
  onSend,
  onStop,
  onApprove,
  onAnswerQuestion,
  onNewSession,
  promptCards,
  noticeActionLabel,
  onNoticeAction,
  chipState,
  onChipModel,
  onChipEffort,
  onChipFast,
  onChipApproval,
  attachmentDraft = createAttachmentDraftState(),
  dispatchAttachmentDraft,
  createTurnId,
  onAddFile,
  onRemoveAttachment,
  onRetryAttachment,
}) {
  const t = C[lang] || C.zh;
  const logRef = React.useRef(null);
  const layoutRef = React.useRef(null);
  const footerRef = React.useRef(null);
  const [composerSize, dispatchComposerSize] = React.useReducer(
    reduceComposerHeight,
    undefined,
    () => createComposerHeightState(),
  );
  const composerHeightRef = React.useRef(composerSize.height);
  composerHeightRef.current = composerSize.height;
  const hasEntries = entries.length > 0;
  const prompts = promptCards || DEFAULT_PROMPTS[lang] || DEFAULT_PROMPTS.zh;
  const chips = chipState && chipState.descriptor ? buildComposerChips({ ...chipState, lang }) : null;
  const composerOptions = chips ? (
    <React.Fragment>
      {chips.model ? (
        <ComposerChip
          icon="box"
          label={chips.model.current}
          title={t.modelChip}
          menuHeader={{ label: t.modelChip }}
          items={menuItems(chips.model.items, chipState.modelId, onChipModel)}
        />
      ) : null}
      {chips.effort ? (
        <ComposerChip
          icon="brain"
          label={chips.effort.current}
          title={t.effortChip}
          menuHeader={{ label: t.effortChip }}
          items={menuItems(chips.effort.items, chipState.effort, onChipEffort)}
        />
      ) : null}
      {chips.fast ? (
        <ComposerChip
          icon="zap"
          label={t.fastChip}
          title={t.fastChip}
          active={chips.fast.active}
          onToggle={(next) => onChipFast && onChipFast(next)}
        />
      ) : null}
      <ComposerChip
        icon="shield"
        label={chips.approval.current}
        title={t.approvalChip}
        menuHeader={{ label: t.approvalChip }}
        items={menuItems(chips.approval.items, chipState.permissionMode, onChipApproval)}
      />
    </React.Fragment>
  ) : null;

  React.useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, streaming, thinking, turnStage, turnProgress]);

  React.useEffect(() => {
    if (typeof ResizeObserver !== 'function') return undefined;
    if (!layoutRef.current || !footerRef.current) return undefined;

    const measureComposerBounds = () => {
      const layout = layoutRef.current;
      const footer = footerRef.current;
      if (!layout || !footer) return;
      const availableHeight = composerAvailableHeight({
        containerHeight: layout.getBoundingClientRect().height,
        footerHeight: footer.getBoundingClientRect().height,
        composerHeight: composerHeightRef.current,
      });
      dispatchComposerSize({ type: 'measure', availableHeight });
    };

    measureComposerBounds();
    const observer = new ResizeObserver(measureComposerBounds);
    observer.observe(layoutRef.current);
    observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, []);

  const sendTurn = (textOverride) => {
    const text = String(textOverride === undefined ? attachmentDraft.text : textOverride).trim();
    const candidate = textOverride === undefined
      ? attachmentDraft
      : { ...attachmentDraft, text };
    if (!draftCanSend(candidate) || composerDisabled || streaming || !createTurnId) return;
    if (textOverride !== undefined) {
      dispatchAttachmentDraft?.({ type: 'text', value: text });
    }
    const turnId = createTurnId();
    const turn = {
      turnId,
      text,
      attachments: readyAttachments(attachmentDraft),
    };
    dispatchAttachmentDraft?.({ type: 'sending', turnId, turn });
    onSend?.(turn);
  };
  const send = () => sendTurn();
  const sendError = attachmentDraft.sendError;
  const attachmentLabels = {
    add: t.attachmentAdd,
    drop: t.attachmentDrop,
    staging: t.attachmentStaging,
    ready: t.attachmentReady,
    retry: t.attachmentRetry,
    remove: t.attachmentRemove,
  };

  return (
    <div ref={layoutRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {sessionTitle ? (
        <div style={{ flex: 'none', height: 28, display: 'flex', alignItems: 'center', gap: 'var(--space-1)', padding: '0 var(--space-2)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Button
              variant="ghost"
              size="sm"
              icon="history"
              title={sessionTitle}
              onClick={onOpenSessions}
              style={{ maxWidth: '100%', minWidth: 0 }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessionTitle}</span>
            </Button>
          </div>
          <Button variant="ghost" size="sm" icon="plus" onClick={onNewSession}>{t.newSession}</Button>
        </div>
      ) : null}
      <div ref={logRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {!hasEntries && composerDisabled ? (
          <React.Fragment>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 'var(--space-5) 0 var(--space-2)', textAlign: 'center' }}>
              <AIAvatar size={32} />
              <div style={{ font: '600 12px/1.35 var(--font-ui)', color: 'var(--text-primary)', maxWidth: 240 }}>{disabledHint || t.keyTitle}</div>
              <div style={{ font: '400 11px/1.45 var(--font-ui)', color: 'var(--text-tertiary)', maxWidth: 250 }}>{t.keyCaption}</div>
            </div>
          </React.Fragment>
        ) : null}

        {!hasEntries && !composerDisabled ? (
          <React.Fragment>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 'var(--space-5) 0 var(--space-2)', textAlign: 'center' }}>
              <AIAvatar size={32} />
              <div style={{ font: '400 12px/1.55 var(--font-ui)', color: 'var(--text-secondary)', maxWidth: 240 }}>{t.hello}</div>
            </div>
            {prompts.map((card) => (
              <PromptCard
                key={card.id || card.title}
                icon={card.icon}
                title={card.title}
                caption={card.caption}
                onClick={() => {
                  if (card.onClick) card.onClick(card);
                  else sendTurn(card.prompt || card.title);
                }}
              />
            ))}
          </React.Fragment>
        ) : null}

        {entries.map((entry) => (
          <Entry key={entry.sid || entry.id} entry={entry} lang={lang} onApprove={onApprove} onAnswerQuestion={onAnswerQuestion} />
        ))}

        {streaming && thinking && !turnProgress ? (
          <div style={{ paddingLeft: 28, display: 'flex', alignItems: 'center', gap: 6, font: '400 11px/1.4 var(--font-ui)', color: 'var(--text-tertiary)' }}>
            <Spinner size={12} />
            <span>{t.thinking}</span>
          </div>
        ) : (turnStage || turnProgress) ? (
          <div style={{ paddingLeft: 28, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, font: '400 11px/1.4 var(--font-ui)', color: 'var(--text-tertiary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spinner size={12} />
              <span>{turnProgressText(turnProgress?.stage || turnStage, turnBackend, lang)}</span>
              {turnProgress?.estimatedTokens !== undefined ? <span>· {t.progressTokens(turnProgress.estimatedTokens)}</span> : null}
              {turnProgress?.elapsedMs !== undefined ? <span>· {t.progressElapsed(progressSeconds(turnProgress.elapsedMs))}</span> : null}
            </div>
            {turnProgress?.warning ? (
              <span style={{ color: 'var(--warning, var(--text-secondary))' }}>{t.progressWarning}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div ref={footerRef} style={{ flex: 'none', padding: 'var(--space-2) var(--space-3) var(--space-3)', borderTop: '1px solid var(--border-subtle)' }}>
        <Composer
          value={attachmentDraft.text}
          onChange={(value) => dispatchAttachmentDraft?.({ type: 'text', value })}
          onSend={send}
          onStop={onStop}
          streaming={streaming}
          disabled={composerDisabled}
          placeholder={t.placeholder}
          options={composerOptions}
          notice={disabledHint
            ? <Notice text={disabledHint} actionLabel={noticeActionLabel || t.noticeAction} onAction={onNoticeAction || onNewSession} />
            : sendError
              ? (
                <Notice
                  text={attachmentDraft.dispatchState === 'uncertain' ? t.uncertainTurn : sendError.message}
                  actionLabel={attachmentDraft.dispatchState === 'uncertain' ? t.newSession : null}
                  onAction={attachmentDraft.dispatchState === 'uncertain' ? onNewSession : null}
                />
              )
              : null}
          height={composerSize.height}
          minHeight={COMPOSER_MIN_HEIGHT}
          maxHeight={composerSize.maxHeight}
          onHeightChange={(height) => dispatchComposerSize({ type: 'request', height })}
          onHeightReset={() => dispatchComposerSize({ type: 'reset' })}
          attachmentDraft={attachmentDraft}
          onAddFile={onAddFile}
          onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={onRetryAttachment}
          attachmentLabels={attachmentLabels}
        />
      </div>
    </div>
  );
}
