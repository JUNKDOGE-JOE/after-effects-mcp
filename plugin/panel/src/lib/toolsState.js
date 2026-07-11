const EMPTY_SUMMARIES = Object.freeze([]);
const INITIAL_STATUSES = Object.freeze(['saved', 'pinned']);

export const INITIAL_TOOLS_STATE = Object.freeze({
  phase: 'idle',
  summaries: EMPTY_SUMMARIES,
  total: 0,
  selectedId: null,
  inspected: null,
  query: '',
  kinds: [],
  category: '',
  risk: '',
  statuses: INITIAL_STATUSES,
  sourceType: '',
  editor: null,
  importPreview: null,
  conflictResolutions: {},
  error: '',
});

const STATUS_ORDER = { pinned: 0, saved: 1, candidate: 2, archived: 3, deprecated: 4 };
const SOURCE_ORDER = { bundled: 0, user: 1, legacy: 2, imported: 3, 'chat-tool-call': 4 };
const RISK_ORDER = { read: 0, write: 1, destructive: 2, external: 3 };

function sourceType(artifact) {
  return artifact && (artifact.sourceType || (artifact.source && artifact.source.type)) || '';
}

function sortSummaries(values) {
  return [...values].sort((left, right) => {
    const pinned = Number(right.status === 'pinned') - Number(left.status === 'pinned');
    if (pinned) return pinned;
    const verified = Number(Boolean(right.verified)) - Number(Boolean(left.verified));
    if (verified) return verified;
    const status = (STATUS_ORDER[left.status] ?? 99) - (STATUS_ORDER[right.status] ?? 99);
    if (status) return status;
    const risk = (RISK_ORDER[left.declaredRisk] ?? 99) - (RISK_ORDER[right.declaredRisk] ?? 99);
    if (risk) return risk;
    const source = (SOURCE_ORDER[sourceType(left)] ?? 99) - (SOURCE_ORDER[sourceType(right)] ?? 99);
    if (source) return source;
    const updated = Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    if (updated) return updated;
    return String(left.id || '').localeCompare(String(right.id || ''));
  });
}

function toSummary(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    kind: value.kind,
    category: value.category,
    tags: Array.isArray(value.tags) ? [...value.tags] : [],
    status: value.status,
    verified: Boolean(value.verified),
    declaredRisk: value.declaredRisk,
    contentHash: value.contentHash,
    revision: value.revision,
    updatedAt: value.updatedAt,
    lastUsedAt: value.lastUsedAt ?? null,
    sourceType: value.sourceType || value.source && value.source.type || '',
  };
}

function messageOf(error) {
  return String(error && error.message || error || 'Tool Library request failed');
}

function isRevisionConflict(error) {
  const code = String(error && (error.code || (error.payload && error.payload.code)) || '');
  return code === 'tool_revision_conflict' || code === 'tool_store_revision_conflict';
}

export function reduceToolsState(state = INITIAL_TOOLS_STATE, event = {}) {
  switch (event.type) {
    case 'load-start':
      return { ...state, phase: 'loading', error: '', refreshRequired: false };
    case 'load-success': {
      const payload = event.payload || event;
      const summaries = (payload.artifacts || payload.summaries || []).map(toSummary);
      return {
        ...state,
        phase: 'ready',
        summaries: sortSummaries(summaries),
        total: Number.isFinite(payload.total) ? payload.total : summaries.length,
        error: '',
        refreshRequired: false,
      };
    }
    case 'load-error':
      return {
        ...state,
        phase: 'error',
        error: messageOf(event.error),
        refreshRequired: isRevisionConflict(event.error),
      };
    case 'select':
      return {
        ...state,
        selectedId: event.id || null,
        inspected: null,
        editor: null,
        error: '',
      };
    case 'inspect-success':
      return {
        ...state,
        phase: 'ready',
        inspected: {
          artifact: event.payload && event.payload.artifact,
          trust: event.payload && event.payload.trust || 'user-untrusted',
        },
        error: '',
      };
    case 'set-query':
      return { ...state, query: String(event.value || ''), error: '' };
    case 'set-filter':
      return { ...state, [event.key]: event.value, error: '' };
    case 'edit-start':
      return { ...state, editor: event.editor || event.artifact || null, error: '' };
    case 'edit-change':
      return {
        ...state,
        editor: state.editor
          ? { ...state.editor, ...(event.changes || { [event.key]: event.value }) }
          : state.editor,
        error: '',
      };
    case 'edit-cancel':
      return { ...state, editor: null, error: '' };
    case 'save-success': {
      const artifact = event.artifact || (event.payload && event.payload.artifact);
      const summaries = artifact
        ? state.summaries.map((row) => row.id === artifact.id ? toSummary({ ...row, ...artifact }) : row)
        : state.summaries;
      return {
        ...state,
        phase: 'ready',
        summaries: sortSummaries(summaries),
        inspected: artifact ? { artifact, trust: event.trust || 'user-untrusted' } : state.inspected,
        editor: null,
        error: '',
        refreshRequired: false,
      };
    }
    case 'delete-success': {
      const id = event.id || event.artifactId;
      return {
        ...state,
        summaries: state.summaries.filter((row) => row.id !== id),
        total: Math.max(0, state.total - 1),
        selectedId: state.selectedId === id ? null : state.selectedId,
        inspected: state.selectedId === id ? null : state.inspected,
        editor: null,
        error: '',
      };
    }
    case 'import-preview':
      return {
        ...state,
        importPreview: event.preview || event.payload || null,
        conflictResolutions: {},
        error: '',
      };
    case 'import-resolution':
      return {
        ...state,
        conflictResolutions: {
          ...state.conflictResolutions,
          [event.conflictId]: event.resolution,
        },
      };
    case 'import-finished':
      return {
        ...state,
        importPreview: null,
        conflictResolutions: {},
        error: '',
      };
    case 'clear-error':
      return { ...state, error: '', refreshRequired: false };
    default:
      return state;
  }
}

