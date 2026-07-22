import crypto from 'node:crypto';

export const LIMITS = Object.freeze({
  maxFrameBytes: 524288,
  maxJsonDepth: 32,
  maxJsonNodes: 32768,
  maxStringLength: 8192,
  defaultDeadlineMs: 5000,
  maximumDeadlineMs: 30000,
  defaultTerminalCacheEntries: 128,
  defaultTerminalCacheTtlMs: 60000,
});

export const ERROR_POLICIES = Object.freeze({
  NATIVE_UNAVAILABLE: [true, 'not-started', 'reconnect'],
  NATIVE_UNSUPPORTED: [false, 'not-started', 'refresh-capabilities'],
  WIRE_VERSION_MISMATCH: [false, 'not-started', 'reconnect'],
  INVALID_REQUEST: [false, 'not-started', 'none'],
  INVALID_ARGUMENT: [false, 'not-started', 'change-arguments'],
  DUPLICATE_REQUEST: [false, 'not-started', 'inspect-state'],
  PRECONDITION_FAILED: [false, 'not-started', 'open-project'],
  STALE_LOCATOR: [true, 'not-started', 'refresh-locator'],
  DEADLINE_EXCEEDED: [true, 'not-started', 'retry'],
  CANCELLED: [false, 'not-started', 'none'],
  QUEUE_FULL: [true, 'not-started', 'retry'],
  AE_SHUTTING_DOWN: [true, 'not-started', 'reconnect'],
  SESSION_STALE: [true, 'not-started', 'reconnect'],
  CAPABILITY_FAILED: [false, 'not-started', 'inspect-state'],
  POSSIBLY_SIDE_EFFECTING_FAILURE: [false, 'may-have-occurred', 'inspect-state'],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const METHODS = new Set(['hello', 'capabilities', 'invoke', 'invalidateGraph', 'cancel']);
const PROGRESS_PHASE = Object.freeze({ queued: 0, dispatched: 1, running: 2, validating: 3 });
const VALID_REPLAY_RECEIPTS = new WeakSet();
const VALID_CANCEL_DECISIONS = new WeakSet();
const CONSUMED_CANCEL_DECISIONS = new WeakSet();
export const INVOKE_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'ae.project.summary',
    version: 1,
    inputContractId: 'aemcp.contract.ae.project.summary.input.v1',
    resultContractId: 'aemcp.contract.ae.project.summary.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.bit-depth.read',
    version: 1,
    inputContractId: 'aemcp.contract.ae.project.bit-depth.read.input.v1',
    resultContractId: 'aemcp.contract.ae.project.bit-depth.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.bit-depth.set',
    version: 1,
    inputContractId: 'aemcp.contract.ae.project.bit-depth.set.input.v1',
    resultContractId: 'aemcp.contract.ae.project.bit-depth.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.items.list',
    version: 1,
    inputContractId: 'aemcp.contract.ae.project.items.list.input.v1',
    resultContractId: 'aemcp.contract.ae.project.items.list.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.layers.list',
    version: 1,
    inputContractId: 'aemcp.contract.ae.composition.layers.list.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.layers.list.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.selected-layers.list',
    version: 1,
    inputContractId: 'aemcp.contract.ae.composition.selected-layers.list.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.selected-layers.list.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.time.read',
    version: 1,
    inputContractId: 'aemcp.contract.ae.composition.time.read.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.time.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.time.set',
    version: 1,
    inputContractId: 'aemcp.contract.ae.composition.time.set.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.time.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.create',
    version: 1,
    inputContractId: 'aemcp.contract.ae.composition.create.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.create.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.layer.create',
    version: 1,
    inputContractId: 'aemcp.contract.ae.composition.layer.create.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.layer.create.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.effect.apply',
    version: 1,
    inputContractId: 'aemcp.contract.ae.layer.effect.apply.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.effect.apply.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.properties.list',
    version: 1,
    inputContractId: 'aemcp.contract.ae.layer.properties.list.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.properties.list.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframes.list',
    version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframes.list.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframes.list.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.set',
    version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframe.details.read', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframe.details.read.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframe.details.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframe.add', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframe.add.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframe.add.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframe.value.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframe.value.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframe.value.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframe.interpolation.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframe.interpolation.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframe.interpolation.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframe.temporal-ease.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframe.temporal-ease.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframe.temporal-ease.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframe.behavior.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframe.behavior.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframe.behavior.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.property.keyframe.delete', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.property.keyframe.delete.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.property.keyframe.delete.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.context.read', version: 1,
    inputContractId: 'aemcp.contract.ae.project.context.read.input.v1',
    resultContractId: 'aemcp.contract.ae.project.context.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.item.metadata.read', version: 1,
    inputContractId: 'aemcp.contract.ae.project.item.metadata.read.input.v1',
    resultContractId: 'aemcp.contract.ae.project.item.metadata.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.settings.read', version: 1,
    inputContractId: 'aemcp.contract.ae.composition.settings.read.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.settings.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.work-area.set', version: 1,
    inputContractId: 'aemcp.contract.ae.composition.work-area.set.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.work-area.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.item.name.set', version: 1,
    inputContractId: 'aemcp.contract.ae.project.item.name.set.input.v1',
    resultContractId: 'aemcp.contract.ae.project.item.name.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.item.comment.set', version: 1,
    inputContractId: 'aemcp.contract.ae.project.item.comment.set.input.v1',
    resultContractId: 'aemcp.contract.ae.project.item.comment.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.project.item.label.set', version: 1,
    inputContractId: 'aemcp.contract.ae.project.item.label.set.input.v1',
    resultContractId: 'aemcp.contract.ae.project.item.label.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.composition.duplicate', version: 1,
    inputContractId: 'aemcp.contract.ae.composition.duplicate.input.v1',
    resultContractId: 'aemcp.contract.ae.composition.duplicate.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.details.read', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.details.read.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.details.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.name.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.name.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.name.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.range.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.range.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.range.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.start-time.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.start-time.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.start-time.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.stretch.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.stretch.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.stretch.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.order.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.order.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.order.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.parent.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.parent.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.parent.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.duplicate', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.duplicate.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.duplicate.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.compositing.read', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.compositing.read.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.compositing.read.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.switch.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.switch.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.switch.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.quality.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.quality.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.quality.set.result.v1',
  }),
  Object.freeze({
    id: 'ae.layer.blending-mode.set', version: 1,
    inputContractId: 'aemcp.contract.ae.layer.blending-mode.set.input.v1',
    resultContractId: 'aemcp.contract.ae.layer.blending-mode.set.result.v1',
  }),
]);
const ENVELOPE_KEYS = new Set([
  'wireVersion', 'kind', 'sessionId', 'requestId', 'method', 'deadlineUnixMs', 'params',
]);

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function unicodeScalarLength(value) {
  if (typeof value !== 'string' || hasLoneSurrogate(value)) {
    fail('INVALID_REQUEST', 'string is not valid Unicode scalar data');
  }
  return Array.from(value).length;
}

function exactKeys(value, allowed, required = []) {
  return isPlainObject(value)
    && Object.keys(value).every((key) => allowed.has(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function isBoundedScalarString(value, minimum, maximum) {
  if (typeof value !== 'string') return false;
  try {
    const length = unicodeScalarLength(value);
    return length >= minimum && length <= maximum;
  } catch {
    return false;
  }
}

function isLocatorShape(value, allowedKinds) {
  return exactKeys(value, new Set([
    'kind', 'hostInstanceId', 'sessionId', 'projectId', 'generation', 'objectId',
  ]), ['kind', 'hostInstanceId', 'sessionId', 'projectId', 'generation', 'objectId'])
    && allowedKinds.includes(value.kind)
    && ['hostInstanceId', 'sessionId', 'projectId', 'objectId']
      .every((key) => UUID.test(value[key] ?? ''))
    && Number.isSafeInteger(value.generation) && value.generation >= 1;
}

function isPositiveRatioInput(value) {
  return exactKeys(value, new Set(['numerator', 'denominator']), ['numerator', 'denominator'])
    && Number.isInteger(value.numerator) && value.numerator >= 1
    && value.numerator <= 2147483647
    && Number.isInteger(value.denominator) && value.denominator >= 1
    && value.denominator <= 2147483647;
}

function isTimeInput(value, minimum) {
  return exactKeys(value, new Set(['value', 'scale']), ['value', 'scale'])
    && Number.isInteger(value.value) && value.value >= minimum && value.value <= 2147483647
    && Number.isInteger(value.scale) && value.scale >= 1 && value.scale <= 4294967295;
}

function isLayerStretchInput(value) {
  return exactKeys(value, new Set(['num', 'den']), ['num', 'den'])
    && Number.isInteger(value.num) && value.num >= -2147483648
    && value.num <= 2147483647 && value.num !== 0
    && Number.isInteger(value.den) && value.den >= 1 && value.den <= 2147483647;
}

function isIdempotencyKey(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(value);
}

function sameLocatorContext(left, right) {
  return ['hostInstanceId', 'sessionId', 'projectId', 'generation']
    .every((field) => left?.[field] === right?.[field]);
}

const LAYER_SWITCHES = Object.freeze([
  'visibility', 'solo', 'locked', 'shy', 'motion-blur', 'three-d', 'adjustment',
]);
const LAYER_QUALITIES = Object.freeze(['wireframe', 'draft', 'best']);
const LAYER_BLENDING_MODES = Object.freeze([
  'normal', 'dissolve', 'add', 'multiply', 'screen', 'overlay', 'soft-light',
  'hard-light', 'darken', 'lighten', 'difference', 'hue', 'saturation', 'color',
  'luminosity', 'color-dodge', 'color-burn', 'exclusion', 'linear-dodge',
  'linear-burn', 'linear-light', 'vivid-light', 'pin-light', 'hard-mix',
  'lighter-color', 'darker-color', 'subtract', 'divide',
]);
const LAYER_TRACK_MATTES = Object.freeze([
  'none', 'alpha', 'inverted-alpha', 'luma', 'inverted-luma',
]);

const KEYFRAME_WRITE_CAPABILITIES = new Set([
  'ae.layer.property.keyframe.add',
  'ae.layer.property.keyframe.value.set',
  'ae.layer.property.keyframe.interpolation.set',
  'ae.layer.property.keyframe.temporal-ease.set',
  'ae.layer.property.keyframe.behavior.set',
  'ae.layer.property.keyframe.delete',
]);

function isKeyframeTimeInput(value) {
  return isTimeInput(value, -2147483648);
}

function isKeyframeEase(value) {
  return exactKeys(value, new Set(['speed', 'influence']), ['speed', 'influence'])
    && validateDecimalWireValue(value.speed)
    && validateDecimalWireValue(value.influence)
    && Number(value.influence) >= 0 && Number(value.influence) <= 100;
}

function isKeyframeEaseDimension(value, expectedDimension) {
  return exactKeys(
    value,
    new Set(['dimension', 'inEase', 'outEase']),
    ['dimension', 'inEase', 'outEase'],
  ) && value.dimension === expectedDimension
    && isKeyframeEase(value.inEase) && isKeyframeEase(value.outEase);
}

function resolveSchemaRef(root, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    fail('INVALID_ARGUMENT', 'only local schema references are supported');
  }
  return reference.slice(2).split('/').reduce((value, segment) => {
    if (!isPlainObject(value)) fail('INVALID_ARGUMENT', 'invalid local schema reference');
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!Object.hasOwn(value, key)) fail('INVALID_ARGUMENT', 'unresolved local schema reference');
    return value[key];
  }, root);
}

function jsonDeepEqual(left, right) {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonDeepEqual(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && jsonDeepEqual(left[key], right[key]));
}

function schemaTypeMatches(type, value) {
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function schemaAcceptsUnchecked(candidate, value, root) {
  if (candidate === true) return true;
  if (candidate === false || !isPlainObject(candidate)) return false;
  if (candidate.$ref !== undefined
      && !schemaAcceptsUnchecked(resolveSchemaRef(root, candidate.$ref), value, root)) return false;
  if (Object.hasOwn(candidate, 'const') && !jsonDeepEqual(candidate.const, value)) return false;
  if (candidate.enum && !candidate.enum.some((item) => jsonDeepEqual(item, value))) return false;
  if (candidate.not && schemaAcceptsUnchecked(candidate.not, value, root)) return false;
  if (candidate.if) {
    const branch = schemaAcceptsUnchecked(candidate.if, value, root) ? candidate.then : candidate.else;
    if (branch !== undefined && !schemaAcceptsUnchecked(branch, value, root)) return false;
  }
  if (candidate.oneOf
      && candidate.oneOf.filter((part) => schemaAcceptsUnchecked(part, value, root)).length !== 1) {
    return false;
  }
  if (candidate.anyOf
      && !candidate.anyOf.some((part) => schemaAcceptsUnchecked(part, value, root))) return false;
  if (candidate.allOf
      && !candidate.allOf.every((part) => schemaAcceptsUnchecked(part, value, root))) return false;
  if (candidate.type && !schemaTypeMatches(candidate.type, value)) return false;

  if (typeof value === 'number') {
    if (candidate.minimum !== undefined && value < candidate.minimum) return false;
    if (candidate.maximum !== undefined && value > candidate.maximum) return false;
  }
  if (typeof value === 'string') {
    const length = unicodeScalarLength(value);
    if (candidate.minLength !== undefined && length < candidate.minLength) return false;
    if (candidate.maxLength !== undefined && length > candidate.maxLength) return false;
    if (candidate.pattern && !(new RegExp(candidate.pattern, 'u')).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (candidate.minItems !== undefined && value.length < candidate.minItems) return false;
    if (candidate.maxItems !== undefined && value.length > candidate.maxItems) return false;
    if (candidate.uniqueItems && value.some((item, index) => (
      value.slice(index + 1).some((other) => jsonDeepEqual(item, other))
    ))) return false;
    if (candidate.items
        && !value.every((item) => schemaAcceptsUnchecked(candidate.items, item, root))) return false;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (candidate.required && !candidate.required.every((key) => Object.hasOwn(value, key))) return false;
    if (candidate.properties) {
      for (const [key, member] of Object.entries(candidate.properties)) {
        if (Object.hasOwn(value, key) && !schemaAcceptsUnchecked(member, value[key], root)) return false;
      }
    }
    if (candidate.additionalProperties === false
        && keys.some((key) => !Object.hasOwn(candidate.properties ?? {}, key))) return false;
  }
  return true;
}

export function schemaAccepts(candidate, value, root = candidate) {
  try {
    assertJsonLimits(value);
    return schemaAcceptsUnchecked(candidate, value, root);
  } catch {
    return false;
  }
}

export function assertJsonLimits(value, limits = LIMITS) {
  const stack = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > limits.maxJsonNodes) fail('INVALID_REQUEST', 'JSON node limit exceeded');
    if (current.depth > limits.maxJsonDepth) fail('INVALID_REQUEST', 'JSON depth exceeded');
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'string') {
      if (unicodeScalarLength(current.value) > limits.maxStringLength) {
        fail('INVALID_REQUEST', 'JSON string limit exceeded');
      }
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) fail('INVALID_REQUEST', 'non-finite JSON number');
      if (Number.isInteger(current.value) && !Number.isSafeInteger(current.value)) {
        fail('INVALID_REQUEST', 'unsafe JSON integer');
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(current.value)) fail('INVALID_REQUEST', 'unsupported JSON value');
    for (const [key, member] of Object.entries(current.value).reverse()) {
      if (unicodeScalarLength(key) > limits.maxStringLength) {
        fail('INVALID_REQUEST', 'JSON key limit exceeded');
      }
      if (member === undefined || typeof member === 'bigint' || typeof member === 'function'
          || typeof member === 'symbol') fail('INVALID_REQUEST', 'unsupported JSON member');
      stack.push({ value: member, depth: current.depth + 1 });
    }
  }
  return true;
}

function canonicalizeUnchecked(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) fail('INVALID_ARGUMENT', 'lone unicode surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_ARGUMENT', 'non-finite JSON number');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('INVALID_ARGUMENT', 'unsafe JSON integer');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeUnchecked(item)).join(',')}]`;
  if (!isPlainObject(value)) fail('INVALID_ARGUMENT', 'unsupported canonical JSON value');
  const members = Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalizeUnchecked(value[key])}`
  ));
  return `{${members.join(',')}}`;
}

export function canonicalize(value) {
  assertJsonLimits(value);
  return canonicalizeUnchecked(value);
}

export function sha256Jcs(value) {
  return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

class StrictJsonParser {
  constructor(text, limits = LIMITS) {
    this.text = text;
    this.index = 0;
    this.nodes = 0;
    this.limits = limits;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.index !== this.text.length) fail('INVALID_REQUEST', 'trailing JSON bytes');
    return value;
  }

  countNode(depth) {
    if (depth > this.limits.maxJsonDepth) fail('INVALID_REQUEST', 'JSON depth exceeded');
    this.nodes += 1;
    if (this.nodes > this.limits.maxJsonNodes) fail('INVALID_REQUEST', 'JSON node limit exceeded');
  }

  parseValue(depth) {
    this.countNode(depth);
    const char = this.text[this.index];
    if (char === '{') return this.parseObject(depth);
    if (char === '[') return this.parseArray(depth);
    if (char === '"') return this.parseString();
    if (char === 't') return this.parseLiteral('true', true);
    if (char === 'f') return this.parseLiteral('false', false);
    if (char === 'n') return this.parseLiteral('null', null);
    return this.parseNumber();
  }

  parseObject(depth) {
    this.index += 1;
    this.skipWhitespace();
    const result = Object.create(null);
    const keys = new Set();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') fail('INVALID_REQUEST', 'object key must be a string');
      const key = this.parseString();
      if (keys.has(key)) fail('INVALID_REQUEST', 'duplicate JSON object key');
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') fail('INVALID_REQUEST', 'missing object colon');
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === '}') return result;
      if (separator !== ',') fail('INVALID_REQUEST', 'invalid object separator');
      this.skipWhitespace();
    }
    fail('INVALID_REQUEST', 'unterminated object');
  }

  parseArray(depth) {
    this.index += 1;
    this.skipWhitespace();
    const result = [];
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === ']') return result;
      if (separator !== ',') fail('INVALID_REQUEST', 'invalid array separator');
      this.skipWhitespace();
    }
    fail('INVALID_REQUEST', 'unterminated array');
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        let value;
        try {
          value = JSON.parse(this.text.slice(start, this.index));
        } catch {
          fail('INVALID_REQUEST', 'invalid JSON string');
        }
        if (unicodeScalarLength(value) > this.limits.maxStringLength) {
          fail('INVALID_REQUEST', 'JSON string limit exceeded');
        }
        return value;
      }
      if (code < 0x20) fail('INVALID_REQUEST', 'unescaped string control character');
      if (code === 0x5c) {
        this.index += 1;
        const escaped = this.text[this.index];
        if (escaped === 'u') {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail('INVALID_REQUEST', 'invalid unicode escape');
          this.index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) {
          fail('INVALID_REQUEST', 'invalid string escape');
        }
      }
      this.index += 1;
    }
    fail('INVALID_REQUEST', 'unterminated string');
  }

  parseLiteral(literal, value) {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      fail('INVALID_REQUEST', 'invalid JSON literal');
    }
    this.index += literal.length;
    return value;
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.index),
    );
    if (!match) fail('INVALID_REQUEST', 'invalid JSON value');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail('INVALID_REQUEST', 'non-finite JSON number');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('INVALID_REQUEST', 'unsafe JSON integer');
    }
    return value;
  }

  skipWhitespace() {
    while (' \t\r\n'.includes(this.text[this.index] ?? '\0')) this.index += 1;
  }
}

export function strictParseJson(text, limits = LIMITS) {
  return new StrictJsonParser(text, limits).parse();
}

export function encodeFrame(message) {
  const body = Buffer.from(canonicalize(message), 'utf8');
  if (body.length === 0 || body.length > LIMITS.maxFrameBytes) fail('INVALID_REQUEST', 'frame size rejected');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeFrame(frame) {
  if (frame.length < 4) fail('INVALID_REQUEST', 'incomplete frame prefix');
  const length = frame.readUInt32BE(0);
  if (length === 0 || length > LIMITS.maxFrameBytes) fail('INVALID_REQUEST', 'frame size rejected');
  if (frame.length !== length + 4) fail('INVALID_REQUEST', 'incomplete or trailing frame bytes');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4));
  } catch {
    fail('INVALID_REQUEST', 'invalid UTF-8');
  }
  return strictParseJson(text);
}

export class FrameDecoder {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      fail('INVALID_REQUEST', 'frame chunk must be bytes');
    }
    if (chunk.length > LIMITS.maxFrameBytes + 4) {
      fail('INVALID_REQUEST', 'transport chunk exceeds bounded decoder input');
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length === 0 || length > LIMITS.maxFrameBytes) fail('INVALID_REQUEST', 'frame size rejected');
      if (this.pending.length < length + 4) break;
      const frame = this.pending.subarray(0, length + 4);
      messages.push(decodeFrame(frame));
      this.pending = this.pending.subarray(length + 4);
    }
    return messages;
  }

  finalize() {
    if (this.pending.length !== 0) fail('INVALID_REQUEST', 'incomplete frame at end of stream');
    return [];
  }
}

export function selectWireVersion(clientRange, pluginRange) {
  for (const range of [clientRange, pluginRange]) {
    if (!Number.isInteger(range?.minimum) || !Number.isInteger(range?.maximum)
        || range.minimum < 1 || range.maximum > 65535 || range.maximum < range.minimum) {
      fail('INVALID_ARGUMENT', 'invalid wire-version range');
    }
  }
  const minimum = Math.max(clientRange.minimum, pluginRange.minimum);
  const maximum = Math.min(clientRange.maximum, pluginRange.maximum);
  return minimum <= maximum ? maximum : null;
}

export function materializeDeadline(request, nowUnixMs, maxDeadlineMs = LIMITS.maximumDeadlineMs) {
  if (!Number.isSafeInteger(nowUnixMs) || nowUnixMs < 1) fail('INVALID_ARGUMENT', 'invalid current time');
  const deadline = request.deadlineUnixMs ?? (nowUnixMs + LIMITS.defaultDeadlineMs);
  if (!Number.isSafeInteger(deadline) || deadline < 1) fail('INVALID_ARGUMENT', 'invalid deadline');
  if (deadline <= nowUnixMs) fail('DEADLINE_EXCEEDED', 'deadline expired before dispatch');
  if (deadline > nowUnixMs + maxDeadlineMs) fail('INVALID_ARGUMENT', 'deadline exceeds negotiated maximum');
  return deadline;
}

