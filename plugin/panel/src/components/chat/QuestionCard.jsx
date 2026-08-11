import React from 'react';
import { Icon } from '../core/Icon';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';
import { validateQuestionAnswers } from '../../lib/questionForm';

// Dedicated agent-to-user question form (#219). Renders single-select,
// multi-select, and free-text questions (with an Other/custom path) and
// submits protocol-agnostic values; it deliberately shares nothing with the
// tool ApprovalCard so a question can never degrade into Allow/Deny.

const L = {
  zh: {
    needs: '需要回答',
    submit: '提交',
    cancel: '取消',
    other: '其他（自定义）',
    otherPlaceholder: '输入自定义回答…',
    textPlaceholder: '输入回答…',
    required: '此项必填',
    invalidOption: '请选择列表中的选项',
    multiHint: '可多选',
    answered: '已回答',
    cancelled: '已取消',
  },
  en: {
    needs: 'Answer required',
    submit: 'Submit',
    cancel: 'Cancel',
    other: 'Other (custom)',
    otherPlaceholder: 'Type a custom answer…',
    textPlaceholder: 'Type an answer…',
    required: 'This question is required',
    invalidOption: 'Pick an option from the list',
    multiHint: 'Multiple answers allowed',
    answered: 'Answered',
    cancelled: 'Cancelled',
  },
};

const OTHER_KEY = '__ae_mcp_other__';

