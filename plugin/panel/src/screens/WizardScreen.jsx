import React from 'react';
import { Icon } from '../components/core/Icon';
import { Button } from '../components/core/Button';
import { IconButton } from '../components/core/IconButton';
import { Segmented } from '../components/core/Segmented';
import { Spinner } from '../components/core/Spinner';
import { externalClientSetupPrompt } from '../lib/externalClientPrompt';
import {
  CLI_STEPS,
  HOST_STEPS,
  OPTIONAL_CLIENT_STEPS,
  initialStepStates,
} from '../lib/wizardSteps';

const W = {
  zh: {
    stepOf: (n) => `第 ${n} 步 / 共 3 步`,
    back: '上一步',
    next: '下一步',
    start: '开始使用',
    skip: '跳过向导',
    t1: '检查面板宿主',
    b1: '面板内的 CEP 宿主直接提供 MCP 与 After Effects 执行能力。',
    langLabel: '界面语言 · Language',
    t2: '检查 AI CLI',
    b2: '内置对话可使用 Claude、Codex 或 opencode；按需安装其中任意一个。',
    t3: '连接外部客户端',
    b3: '复制下面这段话，粘给你正在使用的 AI 客户端，让它自己完成接入。',
    copy: '复制',
    recheck: '复检',
    install: '安装',
    copyLog: '复制日志',
    optionalNode: '系统 Node（stdio 客户端可选）',
    optionalNodeHint: '只有 Claude Desktop 这类只支持 stdio 的客户端才需要。',
    panelOpenNote: '面板开着才能连接；关闭或重载面板后客户端需要重连。',
    directUrl: '或直接使用这个地址',
  },
  en: {
    stepOf: (n) => `Step ${n} of 3`,
    back: 'Back',
    next: 'Next',
    start: 'Start using',
    skip: 'Skip setup',
    t1: 'Check the panel host',
    b1: 'The CEP host serves MCP and After Effects execution directly.',
    langLabel: '界面语言 · Language',
    t2: 'Check AI CLIs',
    b2: 'Built-in chat can use Claude, Codex, or opencode. Install any CLI you need.',
    t3: 'Connect an external client',
    b3: 'Copy the prompt below and paste it into the AI client you use so it can set up the connection.',
    copy: 'Copy',
    recheck: 'Re-check',
    install: 'Install',
    copyLog: 'Copy log',
    optionalNode: 'System Node (optional for stdio clients)',
    optionalNodeHint: 'Only stdio-only clients such as Claude Desktop need this step.',
    panelOpenNote: 'The panel must stay open. Clients reconnect after it closes or reloads.',
    directUrl: 'Or use this address directly',
  },
};

const EMPTY_STEPS = initialStepStates();

const STEP_LABELS = {
  host: 'CEP host /health',
  node: 'Node.js 18+',
  claude: 'Claude Code CLI 2.x+',
  codex: 'Codex CLI',
  opencode: 'opencode CLI',
};

function copyText(text) {
  const clipboard = globalThis.navigator && globalThis.navigator.clipboard;
  if (clipboard && clipboard.writeText) clipboard.writeText(text || '').catch(() => {});
}

function CodeBlock({ code, copyLabel, onCopy, wrap = false }) {
  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--gray-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: '10px 36px 10px 12px',
          font: '400 11px/1.7 var(--font-mono)',
          color: 'var(--text-primary)',
          overflow: 'auto',
          maxHeight: wrap ? 260 : 150,
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          overflowWrap: wrap ? 'anywhere' : 'normal',
        }}
      >
        {code}
      </pre>
      <IconButton
        icon="copy"
        title={copyLabel}
        variant="secondary"
        onClick={onCopy}
        style={{ position: 'absolute', top: 6, right: 6, background: 'var(--bg-panel)' }}
      />
    </div>
  );
}

