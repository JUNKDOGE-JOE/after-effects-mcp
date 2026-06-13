import React from 'react';
import { Icon } from '../components/core/Icon';
import { Button } from '../components/core/Button';
import { IconButton } from '../components/core/IconButton';
import { Segmented } from '../components/core/Segmented';
import { Spinner } from '../components/core/Spinner';
import { AIAvatar } from '../components/chat/AIAvatar';
import { EXTERNAL_CLIENTS, mcpConfigFor } from '../cep/externalClients';
import { initialStepStates, LOCAL_STEPS, SUBSCRIPTION_STEPS } from '../lib/wizardSteps';

const W = {
  zh: {
    stepOf: (n) => `第 ${n} 步 / 共 4 步`,
    back: '上一步', next: '下一步', start: '开始使用', skip: '跳过向导',
    t1: '欢迎使用 ae-mcp',
    b1: '让 AI 助手安全地操作你的 After Effects 工程 — 每一步可见、可批准、可撤销。',
    langLabel: '界面语言 · Language',
    t2: '安装本地服务',
    b2: '面板可以替你完成安装——逐项检测，缺什么装什么：',
    copy: '复制', copied: '已复制', install: '一键安装', recheck: '复检',
    openLogin: '打开登录窗口', loginHint: '登录完成后回来点复检', copyLog: '复制日志',
    uacNote: 'Node 安装会弹一次系统授权（UAC）',
    t3: '连接 AI 客户端',
    b3: '选择你的客户端，把配置粘贴进它的 MCP 设置：',
    builtin: '面板内置对话', builtinNote: '无需配置，开箱即用',
    docClient: '查看接入文档',
    docOnly: '按文档接入',
    t4w: '等待握手…',
    b4w: '在客户端里发起一次对话，面板会自动完成握手。',
    t4s: '连接成功',
    b4s: (c) => `${c} 已连接，可以开始让 AI 操作你的工程了。`,
    t4t: '尚未收到连接',
    b4t: '超过 60 秒没有客户端接入。逐项体检可以找出问题：',
    diagnose: '运行诊断',
  },
  en: {
    stepOf: (n) => `Step ${n} of 4`,
    back: 'Back', next: 'Next', start: 'Start using', skip: 'Skip setup',
    t1: 'Welcome to ae-mcp',
    b1: 'Let AI assistants operate your After Effects project safely — every step visible, approvable, undoable.',
    langLabel: '界面语言 · Language',
    t2: 'Install the local service',
    b2: "The panel installs these for you — detect each item, install what's missing:",
    copy: 'Copy', copied: 'Copied', install: 'Install', recheck: 'Re-check',
    openLogin: 'Open login window', loginHint: 'After login, return here and re-check', copyLog: 'Copy log',
    uacNote: 'Node install triggers one UAC prompt',
    t3: 'Connect an AI client',
    b3: 'Pick your client and paste the config into its MCP settings:',
    builtin: 'Built-in chat', builtinNote: 'No config needed — works out of the box',
    docClient: 'Open integration docs',
    docOnly: 'Use docs',
    t4w: 'Waiting for handshake…',
    b4w: 'Start a conversation in your client; the panel completes the handshake automatically.',
    t4s: 'Connected',
    b4s: (c) => `${c} is connected. You can start directing AI in your project.`,
    t4t: 'No connection yet',
    b4t: 'No client joined within 60 seconds. Run diagnostics to find the issue:',
    diagnose: 'Run diagnostics',
  },
};

const EMPTY_STEPS = initialStepStates();

const STEP_LABELS = {
  uv: 'uv',
  aeMcp: 'ae-mcp',
  node: 'Node.js LTS',
  claude: 'Claude Code',
  login: 'Claude login',
};

function copyText(text) {
  if (globalThis.navigator && globalThis.navigator.clipboard && globalThis.navigator.clipboard.writeText) {
    globalThis.navigator.clipboard.writeText(text || '').catch(() => {});
  }
}