export function classifyRequest(message) {
  if (!exactKeys(message, ENVELOPE_KEYS, ['wireVersion', 'kind', 'requestId', 'method', 'params'])) {
    return { ok: false, errorCode: 'INVALID_REQUEST' };
  }
  if (message.wireVersion !== 1 || message.kind !== 'request'
      || !REQUEST_ID.test(message.requestId) || !METHODS.has(message.method)) {
    return { ok: false, errorCode: 'INVALID_REQUEST' };
  }
  if (message.deadlineUnixMs !== undefined
      && (!Number.isSafeInteger(message.deadlineUnixMs) || message.deadlineUnixMs < 1)) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT' };
  }
  if (message.method === 'hello') {
    if (message.sessionId !== undefined) return { ok: false, errorCode: 'INVALID_REQUEST' };
    const params = message.params;
    if (!exactKeys(params, new Set(['supportedWireVersions', 'client', 'nonce']),
      ['supportedWireVersions', 'client', 'nonce'])) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    try {
      selectWireVersion(params.supportedWireVersions, { minimum: 1, maximum: 1 });
    } catch {
      return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    }
    if (!exactKeys(params.client, new Set(['component', 'version', 'instanceId']),
      ['component', 'version', 'instanceId'])
      || !['core-broker', 'development-smoke'].includes(params.client.component)
      || !isBoundedScalarString(params.client.version, 1, 64) || !UUID.test(params.client.instanceId)
      || typeof params.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(params.nonce)) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    }
    return { ok: true };
  }
  if (!UUID.test(message.sessionId ?? '')) return { ok: false, errorCode: 'SESSION_STALE' };
  if (message.method === 'capabilities') {
    const params = message.params;
    const allowed = new Set(['ids', 'detail', 'limit']);
    if (!exactKeys(params, allowed)) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    if (params.detail !== undefined && !['summary', 'full'].includes(params.detail)) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    }
    if (params.limit !== undefined
        && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    }
    if (params.ids !== undefined
        && (!Array.isArray(params.ids) || params.ids.length < 1 || params.ids.length > 32
          || new Set(params.ids).size !== params.ids.length
          || params.ids.some((id) => typeof id !== 'string' || id.length > 96
            || !/^ae(?:\.[a-z][a-z0-9_-]*)+$/u.test(id)))) {
      return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    }
    return { ok: true };
  }
  if (message.method === 'invoke') {
    const params = message.params;
    if (!exactKeys(params, new Set(['capabilityId', 'capabilityVersion', 'arguments']),
      ['capabilityId', 'capabilityVersion', 'arguments'])) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    const registration = INVOKE_REGISTRY.find((item) => item.id === params.capabilityId
      && item.version === params.capabilityVersion);
    if (!registration) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    if (params.capabilityId === 'ae.project.summary'
        || params.capabilityId === 'ae.project.bit-depth.read') {
      if (!exactKeys(params.arguments, new Set())) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.project.bit-depth.set') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['targetDepth', 'idempotencyKey']),
        ['targetDepth', 'idempotencyKey'],
      )
          || ![8, 16, 32].includes(args.targetDepth)
          || typeof args.idempotencyKey !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.project.items.list') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['projectLocator', 'offset', 'limit']),
        ['offset', 'limit'],
      )
          || !Number.isSafeInteger(args.offset) || args.offset < 0
          || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50
          || (args.projectLocator !== undefined
            && !isLocatorShape(args.projectLocator, ['project']))
          || (args.offset > 0 && args.projectLocator === undefined)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.layers.list'
        || params.capabilityId === 'ae.composition.selected-layers.list') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['compositionLocator', 'offset', 'limit']),
        ['compositionLocator', 'offset', 'limit'],
      )
          || !isLocatorShape(args.compositionLocator, ['composition'])
          || !Number.isSafeInteger(args.offset) || args.offset < 0
          || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.time.read') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['compositionLocator']),
        ['compositionLocator'],
      ) || !isLocatorShape(args.compositionLocator, ['composition'])) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.time.set') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['compositionLocator', 'targetTime', 'idempotencyKey']),
        ['compositionLocator', 'targetTime', 'idempotencyKey'],
      )
          || !isLocatorShape(args.compositionLocator, ['composition'])
          || !exactKeys(args.targetTime, new Set(['value', 'scale']), ['value', 'scale'])
          || !Number.isInteger(args.targetTime.value)
          || args.targetTime.value < -2147483648 || args.targetTime.value > 2147483647
          || !Number.isInteger(args.targetTime.scale)
          || args.targetTime.scale < 1 || args.targetTime.scale > 4294967295
          || typeof args.idempotencyKey !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.create') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set([
          'name', 'width', 'height', 'duration', 'frameRate',
          'pixelAspectRatio', 'idempotencyKey',
        ]),
        [
          'name', 'width', 'height', 'duration', 'frameRate',
          'pixelAspectRatio', 'idempotencyKey',
        ],
      )
          || typeof args.name !== 'string' || hasLoneSurrogate(args.name)
          || args.name.includes('\u0000')
          || Array.from(args.name).length < 1 || Array.from(args.name).length > 255
          || !Number.isInteger(args.width) || args.width < 1 || args.width > 30000
          || !Number.isInteger(args.height) || args.height < 1 || args.height > 30000
          || !exactKeys(args.duration, new Set(['value', 'scale']), ['value', 'scale'])
          || !Number.isInteger(args.duration.value)
          || args.duration.value < 1 || args.duration.value > 2147483647
          || !Number.isInteger(args.duration.scale)
          || args.duration.scale < 1 || args.duration.scale > 4294967295
          || !isPositiveRatioInput(args.frameRate)
          || !isPositiveRatioInput(args.pixelAspectRatio)
          || typeof args.idempotencyKey !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.layer.create') {
      const args = params.arguments;
      const solidOnlyProvided = ['color', 'width', 'height', 'duration']
        .some((key) => Object.hasOwn(args, key));
      const validColor = args.color === undefined || (exactKeys(
        args.color,
        new Set(['red', 'green', 'blue', 'alpha']),
        ['red', 'green', 'blue', 'alpha'],
      ) && ['red', 'green', 'blue', 'alpha'].every((channel) => (
        Number.isInteger(args.color[channel])
          && args.color[channel] >= 0 && args.color[channel] <= 255
      )));
      const validDuration = args.duration === undefined || (exactKeys(
        args.duration, new Set(['value', 'scale']), ['value', 'scale'],
      ) && Number.isInteger(args.duration.value)
        && args.duration.value >= -2147483648 && args.duration.value <= 2147483647
        && Number.isInteger(args.duration.scale)
        && args.duration.scale >= 1 && args.duration.scale <= 4294967295);
      if (!exactKeys(
        args,
        new Set([
          'compositionLocator', 'kind', 'name', 'color', 'width', 'height',
          'duration', 'idempotencyKey',
        ]),
        ['compositionLocator', 'kind', 'name', 'idempotencyKey'],
      )
          || !isLocatorShape(args.compositionLocator, ['composition'])
          || !['null', 'solid'].includes(args.kind)
          || typeof args.name !== 'string' || hasLoneSurrogate(args.name)
          || Array.from(args.name).length < 1 || Array.from(args.name).length > 255
          || (args.kind === 'null' && solidOnlyProvided)
          || !validColor || !validDuration
          || (args.width !== undefined
            && (!Number.isInteger(args.width) || args.width < 1 || args.width > 30000))
          || (args.height !== undefined
            && (!Number.isInteger(args.height) || args.height < 1 || args.height > 30000))
          || typeof args.idempotencyKey !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.effect.apply') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['layerLocator', 'effectMatchName', 'idempotencyKey']),
        ['layerLocator', 'effectMatchName', 'idempotencyKey'],
      )
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isBoundedScalarString(args.effectMatchName, 1, 47)
          || typeof args.idempotencyKey !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.properties.list') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['layerLocator', 'parentPropertyLocator', 'offset', 'limit']),
        ['layerLocator', 'offset', 'limit'],
      )
          || !isLocatorShape(args.layerLocator, ['layer'])
          || (args.parentPropertyLocator !== undefined
            && args.parentPropertyLocator !== null
            && !isLocatorShape(args.parentPropertyLocator, ['stream']))
          || !Number.isSafeInteger(args.offset) || args.offset < 0
          || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 25) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.property.keyframes.list') {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['propertyLocator', 'offset', 'limit']),
        ['propertyLocator', 'offset', 'limit'],
      )
          || !isLocatorShape(args.propertyLocator, ['stream'])
          || !Number.isSafeInteger(args.offset) || args.offset < 0
          || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 25) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.property.keyframe.details.read') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['propertyLocator', 'time']), ['propertyLocator', 'time'])
          || !isLocatorShape(args.propertyLocator, ['stream'])
          || !isKeyframeTimeInput(args.time)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (KEYFRAME_WRITE_CAPABILITIES.has(params.capabilityId)) {
      const args = params.arguments;
      const common = ['layerLocator', 'propertyLocator', 'time', 'idempotencyKey'];
      const extras = params.capabilityId === 'ae.layer.property.keyframe.add'
          || params.capabilityId === 'ae.layer.property.keyframe.value.set'
        ? ['value']
        : params.capabilityId === 'ae.layer.property.keyframe.interpolation.set'
          ? ['inInterpolation', 'outInterpolation']
          : params.capabilityId === 'ae.layer.property.keyframe.temporal-ease.set'
            ? ['dimensions']
            : params.capabilityId === 'ae.layer.property.keyframe.behavior.set'
              ? ['behavior', 'enabled'] : [];
      if (!exactKeys(args, new Set([...common, ...extras]), [...common, ...extras])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isLocatorShape(args.propertyLocator, ['stream'])
          || !sameLocatorContext(args.layerLocator, args.propertyLocator)
          || !isKeyframeTimeInput(args.time)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
      if ((extras.includes('value') && !validatePrimitivePropertyValue(args.value))
          || (extras.includes('inInterpolation')
            && (!['linear', 'bezier', 'hold'].includes(args.inInterpolation)
              || !['linear', 'bezier', 'hold'].includes(args.outInterpolation)))
          || (extras.includes('dimensions')
            && (!Array.isArray(args.dimensions) || args.dimensions.length < 1
              || args.dimensions.length > 4
              || !args.dimensions.every(isKeyframeEaseDimension)))
          || (extras.includes('behavior')
            && (!['temporal-continuous', 'temporal-auto-bezier', 'spatial-continuous',
              'spatial-auto-bezier', 'roving'].includes(args.behavior)
              || typeof args.enabled !== 'boolean'))) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.project.context.read') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['selectionOffset', 'selectionLimit']),
        ['selectionOffset', 'selectionLimit'])
          || !Number.isSafeInteger(args.selectionOffset) || args.selectionOffset < 0
          || !Number.isInteger(args.selectionLimit)
          || args.selectionLimit < 1 || args.selectionLimit > 50) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.project.item.metadata.read') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['itemLocator']), ['itemLocator'])
          || !isLocatorShape(args.itemLocator, ['item', 'composition'])) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.settings.read') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['compositionLocator']), ['compositionLocator'])
          || !isLocatorShape(args.compositionLocator, ['composition'])) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.work-area.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set([
        'compositionLocator', 'start', 'duration', 'idempotencyKey',
      ]), ['compositionLocator', 'start', 'duration', 'idempotencyKey'])
          || !isLocatorShape(args.compositionLocator, ['composition'])
          || !isTimeInput(args.start, 0) || !isTimeInput(args.duration, 1)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.project.item.name.set'
        || params.capabilityId === 'ae.project.item.comment.set') {
      const args = params.arguments;
      const field = params.capabilityId === 'ae.project.item.name.set' ? 'name' : 'comment';
      const minimum = field === 'name' ? 1 : 0;
      const maximum = field === 'name' ? 255 : 1024;
      if (!exactKeys(args, new Set(['itemLocator', field, 'idempotencyKey']),
        ['itemLocator', field, 'idempotencyKey'])
          || !isLocatorShape(args.itemLocator, ['item', 'composition'])
          || !isBoundedScalarString(args[field], minimum, maximum)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.project.item.label.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['itemLocator', 'labelId', 'idempotencyKey']),
        ['itemLocator', 'labelId', 'idempotencyKey'])
          || !isLocatorShape(args.itemLocator, ['item', 'composition'])
          || !Number.isInteger(args.labelId) || args.labelId < 0 || args.labelId > 16
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.composition.duplicate') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['compositionLocator', 'newName', 'idempotencyKey']),
        ['compositionLocator', 'newName', 'idempotencyKey'])
          || !isLocatorShape(args.compositionLocator, ['composition'])
          || !isBoundedScalarString(args.newName, 1, 255)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.details.read') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['layerLocator']), ['layerLocator'])
          || !isLocatorShape(args.layerLocator, ['layer'])) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.name.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['layerLocator', 'name', 'idempotencyKey']),
        ['layerLocator', 'name', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isBoundedScalarString(args.name, 1, 255)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.range.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set([
        'layerLocator', 'inPoint', 'duration', 'idempotencyKey',
      ]), ['layerLocator', 'inPoint', 'duration', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isTimeInput(args.inPoint, -2147483648)
          || !isTimeInput(args.duration, 1)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.start-time.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['layerLocator', 'startTime', 'idempotencyKey']),
        ['layerLocator', 'startTime', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isTimeInput(args.startTime, -2147483648)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.stretch.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['layerLocator', 'stretch', 'idempotencyKey']),
        ['layerLocator', 'stretch', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isLayerStretchInput(args.stretch)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.order.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set([
        'layerLocator', 'targetStackIndex', 'idempotencyKey',
      ]), ['layerLocator', 'targetStackIndex', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !Number.isSafeInteger(args.targetStackIndex) || args.targetStackIndex < 1
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.parent.set') {
      const args = params.arguments;
      const parent = args.parentLayerLocator;
      if (!exactKeys(args, new Set([
        'layerLocator', 'parentLayerLocator', 'idempotencyKey',
      ]), ['layerLocator', 'parentLayerLocator', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || (parent !== null && (!isLocatorShape(parent, ['layer'])
            || !sameLocatorContext(args.layerLocator, parent)
            || parent.objectId === args.layerLocator.objectId))
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.duplicate') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['layerLocator', 'newName', 'idempotencyKey']),
        ['layerLocator', 'newName', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isBoundedScalarString(args.newName, 1, 255)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.compositing.read') {
      const args = params.arguments;
      if (!exactKeys(args, new Set(['layerLocator']), ['layerLocator'])
          || !isLocatorShape(args.layerLocator, ['layer'])) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.switch.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set([
        'layerLocator', 'switch', 'enabled', 'idempotencyKey',
      ]), ['layerLocator', 'switch', 'enabled', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !LAYER_SWITCHES.includes(args.switch)
          || typeof args.enabled !== 'boolean'
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.quality.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set([
        'layerLocator', 'quality', 'idempotencyKey',
      ]), ['layerLocator', 'quality', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !LAYER_QUALITIES.includes(args.quality)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else if (params.capabilityId === 'ae.layer.blending-mode.set') {
      const args = params.arguments;
      if (!exactKeys(args, new Set([
        'layerLocator', 'mode', 'idempotencyKey',
      ]), ['layerLocator', 'mode', 'idempotencyKey'])
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !LAYER_BLENDING_MODES.includes(args.mode)
          || !isIdempotencyKey(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    } else {
      const args = params.arguments;
      if (!exactKeys(
        args,
        new Set(['layerLocator', 'propertyLocator', 'value', 'idempotencyKey']),
        ['layerLocator', 'propertyLocator', 'value', 'idempotencyKey'],
      )
          || !isLocatorShape(args.layerLocator, ['layer'])
          || !isLocatorShape(args.propertyLocator, ['stream'])
          || !sameLocatorContext(args.layerLocator, args.propertyLocator)
          || !validatePrimitivePropertyValue(args.value)
          || typeof args.idempotencyKey !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(args.idempotencyKey)) {
        return { ok: false, errorCode: 'INVALID_ARGUMENT' };
      }
    }
    return { ok: true };
  }
  if (message.method === 'invalidateGraph') {
    const params = message.params;
    if (!exactKeys(params, new Set(['reason']), ['reason']) || params.reason !== 'cep-jsx') {
      return { ok: false, errorCode: 'INVALID_ARGUMENT' };
    }
    return { ok: true };
  }
  const params = message.params;
  if (!exactKeys(params, new Set(['targetRequestId']), ['targetRequestId'])
      || !REQUEST_ID.test(params.targetRequestId)) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
  return { ok: true };
}

export function validateRequestComposite(message, schema) {
  try {
    if (!schemaAccepts(schema?.$defs?.request, message, schema)) {
      return { ok: false, errorCode: 'INVALID_REQUEST' };
    }
    return classifyRequest(message);
  } catch (error) {
    return { ok: false, errorCode: error.code ?? 'INVALID_REQUEST' };
  }
}

export function decodeAndClassifyRequest(frame, schema) {
  try {
    const message = decodeFrame(frame);
    const classification = validateRequestComposite(message, schema);
    return classification.ok === true ? { ok: true, message } : classification;
  } catch (error) {
    return { ok: false, errorCode: error.code ?? 'INVALID_REQUEST' };
  }
}

export function validateResponseShape(message, schema) {
  return schemaAccepts(schema?.$defs?.response, message, schema);
}

export function validateProgressEventShape(message, schema) {
  return schemaAccepts(schema?.$defs?.progressEvent, message, schema);
}

function decodeAndValidateShape(frame, schema, definition) {
  try {
    const message = decodeFrame(frame);
    if (!schemaAccepts(schema?.$defs?.[definition], message, schema)) {
      return { ok: false, errorCode: 'INVALID_REQUEST' };
    }
    return { ok: true, message };
  } catch (error) {
    return { ok: false, errorCode: error.code ?? 'INVALID_REQUEST' };
  }
}

export function decodeAndValidateResponse(frame, schema) {
  return decodeAndValidateShape(frame, schema, 'response');
}

export function decodeAndValidateProgressEvent(frame, schema) {
  return decodeAndValidateShape(frame, schema, 'progressEvent');
}

export function validateErrorPolicy(error, schema) {
  if (!schemaAccepts(schema?.$defs?.rpcError, error, schema)) return false;
  const expected = ERROR_POLICIES[error?.code];
  if (!expected) return false;
  const [retryable, sideEffect, action] = expected;
  const propertyPrecondition = error.code === 'PRECONDITION_FAILED'
    && (['ae.layer.property.set', 'ae.layer.property.keyframes.list',
      'ae.layer.property.keyframe.details.read'].includes(error.details?.capabilityId)
      || KEYFRAME_WRITE_CAPABILITIES.has(error.details?.capabilityId))
    && error.details?.field === 'params.arguments.propertyLocator'
    && error.recovery?.action === 'change-arguments';
  if (error.retryable !== retryable || error.sideEffect !== sideEffect
      || (error.recovery?.action !== action && !propertyPrecondition)) return false;
  if (error.code === 'QUEUE_FULL'
      && (!Number.isInteger(error.recovery.retryAfterMs) || error.recovery.retryAfterMs < 1)) return false;
  if (error.code !== 'QUEUE_FULL' && error.recovery.retryAfterMs !== undefined) return false;
  return true;
}

const CAPABILITY_DETAIL_ERRORS = new Set([
  'NATIVE_UNSUPPORTED',
  'PRECONDITION_FAILED',
  'STALE_LOCATOR',
  'CAPABILITY_FAILED',
  'POSSIBLY_SIDE_EFFECTING_FAILURE',
]);

export function validateFailureExchange(
  helloContext,
  request,
  response,
  descriptor = null,
  schema = helloContext?.schema,
) {
  if (request?.method === 'hello') return validateHelloFailure(request, response, schema);
  if (!validateHelloContext(helloContext, schema)
      || validateRequestComposite(request, schema).ok !== true
      || !validateResponseShape(response, schema)
      || response?.ok !== false || response.kind !== 'response' || response.replayed !== false
      || response.requestId !== request.requestId || response.method !== request.method
      || response.sessionId !== request.sessionId
      || request.sessionId !== helloContext.response.sessionId
      || response.wireVersion !== request.wireVersion || !validateErrorPolicy(response.error, schema)
      || response.error.code === 'WIRE_VERSION_MISMATCH') return false;
  const capabilityId = request.method === 'invoke' ? request.params.capabilityId : null;
  if (CAPABILITY_DETAIL_ERRORS.has(response.error.code)) {
    if (capabilityId === null || response.error.details?.capabilityId !== capabilityId) return false;
  } else if (response.error.details?.capabilityId !== undefined
      && response.error.details.capabilityId !== capabilityId) return false;
  if (response.error.code === 'STALE_LOCATOR'
      && (capabilityId === 'ae.project.items.list'
        || capabilityId === 'ae.composition.layers.list'
        || capabilityId === 'ae.composition.selected-layers.list'
        || capabilityId === 'ae.composition.time.read'
        || capabilityId === 'ae.composition.layer.create'
        || capabilityId === 'ae.layer.effect.apply'
        || capabilityId === 'ae.layer.properties.list'
        || capabilityId === 'ae.layer.property.keyframes.list'
        || capabilityId === 'ae.layer.property.set'
        || capabilityId === 'ae.layer.property.keyframe.details.read'
        || KEYFRAME_WRITE_CAPABILITIES.has(capabilityId)
        || LAYER_COMPOSITING_SPECS.some((spec) => spec.id === capabilityId)
        || LAYER_TIMELINE_SPECS.some((spec) => spec.id === capabilityId))) {
    const expectedFields = capabilityId === 'ae.project.items.list'
      ? new Set(['params.arguments.projectLocator'])
      : capabilityId === 'ae.composition.layers.list'
          || capabilityId === 'ae.composition.selected-layers.list'
          || capabilityId === 'ae.composition.time.read'
          || capabilityId === 'ae.composition.layer.create'
        ? new Set(['params.arguments.compositionLocator'])
        : capabilityId === 'ae.layer.property.set' || KEYFRAME_WRITE_CAPABILITIES.has(capabilityId)
          ? new Set([
            'params.arguments.layerLocator',
            'params.arguments.propertyLocator',
          ])
          : capabilityId === 'ae.layer.property.keyframes.list'
              || capabilityId === 'ae.layer.property.keyframe.details.read'
            ? new Set(['params.arguments.propertyLocator'])
          : capabilityId === 'ae.layer.effect.apply'
            ? new Set(['params.arguments.layerLocator'])
          : LAYER_COMPOSITING_SPECS.some((spec) => spec.id === capabilityId)
            ? new Set(['params.arguments.layerLocator'])
          : LAYER_TIMELINE_SPECS.some((spec) => spec.id === capabilityId)
            ? new Set([
              'params.arguments.layerLocator',
              ...(capabilityId === 'ae.layer.parent.set'
                && request.params.arguments.parentLayerLocator !== null
                ? ['params.arguments.parentLayerLocator'] : []),
            ])
          : new Set([
            'params.arguments.layerLocator',
            ...(request.params.arguments.parentPropertyLocator
              ? ['params.arguments.parentPropertyLocator'] : []),
          ]);
    const currentGeneration = response.error.details?.currentGeneration;
    if (!expectedFields.has(response.error.details?.field)
        || (currentGeneration !== undefined
          && (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1))
        || (capabilityId === 'ae.project.items.list'
          && request.params.arguments.projectLocator === undefined)) return false;
  }
  if (descriptor !== null && (descriptor.id !== capabilityId
      || descriptor.version !== request.params.capabilityVersion)) return false;
  return true;
}

export function validateHelloExchange(request, response, schema) {
  if (validateRequestComposite(request, schema).ok !== true || request.method !== 'hello'
      || !validateResponseShape(response, schema)) return false;
  if (!response?.ok || !isPlainObject(response.result) || !isPlainObject(response.result.host)
      || !isPlainObject(response.result.compiledSdk)
      || response.kind !== 'response' || response.method !== 'hello'
      || response.requestId !== request.requestId || response.replayed !== false) return false;
  if (response.sessionId !== response.result?.sessionId
      || response.result.clientNonce !== request.params.nonce) return false;
  const selected = selectWireVersion(request.params.supportedWireVersions, { minimum: 1, maximum: 1 });
  if (selected === null || response.result.selectedWireVersion !== selected
      || response.wireVersion !== selected) return false;
  const { platform } = response.result.host;
  const { architecture } = response.result.compiledSdk;
  return (platform === 'macos-arm64' && architecture === 'arm64')
    || (platform === 'windows-x64' && architecture === 'x86_64');
}

export function validateHelloFailure(request, response, schema) {
  if (validateRequestComposite(request, schema).ok !== true || request.method !== 'hello'
      || !validateResponseShape(response, schema)) return false;
  if (response?.ok !== false || response.kind !== 'response' || response.method !== 'hello'
      || response.requestId !== request.requestId || response.sessionId !== undefined
      || response.wireVersion !== request.wireVersion || response.replayed !== false
      || !validateErrorPolicy(response.error, schema)) return false;
  if (response.error.code === 'WIRE_VERSION_MISMATCH') {
    const supported = response.error.details?.supportedWireVersions;
    if (!supported) return false;
    try {
      return selectWireVersion(request.params.supportedWireVersions, supported) === null;
    } catch {
      return false;
    }
  }
  return ['NATIVE_UNAVAILABLE', 'INVALID_REQUEST', 'INVALID_ARGUMENT'].includes(response.error.code);
}

function validateHelloContext(context, schemaOverride = undefined) {
  const schema = schemaOverride ?? context?.schema;
  return isPlainObject(context) && isPlainObject(context.request) && isPlainObject(context.response)
    && validateHelloExchange(context.request, context.response, schema);
}

export function projectSummaryContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.projectSummaryInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.projectSummaryResultSchemaContract.const);
  return sha256Jcs({
    inputSchema,
    resultSchema,
  });
}

export function projectBitDepthReadContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.projectBitDepthReadInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.projectBitDepthReadResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function projectBitDepthSetContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.projectBitDepthSetInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.projectBitDepthSetResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function projectItemsListContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.projectItemsListInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.projectItemsListResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function compositionLayersListContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.compositionLayersListInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.compositionLayersListResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function compositionSelectedLayersListContractDigest(schema) {
  return compositionLayersListContractDigest(schema);
}

export function compositionTimeReadContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.compositionTimeReadInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.compositionTimeReadResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function compositionTimeSetContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.compositionTimeSetInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.compositionTimeSetResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function compositionCreateContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.compositionCreateInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.compositionCreateResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function compositionLayerCreateContractDigest(schema) {
  const inputSchema = structuredClone(
    schema.$defs.compositionLayerCreateInputSchemaContract.const,
  );
  const resultSchema = structuredClone(
    schema.$defs.compositionLayerCreateResultSchemaContract.const,
  );
  return sha256Jcs({ inputSchema, resultSchema });
}

export function layerEffectApplyContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.layerEffectApplyInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.layerEffectApplyResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function layerPropertiesListContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.layerPropertiesListInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.layerPropertiesListResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function layerPropertyKeyframesListContractDigest(schema) {
  const inputSchema = structuredClone(
    schema.$defs.layerPropertyKeyframesListInputSchemaContract.const,
  );
  const resultSchema = structuredClone(
    schema.$defs.layerPropertyKeyframesListResultSchemaContract.const,
  );
  return sha256Jcs({ inputSchema, resultSchema });
}

export function layerPropertySetContractDigest(schema) {
  const inputSchema = structuredClone(schema.$defs.layerPropertySetInputSchemaContract.const);
  const resultSchema = structuredClone(schema.$defs.layerPropertySetResultSchemaContract.const);
  return sha256Jcs({ inputSchema, resultSchema });
}

export function capabilityDigest(items) {
  return sha256Jcs(items);
}

export function projectSummaryDescriptor(schema) {
  const registration = INVOKE_REGISTRY[0];
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'Read bounded facts about the active After Effects project.',
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads project state without modifying it.',
    preconditions: [],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: projectSummaryContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.projectSummaryInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.projectSummaryResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.project-read',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-project-summary-empty',
        kind: 'positive',
        summary: 'Read a bounded summary when no project content exists.',
        arguments: {},
        expected: {
          outcome: 'succeeded',
          value: { projectOpen: false, projectName: 'SYNTHETIC_EXAMPLE', itemCount: 0 },
        },
      },
      {
        id: 'aemcp-example-project-summary-unavailable',
        kind: 'negative',
        summary: 'Return a typed unavailable error before native dispatch.',
        arguments: {},
        expected: { errorCode: 'NATIVE_UNAVAILABLE', recoveryAction: 'reconnect' },
      },
    ],
  };
}

export function projectBitDepthReadDescriptor(schema) {
  const registration = INVOKE_REGISTRY[1];
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: "Read the open After Effects project's bit depth.",
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads project bit depth without changing After Effects state.',
    preconditions: ['An After Effects project must be open.'],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: projectBitDepthReadContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.projectBitDepthReadInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.projectBitDepthReadResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.project-bit-depth-read',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-project-bit-depth-read',
        kind: 'positive',
        summary: 'Read the project bits per channel.',
        arguments: {},
        expected: { outcome: 'succeeded', value: { bitsPerChannel: 16 } },
      },
      {
        id: 'aemcp-example-project-bit-depth-read-no-project',
        kind: 'negative',
        summary: 'Require an open project before reading bit depth.',
        arguments: {},
        expected: { errorCode: 'PRECONDITION_FAILED', recoveryAction: 'open-project' },
      },
    ],
  };
}

export function projectBitDepthSetDescriptor(schema) {
  const registration = INVOKE_REGISTRY[2];
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: "Set the open After Effects project's bit depth.",
    risk: 'write',
    mutability: 'mutating',
    idempotency: 'idempotency-key',
    cancellation: 'before-dispatch',
    undo: 'ae-undo-group',
    sideEffectSummary: 'Changes project bit depth and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'targetDepth must differ from the current project bit depth.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: projectBitDepthSetContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.projectBitDepthSetInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.projectBitDepthSetResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.project-bit-depth-set',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-project-bit-depth-set',
        kind: 'positive',
        summary: 'Change the project from 8 to 16 bits per channel.',
        arguments: { idempotencyKey: 'synthetic-bit-depth-0001', targetDepth: 16 },
        expected: {
          outcome: 'succeeded',
          value: {
            afterBitsPerChannel: 16,
            beforeBitsPerChannel: 8,
            changed: true,
          },
        },
      },
      {
        id: 'aemcp-example-project-bit-depth-no-change',
        kind: 'negative',
        summary: 'Reject a target that already matches the project bit depth.',
        arguments: { idempotencyKey: 'synthetic-bit-depth-0002', targetDepth: 16 },
        expected: { errorCode: 'INVALID_ARGUMENT', recoveryAction: 'change-arguments' },
      },
    ],
  };
}