function CheckRow({ label, state, t, onDetect, onInstall, commandPreview, hint }) {
  const status = state && state.status ? state.status : 'idle';
  const busy = status === 'checking' || status === 'running';
  const problem = status === 'missing' || status === 'fail';
  const icon = status === 'ok' ? 'check' : problem ? 'triangle-alert' : 'circle';
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '9px 10px',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-panel)',
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: status === 'ok' ? 'var(--ok)' : problem ? 'var(--warn)' : 'var(--text-tertiary)',
        }}
      >
        {busy ? <Spinner size={14} /> : <Icon name={icon} size={15} strokeWidth={2} />}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>
            {label}
          </span>
          {status === 'ok' && state.version ? (
            <span style={{ font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)' }}>
              {state.version}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <IconButton
            icon="rotate-cw"
            title={t.recheck}
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onDetect}
          />
        </div>
        {hint ? (
          <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>
            {hint}
          </div>
        ) : null}
        {problem && state.logTail ? (
          <div style={{ font: '400 10px/1.45 var(--font-mono)', color: 'var(--text-tertiary)' }}>
            {state.logTail}
          </div>
        ) : null}
        {problem && onInstall && commandPreview ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <code
              style={{
                padding: '6px 8px',
                background: 'var(--gray-0)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                font: '400 10px/1.55 var(--font-mono)',
              }}
            >
              {commandPreview}
            </code>
            <Button variant="secondary" size="sm" onClick={onInstall}>{t.install}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WizardScreen({
  step = 1,
  lang = 'zh',
  onLangChange,
  extensionRoot = '<extension root>',
  mcpReady = true,
  port = 11488,
  onNext,
  onBack,
  onCopy,
  onDone,
  onSkip,
  stepStates = EMPTY_STEPS,
  onDetect,
  onInstall,
  commandPreviews = {},
}) {
  const t = W[lang] || W.zh;
  const promptText = mcpReady ? externalClientSetupPrompt({
    lang,
    port,
    extensionRoot,
  }) : '';
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: 'var(--space-6) var(--space-5) var(--space-5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', gap: 5 }}>
          {[1, 2, 3].map((number) => (
            <span
              key={number}
              style={{
                width: number === step ? 14 : 5,
                height: 5,
                borderRadius: 3,
                background: number === step
                  ? 'var(--gray-11)'
                  : number < step ? 'var(--gray-9)' : 'var(--gray-6)',
              }}
            />
          ))}
        </div>
        <span style={{ font: '400 10px/1 var(--font-mono)', color: 'var(--text-tertiary)' }}>
          {t.stepOf(step)}
        </span>
        <span style={{ flex: 1 }} />
        {onSkip && step < 3 ? (
          <Button variant="ghost" size="sm" onClick={onSkip}>{t.skip}</Button>
        ) : null}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          paddingTop: 'var(--space-6)',
        }}
      >
        {step === 1 ? (
          <React.Fragment>
            <div style={{ font: '600 20px/1.35 var(--font-ui)' }}>{t.t1}</div>
            <div style={{ font: '400 12px/1.55 var(--font-ui)', color: 'var(--text-secondary)' }}>
              {t.b1}
            </div>
            {HOST_STEPS.map((id) => (
              <CheckRow
                key={id}
                label={STEP_LABELS[id]}
                state={stepStates[id] || EMPTY_STEPS[id]}
                t={t}
                onDetect={() => onDetect && onDetect(id)}
              />
            ))}
            <div>
              <div
                style={{
                  font: '500 11px/1.35 var(--font-ui)',
                  color: 'var(--text-secondary)',
                  marginBottom: 6,
                }}
              >
                {t.langLabel}
              </div>
              <Segmented
                full
                value={lang}
                onChange={onLangChange}
                options={[
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </div>
          </React.Fragment>
        ) : null}

        {step === 2 ? (
          <React.Fragment>
            <div style={{ font: '600 20px/1.35 var(--font-ui)' }}>{t.t2}</div>
            <div style={{ font: '400 12px/1.55 var(--font-ui)', color: 'var(--text-secondary)' }}>
              {t.b2}
            </div>
            {CLI_STEPS.map((id) => (
              <CheckRow
                key={id}
                label={STEP_LABELS[id]}
                state={stepStates[id] || EMPTY_STEPS[id]}
                t={t}
                onDetect={() => onDetect && onDetect(id)}
              />
            ))}
          </React.Fragment>
        ) : null}

        {step === 3 ? (
          <React.Fragment>
            <div style={{ font: '600 20px/1.35 var(--font-ui)' }}>{t.t3}</div>
            <div style={{ font: '400 12px/1.55 var(--font-ui)', color: 'var(--text-secondary)' }}>
              {t.b3}
            </div>
            {promptText ? (
              <React.Fragment>
                <CodeBlock
                  wrap
                  code={promptText}
                  copyLabel={t.copy}
                  onCopy={() => (onCopy ? onCopy(promptText) : copyText(promptText))}
                />
                <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>
                  {t.directUrl}
                </div>
                <CodeBlock
                  code={mcpUrl}
                  copyLabel={t.copy}
                  onCopy={() => (onCopy ? onCopy(mcpUrl) : copyText(mcpUrl))}
                />
              </React.Fragment>
            ) : null}
            <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>
              {t.panelOpenNote}
            </div>
            {OPTIONAL_CLIENT_STEPS.map((id) => (
              <CheckRow
                key={id}
                label={t.optionalNode}
                state={stepStates[id] || EMPTY_STEPS[id]}
                t={t}
                hint={t.optionalNodeHint}
                commandPreview={commandPreviews[id] || ''}
                onDetect={() => onDetect && onDetect(id)}
                onInstall={() => onInstall && onInstall(id)}
              />
            ))}
          </React.Fragment>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-15)', paddingTop: 'var(--space-3)' }}>
        {step > 1 ? <Button variant="ghost" size="lg" onClick={onBack}>{t.back}</Button> : null}
        <span style={{ flex: 1 }} />
        {step < 3 ? (
          <Button variant="primary" size="lg" onClick={onNext}>{t.next}</Button>
        ) : (
          <Button variant="primary" size="lg" onClick={onDone}>{t.start}</Button>
        )}
      </div>
    </div>
  );
}
