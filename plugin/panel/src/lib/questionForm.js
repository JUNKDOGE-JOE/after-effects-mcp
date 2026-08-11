// Normalized question-form model shared by every agent-to-user question route
// (#219): ZCode interaction/requestUserInput, ZCode elicitation/create forms,
// and generic MCP elicitation. The UI renders ONLY this model; each backend
// maps the submitted values back to its own protocol reply.
//
// Question: {
//   id:        unique UI key ('q0', 'q1', ...)
//   key:       protocol answer key (question text / schema field name)
//   prompt:    question text shown to the user
//   header:    optional short label
//   options:   [{ label, description }] — empty for free-text questions
//   multiSelect: boolean
//   allowCustom: whether an Other/custom text answer is accepted
//   required:  whether an answer must be supplied
// }
// Submitted values: { [id]: string | string[] } — string[] iff multiSelect.

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizedOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (typeof option === 'string') return { label: option, description: '' };
      if (!option || typeof option !== 'object') return null;
      const label = asText(option.label) || asText(option.value);
      if (!label) return null;
      return { label, description: asText(option.description) };
    })
    .filter(Boolean);
}

// ZCode interaction/requestUserInput params:
//   { input: { questions: [{ question, header, options, multiSelect }] } }
// The reply keys answers by the question text, so `key` mirrors the exact
// fallback chain the protocol reply uses. Answers accept arbitrary strings,
// which is what makes the Other/custom path possible.
export function questionsFromUserInput(params) {
  const input = (params && (params.input || params)) || {};
  const list = Array.isArray(input.questions) ? input.questions : [];
  return list.map((q, index) => {
    const options = normalizedOptions(q && q.options);
    return {
      id: `q${index}`,
      key: asText(q && q.question) || asText(q && q.header) || 'question',
      prompt: asText(q && q.question) || asText(q && q.header),
      header: asText(q && q.header),
      options,
      multiSelect: Boolean(q && q.multiSelect),
      allowCustom: true,
      required: true,
    };
  });
}

function fieldQuestion(name, prop, required, index) {
  const schema = prop && typeof prop === 'object' ? prop : {};
  const prompt = asText(schema.title) || asText(schema.description) || name;
  const base = {
    id: `q${index}`,
    key: name,
    prompt,
    header: '',
    multiSelect: false,
    allowCustom: false,
    required,
  };
  if (Array.isArray(schema.enum)) {
    const options = normalizedOptions(schema.enum.map((value) => ({ label: value })));
    if (!options.length || options.length !== schema.enum.length) return null;
    return { ...base, options };
  }
  if (schema.type === 'array') {
    const itemEnum = schema.items && Array.isArray(schema.items.enum) ? schema.items.enum : null;
    if (!itemEnum) return null;
    const options = normalizedOptions(itemEnum.map((value) => ({ label: value })));
    if (!options.length || options.length !== itemEnum.length) return null;
    return { ...base, options, multiSelect: true };
  }
  if (schema.type === 'string' || schema.type === undefined) {
    return { ...base, options: [] };
  }
  return null;
}

// MCP-style elicitation requestedSchema -> question list. Supported field
// shapes: string, string enum, array of enum. Anything else must FAIL CLEARLY
// ({ ok:false }) rather than invent an answer (#219).
export function questionsFromElicitationSchema(message, requestedSchema) {
  const schema = requestedSchema && typeof requestedSchema === 'object' ? requestedSchema : {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(props);
  if (!names.length) {
    return { ok: false, reason: 'empty-schema' };
  }
  const questions = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const question = fieldQuestion(name, props[name], required.has(name), index);
    if (!question) {
      return { ok: false, reason: `unsupported-field:${name}` };
    }
    questions.push(question);
  }
  if (questions.length === 1 && !questions[0].prompt) {
    questions[0].prompt = asText(message);
  }
  return { ok: true, questions };
}

function valueForQuestion(question, values) {
  const raw = values && typeof values === 'object' ? values[question.id] : undefined;
  if (question.multiSelect) {
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
    return list.map((item) => asText(item).trim()).filter(Boolean);
  }
  return asText(Array.isArray(raw) ? raw[0] : raw).trim();
}

// Validate submitted values; every error is keyed by question id so the form
// can mark the exact field. Values not in the question's option list are only
// legal when the question allows custom answers.
export function validateQuestionAnswers(questions, values) {
  const errors = {};
  for (const question of questions) {
    const value = valueForQuestion(question, values);
    const empty = question.multiSelect ? value.length === 0 : value === '';
    if (question.required && empty) {
      errors[question.id] = 'required';
      continue;
    }
    if (empty || !question.options.length || question.allowCustom) continue;
    const labels = new Set(question.options.map((option) => option.label));
    const chosen = question.multiSelect ? value : [value];
    if (chosen.some((item) => !labels.has(item))) {
      errors[question.id] = 'invalid-option';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// interaction/requestUserInput reply: { <question text>: <answer string> }.
// Multi-select answers join their labels; the protocol carries one string per
// question (same convention as the CLI AskUserQuestion result).
export function answersForUserInput(questions, values) {
  const answers = {};
  for (const question of questions) {
    const value = valueForQuestion(question, values);
    answers[question.key] = question.multiSelect ? value.join(', ') : value;
  }
  return answers;
}

// Elicitation reply content: schema-typed per field — string for string/enum
// fields, array for enum-array fields. Optional fields left empty are omitted
// instead of being submitted as ''.
export function contentForElicitation(questions, values) {
  const content = {};
  for (const question of questions) {
    const value = valueForQuestion(question, values);
    const empty = question.multiSelect ? value.length === 0 : value === '';
    if (empty && !question.required) continue;
    content[question.key] = value;
  }
  return content;
}