function syntheticDescriptorLocator(kind, objectId) {
  return {
    kind,
    hostInstanceId: '22222222-2222-4222-8222-222222222222',
    sessionId: '11111111-1111-4111-8111-111111111111',
    projectId: '44444444-4444-4444-8444-444444444444',
    generation: 8,
    objectId,
  };
}

export function projectItemsListDescriptor(schema) {
  const registration = INVOKE_REGISTRY[3];
  const projectLocator = syntheticDescriptorLocator(
    'project', '77777777-7777-4777-8777-777777777777',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'List a bounded page of items in the open After Effects project.',
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads project items without changing After Effects state.',
    preconditions: ['An After Effects project must be open.'],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: projectItemsListContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.projectItemsListInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.projectItemsListResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.project-items-list',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-project-items-list-empty',
        kind: 'positive',
        summary: 'List the first bounded page of an empty project.',
        arguments: { offset: 0, limit: 25 },
        expected: {
          outcome: 'succeeded',
          value: {
            projectLocator,
            total: 0,
            offset: 0,
            limit: 25,
            returned: 0,
            hasMore: false,
            nextOffset: null,
            items: [],
          },
        },
      },
      {
        id: 'aemcp-example-project-items-list-no-project',
        kind: 'negative',
        summary: 'Require an open project before listing items.',
        arguments: { offset: 0, limit: 25 },
        expected: { errorCode: 'PRECONDITION_FAILED', recoveryAction: 'open-project' },
      },
    ],
  };
}

export function compositionLayersListDescriptor(schema) {
  const registration = INVOKE_REGISTRY[4];
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '66666666-6666-4666-8666-666666666666',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'List a bounded page of layers in one After Effects composition.',
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads composition layers without changing After Effects state.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.items.list@1.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: compositionLayersListContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.compositionLayersListInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.compositionLayersListResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.composition-layers-list',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-composition-layers-list-empty',
        kind: 'positive',
        summary: 'List the first bounded page of an empty composition.',
        arguments: { compositionLocator, offset: 0, limit: 25 },
        expected: {
          outcome: 'succeeded',
          value: {
            compositionLocator,
            compositionName: 'SYNTHETIC_COMPOSITION',
            total: 0,
            offset: 0,
            limit: 25,
            returned: 0,
            hasMore: false,
            nextOffset: null,
            layers: [],
          },
        },
      },
      {
        id: 'aemcp-example-composition-layers-list-stale',
        kind: 'negative',
        summary: 'Refresh a stale composition locator before listing layers.',
        arguments: { compositionLocator, offset: 0, limit: 25 },
        expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' },
      },
    ],
  };
}

export function compositionSelectedLayersListDescriptor(schema) {
  const registration = INVOKE_REGISTRY[5];
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '66666666-6666-4666-8666-666666666666',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'List a bounded page of selected layers in one After Effects composition.',
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads selected composition layers without changing After Effects state.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.items.list@1.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: compositionSelectedLayersListContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.compositionLayersListInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.compositionLayersListResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.composition-selected-layers-list',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-composition-selected-layers-list-empty',
        kind: 'positive',
        summary: 'List an empty selected-layer page for a composition.',
        arguments: { compositionLocator, offset: 0, limit: 25 },
        expected: {
          outcome: 'succeeded',
          value: {
            compositionLocator,
            compositionName: 'SYNTHETIC_COMPOSITION',
            total: 0,
            offset: 0,
            limit: 25,
            returned: 0,
            hasMore: false,
            nextOffset: null,
            layers: [],
          },
        },
      },
      {
        id: 'aemcp-example-composition-selected-layers-list-stale',
        kind: 'negative',
        summary: 'Refresh a stale composition locator before listing selected layers.',
        arguments: { compositionLocator, offset: 0, limit: 25 },
        expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' },
      },
    ],
  };
}

export function compositionTimeReadDescriptor(schema) {
  const registration = INVOKE_REGISTRY[6];
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '66666666-6666-4666-8666-666666666666',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'Read the current time of one After Effects composition.',
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads composition time without changing After Effects state.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.items.list@1.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: compositionTimeReadContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.compositionTimeReadInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.compositionTimeReadResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.composition-time-read',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-composition-time-read',
        kind: 'positive',
        summary: 'Read an exact rational current time from a composition.',
        arguments: { compositionLocator },
        expected: {
          outcome: 'succeeded',
          value: {
            compositionLocator,
            currentTime: { value: 3003, scale: 1000, secondsRational: '3003/1000' },
          },
        },
      },
      {
        id: 'aemcp-example-composition-time-read-stale',
        kind: 'negative',
        summary: 'Refresh a stale composition locator before reading current time.',
        arguments: { compositionLocator },
        expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' },
      },
    ],
  };
}

export function compositionTimeSetDescriptor(schema) {
  const registration = INVOKE_REGISTRY[7];
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '66666666-6666-4666-8666-666666666666',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'Set the current time of one After Effects composition.',
    risk: 'write',
    mutability: 'mutating',
    idempotency: 'idempotency-key',
    cancellation: 'before-dispatch',
    undo: 'ae-undo-group',
    sideEffectSummary: 'Changes composition current time and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.items.list@1.',
      "targetTime must differ from the composition's current time.",
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: compositionTimeSetContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.compositionTimeSetInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.compositionTimeSetResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.composition-time-set',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-composition-time-set',
        kind: 'positive',
        summary: 'Set and verify an exact rational composition time.',
        arguments: {
          compositionLocator,
          targetTime: { value: 1, scale: 1 },
          idempotencyKey: 'synthetic-comp-time-0001',
        },
        expected: {
          outcome: 'succeeded',
          value: {
            changed: true,
            compositionLocator,
            beforeTime: { value: 0, scale: 1, secondsRational: '0' },
            afterTime: { value: 1, scale: 1, secondsRational: '1' },
          },
        },
      },
      {
        id: 'aemcp-example-composition-time-set-stale',
        kind: 'negative',
        summary: 'Refresh a stale composition locator before setting current time.',
        arguments: {
          compositionLocator,
          targetTime: { value: 1, scale: 1 },
          idempotencyKey: 'synthetic-comp-time-0002',
        },
        expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' },
      },
    ],
  };
}

export function compositionCreateDescriptor(schema) {
  const registration = INVOKE_REGISTRY[8];
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '77777777-7777-4777-8777-777777777777',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'Create one root composition in After Effects.',
    risk: 'write',
    mutability: 'mutating',
    idempotency: 'idempotency-key',
    cancellation: 'before-dispatch',
    undo: 'ae-undo-group',
    sideEffectSummary: 'Creates one root composition and one After Effects Undo step.',
    preconditions: ['An After Effects project must be open.'],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: compositionCreateContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.compositionCreateInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.compositionCreateResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.composition-create',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-composition-create',
        kind: 'positive',
        summary: 'Create and verify one root composition with exact settings.',
        arguments: {
          name: 'SYNTHETIC_COMP',
          width: 1920,
          height: 1080,
          duration: { value: 5, scale: 1 },
          frameRate: { numerator: 24, denominator: 1 },
          pixelAspectRatio: { numerator: 1, denominator: 1 },
          idempotencyKey: 'synthetic-comp-create-0001',
        },
        expected: {
          outcome: 'succeeded',
          value: {
            changed: true,
            name: 'SYNTHETIC_COMP',
            compositionLocator,
            projectItemCountBefore: 1,
            projectItemCountAfter: 2,
            layerCount: 0,
            width: 1920,
            height: 1080,
            duration: { value: 5, scale: 1, secondsRational: '5' },
            frameRate: { numerator: 24, denominator: 1, rational: '24' },
            pixelAspectRatio: { numerator: 1, denominator: 1, rational: '1' },
          },
        },
      },
      {
        id: 'aemcp-example-composition-create-duplicate',
        kind: 'negative',
        summary: 'Inspect state when an idempotency key is already bound.',
        arguments: {
          name: 'SYNTHETIC_COMP',
          width: 1920,
          height: 1080,
          duration: { value: 5, scale: 1 },
          frameRate: { numerator: 24, denominator: 1 },
          pixelAspectRatio: { numerator: 1, denominator: 1 },
          idempotencyKey: 'synthetic-comp-create-0002',
        },
        expected: { errorCode: 'DUPLICATE_REQUEST', recoveryAction: 'inspect-state' },
      },
    ],
  };
}

export function compositionLayerCreateDescriptor(schema) {
  const registration = INVOKE_REGISTRY[9];
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '66666666-6666-4666-8666-666666666666',
  );
  const createdCompositionLocator = {
    ...compositionLocator,
    projectId: '55555555-5555-4555-8555-555555555555',
    generation: 9,
  };
  const layerLocator = {
    ...createdCompositionLocator,
    kind: 'layer',
    objectId: '99999999-9999-4999-8999-999999999999',
  };
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'Create one null or solid layer in an After Effects composition.',
    risk: 'write',
    mutability: 'mutating',
    idempotency: 'idempotency-key',
    cancellation: 'before-dispatch',
    undo: 'ae-undo-group',
    sideEffectSummary: 'Creates one composition layer, may create one solid project item, and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.items.list@1.',
      'kind must be null or solid and solid-only options require kind solid.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: compositionLayerCreateContractDigest(schema),
    inputSchema: structuredClone(
      schema.$defs.compositionLayerCreateInputSchemaContract.const,
    ),
    resultSchema: structuredClone(
      schema.$defs.compositionLayerCreateResultSchemaContract.const,
    ),
    requirements: [{
      id: 'aemcp.requirement.native.composition-layer-create',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-composition-layer-create-null',
        kind: 'positive',
        summary: 'Create and verify one named null layer with Undo available.',
        arguments: {
          compositionLocator,
          kind: 'null',
          name: 'SYNTHETIC_NULL',
          idempotencyKey: 'synthetic-layer-create-0001',
        },
        expected: {
          outcome: 'succeeded',
          value: {
            changed: true,
            kind: 'null',
            name: 'SYNTHETIC_NULL',
            stackIndex: 1,
            compositionLocator: createdCompositionLocator,
            layerLocator,
            sourceItemLocator: null,
            layerCountBefore: 0,
            layerCountAfter: 1,
            projectItemCountBefore: 2,
            projectItemCountAfter: 2,
            solid: null,
          },
        },
      },
      {
        id: 'aemcp-example-composition-layer-create-stale',
        kind: 'negative',
        summary: 'Refresh a stale composition locator before creating a layer.',
        arguments: {
          compositionLocator,
          kind: 'null',
          name: 'SYNTHETIC_NULL',
          idempotencyKey: 'synthetic-layer-create-0002',
        },
        expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' },
      },
    ],
  };
}

export function layerEffectApplyDescriptor(schema) {
  const registration = INVOKE_REGISTRY[10];
  const layerLocator = syntheticDescriptorLocator(
    'layer', '88888888-8888-4888-8888-888888888888',
  );
  const freshLayerLocator = {
    ...layerLocator,
    projectId: '55555555-5555-4555-8555-555555555555',
    generation: 9,
  };
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'Apply one installed After Effects effect to a layer by exact match name.',
    risk: 'write',
    mutability: 'mutating',
    idempotency: 'idempotency-key',
    cancellation: 'before-dispatch',
    undo: 'ae-undo-group',
    sideEffectSummary: 'Adds one installed effect to one layer and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'layerLocator must come from ae.composition.layers.list@1.',
      'effectMatchName must exactly identify one installed effect.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: layerEffectApplyContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.layerEffectApplyInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.layerEffectApplyResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.layer-effect-apply',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-layer-effect-apply',
        kind: 'positive',
        summary: 'Apply and verify one Slider Control effect with Undo available.',
        arguments: {
          layerLocator,
          effectMatchName: 'ADBE Slider Control',
          idempotencyKey: 'synthetic-effect-apply-0001',
        },
        expected: {
          outcome: 'succeeded',
          value: {
            changed: true,
            layerLocator: freshLayerLocator,
            name: 'Slider Control',
            matchName: 'ADBE Slider Control',
            effectIndex: 1,
            effectCountBefore: 0,
            effectCountAfter: 1,
            matchingEffectCountBefore: 0,
            matchingEffectCountAfter: 1,
          },
        },
      },
      {
        id: 'aemcp-example-layer-effect-apply-missing',
        kind: 'negative',
        summary: 'Reject a match name that does not identify an installed effect.',
        arguments: {
          layerLocator,
          effectMatchName: 'ADBE Missing Synthetic Effect',
          idempotencyKey: 'synthetic-effect-apply-0002',
        },
        expected: { errorCode: 'PRECONDITION_FAILED', recoveryAction: 'change-arguments' },
      },
    ],
  };
}

export function layerPropertiesListDescriptor(schema) {
  const registration = INVOKE_REGISTRY[11];
  const layerLocator = syntheticDescriptorLocator(
    'layer', '88888888-8888-4888-8888-888888888888',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'List a bounded page of direct properties on an After Effects layer or property group.',
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads layer properties and safe primitive values without changing After Effects state.',
    preconditions: [
      'An After Effects project must be open.',
      'layerLocator must come from ae.composition.layers.list@1.',
      'parentPropertyLocator must come from ae.layer.properties.list@1 for the same layer.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: layerPropertiesListContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.layerPropertiesListInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.layerPropertiesListResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.layer-properties-list',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-layer-properties-list-empty',
        kind: 'positive',
        summary: 'List the first bounded page of direct properties on a layer.',
        arguments: { layerLocator, offset: 0, limit: 25 },
        expected: {
          outcome: 'succeeded',
          value: {
            layerLocator,
            parentPropertyLocator: null,
            layerName: 'SYNTHETIC_LAYER',
            sampleTime: { value: 0, scale: 1, mode: 'comp-time' },
            total: 0,
            offset: 0,
            limit: 25,
            returned: 0,
            hasMore: false,
            nextOffset: null,
            properties: [],
          },
        },
      },
      {
        id: 'aemcp-example-layer-properties-list-stale',
        kind: 'negative',
        summary: 'Refresh stale layer and property locators before listing properties.',
        arguments: { layerLocator, offset: 0, limit: 25 },
        expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' },
      },
    ],
  };
}

