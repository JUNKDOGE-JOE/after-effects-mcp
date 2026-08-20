import React from 'react';
import { Badge } from '../components/core/Badge';
import { Button } from '../components/core/Button';
import { EmptyState } from '../components/shell/EmptyState';
import { Input } from '../components/forms/Input';
import { Textarea } from '../components/forms/Textarea';
import { Segmented } from '../components/core/Segmented';
import { copyText } from '../lib/clipboard';

const TEXT = {
  zh: {
    title: '工具库',
    tools: '工具',
    skills: '技能',
    searchTools: '搜索工具…',
    searchSkills: '筛选技能…',
    empty: '没有匹配项',
    select: '选择一个条目',
    selectCap: '先从左侧选择，再查看详情或运行。',
    args: '参数（JSON）',
    run: '运行',
    render: '渲染并复制',
    result: '结果',
    refresh: '刷新',
    content: '内容',
    invalidArgs: '参数必须是 JSON 对象。',
    signed: '已验证',
    user: '用户工具',
    prompt: '提示技能',
  },
  en: {
    title: 'Tool Library',
    tools: 'Tools',
    skills: 'Skills',
    searchTools: 'Search tools…',
    searchSkills: 'Filter skills…',
    empty: 'No matching items',
    select: 'Select an item',
    selectCap: 'Choose an item on the left to inspect or run it.',
    args: 'Arguments (JSON)',
    run: 'Run',
    render: 'Render & copy',
    result: 'Result',
    refresh: 'Refresh',
    content: 'Content',
    invalidArgs: 'Arguments must be a JSON object.',
    signed: 'Verified',
    user: 'User tool',
    prompt: 'Prompt skill',
  },
};

function objectArgs(text) {
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('object required');
  }
  return value;
}

function defaultArgs(schema) {
  const result = {};
  const properties = schema && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  for (const [name, definition] of Object.entries(properties)) {
    if (definition && definition.default !== undefined) result[name] = definition.default;
  }
  return result;
}

function itemId(mode, item) {
  return mode === 'skills' ? 'skill:' + item.name : item.id;
}