export function searchArgsFromState(state, { offset = 0, limit = 100 } = {}) {
  const args = {
    query: String(state.query || ''),
    statuses: [...(state.statuses || [])],
    offset,
    limit,
  };
  if (state.kinds && state.kinds.length) args.kinds = [...state.kinds];
  if (state.category) args.categories = [state.category];
  if (state.risk) args.risks = [state.risk];
  if (state.sourceType) args.source_types = [state.sourceType];
  return args;
}

export function canEditArtifact(artifact) {
  return Boolean(
    artifact
    && sourceType(artifact) !== 'bundled'
    && !['archived', 'deprecated'].includes(artifact.status),
  );
}

export function canExecuteArtifact(artifact) {
  return Boolean(artifact && ['saved', 'pinned'].includes(artifact.status));
}

export function toolExecutionCapabilities(artifact) {
  const enabled = canExecuteArtifact(artifact);
  const kind = artifact && artifact.kind;
  return {
    render: enabled && ['expression', 'prompt-skill'].includes(kind),
    execute: enabled && ['jsx', 'diagnostic', 'recipe'].includes(kind),
    apply: enabled && kind === 'expression',
  };
}

export function canPromoteArtifact(artifact) {
  return Boolean(artifact && artifact.status === 'candidate');
}

export function displayArtifactContent(artifact) {
  if (!artifact || artifact.content === undefined || artifact.content === null) return '';
  if (typeof artifact.content === 'string') return artifact.content;
  return JSON.stringify(artifact.content, null, 2);
}

export function emptyToolRunInputs() {
  return {
    args: '{}',
    target: { compId: '', layerId: '', path: '' },
  };
}

export function normalizeExpressionTarget(target) {
  const compId = String(target && target.compId || '').trim();
  const path = String(target && target.path || '').trim();
  const layerId = Number(target && target.layerId);
  if (!compId || !path || !Number.isInteger(layerId) || layerId < 1) {
    throw new TypeError('expression target is invalid');
  }
  return { compId, layerId, path };
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalizeJson(value[key]);
    return result;
  }, Object.create(null));
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

export function buildArtifactEditChanges(artifact, editable) {
  const legacy = sourceType(artifact) === 'legacy';
  const fields = [
    ['name', 'name'],
    ['description', 'description'],
    ['kind', 'kind'],
    ['category', 'category'],
    ['tags', 'tags'],
    ['declared_risk', 'declaredRisk'],
    ['content', 'content'],
    ['args_schema', 'argsSchema'],
  ];
  const changes = {};

  for (const [requestKey, artifactKey] of fields) {
    if (legacy && requestKey === 'name') continue;
    if (!sameJsonValue(editable[requestKey], artifact[artifactKey])) {
      changes[requestKey] = editable[requestKey];
    }
  }

  if (legacy) {
    const skillFields = ['description', 'content', 'args_schema', 'kind'];
    const metadataFields = ['category', 'tags', 'declared_risk'];
    const changesSkill = skillFields.some((key) => Object.prototype.hasOwnProperty.call(changes, key));
    const changesMetadata = metadataFields.some((key) => Object.prototype.hasOwnProperty.call(changes, key));
    if (changesSkill && changesMetadata) {
      const error = new Error('Legacy skill fields and metadata must be saved separately');
      error.code = 'tool_legacy_transaction_required';
      throw error;
    }
  }

  return changes;
}

export function confirmToolAction(confirmImpl, message) {
  if (typeof confirmImpl !== 'function') return false;
  try {
    return confirmImpl(message) === true;
  } catch {
    return false;
  }
}