export function layerPropertyKeyframesListDescriptor(schema) {
  const registration = INVOKE_REGISTRY[12];
  const propertyLocator = syntheticDescriptorLocator(
    'stream', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'List a bounded page of exact keyframes on one After Effects layer property.',
    risk: 'read',
    mutability: 'read-only',
    idempotency: 'idempotent',
    cancellation: 'before-dispatch',
    undo: 'not-applicable',
    sideEffectSummary: 'Reads native keyframe times, primitive values, and interpolation without changing After Effects state.',
    preconditions: [
      'An After Effects project must be open.',
      'propertyLocator must come from ae.layer.properties.list@1 in the current native session.',
      'The property must be a keyframeable primitive scalar, vector, or color leaf stream.',
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: layerPropertyKeyframesListContractDigest(schema),
    inputSchema: structuredClone(
      schema.$defs.layerPropertyKeyframesListInputSchemaContract.const,
    ),
    resultSchema: structuredClone(
      schema.$defs.layerPropertyKeyframesListResultSchemaContract.const,
    ),
    requirements: [{
      id: 'aemcp.requirement.native.layer-property-keyframes-list',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-layer-property-keyframes-list-empty',
        kind: 'positive',
        summary: 'Read an empty first keyframe page from a keyframeable property.',
        arguments: { propertyLocator, offset: 0, limit: 25 },
        expected: {
          outcome: 'succeeded',
          value: {
            propertyLocator,
            valueType: 'one-d',
            total: 0,
            offset: 0,
            limit: 25,
            returned: 0,
            hasMore: false,
            nextOffset: null,
            keyframes: [],
          },
        },
      },
      {
        id: 'aemcp-example-layer-property-keyframes-list-unsupported',
        kind: 'negative',
        summary: 'Reject a property whose native value cannot be represented safely.',
        arguments: { propertyLocator, offset: 0, limit: 25 },
        expected: { errorCode: 'PRECONDITION_FAILED', recoveryAction: 'change-arguments' },
      },
    ],
  };
}

export function layerPropertySetDescriptor(schema) {
  const registration = INVOKE_REGISTRY[13];
  const layerLocator = syntheticDescriptorLocator(
    'layer', '88888888-8888-4888-8888-888888888888',
  );
  const propertyLocator = syntheticDescriptorLocator(
    'stream', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  return {
    detail: 'full',
    id: registration.id,
    version: registration.version,
    schemaVersion: 1,
    summary: 'Set one non-keyframed primitive After Effects layer property value.',
    risk: 'write',
    mutability: 'mutating',
    idempotency: 'idempotency-key',
    cancellation: 'before-dispatch',
    undo: 'ae-undo-group',
    sideEffectSummary: 'Changes one primitive layer property and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'Both locators must come from ae.layer.properties.list@1 for the same layer.',
      'The property must be a non-keyframed scalar, vector, or color leaf stream.',
      "value must differ from the property's current sampled value.",
    ],
    compatibility: {
      status: 'unverified',
      intendedPlatforms: ['macos-arm64', 'windows-x64'],
    },
    inputContractId: registration.inputContractId,
    resultContractId: registration.resultContractId,
    contractDigest: layerPropertySetContractDigest(schema),
    inputSchema: structuredClone(schema.$defs.layerPropertySetInputSchemaContract.const),
    resultSchema: structuredClone(schema.$defs.layerPropertySetResultSchemaContract.const),
    requirements: [{
      id: 'aemcp.requirement.native.layer-property-set',
      contractVersion: 1,
    }],
    examples: [
      {
        id: 'aemcp-example-layer-property-set',
        kind: 'positive',
        summary: 'Change one non-keyframed scalar property with Undo available.',
        arguments: {
          layerLocator,
          propertyLocator,
          value: { kind: 'scalar', value: '40' },
          idempotencyKey: 'synthetic-property-0001',
        },
        expected: {
          outcome: 'succeeded',
          value: {
            changed: true,
            layerLocator,
            propertyLocator,
            valueType: 'one-d',
            beforeValue: { kind: 'scalar', value: '25' },
            afterValue: { kind: 'scalar', value: '40' },
          },
        },
      },
      {
        id: 'aemcp-example-layer-property-set-keyframed',
        kind: 'negative',
        summary: 'Reject a keyframed stream without changing After Effects state.',
        arguments: {
          layerLocator,
          propertyLocator,
          value: { kind: 'scalar', value: '40' },
          idempotencyKey: 'synthetic-property-0002',
        },
        expected: { errorCode: 'PRECONDITION_FAILED', recoveryAction: 'change-arguments' },
      },
    ],
  };
}

const PROJECT_COMPOSITION_SPECS = Object.freeze([
  Object.freeze({
    id: 'ae.project.context.read', schema: 'projectContextRead',
    summary: 'Read current After Effects project context and selected items.',
    risk: 'read', sideEffectSummary: 'Reads project context without changing After Effects state.',
    preconditions: ['An After Effects project must be open.'],
    requirementId: 'aemcp.requirement.native.project-context-read',
  }),
  Object.freeze({
    id: 'ae.project.item.metadata.read', schema: 'projectItemMetadataRead',
    summary: 'Read metadata and bounded type facts for one After Effects project item.',
    risk: 'read', sideEffectSummary: 'Reads project item metadata without changing After Effects state.',
    preconditions: [
      'An After Effects project must be open.',
      'itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.',
    ],
    requirementId: 'aemcp.requirement.native.project-item-metadata-read',
  }),
  Object.freeze({
    id: 'ae.composition.settings.read', schema: 'compositionSettingsRead',
    summary: 'Read exact settings for one After Effects composition.',
    risk: 'read', sideEffectSummary: 'Reads composition settings without changing After Effects state.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.context.read@1 or ae.project.items.list@1.',
    ],
    requirementId: 'aemcp.requirement.native.composition-settings-read',
  }),
  Object.freeze({
    id: 'ae.composition.work-area.set', schema: 'compositionWorkAreaSet',
    summary: 'Set the exact work area of one After Effects composition.',
    risk: 'write', sideEffectSummary: 'Changes one composition work area and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.context.read@1 or ae.project.items.list@1.',
      'start plus duration must fit within the composition duration.',
      'The requested work area must differ from the current work area.',
    ],
    requirementId: 'aemcp.requirement.native.composition-work-area-set',
  }),
  Object.freeze({
    id: 'ae.project.item.name.set', schema: 'projectItemNameSet',
    summary: 'Rename one After Effects project item.',
    risk: 'write', sideEffectSummary: 'Changes one project item name and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.',
      'name must differ from the current project item name.',
    ],
    requirementId: 'aemcp.requirement.native.project-item-name-set',
  }),
  Object.freeze({
    id: 'ae.project.item.comment.set', schema: 'projectItemCommentSet',
    summary: 'Set or clear one After Effects project item comment.',
    risk: 'write', sideEffectSummary: 'Changes one project item comment and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.',
      'comment must differ from the current project item comment.',
    ],
    requirementId: 'aemcp.requirement.native.project-item-comment-set',
  }),
  Object.freeze({
    id: 'ae.project.item.label.set', schema: 'projectItemLabelSet',
    summary: 'Set one numeric After Effects project item label slot.',
    risk: 'write', sideEffectSummary: 'Changes one project item label and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.',
      'labelId must differ from the current project item label.',
    ],
    requirementId: 'aemcp.requirement.native.project-item-label-set',
  }),
  Object.freeze({
    id: 'ae.composition.duplicate', schema: 'compositionDuplicate',
    summary: 'Duplicate one After Effects composition with an explicit new name.',
    risk: 'write', sideEffectSummary: 'Adds one composition and creates one After Effects Undo step.',
    preconditions: [
      'An After Effects project must be open.',
      'compositionLocator must come from ae.project.context.read@1 or ae.project.items.list@1.',
    ],
    requirementId: 'aemcp.requirement.native.composition-duplicate',
  }),
]);

function packageExample(spec) {
  const projectLocator = syntheticDescriptorLocator(
    'project', '55555555-5555-4555-8555-555555555555',
  );
  const itemLocator = syntheticDescriptorLocator(
    'item', '77777777-7777-4777-8777-777777777777',
  );
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '66666666-6666-4666-8666-666666666666',
  );
  const newCompositionLocator = {
    ...syntheticDescriptorLocator('composition', '88888888-8888-4888-8888-888888888888'),
    projectId: '55555555-5555-4555-8555-555555555555',
    generation: 9,
  };
  const exactTime = (value, scale = 1) => ({
    value, scale, secondsRational: scale === 1 ? String(value) : `${value}/${scale}`,
  });
  const settings = (name) => ({
    name, width: 1920, height: 1080,
    duration: exactTime(5), frameDuration: exactTime(1, 24),
    frameRate: { numerator: 24, denominator: 1, rational: '24' },
    pixelAspectRatio: { numerator: 1, denominator: 1, rational: '1' },
    workArea: { start: exactTime(0), duration: exactTime(5) },
    displayStartTime: exactTime(0), layerCount: 0,
  });
  const entries = {
    'ae.project.context.read': {
      arguments: { selectionOffset: 0, selectionLimit: 25 },
      value: { projectLocator, generation: 8, activeItem: null,
        mostRecentlyUsedComposition: null,
        selection: { total: 0, offset: 0, limit: 25, returned: 0,
          hasMore: false, nextOffset: null, items: [] } },
      action: 'open-project', errorCode: 'PRECONDITION_FAILED',
    },
    'ae.project.item.metadata.read': {
      arguments: { itemLocator },
      value: { itemLocator, name: 'SYNTHETIC_ITEM', type: 'footage',
        parentLocator: projectLocator, comment: '', labelId: 0 },
      action: 'refresh-locator', errorCode: 'STALE_LOCATOR',
    },
    'ae.composition.settings.read': {
      arguments: { compositionLocator },
      value: { compositionLocator, ...settings('SYNTHETIC_COMPOSITION') },
      action: 'refresh-locator', errorCode: 'STALE_LOCATOR',
    },
    'ae.composition.work-area.set': {
      arguments: { compositionLocator, start: { value: 0, scale: 1 },
        duration: { value: 4, scale: 1 }, idempotencyKey: 'synthetic-work-area-0001' },
      value: { changed: true, compositionLocator,
        beforeWorkArea: { start: exactTime(0), duration: exactTime(5) },
        afterWorkArea: { start: exactTime(0), duration: exactTime(4) } },
      action: 'refresh-locator', errorCode: 'STALE_LOCATOR',
    },
    'ae.project.item.name.set': {
      arguments: { itemLocator, name: 'SYNTHETIC_RENAMED',
        idempotencyKey: 'synthetic-item-name-0001' },
      value: { changed: true, itemLocator, beforeName: 'SYNTHETIC_ITEM',
        afterName: 'SYNTHETIC_RENAMED' },
      action: 'refresh-locator', errorCode: 'STALE_LOCATOR',
    },
    'ae.project.item.comment.set': {
      arguments: { itemLocator, comment: 'SYNTHETIC_COMMENT',
        idempotencyKey: 'synthetic-item-comment-0001' },
      value: { changed: true, itemLocator, beforeComment: '',
        afterComment: 'SYNTHETIC_COMMENT' },
      action: 'refresh-locator', errorCode: 'STALE_LOCATOR',
    },
    'ae.project.item.label.set': {
      arguments: { itemLocator, labelId: 3, idempotencyKey: 'synthetic-item-label-0001' },
      value: { changed: true, itemLocator, beforeLabelId: 0, afterLabelId: 3 },
      action: 'refresh-locator', errorCode: 'STALE_LOCATOR',
    },
    'ae.composition.duplicate': {
      arguments: { compositionLocator, newName: 'SYNTHETIC_COPY',
        idempotencyKey: 'synthetic-comp-duplicate-0001' },
      value: { changed: true,
        sourceCompositionLocator: { ...compositionLocator,
          projectId: '55555555-5555-4555-8555-555555555555', generation: 9,
          objectId: '77777777-7777-4777-8777-777777777777' },
        newCompositionLocator, projectItemCountBefore: 1, projectItemCountAfter: 2,
        sourceSettings: settings('SYNTHETIC_COMPOSITION'),
        newSettings: settings('SYNTHETIC_COPY') },
      action: 'refresh-locator', errorCode: 'STALE_LOCATOR',
    },
  };
  return entries[spec.id];
}

export function projectCompositionDescriptors(schema) {
  return PROJECT_COMPOSITION_SPECS.map((spec) => {
    const registration = INVOKE_REGISTRY.find((candidate) => candidate.id === spec.id);
    const example = packageExample(spec);
    const inputSchema = structuredClone(schema.$defs[`${spec.schema}InputSchemaContract`].const);
    const resultSchema = structuredClone(schema.$defs[`${spec.schema}ResultSchemaContract`].const);
    const stem = spec.id.replace(/^ae\./u, '').replaceAll('.', '-');
    return {
      detail: 'full', id: spec.id, version: 1, schemaVersion: 1,
      summary: spec.summary, risk: spec.risk,
      mutability: spec.risk === 'read' ? 'read-only' : 'mutating',
      idempotency: spec.risk === 'read' ? 'idempotent' : 'idempotency-key',
      cancellation: 'before-dispatch',
      undo: spec.risk === 'read' ? 'not-applicable' : 'ae-undo-group',
      sideEffectSummary: spec.sideEffectSummary,
      preconditions: [...spec.preconditions],
      compatibility: { status: 'unverified', intendedPlatforms: ['macos-arm64', 'windows-x64'] },
      inputContractId: registration.inputContractId,
      resultContractId: registration.resultContractId,
      contractDigest: sha256Jcs({ inputSchema, resultSchema }),
      inputSchema, resultSchema,
      requirements: [{ id: spec.requirementId, contractVersion: 1 }],
      examples: [
        { id: `aemcp-example-${stem}`, kind: 'positive',
          summary: 'Synthetic success demonstrates the typed result contract.',
          arguments: structuredClone(example.arguments),
          expected: { outcome: 'succeeded', value: structuredClone(example.value) } },
        { id: `aemcp-example-${stem}-stale`, kind: 'negative',
          summary: 'Synthetic failure exercises the documented recovery path.',
          arguments: structuredClone(example.arguments),
          expected: { errorCode: example.errorCode, recoveryAction: example.action } },
      ],
    };
  });
}

const LAYER_TIMELINE_SPECS = Object.freeze([
  Object.freeze({ id: 'ae.layer.details.read', schema: 'layerDetailsRead',
    summary: 'Read one After Effects layer and its exact timeline state.', risk: 'read',
    sideEffectSummary: 'Reads layer state without changing After Effects state.',
    preconditions: ['An After Effects project must be open.',
      'layerLocator must come from a current native layer listing.'],
    requirementId: 'aemcp.requirement.native.layer-details-read' }),
  Object.freeze({ id: 'ae.layer.name.set', schema: 'layerNameSet',
    summary: 'Rename one After Effects layer.', risk: 'write',
    sideEffectSummary: 'Changes one layer name and creates one After Effects Undo step.',
    preconditions: ['layerLocator must be current.', 'name must differ from the current name.'],
    requirementId: 'aemcp.requirement.native.layer-name-set' }),
  Object.freeze({ id: 'ae.layer.range.set', schema: 'layerRangeSet',
    summary: 'Set one layer in point and duration using exact rational time.', risk: 'write',
    sideEffectSummary: 'Changes one layer range and creates one After Effects Undo step.',
    preconditions: ['layerLocator must be current.',
      'The range must fit the composition and differ from the current range.'],
    requirementId: 'aemcp.requirement.native.layer-range-set' }),
  Object.freeze({ id: 'ae.layer.start-time.set', schema: 'layerStartTimeSet',
    summary: 'Set one layer start time using exact rational time.', risk: 'write',
    sideEffectSummary: 'Changes one layer start time and creates one After Effects Undo step.',
    preconditions: ['layerLocator must be current.', 'startTime must differ from the current start time.'],
    requirementId: 'aemcp.requirement.native.layer-start-time-set' }),
  Object.freeze({ id: 'ae.layer.stretch.set', schema: 'layerStretchSet',
    summary: 'Set one layer stretch as an exact signed ratio.', risk: 'write',
    sideEffectSummary: 'Changes one layer stretch and creates one After Effects Undo step.',
    preconditions: ['layerLocator must be current.', 'stretch must be nonzero and differ from the current stretch.'],
    requirementId: 'aemcp.requirement.native.layer-stretch-set' }),
  Object.freeze({ id: 'ae.layer.order.set', schema: 'layerOrderSet',
    summary: 'Move one layer to an explicit composition stack index.', risk: 'write',
    sideEffectSummary: 'Changes one layer stack position and creates one After Effects Undo step.',
    preconditions: ['layerLocator must be current.',
      'targetStackIndex must exist and differ from the current stack index.'],
    requirementId: 'aemcp.requirement.native.layer-order-set' }),
  Object.freeze({ id: 'ae.layer.parent.set', schema: 'layerParentSet',
    summary: 'Set or clear one layer parent.', risk: 'write',
    sideEffectSummary: 'Changes one layer parent and creates one After Effects Undo step.',
    preconditions: ['Both locators must be current and in the same composition.',
      'A layer cannot parent itself and the requested parent must differ from the current parent.'],
    requirementId: 'aemcp.requirement.native.layer-parent-set' }),
  Object.freeze({ id: 'ae.layer.duplicate', schema: 'layerDuplicate',
    summary: 'Duplicate one layer with an explicit new name.', risk: 'write',
    sideEffectSummary: 'Adds one layer and creates one After Effects Undo step.',
    preconditions: ['layerLocator must be current.'],
    requirementId: 'aemcp.requirement.native.layer-duplicate' }),
]);

function layerTimelineExample(spec) {
  const layerLocator = syntheticDescriptorLocator(
    'layer', '88888888-8888-4888-8888-888888888888',
  );
  const parentLayerLocator = syntheticDescriptorLocator(
    'layer', '99999999-9999-4999-8999-999999999999',
  );
  const compositionLocator = syntheticDescriptorLocator(
    'composition', '66666666-6666-4666-8666-666666666666',
  );
  const sourceItemLocator = syntheticDescriptorLocator(
    'item', '77777777-7777-4777-8777-777777777777',
  );
  const exactTime = (value, scale = 1) => ({
    value, scale, secondsRational: canonicalSecondsRational(value, scale),
  });
  const details = (locator = layerLocator, name = 'SYNTHETIC_LAYER') => ({
    layerLocator: locator, compositionLocator, stackIndex: 1, name, type: 'av',
    videoEnabled: true, isThreeD: false, locked: false,
    parentLocator: null, sourceItemLocator,
    inPoint: exactTime(0), duration: exactTime(5), startTime: exactTime(0),
    stretch: { numerator: 1, denominator: 1, rational: '1' },
  });
  const fresh = (locator) => ({
    ...locator, projectId: '55555555-5555-4555-8555-555555555555', generation: 9,
  });
  const newLayerLocator = fresh(syntheticDescriptorLocator(
    'layer', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ));
  const entries = {
    'ae.layer.details.read': { arguments: { layerLocator }, value: details(),
      errorCode: 'STALE_LOCATOR', action: 'refresh-locator' },
    'ae.layer.name.set': { arguments: { layerLocator, name: 'SYNTHETIC_RENAMED',
      idempotencyKey: 'synthetic-layer-name-0001' }, value: { changed: true, layerLocator,
      beforeName: 'SYNTHETIC_LAYER', afterName: 'SYNTHETIC_RENAMED' } },
    'ae.layer.range.set': { arguments: { layerLocator, inPoint: { value: 1, scale: 1 },
      duration: { value: 4, scale: 1 }, idempotencyKey: 'synthetic-layer-range-0001' },
      value: { changed: true, layerLocator, beforeInPoint: exactTime(0),
        beforeDuration: exactTime(5), afterInPoint: exactTime(1), afterDuration: exactTime(4) } },
    'ae.layer.start-time.set': { arguments: { layerLocator,
      startTime: { value: 1, scale: 1 }, idempotencyKey: 'synthetic-layer-start-0001' },
      value: { changed: true, layerLocator, beforeStartTime: exactTime(0),
        afterStartTime: exactTime(1) } },
    'ae.layer.stretch.set': { arguments: { layerLocator,
      stretch: { num: 2, den: 1 }, idempotencyKey: 'synthetic-layer-stretch-0001' },
      value: { changed: true, layerLocator,
        beforeStretch: { numerator: 1, denominator: 1, rational: '1' },
        afterStretch: { numerator: 2, denominator: 1, rational: '2' } } },
    'ae.layer.order.set': { arguments: { layerLocator, targetStackIndex: 2,
      idempotencyKey: 'synthetic-layer-order-0001' }, value: { changed: true, layerLocator,
      beforeStackIndex: 1, afterStackIndex: 2 } },
    'ae.layer.parent.set': { arguments: { layerLocator, parentLayerLocator,
      idempotencyKey: 'synthetic-layer-parent-0001' }, value: { changed: true, layerLocator,
      beforeParentLocator: null, afterParentLocator: parentLayerLocator } },
    'ae.layer.duplicate': { arguments: { layerLocator, newName: 'SYNTHETIC_COPY',
      idempotencyKey: 'synthetic-layer-duplicate-0001' }, value: { changed: true,
      sourceLayerLocator: fresh(layerLocator), newLayerLocator,
      compositionLocator: fresh(compositionLocator), layerCountBefore: 1, layerCountAfter: 2,
      newLayer: { ...details(newLayerLocator, 'SYNTHETIC_COPY'),
        compositionLocator: fresh(compositionLocator),
        sourceItemLocator: fresh(sourceItemLocator) } } },
  };
  const entry = entries[spec.id];
  return { errorCode: 'STALE_LOCATOR', action: 'refresh-locator', ...entry };
}

export function layerTimelineDescriptors(schema) {
  return LAYER_TIMELINE_SPECS.map((spec) => {
    const registration = INVOKE_REGISTRY.find((candidate) => candidate.id === spec.id);
    const example = layerTimelineExample(spec);
    const inputSchema = structuredClone(schema.$defs[`${spec.schema}InputSchemaContract`].const);
    const resultSchema = structuredClone(schema.$defs[`${spec.schema}ResultSchemaContract`].const);
    const stem = spec.id.replace(/^ae\./u, '').replaceAll('.', '-');
    return {
      detail: 'full', id: spec.id, version: 1, schemaVersion: 1,
      summary: spec.summary, risk: spec.risk,
      mutability: spec.risk === 'read' ? 'read-only' : 'mutating',
      idempotency: spec.risk === 'read' ? 'idempotent' : 'idempotency-key',
      cancellation: 'before-dispatch',
      undo: spec.risk === 'read' ? 'not-applicable' : 'ae-undo-group',
      sideEffectSummary: spec.sideEffectSummary,
      preconditions: [...spec.preconditions],
      compatibility: { status: 'unverified', intendedPlatforms: ['macos-arm64', 'windows-x64'] },
      inputContractId: registration.inputContractId,
      resultContractId: registration.resultContractId,
      contractDigest: sha256Jcs({ inputSchema, resultSchema }), inputSchema, resultSchema,
      requirements: [{ id: spec.requirementId, contractVersion: 1 }],
      examples: [
        { id: `aemcp-example-${stem}`, kind: 'positive',
          summary: 'Synthetic success demonstrates the typed result contract.',
          arguments: structuredClone(example.arguments),
          expected: { outcome: 'succeeded', value: structuredClone(example.value) } },
        { id: `aemcp-example-${stem}-stale`, kind: 'negative',
          summary: 'Synthetic failure exercises stale-locator recovery.',
          arguments: structuredClone(example.arguments),
          expected: { errorCode: example.errorCode, recoveryAction: example.action } },
      ],
    };
  });
}

const LAYER_COMPOSITING_SPECS = Object.freeze([
  Object.freeze({ id: 'ae.layer.compositing.read', schema: 'layerCompositingRead',
    summary: "Read one layer's render switches, quality, and compositing mode.", risk: 'read',
    postconditionKind: 'layer-compositing-read',
    sideEffectSummary: 'Reads layer state without changing After Effects state.',
    preconditions: ['layerLocator must identify a current native layer.'],
    requirementId: 'aemcp.requirement.native.layer-compositing-read' }),
  Object.freeze({ id: 'ae.layer.switch.set', schema: 'layerSwitchSet',
    summary: 'Set one allowlisted layer switch.', risk: 'write',
    postconditionKind: 'layer-switch-set',
    sideEffectSummary: 'Changes one layer switch and creates one After Effects Undo step.',
    preconditions: ['layerLocator must identify a current native layer.',
      'The requested value must differ from current state.'],
    requirementId: 'aemcp.requirement.native.layer-switch-set' }),
  Object.freeze({ id: 'ae.layer.quality.set', schema: 'layerQualitySet',
    summary: "Set one layer's rendering quality.", risk: 'write',
    postconditionKind: 'layer-quality-set',
    sideEffectSummary: 'Changes layer quality and creates one After Effects Undo step.',
    preconditions: ['layerLocator must identify a current native layer.',
      'The requested quality must differ from current state.'],
    requirementId: 'aemcp.requirement.native.layer-quality-set' }),
  Object.freeze({ id: 'ae.layer.blending-mode.set', schema: 'layerBlendingModeSet',
    summary: "Set one layer's allowlisted blending mode while preserving matte and alpha flags.",
    risk: 'write', postconditionKind: 'layer-blending-mode-set',
    sideEffectSummary: 'Changes layer blending mode and creates one After Effects Undo step.',
    preconditions: ['layerLocator must identify a current native layer.',
      'The requested mode must differ from current state.'],
    requirementId: 'aemcp.requirement.native.layer-blending-mode-set' }),
]);

