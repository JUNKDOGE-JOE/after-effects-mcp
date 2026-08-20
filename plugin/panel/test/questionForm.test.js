import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  answersForAskUserQuestion,
  answersForCodexUserInput,
  displayAnswers,
  answersForUserInput,
  contentForElicitation,
  questionsFromAskUserQuestion,
  questionsFromCodexUserInput,
  questionsFromElicitationSchema,
  questionsFromUserInput,
  validateQuestionAnswers,
} from '../src/lib/questionForm.js';

// --- normalization: interaction/requestUserInput ---

test('questionsFromUserInput normalizes options, multiSelect, and custom-answer capability', () => {
  const questions = questionsFromUserInput({
    input: {
      questions: [
        {
          question: 'Which color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
        },
        { question: 'Which passes?', multiSelect: true, options: ['Beauty', 'Depth'] },
        { header: 'Notes' },
      ],
    },
  });

  assert.equal(questions.length, 3);
  assert.deepEqual(questions.map((q) => q.id), ['q0', 'q1', 'q2']);
  assert.equal(questions[0].key, 'Which color?');
  assert.deepEqual(questions[0].options, [
    { label: 'Red', description: 'warm' },
    { label: 'Blue', description: '' },
  ]);
  assert.equal(questions[0].allowCustom, true);
  assert.equal(questions[1].multiSelect, true);
  assert.deepEqual(questions[1].options.map((o) => o.label), ['Beauty', 'Depth']);
  // No options -> free text question keyed by its header.
  assert.equal(questions[2].key, 'Notes');
  assert.deepEqual(questions[2].options, []);
});

// --- normalization: codex item/tool/requestUserInput (#228) ---

test('questionsFromCodexUserInput keys by question id and honors isOther', () => {
  const questions = questionsFromCodexUserInput({
    threadId: 't', turnId: 'u', itemId: 'call_1',
    questions: [
      {
        id: 'color_choice', header: '颜色', question: '你喜欢哪种颜色？',
        isOther: true, isSecret: false,
        options: [{ label: '红色', description: '偏暖' }, { label: '蓝色', description: '偏冷' }],
      },
      { id: 'locked', header: 'Locked', question: 'pick one', isOther: false, options: [{ label: 'A', description: '' }] },
    ],
  });
  assert.equal(questions.length, 2);
  assert.equal(questions[0].key, 'color_choice');
  assert.equal(questions[0].prompt, '你喜欢哪种颜色？');
  assert.equal(questions[0].allowCustom, true);
  assert.equal(questions[0].multiSelect, false);
  assert.deepEqual(questions[0].options.map((o) => o.label), ['红色', '蓝色']);
  assert.equal(questions[1].allowCustom, false);
});

test('answersForCodexUserInput wraps each answer as { answers: [string] } keyed by id', () => {
  const questions = questionsFromCodexUserInput({
    questions: [{ id: 'color_choice', question: 'q', options: [{ label: '红色' }] }],
  });
  const answers = answersForCodexUserInput(questions, { q0: '红色' });
  assert.deepEqual(answers, { color_choice: { answers: ['红色'] } });
  // A custom free-text answer still rides through as a one-element array.
  assert.deepEqual(
    answersForCodexUserInput(questions, { q0: 'teal' }),
    { color_choice: { answers: ['teal'] } },
  );
  // An empty answer yields an empty list, not [''].
  assert.deepEqual(answersForCodexUserInput(questions, {}), { color_choice: { answers: [] } });
});

test('displayAnswers renders plain strings for the question-resolved card', () => {
  const single = questionsFromCodexUserInput({
    questions: [{ id: 'color_choice', question: 'q', options: [{ label: '蓝色' }] }],
  });
  // Codex wire shape is { answers: [...] } objects; the card shape is a string.
  assert.deepEqual(displayAnswers(single, { q0: '蓝色' }), { color_choice: '蓝色' });

  const multi = questionsFromAskUserQuestion({
    questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
  });
  assert.deepEqual(displayAnswers(multi, { q0: ['A', 'B'] }), { 'Which?': 'A, B' });

  // Unanswered questions are omitted instead of rendering an empty entry.
  assert.deepEqual(displayAnswers(single, {}), {});
});

// --- normalization: claude AskUserQuestion (#228) ---

test('questionsFromAskUserQuestion keys by question text and carries multiSelect', () => {
  const questions = questionsFromAskUserQuestion({
    questions: [
      {
        question: 'How should I format the output?', header: 'Format', multiSelect: false,
        options: [{ label: 'Summary', description: 'Brief' }, { label: 'Detailed', description: 'Full' }],
      },
      {
        question: 'Which sections?', header: 'Sections', multiSelect: true,
        options: [{ label: 'Intro', description: '' }, { label: 'Conclusion', description: '' }],
      },
    ],
  });
  assert.equal(questions[0].key, 'How should I format the output?');
  assert.equal(questions[0].multiSelect, false);
  assert.equal(questions[0].allowCustom, true);
  assert.equal(questions[1].multiSelect, true);
});

test('answersForAskUserQuestion maps question text to label / label[]', () => {
  const questions = questionsFromAskUserQuestion({
    questions: [
      { question: 'Format?', options: [{ label: 'Summary' }], multiSelect: false },
      { question: 'Sections?', options: [{ label: 'Intro' }, { label: 'Conclusion' }], multiSelect: true },
    ],
  });
  const answers = answersForAskUserQuestion(questions, { q0: 'Summary', q1: ['Intro', 'Conclusion'] });
  assert.deepEqual(answers, {
    'Format?': 'Summary',
    'Sections?': ['Intro', 'Conclusion'],
  });
});