function CodeBlock({ code, copyLabel, onCopy, maxHeight }) {
  return (
    <div style={{ position: 'relative', background: 'var(--gray-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
      <pre style={{ margin: 0, padding: '10px 36px 10px 12px', font: '400 11px/1.7 var(--font-mono)', color: 'var(--text-primary)', overflow: 'auto', maxHeight: maxHeight || 180, whiteSpace: 'pre' }}>{code}</pre>
      <IconButton icon="copy" title={copyLabel} variant="secondary" onClick={onCopy} style={{ position: 'absolute', top: 6, right: 6, background: 'var(--bg-panel)' }} />
    </div>
  );
}

function ClientRow({ name, note, selected, onSelect }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      className="ds-focusable"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 32, padding: '0 10px', textAlign: 'left',
        background: selected ? 'var(--bg-selected)' : hover ? 'var(--bg-hover)' : 'transparent',
        border: `1px solid ${selected ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-md)', cursor: 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{name}</span>
        {note ? <span style={{ display: 'block', font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{note}</span> : null}
      </span>
      {selected ? <Icon name="check" size={13} strokeWidth={2.5} color="var(--text-primary)" /> : null}
    </button>
  );
}

function InstallStepRow({ label, state, commandPreview, t, onDetect, onInstall, login = false, hint }) {
  const status = state && state.status ? state.status : 'idle';
  const isBusy = status === 'checking' || status === 'running';
  const isProblem = status === 'missing' || status === 'fail';
  const icon = status === 'ok' ? 'check' : isProblem ? 'triangle-alert' : status === 'idle' ? 'circle' : null;
  const tail = String((state && state.logTail) || '').split(/\r?\n/).slice(-6).join('\n');
  return (
    <div style={{ display: 'flex', gap: 8, padding: '9px 10px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-panel)' }}>
      <span style={{ width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: status === 'ok' ? 'var(--ok)' : isProblem ? 'var(--warn)' : 'var(--text-tertiary)' }}>
        {isBusy ? <Spinner size={14} /> : <Icon name={icon} size={15} strokeWidth={2} />}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 18 }}>
          <span style={{ font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{label}</span>
          {status === 'ok' && state.version ? <span style={{ font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.version}</span> : null}
          <span style={{ flex: 1 }}></span>
          <IconButton icon="rotate-cw" title={t.recheck} variant="secondary" size="sm" disabled={isBusy} onClick={onDetect} />
        </div>
        {hint ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>{hint}</div> : null}
        {isProblem ? (
          <React.Fragment>
            <code style={{ display: 'block', padding: '6px 8px', background: 'var(--gray-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', font: '400 10px/1.55 var(--font-mono)', color: 'var(--text-primary)', overflow: 'auto', whiteSpace: 'pre' }}>{commandPreview}</code>
            {login ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>{t.loginHint}</div> : null}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button variant="secondary" size="sm" onClick={onInstall}>{login ? t.openLogin : t.install}</Button>
              {status === 'fail' ? <Button variant="ghost" size="sm" onClick={() => copyText(state.logTail)}>{t.copyLog}</Button> : null}
            </div>
          </React.Fragment>
        ) : null}
        {status === 'running' ? <pre style={{ margin: 0, maxHeight: 96, overflow: 'auto', padding: 8, background: 'var(--gray-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', font: '400 10px/1.45 var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{tail}</pre> : null}
      </div>
    </div>
  );
}

/* Full-screen 4-step first-run wizard. Render inside PanelFrame chrome={false}. */
export function WizardScreen({
  step = 1,
  lang = 'zh',
  onLangChange,
  client = 'claude-desktop',
  onClient,
  handshake = 'waiting',
  clientName = 'Claude Desktop',
  mcpConfig = '',
  onNext,
  onBack,
  onCopy,
  onDiagnose,
  onDone,
  onSkip,
  stepStates = EMPTY_STEPS,
  onDetect,
  onInstall,
  onOpenLogin,
  commandPreviews = {},
}) {
  const t = W[lang] || W.zh;
  const clientOptions = [{ id: 'builtin', name: 'builtin' }, ...EXTERNAL_CLIENTS];
  const selectedExternalClient = EXTERNAL_CLIENTS.find((item) => item.id === client);
  const selectedMcpConfig = selectedExternalClient && selectedExternalClient.kind === 'mcp-stdio'
    ? (mcpConfig || JSON.stringify(mcpConfigFor(selectedExternalClient), null, 2))
    : '';
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 'var(--space-6) var(--space-5) var(--space-5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', gap: 5 }}>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} style={{ width: n === step ? 14 : 5, height: 5, borderRadius: 3, background: n === step ? 'var(--gray-11)' : n < step ? 'var(--gray-9)' : 'var(--gray-6)', transition: 'width var(--dur-base) var(--ease-out)' }}></span>
          ))}
        </div>
        <span style={{ font: '400 10px/1 var(--font-mono)', color: 'var(--text-tertiary)' }}>{t.stepOf(step)}</span>
        <span style={{ flex: 1 }}></span>
        {onSkip && step < 4 ? (
          <Button variant="ghost" size="sm" onClick={onSkip} style={{ color: 'var(--text-tertiary)' }}>{t.skip}</Button>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', paddingTop: 'var(--space-6)' }}>
        {step === 1 ? (
          <React.Fragment>
            <AIAvatar size={44} />
            <div style={{ font: '600 20px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{t.t1}</div>
            <div style={{ font: '400 12px/1.55 var(--font-ui)', color: 'var(--text-secondary)' }}>{t.b1}</div>
            <div style={{ marginTop: 'var(--space-2)' }}>
              <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)', marginBottom: 6 }}>{t.langLabel}</div>
              <Segmented full value={lang} onChange={onLangChange} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} />
            </div>
          </React.Fragment>
        ) : null}

        {step === 2 ? (
          <React.Fragment>
            <div style={{ font: '600 20px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{t.t2}</div>
            <div style={{ font: '400 12px/1.55 var(--font-ui)', color: 'var(--text-secondary)' }}>{t.b2}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {LOCAL_STEPS.map((id) => (
                <InstallStepRow
                  key={id}
                  label={STEP_LABELS[id]}
                  state={stepStates[id] || EMPTY_STEPS[id]}
                  commandPreview={commandPreviews[id] || ''}
                  t={t}
                  onDetect={() => onDetect && onDetect(id)}
                  onInstall={() => onInstall && onInstall(id)}
                />
              ))}
            </div>
          </React.Fragment>
        ) : null}

        {step === 3 ? (
          <React.Fragment>
            <div style={{ font: '600 20px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{t.t3}</div>
            <div style={{ font: '400 12px/1.55 var(--font-ui)', color: 'var(--text-secondary)' }}>{t.b3}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {clientOptions.map((c) => (
                <ClientRow
                  key={c.id}
                  name={c.id === 'builtin' ? t.builtin : c.name}
                  note={c.id === 'builtin' ? t.builtinNote : c.kind === 'mcp-doc' ? t.docOnly : null}
                  selected={client === c.id}
                  onSelect={() => onClient && onClient(c.id)}
                />
              ))}
            </div>
            {selectedExternalClient && selectedExternalClient.kind === 'mcp-stdio' ? <CodeBlock code={selectedMcpConfig} copyLabel={t.copy} onCopy={() => (onCopy ? onCopy(selectedMcpConfig) : copyText(selectedMcpConfig))} maxHeight={150} /> : null}
            {selectedExternalClient && selectedExternalClient.kind === 'mcp-doc' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-panel)' }}>
                <a href={selectedExternalClient.docsUrl} target="_blank" rel="noreferrer" style={{ font: '500 12px/1.35 var(--font-ui)', color: 'var(--accent)' }}>{t.docClient}</a>
                {selectedExternalClient.networkNote ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>{selectedExternalClient.networkNote}</div> : null}
              </div>
            ) : null}
            {client === 'builtin' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {SUBSCRIPTION_STEPS.map((id) => (
                  <InstallStepRow
                    key={id}
                    label={STEP_LABELS[id]}
                    state={stepStates[id] || EMPTY_STEPS[id]}
                    commandPreview={commandPreviews[id] || (id === 'login' ? 'claude' : '')}
                    t={t}
                    login={id === 'login'}
                    hint={id === 'node' ? t.uacNote : null}
                    onDetect={() => onDetect && onDetect(id)}
                    onInstall={() => (id === 'login' ? onOpenLogin && onOpenLogin() : onInstall && onInstall(id))}
                  />
                ))}
              </div>
            ) : null}
          </React.Fragment>
        ) : null}

        {step === 4 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)', textAlign: 'center' }}>
            {handshake === 'waiting' ? (
              <React.Fragment>
                <Spinner size={28} />
                <div style={{ font: '600 15px/1.35 var(--font-ui)', color: 'var(--text-primary)', marginTop: 8 }}>{t.t4w}</div>
                <div style={{ font: '400 11px/1.55 var(--font-ui)', color: 'var(--text-secondary)', maxWidth: 230 }}>{t.b4w}</div>
              </React.Fragment>
            ) : null}
            {handshake === 'success' ? (
              <React.Fragment>
                <span style={{ width: 48, height: 48, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--ok-bg)', border: '1px solid var(--ok-border)', borderRadius: '50%' }}>
                  <Icon name="check" size={22} strokeWidth={2.5} color="var(--ok)" />
                </span>
                <div style={{ font: '600 15px/1.35 var(--font-ui)', color: 'var(--text-primary)', marginTop: 8 }}>{t.t4s}</div>
                <div style={{ font: '400 11px/1.55 var(--font-ui)', color: 'var(--text-secondary)', maxWidth: 230 }}>{t.b4s(clientName)}</div>
              </React.Fragment>
            ) : null}
            {handshake === 'timeout' ? (
              <React.Fragment>
                <span style={{ width: 48, height: 48, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: '50%' }}>
                  <Icon name="triangle-alert" size={20} strokeWidth={2} color="var(--warn)" />
                </span>
                <div style={{ font: '600 15px/1.35 var(--font-ui)', color: 'var(--text-primary)', marginTop: 8 }}>{t.t4t}</div>
                <div style={{ font: '400 11px/1.55 var(--font-ui)', color: 'var(--text-secondary)', maxWidth: 240 }}>{t.b4t}</div>
                <Button variant="secondary" icon="stethoscope" onClick={onDiagnose} style={{ marginTop: 4 }}>{t.diagnose}</Button>
              </React.Fragment>
            ) : null}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-15)', paddingTop: 'var(--space-3)' }}>
        {step > 1 ? <Button variant="ghost" size="lg" onClick={onBack}>{t.back}</Button> : null}
        <span style={{ flex: 1 }}></span>
        {step < 4 ? (
          <Button variant="primary" size="lg" onClick={onNext}>{t.next}</Button>
        ) : handshake === 'success' ? (
          <Button variant="primary" size="lg" onClick={onDone}>{t.start}</Button>
        ) : null}
      </div>
    </div>
  );
}