function layerCompositingExample(spec) {
  const layerLocator = syntheticDescriptorLocator(
    'layer', '88888888-8888-4888-8888-888888888888',
  );
  const entries = {
    'ae.layer.compositing.read': {
      arguments: { layerLocator },
      value: { layerLocator, visibilityEnabled: true, solo: false, locked: false,
        shy: false, motionBlur: false, threeD: false, adjustment: false,
        quality: 'best', blendingMode: 'normal', preserveAlpha: false, trackMatte: 'none' },
    },
    'ae.layer.switch.set': {
      arguments: { layerLocator, switch: 'solo', enabled: true,
        idempotencyKey: 'synthetic-layer-switch-0001' },
      value: { changed: true, layerLocator, switch: 'solo',
        beforeEnabled: false, afterEnabled: true },
    },
    'ae.layer.quality.set': {
      arguments: { layerLocator, quality: 'draft',
        idempotencyKey: 'synthetic-layer-quality-0001' },
      value: { changed: true, layerLocator, beforeQuality: 'best', afterQuality: 'draft' },
    },
    'ae.layer.blending-mode.set': {
      arguments: { layerLocator, mode: 'multiply',
        idempotencyKey: 'synthetic-layer-blend-0001' },
      value: { changed: true, layerLocator, beforeMode: 'normal', afterMode: 'multiply',
        preserveAlpha: false, trackMatte: 'none' },
    },
  };
  return entries[spec.id];
}

export function layerCompositingDescriptors(schema) {
  return LAYER_COMPOSITING_SPECS.map((spec) => {
    const registration = INVOKE_REGISTRY.find((candidate) => candidate.id === spec.id);
    const example = layerCompositingExample(spec);
    const inputSchema = structuredClone(schema.$defs[`${spec.schema}InputSchemaContract`].const);
    const resultSchema = structuredClone(schema.$defs[`${spec.schema}ResultSchemaContract`].const);
    const stem = spec.id.replace(/^ae\./u, '').replaceAll('.', '-');
    return {
      detail: 'full', id: spec.id, version: 1, schemaVersion: 1,
      summary: spec.summary, risk: spec.risk,
      mutability: spec.risk === 'read' ? 'read-only' : 'mutating',
      idempotency: spec.risk === 'read' ? 'idempotent' : 'idempotency-key',
      cancellation: 'before-dispatch',
      undo: spec.risk === 'read' ? 'not-applicable' : 'ae-undo-group',
      sideEffectSummary: spec.sideEffectSummary, preconditions: [...spec.preconditions],
      compatibility: { status: 'unverified', intendedPlatforms: ['macos-arm64', 'windows-x64'] },
      inputContractId: registration.inputContractId,
      resultContractId: registration.resultContractId,
      contractDigest: sha256Jcs({ inputSchema, resultSchema }), inputSchema, resultSchema,
      requirements: [{ id: spec.requirementId, contractVersion: 1 }],
      examples: [
        { id: `aemcp-example-${stem}`, kind: 'positive',
          summary: 'Synthetic success demonstrates the typed result contract.',
          arguments: structuredClone(example.arguments),
          expected: { outcome: 'succeeded', value: structuredClone(example.value) } },
        { id: `aemcp-example-${stem}-stale`, kind: 'negative',
          summary: 'Synthetic failure exercises stale-locator recovery.',
          arguments: structuredClone(example.arguments),
          expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' } },
      ],
    };
  });
}

const KEYFRAME_AUTHORING_SPECS = Object.freeze([
  Object.freeze({ id: 'ae.layer.property.keyframe.details.read', kind: 'details',
    summary: 'Read one After Effects property keyframe by exact composition time.',
    sideEffectSummary: 'Reads one native keyframe without changing After Effects state.',
    preconditions: ['An After Effects project must be open.',
      'propertyLocator must identify a keyframed primitive leaf stream.',
      'A keyframe must exist at the exact requested composition time.'],
    requirementId: 'aemcp.requirement.native.layer-property-keyframe-details-read' }),
  Object.freeze({ id: 'ae.layer.property.keyframe.add', kind: 'value',
    summary: 'Add one After Effects property keyframe at exact composition time.',
    sideEffectSummary: 'Adds one native keyframe and creates one After Effects Undo step.',
    preconditions: ['Both locators must be current and identify one keyframeable primitive leaf stream.',
      'No keyframe may exist at the exact requested composition time.',
      'value must match the property value type.'],
    requirementId: 'aemcp.requirement.native.layer-property-keyframe-add' }),
  Object.freeze({ id: 'ae.layer.property.keyframe.value.set', kind: 'value',
    summary: 'Set one After Effects property keyframe value.',
    sideEffectSummary: 'Changes one native keyframe value and creates one After Effects Undo step.',
    preconditions: ['Both locators must be current and identify one keyframed primitive leaf stream.',
      'A keyframe must exist at the exact requested composition time.',
      'value must match the property value type and differ from the current value.'],
    requirementId: 'aemcp.requirement.native.layer-property-keyframe-value-set' }),
  Object.freeze({ id: 'ae.layer.property.keyframe.interpolation.set', kind: 'interpolation',
    summary: 'Set incoming and outgoing interpolation for one After Effects property keyframe.',
    sideEffectSummary: 'Changes one native keyframe interpolation and creates one After Effects Undo step.',
    preconditions: ['Both locators must be current and identify one keyframed primitive leaf stream.',
      'A keyframe must exist at the exact requested composition time.',
      'The requested interpolation pair must differ from the current pair.'],
    requirementId: 'aemcp.requirement.native.layer-property-keyframe-interpolation-set' }),
  Object.freeze({ id: 'ae.layer.property.keyframe.temporal-ease.set', kind: 'ease',
    summary: 'Set typed temporal ease dimensions for one After Effects property keyframe.',
    sideEffectSummary: 'Changes one native keyframe temporal ease and creates one After Effects Undo step.',
    preconditions: ['Both locators must be current and identify one keyframed primitive leaf stream.',
      'A keyframe must exist at the exact requested composition time.',
      "dimensions must cover the property's temporal dimensions in zero-based order and differ from current ease."],
    requirementId: 'aemcp.requirement.native.layer-property-keyframe-temporal-ease-set' }),
  Object.freeze({ id: 'ae.layer.property.keyframe.behavior.set', kind: 'behavior',
    summary: 'Set one behavior flag on an After Effects property keyframe.',
    sideEffectSummary: 'Changes one native keyframe behavior and creates one After Effects Undo step.',
    preconditions: ['Both locators must be current and identify one keyframed primitive leaf stream.',
      'A keyframe must exist at the exact requested composition time.',
      'The requested behavior state must be supported and differ from current state.'],
    requirementId: 'aemcp.requirement.native.layer-property-keyframe-behavior-set' }),
  Object.freeze({ id: 'ae.layer.property.keyframe.delete', kind: 'delete',
    summary: 'Delete one After Effects property keyframe at exact composition time.',
    sideEffectSummary: 'Deletes one native keyframe and creates one After Effects Undo step.',
    preconditions: ['Both locators must be current and identify one keyframed primitive leaf stream.',
      'A keyframe must exist at the exact requested composition time.'],
    requirementId: 'aemcp.requirement.native.layer-property-keyframe-delete' }),
]);

function keyframeLocatorSchema(kind) {
  return {
    type: 'object', additionalProperties: false,
    required: ['kind', 'hostInstanceId', 'sessionId', 'projectId', 'generation', 'objectId'],
    properties: {
      kind: { const: kind }, hostInstanceId: { type: 'string', pattern: UUID.source },
      sessionId: { type: 'string', pattern: UUID.source },
      projectId: { type: 'string', pattern: UUID.source },
      generation: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      objectId: { type: 'string', pattern: UUID.source },
    },
  };
}

function keyframeTimeInputSchema() {
  return { type: 'object', additionalProperties: false, required: ['value', 'scale'],
    properties: { value: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
      scale: { type: 'integer', minimum: 1, maximum: 4294967295 } } };
}

function keyframeExactTimeSchema() {
  const result = keyframeTimeInputSchema();
  result.required.push('secondsRational');
  result.properties.secondsRational = { type: 'string', minLength: 1, maxLength: 28,
    pattern: '^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$' };
  return result;
}

function keyframeDecimalSchema() {
  return { type: 'string', minLength: 1, maxLength: 32,
    pattern: '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' };
}

function keyframePrimitiveSchema() {
  return { oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'value'],
      properties: { kind: { const: 'scalar' }, value: keyframeDecimalSchema() } },
    { type: 'object', additionalProperties: false, required: ['kind', 'components'],
      properties: { kind: { const: 'vector' }, components: { type: 'array', minItems: 2,
        maxItems: 3, items: keyframeDecimalSchema() } } },
    { type: 'object', additionalProperties: false,
      required: ['kind', 'alpha', 'red', 'green', 'blue'], properties: {
        kind: { const: 'color' }, alpha: keyframeDecimalSchema(), red: keyframeDecimalSchema(),
        green: keyframeDecimalSchema(), blue: keyframeDecimalSchema(),
      } },
  ] };
}

function keyframeEaseSchema() {
  return { type: 'object', additionalProperties: false, required: ['speed', 'influence'],
    properties: { speed: keyframeDecimalSchema(), influence: keyframeDecimalSchema() },
    'x-invariant': 'speed-and-influence-are-finite-and-influence-is-within-0-to-100' };
}

function keyframeEaseDimensionSchema() {
  return { type: 'object', additionalProperties: false,
    required: ['dimension', 'inEase', 'outEase'], properties: {
      dimension: { type: 'integer', minimum: 0, maximum: 3 },
      inEase: keyframeEaseSchema(), outEase: keyframeEaseSchema(),
    } };
}

function keyframeDetailsSchema() {
  return { type: 'object', additionalProperties: false,
    required: ['propertyLocator', 'time', 'temporalDimensionality', 'valueType', 'value',
      'inInterpolation', 'outInterpolation', 'temporalEaseDimensions', 'behaviors'],
    properties: {
      propertyLocator: keyframeLocatorSchema('stream'), time: keyframeExactTimeSchema(),
      temporalDimensionality: { type: 'integer', minimum: 1, maximum: 4 },
      valueType: { enum: ['one-d', 'two-d', 'two-d-spatial', 'three-d',
        'three-d-spatial', 'color'] }, value: keyframePrimitiveSchema(),
      inInterpolation: { enum: ['none', 'linear', 'bezier', 'hold'] },
      outInterpolation: { enum: ['none', 'linear', 'bezier', 'hold'] },
      temporalEaseDimensions: { type: 'array', minItems: 1, maxItems: 4,
        items: keyframeEaseDimensionSchema() },
      behaviors: { type: 'object', additionalProperties: false,
        required: ['temporalContinuous', 'temporalAutoBezier', 'spatialContinuous',
          'spatialAutoBezier', 'roving'], properties: {
          temporalContinuous: { type: 'boolean' }, temporalAutoBezier: { type: 'boolean' },
          spatialContinuous: { type: 'boolean' }, spatialAutoBezier: { type: 'boolean' },
          roving: { type: 'boolean' },
        } },
    },
    'x-invariant': 'value-matches-valueType-and-temporal-ease-dimensions-match-temporalDimensionality' };
}

function keyframeMutationSchema() {
  const details = keyframeDetailsSchema();
  return { type: 'object', additionalProperties: false,
    required: ['changed', 'layerLocator', 'propertyLocator', 'time', 'keyframeCountBefore',
      'keyframeCountAfter', 'beforeKeyframe', 'afterKeyframe'], properties: {
      changed: { const: true }, layerLocator: keyframeLocatorSchema('layer'),
      propertyLocator: keyframeLocatorSchema('stream'), time: keyframeExactTimeSchema(),
      keyframeCountBefore: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      keyframeCountAfter: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      beforeKeyframe: { oneOf: [{ type: 'null' }, details] },
      afterKeyframe: { oneOf: [{ type: 'null' }, details] },
    }, 'x-invariant': 'before-and-after-keyframes-are-bound-to-propertyLocator-and-time' };
}

function keyframeInputSchema(spec) {
  if (spec.kind === 'details') {
    return { type: 'object', additionalProperties: false, required: ['propertyLocator', 'time'],
      properties: { propertyLocator: keyframeLocatorSchema('stream'),
        time: keyframeTimeInputSchema() } };
  }
  const properties = { layerLocator: keyframeLocatorSchema('layer'),
    propertyLocator: keyframeLocatorSchema('stream'), time: keyframeTimeInputSchema(),
    idempotencyKey: { type: 'string', minLength: 16, maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' } };
  if (spec.kind === 'value') properties.value = keyframePrimitiveSchema();
  if (spec.kind === 'interpolation') {
    properties.inInterpolation = { enum: ['linear', 'bezier', 'hold'] };
    properties.outInterpolation = { enum: ['linear', 'bezier', 'hold'] };
  }
  if (spec.kind === 'ease') properties.dimensions = { type: 'array', minItems: 1,
    maxItems: 4, items: keyframeEaseDimensionSchema(),
    'x-invariant': 'dimensions-are-contiguous-and-zero-based' };
  if (spec.kind === 'behavior') {
    properties.behavior = { enum: ['temporal-continuous', 'temporal-auto-bezier',
      'spatial-continuous', 'spatial-auto-bezier', 'roving'] };
    properties.enabled = { type: 'boolean' };
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(properties),
    properties, 'x-invariant': 'layerLocator-and-propertyLocator-share-one-current-context' };
}

function keyframeDescriptorExample(spec) {
  const layerLocator = syntheticDescriptorLocator('layer', '88888888-8888-4888-8888-888888888888');
  const propertyLocator = syntheticDescriptorLocator('stream', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  const time = { value: 1, scale: 1 };
  const details = { propertyLocator, time: { ...time, secondsRational: '1' },
    temporalDimensionality: 1, valueType: 'one-d', value: { kind: 'scalar', value: '50' },
    inInterpolation: 'linear', outInterpolation: 'linear',
    temporalEaseDimensions: [{ dimension: 0, inEase: { speed: '0', influence: '33.333' },
      outEase: { speed: '0', influence: '33.333' } }],
    behaviors: { temporalContinuous: false, temporalAutoBezier: false,
      spatialContinuous: false, spatialAutoBezier: false, roving: false } };
  if (spec.kind === 'details') return { arguments: { propertyLocator, time }, value: details };
  const argumentsValue = { layerLocator, propertyLocator, time,
    idempotencyKey: 'synthetic-keyframe-0001' };
  if (spec.kind === 'value') argumentsValue.value = { kind: 'scalar', value: '50' };
  if (spec.kind === 'interpolation') Object.assign(argumentsValue,
    { inInterpolation: 'bezier', outInterpolation: 'bezier' });
  if (spec.kind === 'ease') argumentsValue.dimensions = structuredClone(details.temporalEaseDimensions);
  if (spec.kind === 'behavior') Object.assign(argumentsValue,
    { behavior: 'temporal-continuous', enabled: true });
  const value = { changed: true, layerLocator, propertyLocator,
    time: { ...time, secondsRational: '1' }, keyframeCountBefore: 1,
    keyframeCountAfter: 1, beforeKeyframe: details, afterKeyframe: details };
  if (spec.kind === 'value') Object.assign(value,
    { keyframeCountBefore: 0, keyframeCountAfter: 1, beforeKeyframe: null });
  if (spec.kind === 'delete') Object.assign(value,
    { keyframeCountBefore: 1, keyframeCountAfter: 0, afterKeyframe: null });
  return { arguments: argumentsValue, value };
}

export function keyframeAuthoringDescriptors() {
  return KEYFRAME_AUTHORING_SPECS.map((spec) => {
    const registration = INVOKE_REGISTRY.find((candidate) => candidate.id === spec.id);
    const example = keyframeDescriptorExample(spec);
    const inputSchema = keyframeInputSchema(spec);
    const resultSchema = spec.kind === 'details' ? keyframeDetailsSchema() : keyframeMutationSchema();
    return { detail: 'full', id: spec.id, version: 1, schemaVersion: 1,
      summary: spec.summary, risk: spec.kind === 'details' ? 'read' : 'write',
      mutability: spec.kind === 'details' ? 'read-only' : 'mutating',
      idempotency: spec.kind === 'details' ? 'idempotent' : 'idempotency-key',
      cancellation: 'before-dispatch',
      undo: spec.kind === 'details' ? 'not-applicable' : 'ae-undo-group',
      sideEffectSummary: spec.sideEffectSummary, preconditions: [...spec.preconditions],
      compatibility: { status: 'unverified', intendedPlatforms: ['macos-arm64', 'windows-x64'] },
      inputContractId: registration.inputContractId, resultContractId: registration.resultContractId,
      contractDigest: sha256Jcs({ inputSchema, resultSchema }), inputSchema, resultSchema,
      requirements: [{ id: spec.requirementId, contractVersion: 1 }],
      examples: [
        { id: 'aemcp-example-keyframe-positive', kind: 'positive',
          summary: 'Synthetic success demonstrates the typed result contract.',
          arguments: structuredClone(example.arguments),
          expected: { outcome: 'succeeded', value: structuredClone(example.value) } },
        { id: 'aemcp-example-keyframe-stale', kind: 'negative',
          summary: 'Synthetic failure exercises the documented recovery path.',
          arguments: structuredClone(example.arguments),
          expected: { errorCode: 'STALE_LOCATOR', recoveryAction: 'refresh-locator' } },
      ] };
  });
}

export function nativeCapabilityRegistry(schema) {
  return [
    projectSummaryDescriptor(schema),
    projectBitDepthReadDescriptor(schema),
    projectBitDepthSetDescriptor(schema),
    projectItemsListDescriptor(schema),
    compositionLayersListDescriptor(schema),
    compositionSelectedLayersListDescriptor(schema),
    compositionTimeReadDescriptor(schema),
    compositionTimeSetDescriptor(schema),
    compositionCreateDescriptor(schema),
    compositionLayerCreateDescriptor(schema),
    layerEffectApplyDescriptor(schema),
    layerPropertiesListDescriptor(schema),
    layerPropertyKeyframesListDescriptor(schema),
    layerPropertySetDescriptor(schema),
    ...projectCompositionDescriptors(schema),
    ...layerTimelineDescriptors(schema),
    ...layerCompositingDescriptors(schema),
    ...keyframeAuthoringDescriptors(schema),
  ];
}

export function capabilityQueryDigest(request) {
  if (classifyRequest(request).ok !== true || request.method !== 'capabilities') {
    fail('INVALID_ARGUMENT', 'invalid capabilities request');
  }
  return sha256Jcs({
    sessionId: request.sessionId,
    ids: request.params.ids ?? null,
    detail: request.params.detail ?? 'summary',
    limit: request.params.limit ?? 50,
  });
}

function summarizeDescriptor(descriptor) {
  const summary = structuredClone(descriptor);
  summary.detail = 'summary';
  for (const key of [
    'inputContractId', 'resultContractId', 'contractDigest', 'inputSchema', 'resultSchema',
    'requirements', 'examples',
  ]) delete summary[key];
  return summary;
}

export function postconditionDigest(result) {
  return sha256Jcs({
    capabilityId: result.capabilityId,
    capabilityVersion: result.capabilityVersion,
    value: result.value,
  });
}

function validatePageMetadata(value, args, entriesKey) {
  const entries = value?.[entriesKey];
  if (!Array.isArray(entries)
      || value.offset !== args.offset || value.limit !== args.limit
      || value.returned !== entries.length || value.returned > value.limit) return false;
  const endOffset = value.offset + value.returned;
  if (!Number.isSafeInteger(endOffset) || value.total < endOffset) return false;
  const expectedHasMore = endOffset < value.total;
  return value.hasMore === expectedHasMore
    && (expectedHasMore
      ? value.returned > 0 && value.nextOffset === endOffset
      : value.nextOffset === null);
}

function locatorContext(locator) {
  return {
    hostInstanceId: locator.hostInstanceId,
    sessionId: locator.sessionId,
    projectId: locator.projectId,
    generation: locator.generation,
  };
}

const DECIMAL_WIRE_VALUE = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE][+-]?[0-9]+)?$/;

function validateDecimalWireValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32) return false;
  const match = DECIMAL_WIRE_VALUE.exec(value);
  if (!match) return false;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return false;
  if (numeric === 0) {
    const isTextualZero = !/[1-9]/.test(`${match[2]}${match[3] ?? ''}`);
    if (match[1] === '-' || !isTextualZero) return false;
  }
  return true;
}

function validatePrimitivePropertyValue(value) {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'scalar') {
    return exactKeys(value, new Set(['kind', 'value']), ['kind', 'value'])
      && validateDecimalWireValue(value.value);
  }
  if (value.kind === 'vector') {
    return exactKeys(value, new Set(['kind', 'components']), ['kind', 'components'])
      && Array.isArray(value.components)
      && [2, 3].includes(value.components.length)
      && value.components.every(validateDecimalWireValue);
  }
  if (value.kind === 'color') {
    return exactKeys(
      value,
      new Set(['kind', 'alpha', 'red', 'green', 'blue']),
      ['kind', 'alpha', 'red', 'green', 'blue'],
    ) && ['alpha', 'red', 'green', 'blue']
      .every((component) => validateDecimalWireValue(value[component]));
  }
  return false;
}

function primitivePropertyValuesEqual(left, right) {
  if (!validatePrimitivePropertyValue(left)
      || !validatePrimitivePropertyValue(right)
      || left.kind !== right.kind) return false;
  const decimalEqual = (first, second) => Number(first) === Number(second);
  if (left.kind === 'scalar') return decimalEqual(left.value, right.value);
  if (left.kind === 'vector') {
    return left.components.length === right.components.length
      && left.components.every(
        (component, index) => decimalEqual(component, right.components[index]),
      );
  }
  return ['alpha', 'red', 'green', 'blue']
    .every((component) => decimalEqual(left[component], right[component]));
}

function validateSampledPropertyValue(property) {
  const value = property.value;
  if (property.valueType === 'one-d') {
    return value?.kind === 'scalar' && validateDecimalWireValue(value.value);
  }
  if (property.valueType === 'two-d' || property.valueType === 'two-d-spatial'
      || property.valueType === 'three-d' || property.valueType === 'three-d-spatial') {
    const expectedArity = property.valueType.startsWith('two-d') ? 2 : 3;
    return value?.kind === 'vector' && Array.isArray(value.components)
      && value.components.length === expectedArity
      && value.components.every(validateDecimalWireValue);
  }
  if (property.valueType === 'color') {
    return value?.kind === 'color'
      && ['alpha', 'red', 'green', 'blue'].every(
        (component) => validateDecimalWireValue(value[component]),
      );
  }
  return false;
}

function validateLayerProperty(property, value, context, seenObjectIds, index, schema) {
  if (!validateLocator(property.propertyLocator, context, schema)
      || property.propertyLocator.kind !== 'stream'
      || property.propertyIndex !== value.offset + index + 1
      || seenObjectIds.has(property.propertyLocator.objectId)
      || (value.parentPropertyLocator !== null
        && property.propertyLocator.objectId === value.parentPropertyLocator.objectId)) return false;
  seenObjectIds.add(property.propertyLocator.objectId);

  if (property.groupingType === 'named-group' || property.groupingType === 'indexed-group') {
    return property.valueType === 'none' && property.valueStatus === 'group'
      && property.value === null && property.canVaryOverTime === null
      && property.timeVarying === null;
  }
  if (property.groupingType !== 'leaf' || property.childCount !== 0) return false;
  if (property.valueStatus === 'sampled') {
    return typeof property.canVaryOverTime === 'boolean'
      && typeof property.timeVarying === 'boolean'
      && validateSampledPropertyValue(property);
  }
  if (property.valueStatus === 'no-data') {
    return property.valueType === 'none' && property.value === null;
  }
  if (property.valueStatus === 'unsupported') {
    return new Set([
      'arb', 'marker', 'layer-id', 'mask-id', 'mask', 'text-document', 'unknown',
    ])
      .has(property.valueType) && property.value === null;
  }
  return false;
}