// --- normalization: elicitation / MCP schema ---

test('questionsFromElicitationSchema maps enum, enum-array, and string fields', () => {
  const built = questionsFromElicitationSchema('Pick the setup', {
    type: 'object',
    properties: {
      color: { type: 'string', enum: ['red', 'green'] },
      passes: { type: 'array', items: { enum: ['beauty', 'depth'] } },
      note: { type: 'string', description: 'Anything else?' },
    },
    required: ['color'],
  });

  assert.equal(built.ok, true);
  const [color, passes, note] = built.questions;
  assert.deepEqual(color.options.map((o) => o.label), ['red', 'green']);
  assert.equal(color.required, true);
  assert.equal(color.allowCustom, false);
  assert.equal(passes.multiSelect, true);
  assert.deepEqual(passes.options.map((o) => o.label), ['beauty', 'depth']);
  assert.equal(note.options.length, 0);
  assert.equal(note.prompt, 'Anything else?');
  assert.equal(note.required, false);
});

test('questionsFromElicitationSchema fails clearly on unsupported shapes', () => {
  assert.equal(questionsFromElicitationSchema('m', {}).ok, false);
  assert.equal(questionsFromElicitationSchema('m', {
    properties: { budget: { type: 'number' } },
  }).ok, false);
  assert.equal(questionsFromElicitationSchema('m', {
    properties: { nested: { type: 'object' } },
  }).ok, false);
  assert.equal(questionsFromElicitationSchema('m', {
    properties: { list: { type: 'array', items: { type: 'string' } } },
  }).ok, false);
  const unsupported = questionsFromElicitationSchema('m', {
    properties: { ok: { enum: ['a'] }, bad: { type: 'boolean' } },
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.reason, /unsupported-field:bad/);
});

// --- validation ---

test('validateQuestionAnswers enforces required fields per question', () => {
  const questions = questionsFromUserInput({
    input: {
      questions: [
        { question: 'Pick', options: [{ label: 'A' }] },
        { question: 'Passes', multiSelect: true, options: [{ label: 'B' }] },
        { question: 'Free text' },
      ],
    },
  });
  const empty = validateQuestionAnswers(questions, {});
  assert.equal(empty.ok, false);
  assert.deepEqual(Object.keys(empty.errors), ['q0', 'q1', 'q2']);

  const filled = validateQuestionAnswers(questions, { q0: 'A', q1: ['B'], q2: '  typed  ' });
  assert.equal(filled.ok, true);
});

test('validateQuestionAnswers rejects off-list values only when custom answers are not allowed', () => {
  const strict = questionsFromElicitationSchema('m', {
    properties: { color: { enum: ['red'] } },
    required: ['color'],
  }).questions;
  assert.equal(validateQuestionAnswers(strict, { q0: 'purple' }).ok, false);
  assert.equal(validateQuestionAnswers(strict, { q0: 'red' }).ok, true);

  const custom = questionsFromUserInput({
    input: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
  });
  assert.equal(validateQuestionAnswers(custom, { q0: 'my own words' }).ok, true);
});

// --- protocol replies ---

test('answersForUserInput keys answers by question text with independent values', () => {
  const questions = questionsFromUserInput({
    input: {
      questions: [
        { question: 'First', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Passes', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
      ],
    },
  });
  const answers = answersForUserInput(questions, { q0: 'B', q1: 'A', q2: ['X', 'Y'] });
  assert.deepEqual(answers, { First: 'B', Second: 'A', Passes: 'X, Y' });
});

test('contentForElicitation types values per schema and omits empty optional fields', () => {
  const built = questionsFromElicitationSchema('m', {
    properties: {
      color: { enum: ['red', 'green'] },
      passes: { type: 'array', items: { enum: ['beauty', 'depth'] } },
      note: { type: 'string' },
    },
    required: ['color'],
  });
  const content = contentForElicitation(built.questions, { q0: 'green', q1: ['depth'], q2: '' });
  assert.deepEqual(content, { color: 'green', passes: ['depth'] });
});

// --- wiring: the form reaches the real UI and both backends' answer path ---

test('chat renders question entries through the dedicated QuestionCard', () => {
  const chat = readFileSync(new URL('../src/screens/ChatScreen.jsx', import.meta.url), 'utf8');
  assert.match(chat, /entry\.type === 'question'/);
  assert.match(chat, /<QuestionCard/);
  assert.match(chat, /onAnswerQuestion\(entry\.toolUseId, \{ action: 'submit', values \}\)/);
  assert.match(chat, /onAnswerQuestion\(entry\.toolUseId, \{ action: 'cancel' \}\)/);
});

test('App wires answerQuestion and surfaces generic MCP elicitation as the same form', () => {
  const app = readFileSync(new URL('../src/app/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /onAnswerQuestion=\{\(id, result\) => activeBackend\?\.answerQuestion/);
  assert.match(app, /questionsFromElicitationSchema\(/);
  assert.match(app, /<QuestionFormDialog/);
  // The old always-decline stub must not come back.
  assert.doesNotMatch(app, /presentGenericForm: \(\) => \(\{ action: 'decline'/);
});

test('QuestionCard supports select, multi-select, custom text, validation, and cancel', () => {
  const card = readFileSync(new URL('../src/components/chat/QuestionCard.jsx', import.meta.url), 'utf8');
  assert.match(card, /multiSelect/);
  assert.match(card, /validateQuestionAnswers/);
  assert.match(card, /allowCustom/);
  assert.match(card, /onCancel/);
  assert.match(card, /role=\{question\.multiSelect \? 'group' : 'radiogroup'\}/);
});
