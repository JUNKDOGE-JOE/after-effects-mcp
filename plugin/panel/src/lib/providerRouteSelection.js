import { normalizeProviderEntryV3 } from './providerProfile.js';

const CLIENT_PROTOCOLS = Object.freeze({
  codex: 'responses',
  'claude-code': 'messages',
});
const AUTO_PROTOCOLS = Object.freeze({
  codex: Object.freeze(['responses', 'chat', 'messages']),
  'claude-code': Object.freeze(['messages', 'responses', 'chat']),
});
const FEATURES = new Set(['generate', 'compact', 'countTokens']);
const AGENT_FEATURE_KEYS = Object.freeze([
  'compact',
  'continuation',
  'countTokens',
  'namespaceTools',
  'reasoningReplay',
  'stream',
  'terminal',
  'tools',
]);
const GENERATE_AGENT_FEATURES = Object.freeze(['stream', 'terminal', 'tools']);
const FEATURE_CLIENTS = Object.freeze({
  compact: 'codex',
  countTokens: 'claude-code',
});

function unknownFeatures() {
  return {
    generate: 'unknown',
    compact: 'unknown',
    continuation: 'unknown',
    countTokens: 'unknown',
    namespaceTools: 'unknown',
    reasoningReplay: 'unknown',
    stream: 'unknown',
    terminal: 'unknown',
    tools: 'unknown',
  };
}

function capabilityFeatures(capability) {
  const features = unknownFeatures();
  if (!capability) return features;
  features.generate = capability.status;
  for (const key of AGENT_FEATURE_KEYS) features[key] = capability.agentFeatures[key];
  return features;
}

function routeResult({
  ok = false,
  upstreamProtocol = null,
  clientProtocol = null,
  conversion = null,
  capability = null,
  reasonCode,
} = {}) {
  return {
    ok,
    upstreamProtocol,
    clientProtocol,
    conversion,
    apiRoot: ok ? capability.apiRoot : null,
    auth: ok && capability.auth ? { ...capability.auth } : null,
    compatibility: ok && capability.compatibility ? { ...capability.compatibility } : null,
    features: capabilityFeatures(capability),
    reasonCode,
  };
}

function currentTime(now) {
  if (now === undefined) return Date.now();
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(value) || value < 0) throw new TypeError('now must resolve to a timestamp');
  return value;
}

function capabilityKnowledge(provider, model, protocol, now) {
  const capability = model?.[protocol] || null;
  if (!capability || capability.status === 'unknown') {
    return { state: 'unknown', capability };
  }
  if (
    capability.requestProfileRevision !== provider.requestProfileRevision
    || capability.modelListRevision !== provider.modelList.revision
    || capability.checkedAt > now
    || (capability.validUntil !== null && capability.validUntil < now)
  ) {
    return { state: 'stale', capability };
  }
  return { state: 'current', capability };
}

function evaluateCandidate(provider, model, protocol, feature, now, requireAgentReady) {
  const knowledge = capabilityKnowledge(provider, model, protocol, now);
  if (knowledge.state !== 'current') return { outcome: 'needs-probe', ...knowledge };
  const { capability } = knowledge;
  if (capability.status === 'unsupported') return { outcome: 'unavailable', ...knowledge };
  const required = feature === 'generate'
    ? (requireAgentReady ? GENERATE_AGENT_FEATURES : [])
    : [feature];
  const statuses = required.map((name) => capability.agentFeatures[name]);
  if (statuses.includes('unsupported')) return { outcome: 'unavailable', ...knowledge };
  if (statuses.includes('unknown')) return { outcome: 'needs-probe', ...knowledge };
  return { outcome: 'selected', ...knowledge };
}

function conversionFor(clientProtocol, upstreamProtocol) {
  return clientProtocol === upstreamProtocol
    ? 'native'
    : `${clientProtocol}-to-${upstreamProtocol}`;
}

function successfulRoute(clientProtocol, upstreamProtocol, capability, reasonCode) {
  return routeResult({
    ok: true,
    upstreamProtocol,
    clientProtocol,
    conversion: conversionFor(clientProtocol, upstreamProtocol),
    capability,
    reasonCode,
  });
}

export function selectProviderRoute(provider, {
  client,
  modelId,
  feature = 'generate',
  now,
  requireAgentReady = true,
} = {}) {
  const clientProtocol = CLIENT_PROTOCOLS[client] || null;
  const selectedModelId = typeof modelId === 'string' ? modelId.trim() : '';
  if (!clientProtocol || !selectedModelId || !FEATURES.has(feature)
      || typeof requireAgentReady !== 'boolean') {
    return routeResult({ clientProtocol, reasonCode: 'invalid-request' });
  }

  let timestamp;
  try { timestamp = currentTime(now); } catch {
    return routeResult({ clientProtocol, reasonCode: 'invalid-request' });
  }

  let normalized;
  try { normalized = normalizeProviderEntryV3(provider); } catch {
    return routeResult({ clientProtocol, reasonCode: 'invalid-provider' });
  }
  const model = normalized.modelCapabilities.find((entry) => entry.modelId === selectedModelId);
  const override = normalized.routeOverrides.find((entry) => (
    entry.client === client && entry.modelId === selectedModelId
  ));

  if (feature !== 'generate' && FEATURE_CLIENTS[feature] !== client) {
    return routeResult({ clientProtocol, reasonCode: 'unavailable' });
  }

  if (override) {
    if (feature !== 'generate' && override.protocol !== clientProtocol) {
      return routeResult({
        upstreamProtocol: override.protocol,
        clientProtocol,
        capability: model?.[override.protocol] || null,
        reasonCode: 'unavailable',
      });
    }
    const evaluated = evaluateCandidate(
      normalized,
      model,
      override.protocol,
      feature,
      timestamp,
      requireAgentReady,
    );
    if (evaluated.outcome === 'selected') {
      return successfulRoute(
        clientProtocol,
        override.protocol,
        evaluated.capability,
        'override-selected',
      );
    }
    return routeResult({
      upstreamProtocol: override.protocol,
      clientProtocol,
      capability: evaluated.capability,
      reasonCode: evaluated.outcome,
    });
  }

  const protocols = feature === 'generate' ? AUTO_PROTOCOLS[client] : [clientProtocol];
  let pendingProbe = null;
  for (const protocol of protocols) {
    const evaluated = evaluateCandidate(
      normalized,
      model,
      protocol,
      feature,
      timestamp,
      requireAgentReady,
    );
    if (evaluated.outcome === 'selected') {
      return successfulRoute(clientProtocol, protocol, evaluated.capability, 'selected');
    }
    if (evaluated.outcome === 'needs-probe' && !pendingProbe) {
      pendingProbe = { protocol, capability: evaluated.capability };
    }
  }
  if (pendingProbe) {
    return routeResult({
      upstreamProtocol: pendingProbe.protocol,
      clientProtocol,
      capability: pendingProbe.capability,
      reasonCode: 'needs-probe',
    });
  }
  return routeResult({ clientProtocol, reasonCode: 'unavailable' });
}

export function providerRouteLabel(route, lang = 'zh') {
  if (!route?.ok || !['responses', 'chat', 'messages'].includes(route.upstreamProtocol)) {
    return null;
  }
  const direct = route.conversion === 'native';
  const names = lang === 'en'
    ? { responses: 'Responses', chat: 'Chat', messages: 'Messages' }
    : { responses: 'Responses', chat: 'Chat', messages: 'Messages' };
  const suffix = lang === 'en'
    ? (direct ? 'direct' : 'conversion')
    : (direct ? '直连' : '转换');
  return `${names[route.upstreamProtocol]} ${suffix}`;
}