function canonicalSecondsRational(value, scale) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(scale)
      || value < -2147483648 || value > 2147483647
      || scale < 1 || scale > 4294967295) return null;
  if (value === 0) return '0';
  const numerator = BigInt(value);
  const denominator = BigInt(scale);
  let left = numerator < 0n ? -numerator : numerator;
  let right = denominator;
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  const reducedNumerator = numerator / left;
  const reducedDenominator = denominator / left;
  return reducedDenominator === 1n
    ? String(reducedNumerator)
    : `${String(reducedNumerator)}/${String(reducedDenominator)}`;
}

function compositionTimesEqual(left, right) {
  if (canonicalSecondsRational(left?.value, left?.scale) === null
      || canonicalSecondsRational(right?.value, right?.scale) === null) return false;
  return BigInt(left.value) * BigInt(right.scale)
    === BigInt(right.value) * BigInt(left.scale);
}

function canonicalPositiveRatio(numerator, denominator) {
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 2147483647
      || !Number.isInteger(denominator) || denominator < 1
      || denominator > 2147483647) return null;
  const gcd = (left, right) => {
    let a = left;
    let b = right;
    while (b !== 0) [a, b] = [b, a % b];
    return a;
  };
  const divisor = gcd(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;
  return reducedDenominator === 1
    ? String(reducedNumerator)
    : `${reducedNumerator}/${reducedDenominator}`;
}

function positiveRatiosEqual(left, right) {
  return canonicalPositiveRatio(left?.numerator, left?.denominator) !== null
    && canonicalPositiveRatio(right?.numerator, right?.denominator) !== null
    && BigInt(left.numerator) * BigInt(right.denominator)
      === BigInt(right.numerator) * BigInt(left.denominator);
}

function validateExactTime(value) {
  return canonicalSecondsRational(value?.value, value?.scale) === value?.secondsRational;
}

function validatePositiveRatio(value) {
  return canonicalPositiveRatio(value?.numerator, value?.denominator) === value?.rational;
}

function canonicalSignedRatio(numerator, denominator) {
  if (!Number.isInteger(numerator) || numerator === 0
      || numerator < -2147483648 || numerator > 2147483647
      || !Number.isInteger(denominator) || denominator < 1
      || denominator > 2147483647) return null;
  const absolute = numerator < 0 ? -BigInt(numerator) : BigInt(numerator);
  let left = absolute;
  let right = BigInt(denominator);
  while (right !== 0n) [left, right] = [right, left % right];
  const reducedNumerator = BigInt(numerator) / left;
  const reducedDenominator = BigInt(denominator) / left;
  return reducedDenominator === 1n
    ? String(reducedNumerator)
    : `${String(reducedNumerator)}/${String(reducedDenominator)}`;
}

function validateSignedRatio(value) {
  return canonicalSignedRatio(value?.numerator, value?.denominator) === value?.rational;
}

function validateSettingsSnapshot(value) {
  return isPlainObject(value)
    && validateExactTime(value.duration)
    && validateExactTime(value.frameDuration)
    && validatePositiveRatio(value.frameRate)
    && validatePositiveRatio(value.pixelAspectRatio)
    && validateExactTime(value.workArea?.start)
    && validateExactTime(value.workArea?.duration)
    && validateExactTime(value.displayStartTime);
}

function validateProjectCompositionResult(request, result, helloContext, schema) {
  const id = request.params.capabilityId;
  const packageIds = new Set(PROJECT_COMPOSITION_SPECS.map((spec) => spec.id));
  if (!packageIds.has(id)) return true;
  const args = request.params.arguments;
  const value = result.value;
  const expectedKind = PROJECT_COMPOSITION_SPECS.find((spec) => spec.id === id).schema
    .replace(/([A-Z])/gu, '-$1').toLowerCase();
  if (result.evidence.postcondition.kind !== expectedKind) return false;
  const hostId = helloContext.response.result.host.instanceId;
  const locatorValid = (locator, kinds) => isLocatorShape(locator, kinds)
    && locator.hostInstanceId === hostId && locator.sessionId === request.sessionId
    && validateLocator(locator, locatorContext(locator), schema);

  if (id === 'ae.project.context.read') {
    if (!locatorValid(value.projectLocator, ['project'])
        || value.generation !== value.projectLocator.generation
        || value.selection.offset !== args.selectionOffset
        || value.selection.limit !== args.selectionLimit
        || !validatePageMetadata({ ...value.selection, selected: value.selection.items },
          { offset: args.selectionOffset, limit: args.selectionLimit }, 'selected')) return false;
    const context = locatorContext(value.projectLocator);
    const validEntry = (entry) => entry === null || (
      validateLocator(entry.locator, context, schema)
      && validateLocator(entry.parentLocator, context, schema)
      && (entry.type === 'composition') === (entry.locator.kind === 'composition')
    );
    return validEntry(value.activeItem)
      && validEntry(value.mostRecentlyUsedComposition)
      && (value.mostRecentlyUsedComposition === null
        || value.mostRecentlyUsedComposition.type === 'composition')
      && value.selection.items.every(validEntry);
  }

  if (id === 'ae.project.item.metadata.read') {
    if (!jsonDeepEqual(value.itemLocator, args.itemLocator)
        || !locatorValid(value.itemLocator, ['item', 'composition'])
        || value.parentLocator !== null
          && !validateLocator(value.parentLocator, locatorContext(value.itemLocator), schema)
        || (value.type === 'composition') !== (value.itemLocator.kind === 'composition')) return false;
    return (value.duration === undefined || validateExactTime(value.duration))
      && (value.pixelAspectRatio === undefined || validatePositiveRatio(value.pixelAspectRatio));
  }

  if (id === 'ae.composition.settings.read') {
    return jsonDeepEqual(value.compositionLocator, args.compositionLocator)
      && locatorValid(value.compositionLocator, ['composition'])
      && validateSettingsSnapshot(value);
  }

  if (id === 'ae.composition.work-area.set') {
    return value.changed === true
      && jsonDeepEqual(value.compositionLocator, args.compositionLocator)
      && locatorValid(value.compositionLocator, ['composition'])
      && validateExactTime(value.beforeWorkArea?.start)
      && validateExactTime(value.beforeWorkArea?.duration)
      && validateExactTime(value.afterWorkArea?.start)
      && validateExactTime(value.afterWorkArea?.duration)
      && compositionTimesEqual(value.afterWorkArea.start, args.start)
      && compositionTimesEqual(value.afterWorkArea.duration, args.duration)
      && (!compositionTimesEqual(value.beforeWorkArea.start, value.afterWorkArea.start)
        || !compositionTimesEqual(value.beforeWorkArea.duration, value.afterWorkArea.duration));
  }

  if (id === 'ae.project.item.name.set' || id === 'ae.project.item.comment.set') {
    const field = id === 'ae.project.item.name.set' ? 'Name' : 'Comment';
    return value.changed === true
      && jsonDeepEqual(value.itemLocator, args.itemLocator)
      && locatorValid(value.itemLocator, ['item', 'composition'])
      && value[`after${field}`] === args[field.toLowerCase()]
      && value[`before${field}`] !== value[`after${field}`];
  }

  if (id === 'ae.project.item.label.set') {
    return value.changed === true
      && jsonDeepEqual(value.itemLocator, args.itemLocator)
      && locatorValid(value.itemLocator, ['item', 'composition'])
      && value.afterLabelId === args.labelId
      && value.beforeLabelId !== value.afterLabelId;
  }

  const source = value.sourceCompositionLocator;
  const duplicate = value.newCompositionLocator;
  if (value.changed !== true
      || !locatorValid(source, ['composition']) || !locatorValid(duplicate, ['composition'])
      || source.hostInstanceId !== args.compositionLocator.hostInstanceId
      || source.sessionId !== args.compositionLocator.sessionId
      || source.projectId === args.compositionLocator.projectId
      || source.generation <= args.compositionLocator.generation
      || duplicate.objectId === source.objectId
      || !sameLocatorContext(source, duplicate)
      || value.projectItemCountAfter !== value.projectItemCountBefore + 1
      || !validateSettingsSnapshot(value.sourceSettings)
      || !validateSettingsSnapshot(value.newSettings)
      || value.newSettings.name !== args.newName) return false;
  return true;
}

function validateLayerTimelineResult(request, result, helloContext, schema) {
  const capabilityId = request.params.capabilityId;
  const spec = LAYER_TIMELINE_SPECS.find((candidate) => candidate.id === capabilityId);
  if (spec === undefined) return true;
  const args = request.params.arguments;
  const value = result.value;
  const expectedKind = spec.schema.replace(/([A-Z])/gu, '-$1').toLowerCase();
  if (result.evidence.postcondition.kind !== expectedKind) return false;
  const hostId = helloContext.response.result.host.instanceId;
  const locatorValid = (locator, kinds, context = locatorContext(locator)) => (
    isLocatorShape(locator, kinds)
    && locator.hostInstanceId === hostId
    && locator.sessionId === request.sessionId
    && validateLocator(locator, context, schema)
  );
  const nullableLocatorValid = (locator, kinds, context) => locator === null
    || locatorValid(locator, kinds, context);
  const detailsValid = (details, context) => (
    locatorValid(details.layerLocator, ['layer'], context)
    && locatorValid(details.compositionLocator, ['composition'], context)
    && nullableLocatorValid(details.parentLocator, ['layer'], context)
    && nullableLocatorValid(details.sourceItemLocator, ['item', 'composition'], context)
    && validateExactTime(details.inPoint)
    && validateExactTime(details.duration)
    && details.duration.value > 0
    && validateExactTime(details.startTime)
    && validateSignedRatio(details.stretch)
  );

  if (capabilityId === 'ae.layer.details.read') {
    const context = locatorContext(value.layerLocator);
    return jsonDeepEqual(value.layerLocator, args.layerLocator)
      && locatorValid(value.layerLocator, ['layer'], context)
      && detailsValid(value, context);
  }

  if (capabilityId === 'ae.layer.duplicate') {
    const context = locatorContext(value.newLayerLocator);
    return value.changed === true
      && value.sourceLayerLocator.objectId === args.layerLocator.objectId
      && value.sourceLayerLocator.objectId !== value.newLayerLocator.objectId
      && value.sourceLayerLocator.generation > args.layerLocator.generation
      && value.sourceLayerLocator.projectId !== args.layerLocator.projectId
      && sameLocatorContext(value.sourceLayerLocator, value.newLayerLocator)
      && sameLocatorContext(value.sourceLayerLocator, value.compositionLocator)
      && locatorValid(value.sourceLayerLocator, ['layer'], context)
      && locatorValid(value.newLayerLocator, ['layer'], context)
      && locatorValid(value.compositionLocator, ['composition'], context)
      && value.layerCountAfter === value.layerCountBefore + 1
      && jsonDeepEqual(value.newLayerLocator, value.newLayer.layerLocator)
      && jsonDeepEqual(value.compositionLocator, value.newLayer.compositionLocator)
      && value.newLayer.stackIndex <= value.layerCountAfter
      && value.newLayer.name === args.newName
      && detailsValid(value.newLayer, context);
  }

  const context = locatorContext(value.layerLocator);
  if (value.changed !== true
      || !jsonDeepEqual(value.layerLocator, args.layerLocator)
      || !locatorValid(value.layerLocator, ['layer'], context)) return false;
  if (capabilityId === 'ae.layer.name.set') {
    return value.afterName === args.name && value.beforeName !== value.afterName;
  }
  if (capabilityId === 'ae.layer.range.set') {
    return validateExactTime(value.beforeInPoint) && validateExactTime(value.beforeDuration)
      && validateExactTime(value.afterInPoint) && validateExactTime(value.afterDuration)
      && compositionTimesEqual(value.afterInPoint, args.inPoint)
      && compositionTimesEqual(value.afterDuration, args.duration)
      && (!compositionTimesEqual(value.beforeInPoint, value.afterInPoint)
        || !compositionTimesEqual(value.beforeDuration, value.afterDuration));
  }
  if (capabilityId === 'ae.layer.start-time.set') {
    return validateExactTime(value.beforeStartTime) && validateExactTime(value.afterStartTime)
      && compositionTimesEqual(value.afterStartTime, args.startTime)
      && !compositionTimesEqual(value.beforeStartTime, value.afterStartTime);
  }
  if (capabilityId === 'ae.layer.stretch.set') {
    return validateSignedRatio(value.beforeStretch) && validateSignedRatio(value.afterStretch)
      && BigInt(value.afterStretch.numerator) * BigInt(args.stretch.den)
        === BigInt(args.stretch.num) * BigInt(value.afterStretch.denominator)
      && BigInt(value.beforeStretch.numerator) * BigInt(value.afterStretch.denominator)
        !== BigInt(value.afterStretch.numerator) * BigInt(value.beforeStretch.denominator);
  }
  if (capabilityId === 'ae.layer.order.set') {
    return value.afterStackIndex === args.targetStackIndex
      && value.beforeStackIndex !== value.afterStackIndex;
  }
  const parentValid = (locator) => locator === null
    || locatorValid(locator, ['layer'], context);
  return parentValid(value.beforeParentLocator)
    && parentValid(value.afterParentLocator)
    && jsonDeepEqual(value.afterParentLocator, args.parentLayerLocator)
    && !jsonDeepEqual(value.beforeParentLocator, value.afterParentLocator);
}

function validateLayerCompositingResult(request, result, helloContext, schema) {
  const capabilityId = request.params.capabilityId;
  const spec = LAYER_COMPOSITING_SPECS.find((candidate) => candidate.id === capabilityId);
  if (spec === undefined) return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== spec.postconditionKind
      || !jsonDeepEqual(value.layerLocator, args.layerLocator)
      || value.layerLocator.hostInstanceId !== helloContext.response.result.host.instanceId
      || value.layerLocator.sessionId !== request.sessionId
      || !validateLocator(value.layerLocator, locatorContext(value.layerLocator), schema)) return false;

  if (capabilityId === 'ae.layer.compositing.read') {
    return ['visibilityEnabled', 'solo', 'locked', 'shy', 'motionBlur', 'threeD',
      'adjustment', 'preserveAlpha'].every((field) => typeof value[field] === 'boolean')
      && LAYER_QUALITIES.includes(value.quality)
      && LAYER_BLENDING_MODES.includes(value.blendingMode)
      && LAYER_TRACK_MATTES.includes(value.trackMatte);
  }
  if (value.changed !== true) return false;
  if (capabilityId === 'ae.layer.switch.set') {
    return value.switch === args.switch
      && value.afterEnabled === args.enabled
      && typeof value.beforeEnabled === 'boolean'
      && value.beforeEnabled !== value.afterEnabled;
  }
  if (capabilityId === 'ae.layer.quality.set') {
    return value.afterQuality === args.quality
      && LAYER_QUALITIES.includes(value.beforeQuality)
      && value.beforeQuality !== value.afterQuality;
  }
  return value.afterMode === args.mode
    && LAYER_BLENDING_MODES.includes(value.beforeMode)
    && value.beforeMode !== value.afterMode
    && typeof value.preserveAlpha === 'boolean'
    && LAYER_TRACK_MATTES.includes(value.trackMatte);
}

function validateNavigationResult(request, result, helloContext, schema) {
  const capabilityId = request.params.capabilityId;
  if (capabilityId !== 'ae.project.items.list'
      && capabilityId !== 'ae.composition.layers.list'
      && capabilityId !== 'ae.composition.selected-layers.list'
      && capabilityId !== 'ae.composition.time.read'
      && capabilityId !== 'ae.layer.properties.list') return true;
  const value = result.value;
  const args = request.params.arguments;
  const rootLocator = capabilityId === 'ae.project.items.list'
    ? value.projectLocator
    : capabilityId === 'ae.composition.layers.list'
        || capabilityId === 'ae.composition.selected-layers.list'
        || capabilityId === 'ae.composition.time.read'
      ? value.compositionLocator : value.layerLocator;
  const expectedKind = capabilityId === 'ae.project.items.list'
    ? 'project'
    : capabilityId === 'ae.composition.layers.list'
        || capabilityId === 'ae.composition.selected-layers.list'
        || capabilityId === 'ae.composition.time.read'
      ? 'composition' : 'layer';
  if (rootLocator?.kind !== expectedKind
      || rootLocator.hostInstanceId !== helloContext.response.result.host.instanceId
      || rootLocator.sessionId !== request.sessionId) return false;
  const context = locatorContext(rootLocator);
  if (!validateLocator(rootLocator, context, schema)) return false;

  if (capabilityId === 'ae.project.items.list') {
    if (!validatePageMetadata(value, args, 'items')
        || result.evidence.postcondition.kind !== 'project-items-list'
        || (args.projectLocator !== undefined
          && !jsonDeepEqual(args.projectLocator, value.projectLocator))) return false;
    const objectIds = new Set();
    for (const item of value.items) {
      if (!validateLocator(item.locator, context, schema)
          || !validateLocator(item.parentLocator, context, schema)
          || objectIds.has(item.locator.objectId)
          || (item.type === 'composition') !== (item.locator.kind === 'composition')
          || (item.parentLocator.kind === 'project'
            && !jsonDeepEqual(item.parentLocator, value.projectLocator))) return false;
      objectIds.add(item.locator.objectId);
    }
    return true;
  }

  if (capabilityId === 'ae.composition.time.read') {
    return result.evidence.postcondition.kind === 'composition-time-read'
      && jsonDeepEqual(args.compositionLocator, value.compositionLocator)
      && canonicalSecondsRational(value.currentTime?.value, value.currentTime?.scale)
        === value.currentTime?.secondsRational;
  }

  if (capabilityId === 'ae.layer.properties.list') {
    const expectedParent = args.parentPropertyLocator ?? null;
    if (!validatePageMetadata(value, args, 'properties')
        || result.evidence.postcondition.kind !== 'layer-properties-list'
        || !jsonDeepEqual(args.layerLocator, value.layerLocator)
        || !jsonDeepEqual(expectedParent, value.parentPropertyLocator)
        || (value.parentPropertyLocator !== null
          && (!validateLocator(value.parentPropertyLocator, context, schema)
            || value.parentPropertyLocator.kind !== 'stream'))
        || !Number.isSafeInteger(value.sampleTime?.value)
        || !Number.isSafeInteger(value.sampleTime?.scale)
        || value.sampleTime.scale < 1 || value.sampleTime.mode !== 'comp-time') return false;
    const objectIds = new Set();
    return value.properties.every((property, index) => validateLayerProperty(
      property, value, context, objectIds, index, schema,
    ));
  }

  const selectedLayers = capabilityId === 'ae.composition.selected-layers.list';
  if (!validatePageMetadata(value, args, 'layers')
      || result.evidence.postcondition.kind !== (selectedLayers
        ? 'composition-selected-layers-list' : 'composition-layers-list')
      || !jsonDeepEqual(args.compositionLocator, value.compositionLocator)) return false;
  const objectIds = new Set();
  let previousStackIndex = 0;
  for (let index = 0; index < value.layers.length; index += 1) {
    const layer = value.layers[index];
    if (!validateLocator(layer.locator, context, schema)
        || (selectedLayers
          ? (!Number.isSafeInteger(layer.stackIndex)
            || layer.stackIndex < 1 || layer.stackIndex <= previousStackIndex)
          : layer.stackIndex !== value.offset + index + 1)
        || objectIds.has(layer.locator.objectId)
        || (layer.parentLocator !== null
          && !validateLocator(layer.parentLocator, context, schema))
        || (layer.sourceItemLocator !== null
          && !validateLocator(layer.sourceItemLocator, context, schema))) return false;
    objectIds.add(layer.locator.objectId);
    previousStackIndex = layer.stackIndex;
  }
  return true;
}

function validateLayerPropertySetResult(request, result, helloContext, schema) {
  if (request.params.capabilityId !== 'ae.layer.property.set') return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== 'layer-property-set'
      || value.changed !== true
      || !jsonDeepEqual(value.layerLocator, args.layerLocator)
      || !jsonDeepEqual(value.propertyLocator, args.propertyLocator)
      || !primitivePropertyValuesEqual(value.afterValue, args.value)
      || primitivePropertyValuesEqual(value.beforeValue, value.afterValue)
      || !validatePrimitivePropertyValue(value.beforeValue)
      || !validatePrimitivePropertyValue(value.afterValue)
      || !validateSampledPropertyValue({ valueType: value.valueType, value: value.beforeValue })
      || !validateSampledPropertyValue({ valueType: value.valueType, value: value.afterValue })) {
    return false;
  }
  const context = locatorContext(value.layerLocator);
  return value.layerLocator.kind === 'layer'
    && value.propertyLocator.kind === 'stream'
    && value.layerLocator.hostInstanceId === helloContext.response.result.host.instanceId
    && value.layerLocator.sessionId === request.sessionId
    && validateLocator(value.layerLocator, context, schema)
    && validateLocator(value.propertyLocator, context, schema);
}

function validateLayerPropertyKeyframesResult(request, result, helloContext, schema) {
  if (request.params.capabilityId !== 'ae.layer.property.keyframes.list') return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== 'layer-property-keyframes-list'
      || !jsonDeepEqual(value.propertyLocator, args.propertyLocator)
      || !validatePageMetadata(value, args, 'keyframes')
      || !['one-d', 'two-d', 'two-d-spatial', 'three-d', 'three-d-spatial', 'color']
        .includes(value.valueType)) return false;
  const context = locatorContext(value.propertyLocator);
  if (value.propertyLocator.kind !== 'stream'
      || value.propertyLocator.hostInstanceId
        !== helloContext.response.result.host.instanceId
      || value.propertyLocator.sessionId !== request.sessionId
      || !validateLocator(value.propertyLocator, context, schema)) return false;
  let previousTime = null;
  for (let index = 0; index < value.keyframes.length; index += 1) {
    const keyframe = value.keyframes[index];
    if (keyframe.keyframeIndex !== value.offset + index + 1
        || !Number.isSafeInteger(keyframe.time?.value)
        || !Number.isSafeInteger(keyframe.time?.scale)
        || keyframe.time.scale < 1 || keyframe.time.mode !== 'comp-time'
        || !validatePrimitivePropertyValue(keyframe.value)
        || !validateSampledPropertyValue({
          valueType: value.valueType,
          value: keyframe.value,
        })
        || !['none', 'linear', 'bezier', 'hold'].includes(keyframe.inInterpolation)
        || !['none', 'linear', 'bezier', 'hold'].includes(keyframe.outInterpolation)) {
      return false;
    }
    if (previousTime !== null
        && BigInt(previousTime.value) * BigInt(keyframe.time.scale)
          >= BigInt(keyframe.time.value) * BigInt(previousTime.scale)) return false;
    previousTime = keyframe.time;
  }
  return true;
}