function ItemRow({ mode, item, selected, onSelect }) {
  const id = itemId(mode, item);
  return (
    <button
      type="button"
      className="ds-focusable"
      onClick={() => onSelect(item)}
      style={{
        width: '100%',
        minHeight: 48,
        padding: '7px 9px',
        textAlign: 'left',
        background: selected ? 'var(--bg-selected)' : 'transparent',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-primary)',
        cursor: 'pointer',
      }}
      data-item-id={id}
    >
      <span
        style={{
          display: 'block',
          font: '500 12px/1.35 var(--font-ui)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.name || item.id}
      </span>
      <span
        style={{
          display: 'block',
          marginTop: 2,
          font: '400 10px/1.35 var(--font-ui)',
          color: 'var(--text-tertiary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.description || item.kind || ''}
      </span>
    </button>
  );
}

export function ToolsScreen({ api, lang = 'zh' }) {
  const t = TEXT[lang] || TEXT.zh;
  const [mode, setMode] = React.useState('tools');
  const [query, setQuery] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [selectedId, setSelectedId] = React.useState('');
  const [detail, setDetail] = React.useState(null);
  const [argsText, setArgsText] = React.useState('{}');
  const [result, setResult] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const loadSequence = React.useRef(0);
  const selectSequence = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!api) return;
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    setError('');
    try {
      if (mode === 'skills') {
        const payload = await api.listSkills({ includeTemplates: true });
        const needle = query.trim().toLowerCase();
        const skills = (payload.skills || []).filter((skill) => {
          const text = [skill.name, skill.description].join(' ').toLowerCase();
          return !needle || text.includes(needle);
        });
        if (sequence === loadSequence.current) setItems(skills);
      } else {
        const payload = query.trim()
          ? await api.search({ query, limit: 100 })
          : await api.index({ limit: 100 });
        if (sequence === loadSequence.current) setItems(payload.artifacts || []);
      }
    } catch (cause) {
      if (sequence === loadSequence.current) setError(cause.message || String(cause));
    }
  }, [api, mode, query]);

  React.useEffect(() => {
    const timer = setTimeout(load, 120);
    return () => clearTimeout(timer);
  }, [load]);

  const changeMode = (next) => {
    setMode(next);
    setSelectedId('');
    setDetail(null);
    setResult(null);
    setArgsText('{}');
  };

  const select = async (item) => {
    const id = itemId(mode, item);
    const sequence = selectSequence.current + 1;
    selectSequence.current = sequence;
    setSelectedId(id);
    setResult(null);
    setError('');
    try {
      const value = mode === 'skills'
        ? item
        : (await api.inspect(item.id)).artifact;
      if (sequence !== selectSequence.current) return;
      setDetail({ mode, value });
      const schema = mode === 'skills' ? value.args_schema : value.argsSchema;
      setArgsText(JSON.stringify(defaultArgs(schema), null, 2));
    } catch (cause) {
      if (sequence === selectSequence.current) setError(cause.message || String(cause));
    }
  };

  const invoke = async (action) => {
    if (!detail || busy) return;
    setBusy(true);
    setError('');
    try {
      const args = objectArgs(argsText);
      const value = detail.value;
      let output;
      if (detail.mode === 'skills') {
        output = action === 'render'
          ? await api.renderSkill(value.name, args)
          : await api.executeSkill(value.name, args);
      } else {
        output = await api.executeTool(value.id, args);
      }
      if (action === 'render') await copyText(output.rendered || '');
      setResult(output);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? t.invalidArgs : cause.message || String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selected = detail && detail.value;
  const selectedSchema = selected && (detail.mode === 'skills'
    ? selected.args_schema
    : selected.argsSchema);
  const selectedContent = selected && (detail.mode === 'skills'
    ? selected.template
    : selected.content);
  const canExecuteSkill = detail && detail.mode === 'skills'
    && selected.template_type === 'jsx';

  return (
    <div className="tools-screen">
      <header className="tools-header">
        <div className="tools-header__title">{t.title}</div>
        <div className="tools-header__actions">
          <Button size="sm" variant="ghost" icon="rotate-cw" onClick={load} disabled={busy}>
            {t.refresh}
          </Button>
        </div>
      </header>
      <div className="tools-filters">
        <Segmented
          value={mode}
          onChange={changeMode}
          options={[
            { value: 'tools', label: t.tools },
            { value: 'skills', label: t.skills },
          ]}
        />
        <Input
          value={query}
          onChange={setQuery}
          placeholder={mode === 'skills' ? t.searchSkills : t.searchTools}
        />
      </div>
      {error ? <div className="tools-error" role="alert">{error}</div> : null}
      <div className="tools-split">
        <section className="tools-list" aria-label={mode === 'skills' ? t.skills : t.tools}>
          {items.length ? items.map((item) => (
            <ItemRow
              key={itemId(mode, item)}
              mode={mode}
              item={item}
              selected={itemId(mode, item) === selectedId}
              onSelect={select}
            />
          )) : <EmptyState icon="box" title={t.empty} compact />}
        </section>
        <section className="tools-detail">
          {!selected ? (
            <EmptyState icon="box" title={t.select} caption={t.selectCap} />
          ) : (
            <React.Fragment>
              <div className="tools-detail__heading">
                <div>
                  <h2>{selected.name}</h2>
                  <p>{selected.description}</p>
                </div>
                <Badge status={selected.verified ? 'ok' : 'neutral'}>
                  {selected.verified ? t.signed : detail.mode === 'skills' ? t.prompt : t.user}
                </Badge>
              </div>
              <section className="tools-detail__section">
                <h3>{t.content}</h3>
                <pre className="tools-content">{selectedContent || '—'}</pre>
              </section>
              <section className="tools-detail__section tools-runner">
                <h3>{t.args}</h3>
                <Textarea
                  mono
                  value={argsText}
                  onChange={setArgsText}
                  rows={Math.max(4, Object.keys(selectedSchema?.properties || {}).length + 2)}
                />
                <div className="tools-runner__actions">
                  {detail.mode === 'skills' ? (
                    <Button variant="secondary" onClick={() => invoke('render')} disabled={busy}>
                      {t.render}
                    </Button>
                  ) : null}
                  {detail.mode === 'tools' || canExecuteSkill ? (
                    <Button variant="primary" onClick={() => invoke('execute')} disabled={busy}>
                      {t.run}
                    </Button>
                  ) : null}
                </div>
                {result ? (
                  <React.Fragment>
                    <h3>{t.result}</h3>
                    <pre className="tools-content">{JSON.stringify(result, null, 2)}</pre>
                  </React.Fragment>
                ) : null}
              </section>
            </React.Fragment>
          )}
        </section>
      </div>
    </div>
  );
}