function OptionRow({ selected, multiSelect, label, description, onToggle }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      className="ds-focusable"
      role={multiSelect ? 'checkbox' : 'radio'}
      aria-checked={selected}
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-15)',
        width: '100%',
        textAlign: 'left',
        padding: '5px 8px',
        background: selected ? 'var(--bg-well)' : hover ? 'var(--bg-well)' : 'transparent',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        color: 'var(--text-primary)',
        font: `var(--weight-regular) var(--text-body)/var(--leading-tight) var(--font-ui)`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          flex: 'none',
          marginTop: 2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
          borderRadius: multiSelect ? 3 : '50%',
          background: selected ? 'var(--accent)' : 'transparent',
          color: 'var(--text-on-solid)',
        }}
      >
        {selected ? <Icon name="check" size={9} strokeWidth={3} /> : null}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{label}</span>
        {description ? (
          <span
            style={{
              display: 'block',
              marginTop: 1,
              color: 'var(--text-tertiary)',
              font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
            }}
          >
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function textInputStyle(hasError) {
  return {
    width: '100%',
    padding: '4px 8px',
    background: 'var(--bg-well)',
    border: `1px solid ${hasError ? 'var(--error-border)' : 'var(--border-default)'}`,
    borderRadius: 'var(--radius-md)',
    outline: 'none',
    resize: 'vertical',
    color: 'var(--text-primary)',
    font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`,
  };
}

function QuestionField({ question, t, selection, customText, error, onSelect, onCustomText }) {
  const selected = Array.isArray(selection) ? selection : (selection ? [selection] : []);
  const customActive = selected.includes(OTHER_KEY);
  const freeText = !question.options.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ font: `var(--weight-semibold) var(--text-body)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
        {question.prompt || question.header || question.key}
        {question.multiSelect ? (
          <span style={{ marginLeft: 6, color: 'var(--text-tertiary)', font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)` }}>
            {t.multiHint}
          </span>
        ) : null}
      </div>
      {freeText ? (
        <textarea
          rows={2}
          className="ds-focusable"
          value={customText}
          placeholder={t.textPlaceholder}
          onChange={(event) => onCustomText(event.target.value)}
          style={textInputStyle(Boolean(error))}
        ></textarea>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} role={question.multiSelect ? 'group' : 'radiogroup'}>
          {question.options.map((option) => (
            <OptionRow
              key={option.label}
              multiSelect={question.multiSelect}
              selected={selected.includes(option.label)}
              label={option.label}
              description={option.description}
              onToggle={() => onSelect(option.label)}
            />
          ))}
          {question.allowCustom ? (
            <OptionRow
              multiSelect={question.multiSelect}
              selected={customActive}
              label={t.other}
              description=""
              onToggle={() => onSelect(OTHER_KEY)}
            />
          ) : null}
          {question.allowCustom && customActive ? (
            <textarea
              rows={1}
              className="ds-focusable"
              value={customText}
              placeholder={t.otherPlaceholder}
              onChange={(event) => onCustomText(event.target.value)}
              style={textInputStyle(Boolean(error))}
            ></textarea>
          ) : null}
        </div>
      )}
      {error ? (
        <div style={{ color: 'var(--error)', font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)` }}>
          {error === 'invalid-option' ? t.invalidOption : t.required}
        </div>
      ) : null}
    </div>
  );
}

// Map UI state (selections + custom text) to the submitted protocol values.
export function collectQuestionValues(questions, selections, customTexts) {
  const values = {};
  for (const question of questions) {
    const selection = selections[question.id];
    const selected = Array.isArray(selection) ? selection : (selection ? [selection] : []);
    const custom = (customTexts[question.id] || '').trim();
    if (!question.options.length) {
      values[question.id] = question.multiSelect ? (custom ? [custom] : []) : custom;
      continue;
    }
    const labels = selected.filter((item) => item !== OTHER_KEY);
    const withCustom = selected.includes(OTHER_KEY) && custom ? labels.concat(custom) : labels;
    values[question.id] = question.multiSelect ? withCustom : (withCustom[0] || '');
  }
  return values;
}

export function QuestionCard({
  title,
  questions = [],
  lang = 'zh',
  state = 'pending',
  answers,
  onSubmit,
  onCancel,
  style,
}) {
  const t = L[lang] || L.zh;
  const [selections, setSelections] = React.useState({});
  const [customTexts, setCustomTexts] = React.useState({});
  const [errors, setErrors] = React.useState({});

  const select = (question, label) => {
    setSelections((current) => {
      const previous = current[question.id];
      if (!question.multiSelect) {
        return { ...current, [question.id]: previous === label ? '' : label };
      }
      const list = Array.isArray(previous) ? previous : (previous ? [previous] : []);
      const next = list.includes(label) ? list.filter((item) => item !== label) : list.concat(label);
      return { ...current, [question.id]: next };
    });
    setErrors((current) => ({ ...current, [question.id]: undefined }));
  };

  const setCustom = (question, text) => {
    setCustomTexts((current) => ({ ...current, [question.id]: text }));
    setErrors((current) => ({ ...current, [question.id]: undefined }));
  };

  const submit = () => {
    const values = collectQuestionValues(questions, selections, customTexts);
    const checked = validateQuestionAnswers(questions, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    if (onSubmit) onSubmit(values);
  };

  return (
    <div
      style={{
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-strong)',
        borderLeft: '2px solid var(--accent)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div style={{ padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-15)' }}>
          <Badge status="warn" icon="message-square">{t.needs}</Badge>
        </div>
        {title ? (
          <div style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            {title}
          </div>
        ) : null}
        {state === 'pending' ? questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            t={t}
            selection={selections[question.id]}
            customText={customTexts[question.id] || ''}
            error={errors[question.id]}
            onSelect={(label) => select(question, label)}
            onCustomText={(text) => setCustom(question, text)}
          />
        )) : null}
      </div>
      {state === 'pending' ? (
        <div style={{ padding: '0 var(--space-2) var(--space-2)', display: 'flex', gap: 'var(--space-15)' }}>
          <Button variant="primary" full onClick={submit}>{t.submit}</Button>
          <Button variant="secondary" full onClick={onCancel}>{t.cancel}</Button>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-15)',
            padding: 'var(--space-15) var(--space-2)',
            borderTop: '1px solid var(--border-subtle)',
            font: `var(--weight-medium) var(--text-caption)/var(--leading-normal) var(--font-ui)`,
            color: state === 'answered' ? 'var(--ok)' : 'var(--text-tertiary)',
          }}
        >
          <Icon name={state === 'answered' ? 'check' : 'x'} size={12} strokeWidth={2.5} style={{ marginTop: 1 }} />
          <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
            {state === 'answered' ? t.answered : t.cancelled}
            {state === 'answered' && answers && Object.keys(answers).length ? (
              ': ' + Object.values(answers).join(' · ')
            ) : ''}
          </span>
        </div>
      )}
    </div>
  );
}