const KEYFRAME_BEHAVIOR_FIELD = Object.freeze({
  'temporal-continuous': 'temporalContinuous',
  'temporal-auto-bezier': 'temporalAutoBezier',
  'spatial-continuous': 'spatialContinuous',
  'spatial-auto-bezier': 'spatialAutoBezier',
  roving: 'roving',
});

function validateKeyframeDetailsValue(details, propertyLocator, time, context, schema) {
  if (!schemaAccepts(schema?.$defs?.keyframeDetailsValue, details, schema)
      || !jsonDeepEqual(details.propertyLocator, propertyLocator)
      || !compositionTimesEqual(details.time, time)
      || canonicalSecondsRational(details.time?.value, details.time?.scale)
        !== details.time?.secondsRational
      || !validateLocator(details.propertyLocator, context, schema)
      || !validateSampledPropertyValue({ valueType: details.valueType, value: details.value })
      || details.temporalEaseDimensions.length !== details.temporalDimensionality) return false;
  return details.temporalEaseDimensions.every((dimension, index) => (
    dimension.dimension === index
      && isKeyframeEase(dimension.inEase)
      && isKeyframeEase(dimension.outEase)
  ));
}

function validateKeyframeAuthoringResult(request, result, helloContext, schema) {
  const capabilityId = request.params.capabilityId;
  const detailsRead = capabilityId === 'ae.layer.property.keyframe.details.read';
  if (!detailsRead && !KEYFRAME_WRITE_CAPABILITIES.has(capabilityId)) return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== capabilityId.replace(/^ae\./u, '').replaceAll('.', '-')) {
    return false;
  }
  if (detailsRead) {
    const context = locatorContext(value.propertyLocator);
    return value.propertyLocator.hostInstanceId === helloContext.response.result.host.instanceId
      && value.propertyLocator.sessionId === request.sessionId
      && validateKeyframeDetailsValue(value, args.propertyLocator, args.time, context, schema);
  }

  if (value.changed !== true
      || !jsonDeepEqual(value.layerLocator, args.layerLocator)
      || !jsonDeepEqual(value.propertyLocator, args.propertyLocator)
      || !compositionTimesEqual(value.time, args.time)
      || canonicalSecondsRational(value.time?.value, value.time?.scale)
        !== value.time?.secondsRational) return false;
  const context = locatorContext(value.layerLocator);
  if (value.layerLocator.hostInstanceId !== helloContext.response.result.host.instanceId
      || value.layerLocator.sessionId !== request.sessionId
      || !validateLocator(value.layerLocator, context, schema)
      || !validateLocator(value.propertyLocator, context, schema)) return false;
  const detailsValid = (details) => details === null
    || validateKeyframeDetailsValue(details, value.propertyLocator, value.time, context, schema);
  if (!detailsValid(value.beforeKeyframe) || !detailsValid(value.afterKeyframe)) return false;

  if (capabilityId === 'ae.layer.property.keyframe.add') {
    return value.beforeKeyframe === null && value.afterKeyframe !== null
      && value.keyframeCountAfter === value.keyframeCountBefore + 1
      && primitivePropertyValuesEqual(value.afterKeyframe.value, args.value);
  }
  if (capabilityId === 'ae.layer.property.keyframe.delete') {
    return value.beforeKeyframe !== null && value.afterKeyframe === null
      && value.keyframeCountBefore === value.keyframeCountAfter + 1;
  }
  if (value.beforeKeyframe === null || value.afterKeyframe === null
      || value.keyframeCountBefore !== value.keyframeCountAfter) return false;
  if (capabilityId === 'ae.layer.property.keyframe.value.set') {
    return primitivePropertyValuesEqual(value.afterKeyframe.value, args.value)
      && !primitivePropertyValuesEqual(value.beforeKeyframe.value, value.afterKeyframe.value);
  }
  if (capabilityId === 'ae.layer.property.keyframe.interpolation.set') {
    return value.afterKeyframe.inInterpolation === args.inInterpolation
      && value.afterKeyframe.outInterpolation === args.outInterpolation
      && (value.beforeKeyframe.inInterpolation !== value.afterKeyframe.inInterpolation
        || value.beforeKeyframe.outInterpolation !== value.afterKeyframe.outInterpolation);
  }
  if (capabilityId === 'ae.layer.property.keyframe.temporal-ease.set') {
    return jsonDeepEqual(value.afterKeyframe.temporalEaseDimensions, args.dimensions)
      && !jsonDeepEqual(
        value.beforeKeyframe.temporalEaseDimensions,
        value.afterKeyframe.temporalEaseDimensions,
      );
  }
  const field = KEYFRAME_BEHAVIOR_FIELD[args.behavior];
  return typeof field === 'string' && value.afterKeyframe.behaviors[field] === args.enabled
    && value.beforeKeyframe.behaviors[field] !== value.afterKeyframe.behaviors[field];
}

function validateCompositionTimeSetResult(request, result, helloContext, schema) {
  if (request.params.capabilityId !== 'ae.composition.time.set') return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== 'composition-time-set'
      || value.changed !== true
      || !jsonDeepEqual(value.compositionLocator, args.compositionLocator)
      || canonicalSecondsRational(value.beforeTime?.value, value.beforeTime?.scale)
          !== value.beforeTime?.secondsRational
      || canonicalSecondsRational(value.afterTime?.value, value.afterTime?.scale)
          !== value.afterTime?.secondsRational
      || compositionTimesEqual(value.beforeTime, value.afterTime)
      || !compositionTimesEqual(value.afterTime, args.targetTime)) return false;
  const context = locatorContext(value.compositionLocator);
  return value.compositionLocator.kind === 'composition'
    && value.compositionLocator.hostInstanceId === helloContext.response.result.host.instanceId
    && value.compositionLocator.sessionId === request.sessionId
    && validateLocator(value.compositionLocator, context, schema);
}

function validateCompositionCreateResult(request, result, helloContext, schema) {
  if (request.params.capabilityId !== 'ae.composition.create') return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== 'composition-create'
      || value.changed !== true || value.name !== args.name
      || value.width !== args.width || value.height !== args.height
      || value.layerCount !== 0
      || value.projectItemCountAfter !== value.projectItemCountBefore + 1
      || !compositionTimesEqual(value.duration, args.duration)
      || canonicalSecondsRational(value.duration?.value, value.duration?.scale)
        !== value.duration?.secondsRational
      || !positiveRatiosEqual(value.frameRate, args.frameRate)
      || !positiveRatiosEqual(value.pixelAspectRatio, args.pixelAspectRatio)
      || canonicalPositiveRatio(value.frameRate?.numerator, value.frameRate?.denominator)
        !== value.frameRate?.rational
      || canonicalPositiveRatio(
        value.pixelAspectRatio?.numerator, value.pixelAspectRatio?.denominator,
      ) !== value.pixelAspectRatio?.rational
      || value.compositionLocator.hostInstanceId
        !== helloContext.response.result.host.instanceId
      || value.compositionLocator.sessionId !== request.sessionId) return false;
  const context = locatorContext(value.compositionLocator);
  return value.compositionLocator.kind === 'composition'
    && validateLocator(value.compositionLocator, context, schema);
}

function validateCompositionLayerCreateResult(request, result, helloContext, schema) {
  if (request.params.capabilityId !== 'ae.composition.layer.create') return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== 'composition-layer-create'
      || value.changed !== true || value.kind !== args.kind || value.name !== args.name
      || value.compositionLocator.hostInstanceId
        !== helloContext.response.result.host.instanceId
      || value.compositionLocator.sessionId !== request.sessionId
      || value.compositionLocator.generation <= args.compositionLocator.generation
      || value.compositionLocator.projectId === args.compositionLocator.projectId
      || value.layerCountAfter !== value.layerCountBefore + 1
      || value.stackIndex > value.layerCountAfter
      || value.projectItemCountAfter < value.projectItemCountBefore) return false;
  const context = locatorContext(value.compositionLocator);
  if (!validateLocator(value.compositionLocator, context, schema)
      || !validateLocator(value.layerLocator, context, schema)
      || value.layerLocator.kind !== 'layer'
      || (value.sourceItemLocator !== null
        && !validateLocator(value.sourceItemLocator, context, schema))) return false;
  if (args.kind === 'null') return value.solid === null;
  if (value.sourceItemLocator === null || value.solid === null
      || value.projectItemCountAfter <= value.projectItemCountBefore
      || canonicalSecondsRational(value.solid.duration?.value, value.solid.duration?.scale)
        !== value.solid.duration?.secondsRational
      || (args.color !== undefined && !jsonDeepEqual(value.solid.color, args.color))
      || (args.width !== undefined && value.solid.width !== args.width)
      || (args.height !== undefined && value.solid.height !== args.height)
      || (args.duration !== undefined
        && !compositionTimesEqual(value.solid.duration, args.duration))) return false;
  return true;
}

function validateLayerEffectApplyResult(request, result, helloContext, schema) {
  if (request.params.capabilityId !== 'ae.layer.effect.apply') return true;
  const args = request.params.arguments;
  const value = result.value;
  if (result.evidence.postcondition.kind !== 'layer-effect-apply'
      || value.changed !== true
      || value.matchName !== args.effectMatchName
      || value.layerLocator.hostInstanceId !== helloContext.response.result.host.instanceId
      || value.layerLocator.sessionId !== request.sessionId
      || value.layerLocator.generation <= args.layerLocator.generation
      || value.layerLocator.projectId === args.layerLocator.projectId
      || value.effectCountAfter !== value.effectCountBefore + 1
      || value.matchingEffectCountAfter !== value.matchingEffectCountBefore + 1
      || value.effectIndex < 1 || value.effectIndex > value.effectCountAfter) return false;
  const context = locatorContext(value.layerLocator);
  return value.layerLocator.kind === 'layer'
    && value.layerLocator.objectId === args.layerLocator.objectId
    && validateLocator(value.layerLocator, context, schema);
}

export function validateCapabilitiesExchange(
  helloContext,
  request,
  response,
  schema,
  registryOverride = undefined,
) {
  if (!validateHelloContext(helloContext, schema)
      || validateRequestComposite(request, schema).ok !== true
      || !validateResponseShape(response, schema)
      || request.method !== 'capabilities' || !response?.ok || response.kind !== 'response'
      || response.method !== 'capabilities' || response.requestId !== request.requestId
      || response.replayed !== false
      || request.sessionId !== helloContext.response.sessionId
      || response.sessionId !== request.sessionId || response.wireVersion !== request.wireVersion) return false;
  if (!isPlainObject(response.result) || !Array.isArray(response.result.items)) return false;
  const detail = request.params.detail ?? 'summary';
  let registry;
  try {
    registry = registryOverride ?? nativeCapabilityRegistry(schema);
  } catch {
    return false;
  }
  if (!Array.isArray(registry)
      || registry.some((item) => !validateCapabilityDescriptor(item, schema))) {
    return false;
  }
  const requestedIds = request.params.ids ? new Set(request.params.ids) : null;
  const selected = registry.filter((item) => !requestedIds || requestedIds.has(item.id));
  if (selected.length > (request.params.limit ?? 50)) return false;
  const expectedItems = detail === 'full' ? selected : selected.map(summarizeDescriptor);
  const result = response.result;
  if (result.detail !== detail || result.nextCursor !== null
      || result.items.length > (request.params.limit ?? 50)
      || result.queryDigest !== capabilityQueryDigest(request)) return false;
  try {
    if (canonicalize(result.items) !== canonicalize(expectedItems)) return false;
  } catch {
    return false;
  }
  if (result.items.some((item) => !validateCapabilityDescriptor(item, schema))) return false;
  let digest;
  try {
    digest = capabilityDigest(registry);
  } catch {
    return false;
  }
  return result.capabilitiesDigest === digest
    && helloContext.response.result.capabilitiesDigest === digest;
}

export function validateCapabilityDescriptor(descriptor, schema) {
  if (!schemaAccepts(schema?.$defs?.capabilityResultItem, descriptor, schema)
      || !isPlainObject(descriptor) || !isPlainObject(descriptor.compatibility)) return false;
  if (descriptor.risk === 'read'
      && (descriptor.mutability !== 'read-only' || descriptor.undo !== 'not-applicable'
        || descriptor.idempotency !== 'idempotent')) return false;
  if (descriptor.risk === 'write' && descriptor.mutability !== 'mutating') return false;
  if (descriptor.detail === 'full') {
    if (!Array.isArray(descriptor.requirements) || descriptor.requirements.length === 0
        || descriptor.requirements.some((requirement) => !isPlainObject(requirement)
          || typeof requirement.id !== 'string'
          || !Number.isInteger(requirement.contractVersion) || requirement.contractVersion < 1)) return false;
    if (!Array.isArray(descriptor.examples)) return false;
    const kinds = new Set(descriptor.examples.map((example) => example?.kind));
    if (!kinds.has('positive') || !kinds.has('negative')) return false;
    if (descriptor.examples.some((example) => !isPlainObject(example.arguments)
        || !isPlainObject(example.expected))) return false;
  }
  const compatibility = descriptor.compatibility;
  if (compatibility.status === 'unverified') {
    return compatibility.minimumHostMajor === undefined && compatibility.maximumHostMajor === undefined;
  }
  return compatibility.status === 'verified'
    && Number.isInteger(compatibility.minimumHostMajor)
    && Number.isInteger(compatibility.maximumHostMajor)
    && compatibility.minimumHostMajor <= compatibility.maximumHostMajor;
}

export function validateIdempotencyContract(descriptor, invokeParams) {
  if (descriptor.idempotency === 'idempotency-key') {
    return typeof invokeParams?.arguments?.idempotencyKey === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$/u.test(invokeParams.arguments.idempotencyKey);
  }
  return invokeParams?.arguments?.idempotencyKey === undefined;
}

export function validateCancelResult(result, schema) {
  if (!schemaAccepts(schema?.$defs?.cancelResult, result, schema)) return false;
  const expected = {
    'queued-cancelled': true,
    'running-cancel-requested': true,
    'running-not-cancellable': true,
    'already-terminal': false,
    'not-found': false,
  }[result?.state];
  return expected !== undefined && result.terminalResponseExpected === expected;
}

export function validateInvalidateGraphExchange(helloContext, request, response, schema) {
  const result = response?.result;
  return validateHelloContext(helloContext, schema)
    && validateRequestComposite(request, schema).ok === true
    && request.method === 'invalidateGraph'
    && request.sessionId === helloContext.response.sessionId
    && validateResponseShape(response, schema)
    && response?.ok === true
    && response.kind === 'response'
    && response.method === 'invalidateGraph'
    && response.sessionId === request.sessionId
    && response.requestId === request.requestId
    && response.wireVersion === request.wireVersion
    && response.replayed === false
    && schemaAccepts(schema?.$defs?.invalidateGraphResult, result, schema)
    && (result.invalidated ? result.generation >= 1 : result.generation === 0);
}

export function validateProgressEvent(message, request, schema) {
  return validateProgressEventShape(message, schema)
    && validateRequestComposite(request, schema).ok === true
    && isPlainObject(request) && isPlainObject(message) && isPlainObject(message.progress)
    && exactKeys(message, new Set([
    'wireVersion', 'kind', 'sessionId', 'requestId', 'event', 'sequence', 'progress',
  ]), ['wireVersion', 'kind', 'sessionId', 'requestId', 'event', 'sequence', 'progress'])
    && message.wireVersion === request.wireVersion
    && message.kind === 'event'
    && message.sessionId === request.sessionId
    && message.requestId === request.requestId
    && message.event === 'progress'
    && Number.isSafeInteger(message.sequence) && message.sequence >= 1
    && exactKeys(message.progress, new Set(['phase', 'fraction', 'message']), [
      'phase', 'fraction', 'message',
    ])
    && PROGRESS_PHASE[message.progress.phase] !== undefined
    && typeof message.progress.fraction === 'number'
    && Number.isFinite(message.progress.fraction)
    && message.progress.fraction >= 0 && message.progress.fraction <= 1
    && isBoundedScalarString(message.progress.message, 1, 160);
}

export function validateCancelExchange(
  context,
  cancelRequest,
  cancelResponse,
  targetRequest,
  targetMessages,
) {
  const helloContext = context?.hello;
  const descriptor = context?.descriptor;
  const schema = context?.schema;
  const decision = context?.cancelDecision;
  if (!validateHelloContext(helloContext, schema)
      || validateRequestComposite(cancelRequest, schema).ok !== true
      || cancelRequest.method !== 'cancel' || !validateResponseShape(cancelResponse, schema)
      || cancelRequest.sessionId !== helloContext.response.sessionId
      || cancelResponse?.ok !== true || cancelResponse.kind !== 'response'
      || cancelResponse.method !== 'cancel' || cancelResponse.requestId !== cancelRequest.requestId
      || cancelResponse.sessionId !== cancelRequest.sessionId
      || cancelResponse.wireVersion !== cancelRequest.wireVersion
      || cancelResponse.replayed !== false
      || cancelResponse.result?.targetRequestId !== cancelRequest.params.targetRequestId
      || !validateCancelResult(cancelResponse.result, schema) || !Array.isArray(targetMessages)
      || !validateCapabilityDescriptor(descriptor, schema)
      || !isPlainObject(decision) || !VALID_CANCEL_DECISIONS.has(decision)
      || CONSUMED_CANCEL_DECISIONS.has(decision)
      || decision.cancelKey !== `${cancelRequest.sessionId}:${cancelRequest.requestId}`
      || decision.cancelRequestId !== cancelRequest.requestId
      || decision.sessionId !== cancelRequest.sessionId
      || decision.targetKey !== `${cancelRequest.sessionId}:${cancelRequest.params.targetRequestId}`
      || decision.targetRequestId !== cancelRequest.params.targetRequestId
      || decision.capabilityId !== descriptor.id
      || decision.capabilityVersion !== descriptor.version
      || decision.cancellation !== descriptor.cancellation
      || decision.state !== cancelResponse.result.state
      || decision.terminalResponseExpected !== cancelResponse.result.terminalResponseExpected) return false;

  const { state, terminalResponseExpected } = cancelResponse.result;
  const knownTarget = state !== 'not-found';
  if (!knownTarget) {
    if (targetRequest !== null || decision.targetRequestDigest !== null
        || decision.targetEffectiveDeadlineUnixMs !== null || targetMessages.length !== 0) return false;
    CONSUMED_CANCEL_DECISIONS.add(decision);
    return true;
  }
  if (validateRequestComposite(targetRequest, schema).ok !== true
      || targetRequest.method !== 'invoke' || targetRequest.requestId === cancelRequest.requestId
      || targetRequest.requestId !== cancelRequest.params.targetRequestId
      || targetRequest.sessionId !== cancelRequest.sessionId
      || descriptor.id !== targetRequest.params.capabilityId
      || descriptor.version !== targetRequest.params.capabilityVersion
      || decision.targetRequestDigest !== sha256Jcs(targetRequest)
      || decision.targetEffectiveDeadlineUnixMs !== context?.targetTranscriptContext?.effectiveDeadlineUnixMs) {
    return false;
  }
  if (!terminalResponseExpected) {
    if (state !== 'already-terminal' || targetMessages.length !== 0) return false;
    CONSUMED_CANCEL_DECISIONS.add(decision);
    return true;
  }
  const transcriptContext = {
    ...context.targetTranscriptContext,
    hello: helloContext,
    descriptor,
    registry: context.registry,
    schema,
  };
  if (!validateTranscript(transcriptContext, targetRequest, targetMessages)) return false;
  const terminal = targetMessages.at(-1);
  let validTerminal = true;
  if (state === 'queued-cancelled') {
    validTerminal = terminal.ok === false && terminal.error?.code === 'CANCELLED';
  } else if (state === 'running-not-cancellable') {
    validTerminal = !(terminal.ok === false && terminal.error?.code === 'CANCELLED');
  } else if (state !== 'running-cancel-requested') {
    validTerminal = false;
  }
  if (!validTerminal) return false;
  CONSUMED_CANCEL_DECISIONS.add(decision);
  return true;
}

