import React from 'react';
import { QuestionCard } from '../chat/QuestionCard';
import { contentForElicitation } from '../../lib/questionForm';

// Generic MCP elicitation surfaced as the SAME question form the chat uses
// (#219). The coordinator stores the built questions on record.presentation;
// submitting resolves the pending elicitation with schema-typed content.
export function QuestionFormDialog({ record, lang = 'zh', onResolve }) {
  if (!record) return null;
  const presentation = record.presentation;
  if (!presentation || presentation.kind !== 'question-form') return null;
  const questions = Array.isArray(presentation.questions) ? presentation.questions : [];
  const resolve = (result) => onResolve && onResolve({ id: record.id, ...result });
  return (
    <div className="tools-modal" role="presentation">
      <div className="tools-modal__scrim" onClick={() => resolve({ action: 'cancel', content: {} })} />
      <div className="tools-approval" role="dialog" aria-label={presentation.title || ''}>
        <QuestionCard
          lang={lang}
          title={presentation.title}
          questions={questions}
          onSubmit={(values) => resolve({
            action: 'accept',
            content: contentForElicitation(questions, values),
          })}
          onCancel={() => resolve({ action: 'cancel', content: {} })}
        />
      </div>
    </div>
  );
}