export function validateTranscript(context, request, messages) {
  const helloContext = context?.hello;
  const descriptor = context?.descriptor;
  const schema = context?.schema;
  const deadline = context?.effectiveDeadlineUnixMs;
  const brokerSendUnixMs = context?.brokerSendUnixMs;
  const terminalObservedUnixMs = context?.terminalObservedUnixMs;
  let expectedDeadline;
  try {
    expectedDeadline = request?.deadlineUnixMs === undefined
        && VALID_REPLAY_RECEIPTS.has(context?.replayReceipt)
      ? context.replayReceipt.effectiveDeadlineUnixMs
      : materializeDeadline(
        request,
        brokerSendUnixMs,
        helloContext?.response?.result?.limits?.maxDeadlineMs,
      );
  } catch {
    return false;
  }
  let descriptorDigest;
  let registeredDescriptor;
  let requestDigest;
  try {
    const registry = context?.registry ?? nativeCapabilityRegistry(schema);
    descriptorDigest = capabilityDigest(registry);
    registeredDescriptor = registry.find((item) => item.id === descriptor?.id
      && item.version === descriptor?.version);
    requestDigest = sha256Jcs(request);
  } catch {
    return false;
  }
  let descriptorIsRegistered = false;
  try {
    descriptorIsRegistered = registeredDescriptor !== undefined
      && canonicalize(registeredDescriptor) === canonicalize(descriptor);
  } catch {
    descriptorIsRegistered = false;
  }
  if (!Array.isArray(messages) || !validateHelloContext(helloContext, schema)
      || validateRequestComposite(request, schema).ok !== true
      || request.method !== 'invoke' || !validateCapabilityDescriptor(descriptor, schema)
      || !descriptorIsRegistered
      || descriptor.id !== request.params.capabilityId
      || descriptor.version !== request.params.capabilityVersion
      || descriptorDigest !== helloContext.response.result.capabilitiesDigest
      || request.sessionId !== helloContext.response.sessionId
      || request.wireVersion !== helloContext.response.result.selectedWireVersion
      || !Number.isSafeInteger(deadline) || deadline < 1 || deadline !== expectedDeadline) return false;
  let expectedSequence = 1;
  let terminal = null;
  let previousPhase = -1;
  let previousFraction = -1;
  for (const message of messages) {
    if (terminal) return false;
    if (message.kind === 'event') {
      if (!validateProgressEvent(message, request, schema) || message.sequence !== expectedSequence
          || PROGRESS_PHASE[message.progress.phase] < previousPhase
          || message.progress.fraction < previousFraction
      ) return false;
      previousPhase = PROGRESS_PHASE[message.progress.phase];
      previousFraction = message.progress.fraction;
      expectedSequence += 1;
    } else if (message.kind === 'response') {
      if (!validateResponseShape(message, schema)) return false;
      terminal = message;
    } else {
      return false;
    }
  }
  if (!terminal || terminal.requestId !== request.requestId || terminal.sessionId !== request.sessionId
      || terminal.method !== request.method || terminal.wireVersion !== request.wireVersion) return false;
  if (terminal.replayed !== false && terminal.replayed !== true) return false;
  if (!terminal.ok) {
    return terminal.replayed === false
      && validateFailureExchange(helloContext, request, terminal, descriptor, schema);
  }
  const replayed = terminal.replayed === true;
  if (replayed) {
    const receipt = context.replayReceipt;
    const original = structuredClone(terminal);
    original.replayed = false;
    if (!isPlainObject(receipt) || !VALID_REPLAY_RECEIPTS.has(receipt)
        || expectedSequence !== 1
        || receipt.sessionId !== request.sessionId || receipt.requestId !== request.requestId
        || receipt.requestDigest !== requestDigest
        || (() => {
          try {
            return receipt.responseDigest !== sha256Jcs(original);
          } catch {
            return true;
          }
        })()
        || receipt.effectiveDeadlineUnixMs !== deadline
        || !Number.isSafeInteger(receipt.terminalObservedUnixMs)
        || !Number.isSafeInteger(original.result?.evidence?.completedAtUnixMs)
        || original.result.evidence.completedAtUnixMs > receipt.terminalObservedUnixMs
        || receipt.terminalObservedUnixMs > deadline) return false;
  } else if (context.replayReceipt !== undefined) return false;
  const result = terminal.result;
  if (!isPlainObject(result) || !isPlainObject(result.evidence)
      || !isPlainObject(result.evidence.postcondition)
      || !schemaAccepts(descriptor.resultSchema, result.value, descriptor.resultSchema)) return false;
  const evidence = result.evidence;
  let resultDigest;
  try {
    resultDigest = postconditionDigest(result);
  } catch {
    return false;
  }
  return result.capabilityId === request.params.capabilityId
    && result.capabilityVersion === request.params.capabilityVersion
    && result.engine === 'native-aegp'
    && evidence.engine === result.engine
    && evidence.hostInstanceId === helloContext.response.result.host.instanceId
    && evidence.sessionId === request.sessionId
    && evidence.requestId === request.requestId
    && evidence.capabilityId === result.capabilityId
    && evidence.capabilityVersion === result.capabilityVersion
    && (replayed || evidence.startedAtUnixMs >= brokerSendUnixMs)
    && evidence.completedAtUnixMs >= evidence.startedAtUnixMs
    && evidence.completedAtUnixMs <= deadline
    && (replayed || (Number.isSafeInteger(terminalObservedUnixMs)
      && evidence.completedAtUnixMs <= terminalObservedUnixMs
      && terminalObservedUnixMs <= deadline))
    && (descriptor.mutability !== 'read-only'
      || (evidence.effect === 'none' && evidence.undo === undefined))
    && (descriptor.mutability !== 'mutating'
      || (evidence.effect === 'committed'
        && (descriptor.undo !== 'ae-undo-group'
          || (evidence.undo?.available === true
            && typeof evidence.undo?.verified === 'boolean'
            && (!['ae.project.bit-depth.set', 'ae.composition.time.set', 'ae.composition.create', 'ae.composition.layer.create', 'ae.layer.effect.apply', 'ae.layer.property.set', 'ae.composition.work-area.set', 'ae.project.item.name.set', 'ae.project.item.comment.set', 'ae.project.item.label.set', 'ae.composition.duplicate', 'ae.layer.name.set', 'ae.layer.range.set', 'ae.layer.start-time.set', 'ae.layer.stretch.set', 'ae.layer.order.set', 'ae.layer.parent.set', 'ae.layer.duplicate', 'ae.layer.switch.set', 'ae.layer.quality.set', 'ae.layer.blending-mode.set', 'ae.layer.property.keyframe.add', 'ae.layer.property.keyframe.value.set', 'ae.layer.property.keyframe.interpolation.set', 'ae.layer.property.keyframe.temporal-ease.set', 'ae.layer.property.keyframe.behavior.set', 'ae.layer.property.keyframe.delete']
              .includes(request.params.capabilityId)
              || request.params.capabilityVersion !== 1
              || evidence.undo.verified === false)))))
    && (request.params.capabilityId !== 'ae.project.bit-depth.set'
      || request.params.capabilityVersion !== 1
      || (result.value.beforeBitsPerChannel !== result.value.afterBitsPerChannel
        && result.value.afterBitsPerChannel === request.params.arguments.targetDepth))
    && validateNavigationResult(request, result, helloContext, schema)
    && validateCompositionTimeSetResult(request, result, helloContext, schema)
    && validateCompositionCreateResult(request, result, helloContext, schema)
    && validateCompositionLayerCreateResult(request, result, helloContext, schema)
    && validateLayerEffectApplyResult(request, result, helloContext, schema)
    && validateLayerPropertyKeyframesResult(request, result, helloContext, schema)
    && validateLayerPropertySetResult(request, result, helloContext, schema)
    && validateKeyframeAuthoringResult(request, result, helloContext, schema)
    && validateProjectCompositionResult(request, result, helloContext, schema)
    && validateLayerTimelineResult(request, result, helloContext, schema)
    && validateLayerCompositingResult(request, result, helloContext, schema)
    && evidence.postcondition.verified === true
    && evidence.requestDigest === requestDigest
    && evidence.postcondition.digest === resultDigest;
}

export function validateLocator(locator, context, schema) {
  const ids = ['hostInstanceId', 'sessionId', 'projectId', 'objectId'];
  if (!schemaAccepts(schema?.$defs?.locator, locator, schema)
      || !isPlainObject(locator) || !isPlainObject(context)
      || !ids.every((key) => UUID.test(locator[key] ?? ''))
      || !Number.isSafeInteger(locator.generation) || locator.generation < 1) return false;
  return ids.slice(0, 3).every((key) => locator[key] === context[key])
    && locator.generation === context.generation;
}

function requireSafeTime(nowUnixMs) {
  if (!Number.isSafeInteger(nowUnixMs) || nowUnixMs < 0) {
    fail('INVALID_ARGUMENT', 'invalid monotonic reference time');
  }
}

const ADMISSION_MAXIMA = Object.freeze({
  maxInFlight: 64,
  maxQueueDepth: 256,
  maxDeadlineMs: LIMITS.maximumDeadlineMs,
  maxRequestsPerSecond: 100,
  maxBurst: 100,
  maxControlInFlight: 8,
  maxControlRequestsPerSecond: 100,
  maxControlBurst: 100,
  maxTerminalCacheEntries: 4096,
});

export class AdmissionController {
  constructor(limits) {
    for (const [key, maximum] of Object.entries(ADMISSION_MAXIMA)) {
      const minimum = key === 'maxDeadlineMs' ? 100 : 1;
      if (!Number.isSafeInteger(limits?.[key])
          || limits[key] < minimum || limits[key] > maximum) {
        fail('INVALID_ARGUMENT', `invalid admission limit ${key}`);
      }
    }
    this.limits = Object.freeze(Object.fromEntries(
      Object.keys(ADMISSION_MAXIMA).map((key) => [key, limits[key]]),
    ));
    this.inFlight = new Map();
    this.queue = [];
    this.controlInFlight = new Map();
    this.terminal = new Map();
    this.cancelRequested = new Set();
    this.decidedControls = new Set();
    this.tokens = limits.maxBurst;
    this.controlTokens = limits.maxControlBurst;
    this.lastRefillMs = null;
    this.lastControlRefillMs = null;
  }

  refill(nowUnixMs, control = false) {
    requireSafeTime(nowUnixMs);
    const lastKey = control ? 'lastControlRefillMs' : 'lastRefillMs';
    const tokenKey = control ? 'controlTokens' : 'tokens';
    const burstKey = control ? 'maxControlBurst' : 'maxBurst';
    const rateKey = control ? 'maxControlRequestsPerSecond' : 'maxRequestsPerSecond';
    if (this[lastKey] === null) {
      this[lastKey] = nowUnixMs;
      return;
    }
    if (nowUnixMs < this[lastKey]) fail('INVALID_ARGUMENT', 'admission clock moved backwards');
    const elapsed = nowUnixMs - this[lastKey];
    this[tokenKey] = Math.min(
      this.limits[burstKey],
      this[tokenKey] + ((elapsed * this.limits[rateKey]) / 1000),
    );
    this[lastKey] = nowUnixMs;
  }

  static key(request) {
    if (!isPlainObject(request) || !UUID.test(request.sessionId ?? '')
        || !REQUEST_ID.test(request.requestId ?? '')) {
      fail('INVALID_ARGUMENT', 'request identity requires session and request IDs');
    }
    return `${request.sessionId}:${request.requestId}`;
  }

  static identity(request, effectiveDeadlineUnixMs) {
    return Object.freeze({
      key: AdmissionController.key(request),
      sessionId: request.sessionId,
      requestId: request.requestId,
      method: request.method,
      effectiveDeadlineUnixMs,
      requestDigest: sha256Jcs(request),
      ...(request.method === 'invoke' ? {
        capabilityId: request.params.capabilityId,
        capabilityVersion: request.params.capabilityVersion,
      } : {}),
    });
  }

  contains(request) {
    const key = AdmissionController.key(request);
    return this.inFlight.has(key) || this.controlInFlight.has(key) || this.terminal.has(key)
      || this.queue.some((item) => item.key === key);
  }

  rememberTerminal(identity) {
    this.terminal.delete(identity.key);
    while (this.terminal.size >= this.limits.maxTerminalCacheEntries) {
      this.terminal.delete(this.terminal.keys().next().value);
    }
    this.terminal.set(identity.key, identity);
  }

  rateLimit(nowUnixMs, control) {
    this.refill(nowUnixMs, control);
    const tokenKey = control ? 'controlTokens' : 'tokens';
    const rateKey = control ? 'maxControlRequestsPerSecond' : 'maxRequestsPerSecond';
    if (this[tokenKey] < 1) {
      return Math.max(1, Math.ceil(
        ((1 - this[tokenKey]) * 1000) / this.limits[rateKey],
      ));
    }
    this[tokenKey] -= 1;
    return null;
  }

  admit(request, nowUnixMs) {
    if (classifyRequest(request).ok !== true || request.method === 'hello') {
      return { state: 'rejected', errorCode: 'INVALID_REQUEST' };
    }
    let effectiveDeadlineUnixMs;
    try {
      effectiveDeadlineUnixMs = materializeDeadline(request, nowUnixMs, this.limits.maxDeadlineMs);
      if (this.contains(request)) {
        return { state: 'rejected', errorCode: 'DUPLICATE_REQUEST' };
      }
    } catch (error) {
      return { state: 'rejected', errorCode: error.code ?? 'INVALID_ARGUMENT' };
    }
    const identity = AdmissionController.identity(request, effectiveDeadlineUnixMs);
    if (request.method === 'cancel') {
      const retryAfterMs = this.rateLimit(nowUnixMs, true);
      if (retryAfterMs !== null) {
        return {
          state: 'rejected', errorCode: 'QUEUE_FULL', reason: 'control-rate-limit', retryAfterMs,
        };
      }
      if (this.controlInFlight.size >= this.limits.maxControlInFlight) {
        return {
          state: 'rejected', errorCode: 'QUEUE_FULL', reason: 'control-capacity', retryAfterMs: 1,
        };
      }
      this.controlInFlight.set(identity.key, identity);
      return { state: 'control-dispatched', request: identity };
    }
    const retryAfterMs = this.rateLimit(nowUnixMs, false);
    if (retryAfterMs !== null) {
      return { state: 'rejected', errorCode: 'QUEUE_FULL', reason: 'rate-limit', retryAfterMs };
    }
    if (this.inFlight.size < this.limits.maxInFlight) {
      this.inFlight.set(identity.key, identity);
      return { state: 'dispatched', request: identity };
    }
    if (this.queue.length < this.limits.maxQueueDepth) {
      this.queue.push(identity);
      return { state: 'queued', request: identity };
    }
    return { state: 'rejected', errorCode: 'QUEUE_FULL', reason: 'queue-capacity', retryAfterMs: 1 };
  }

  complete(request, nowUnixMs) {
    requireSafeTime(nowUnixMs);
    const key = AdmissionController.key(request);
    if (this.controlInFlight.has(key)) {
      const completed = this.controlInFlight.get(key);
      this.controlInFlight.delete(key);
      this.decidedControls.delete(key);
      this.rememberTerminal(completed);
      return { state: 'control-released', completed };
    }
    if (!this.inFlight.has(key)) fail('INVALID_REQUEST', 'request is not in flight');
    const completed = this.inFlight.get(key);
    this.inFlight.delete(key);
    this.cancelRequested.delete(key);
    this.rememberTerminal(completed);
    const expired = [];
    while (this.queue.length > 0) {
      const candidate = this.queue.shift();
      if (candidate.effectiveDeadlineUnixMs <= nowUnixMs) {
        this.rememberTerminal(candidate);
        expired.push({ request: candidate, errorCode: 'DEADLINE_EXCEEDED' });
        continue;
      }
      this.inFlight.set(candidate.key, candidate);
      return { state: 'promoted', completed, promoted: candidate, expired };
    }
    return { state: 'released', completed, expired };
  }

  decideCancel(cancelRequest, descriptor) {
    if (classifyRequest(cancelRequest).ok !== true || cancelRequest.method !== 'cancel'
        || !isPlainObject(descriptor)
        || !['before-dispatch', 'cooperative', 'none'].includes(descriptor.cancellation)) {
      fail('INVALID_ARGUMENT', 'invalid atomic cancellation decision input');
    }
    const cancelKey = AdmissionController.key(cancelRequest);
    if (!this.controlInFlight.has(cancelKey) || this.decidedControls.has(cancelKey)) {
      fail('INVALID_REQUEST', 'cancel request is not an undecided control operation');
    }
    const targetKey = `${cancelRequest.sessionId}:${cancelRequest.params.targetRequestId}`;
    const runningTarget = this.inFlight.get(targetKey) ?? null;
    const queueIndex = runningTarget
      ? -1 : this.queue.findIndex((item) => item.key === targetKey);
    const queuedTarget = queueIndex >= 0 ? this.queue[queueIndex] : null;
    const terminalTarget = runningTarget || queuedTarget
      ? null : this.terminal.get(targetKey) ?? null;
    const target = runningTarget ?? queuedTarget ?? terminalTarget;
    if (target && (target.method !== 'invoke' || target.sessionId !== cancelRequest.sessionId
        || target.capabilityId !== descriptor.id
        || target.capabilityVersion !== descriptor.version)) {
      fail('INVALID_ARGUMENT', 'cancel target does not match capability descriptor');
    }

    let state;
    if (runningTarget) {
      state = descriptor.cancellation === 'cooperative'
        ? 'running-cancel-requested' : 'running-not-cancellable';
      if (state === 'running-cancel-requested') this.cancelRequested.add(targetKey);
    } else if (queuedTarget) {
      this.queue.splice(queueIndex, 1);
      this.rememberTerminal(queuedTarget);
      state = 'queued-cancelled';
    } else if (terminalTarget) {
      state = 'already-terminal';
    } else {
      state = 'not-found';
    }
    const terminalResponseExpected = [
      'queued-cancelled', 'running-cancel-requested', 'running-not-cancellable',
    ].includes(state);
    const decisionReceipt = Object.freeze({
      cancelKey,
      cancelRequestId: cancelRequest.requestId,
      sessionId: cancelRequest.sessionId,
      targetKey,
      targetRequestId: cancelRequest.params.targetRequestId,
      capabilityId: descriptor.id,
      capabilityVersion: descriptor.version,
      cancellation: descriptor.cancellation,
      state,
      terminalResponseExpected,
      targetRequestDigest: target?.requestDigest ?? null,
      targetEffectiveDeadlineUnixMs: target?.effectiveDeadlineUnixMs ?? null,
    });
    this.decidedControls.add(cancelKey);
    VALID_CANCEL_DECISIONS.add(decisionReceipt);
    return { state, terminalResponseExpected, target, decisionReceipt };
  }

  snapshot() {
    return {
      inFlight: [...this.inFlight.values()],
      queued: [...this.queue],
      controlInFlight: [...this.controlInFlight.values()],
      terminal: [...this.terminal.values()],
      tokens: this.tokens,
      controlTokens: this.controlTokens,
    };
  }
}

export class RequestLedger {
  constructor({
    maxActiveEntries = 40,
    maxTerminalEntries = LIMITS.defaultTerminalCacheEntries,
    terminalTtlMs = LIMITS.defaultTerminalCacheTtlMs,
    maxDeadlineMs = LIMITS.maximumDeadlineMs,
    terminalValidator = null,
  } = {}) {
    for (const [key, value] of Object.entries({
      maxActiveEntries, maxTerminalEntries, terminalTtlMs, maxDeadlineMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_ARGUMENT', `invalid ledger ${key}`);
    }
    if (maxActiveEntries > 320 || maxTerminalEntries > 4096 || terminalTtlMs > 300000
        || maxDeadlineMs > LIMITS.maximumDeadlineMs) {
      fail('INVALID_ARGUMENT', 'ledger limit exceeds protocol maximum');
    }
    if (terminalValidator !== null && typeof terminalValidator !== 'function') {
      fail('INVALID_ARGUMENT', 'terminal validator must be a function');
    }
    this.maxActiveEntries = maxActiveEntries;
    this.maxTerminalEntries = maxTerminalEntries;
    this.terminalTtlMs = terminalTtlMs;
    this.maxDeadlineMs = maxDeadlineMs;
    this.terminalValidator = terminalValidator;
    this.active = new Map();
    this.terminal = new Map();
  }

  static key(request) {
    return `${request.sessionId}:${request.requestId}`;
  }

  storeTerminal(key, entry) {
    this.terminal.delete(key);
    while (this.terminal.size >= this.maxTerminalEntries) {
      this.terminal.delete(this.terminal.keys().next().value);
    }
    this.terminal.set(key, entry);
  }

  purgeExpired(nowUnixMs, preserveActiveKey = null) {
    requireSafeTime(nowUnixMs);
    for (const [key, entry] of this.terminal) {
      if (entry.expiresAtUnixMs <= nowUnixMs) this.terminal.delete(key);
    }
    if (!Number.isSafeInteger(nowUnixMs + this.terminalTtlMs)) {
      fail('INVALID_ARGUMENT', 'terminal expiry exceeds safe integer range');
    }
    for (const [key, entry] of this.active) {
      if (key !== preserveActiveKey && entry.effectiveDeadlineUnixMs <= nowUnixMs) {
        this.active.delete(key);
        this.storeTerminal(key, {
          digest: entry.digest,
          effectiveDeadlineUnixMs: entry.effectiveDeadlineUnixMs,
          response: null,
          replayable: false,
          replayReceipt: null,
          expired: true,
          expiresAtUnixMs: nowUnixMs + this.terminalTtlMs,
        });
      }
    }
  }

  accept(request, nowUnixMs = 0) {
    requireSafeTime(nowUnixMs);
    if (classifyRequest(request).ok !== true || request.method === 'hello') {
      return { state: 'rejected', errorCode: 'INVALID_REQUEST' };
    }
    this.purgeExpired(nowUnixMs);
    const key = RequestLedger.key(request);
    const digest = sha256Jcs(request);
    if (this.active.has(key)) return { state: 'rejected', errorCode: 'DUPLICATE_REQUEST' };
    const previous = this.terminal.get(key);
    if (previous) {
      if (nowUnixMs >= previous.effectiveDeadlineUnixMs) {
        return { state: 'rejected', errorCode: 'DEADLINE_EXCEEDED' };
      }
      if (previous.digest === digest && previous.replayable && previous.response.ok === true) {
        return {
          state: 'replayed',
          effectiveDeadlineUnixMs: previous.effectiveDeadlineUnixMs,
          response: { ...structuredClone(previous.response), replayed: true },
          replayReceipt: previous.replayReceipt,
        };
      }
      return { state: 'rejected', errorCode: 'DUPLICATE_REQUEST' };
    }
    let effectiveDeadlineUnixMs;
    try {
      effectiveDeadlineUnixMs = materializeDeadline(request, nowUnixMs, this.maxDeadlineMs);
    } catch (error) {
      return { state: 'rejected', errorCode: error.code ?? 'INVALID_ARGUMENT' };
    }
    if (this.active.size >= this.maxActiveEntries) {
      return { state: 'rejected', errorCode: 'QUEUE_FULL' };
    }
    this.active.set(key, {
      digest,
      request: structuredClone(request),
      brokerSendUnixMs: nowUnixMs,
      effectiveDeadlineUnixMs,
    });
    return { state: 'accepted', effectiveDeadlineUnixMs };
  }

  complete(request, response, terminalObservedUnixMs = 0) {
    requireSafeTime(terminalObservedUnixMs);
    const key = RequestLedger.key(request);
    let current = this.active.get(key);
    if (current && terminalObservedUnixMs > current.effectiveDeadlineUnixMs) {
      this.purgeExpired(terminalObservedUnixMs);
      fail('DEADLINE_EXCEEDED', 'terminal was observed after the effective deadline');
    }
    this.purgeExpired(terminalObservedUnixMs, key);
    current = this.active.get(key);
    if (!current) fail('INVALID_REQUEST', 'request is not active');
    if (sha256Jcs(request) !== current.digest) {
      fail('INVALID_REQUEST', 'completion request does not match stored active request');
    }
    const storedRequest = current.request;
    if (response?.requestId !== storedRequest.requestId
        || response.sessionId !== storedRequest.sessionId
        || response.method !== storedRequest.method || response.kind !== 'response'
        || response.replayed !== false) {
      fail('INVALID_REQUEST', 'terminal response does not match active request');
    }
    if (storedRequest.method === 'invoke' && response.ok === true
        && (!Number.isSafeInteger(response.result?.evidence?.completedAtUnixMs)
          || response.result.evidence.completedAtUnixMs > terminalObservedUnixMs)) {
      fail('INVALID_REQUEST', 'terminal evidence is later than broker observation');
    }
    let validation;
    try {
      validation = this.terminalValidator?.(storedRequest, response, {
        brokerSendUnixMs: current.brokerSendUnixMs,
        effectiveDeadlineUnixMs: current.effectiveDeadlineUnixMs,
        terminalObservedUnixMs,
      });
    } catch {
      fail('INVALID_REQUEST', 'terminal validator rejected response');
    }
    if (validation !== true && validation?.valid !== true) {
      fail('INVALID_REQUEST', 'terminal response was not independently validated');
    }
    if (!Number.isSafeInteger(terminalObservedUnixMs + this.terminalTtlMs)) {
      fail('INVALID_ARGUMENT', 'terminal expiry exceeds safe integer range');
    }
    const responseDigest = sha256Jcs(response);
    const replayable = response.ok === true && storedRequest.method === 'invoke'
      && storedRequest.params.capabilityId === 'ae.project.summary';
    let replayReceipt = null;
    if (replayable) {
      replayReceipt = Object.freeze({
        sessionId: storedRequest.sessionId,
        requestId: storedRequest.requestId,
        requestDigest: current.digest,
        responseDigest,
        effectiveDeadlineUnixMs: current.effectiveDeadlineUnixMs,
        terminalObservedUnixMs,
      });
      VALID_REPLAY_RECEIPTS.add(replayReceipt);
    }
    this.active.delete(key);
    this.storeTerminal(key, {
      digest: current.digest,
      effectiveDeadlineUnixMs: current.effectiveDeadlineUnixMs,
      response: structuredClone(response),
      replayable,
      replayReceipt,
      expiresAtUnixMs: terminalObservedUnixMs + this.terminalTtlMs,
    });
  }

  purgeSession(sessionId) {
    for (const store of [this.active, this.terminal]) {
      for (const [key, entry] of store) {
        const request = entry.request;
        if (request?.sessionId === sessionId || key.startsWith(`${sessionId}:`)) store.delete(key);
      }
    }
  }

  snapshot() {
    return { active: this.active.size, terminal: this.terminal.size };
  }
}
