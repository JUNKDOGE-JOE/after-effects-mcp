const PROTOCOLS = new Set(['responses', 'chat', 'messages']);
const CAPABILITY_STATUSES = new Set(['unknown', 'supported', 'unsupported']);
const AGENT_FEATURES = Object.freeze([
  'compact',
  'continuation',
  'countTokens',
  'namespaceTools',
  'reasoningReplay',
  'stream',
  'terminal',
  'tools',
]);
const ROUTE_FEATURES = Object.freeze(['generate', ...AGENT_FEATURES]);
const ROUTE_REASON_CODES = new Set([
  'invalid-request',
  'invalid-provider',
  'needs-probe',
  'override-selected',
  'selected',
  'unavailable',
]);
const PROBE_REASONS = new Set([
  'authentication',
  'capability-incompatible',
  'configuration',
  'network',
  'path-unsupported',
]);
const PROBE_SUPPORT = new Set([
  'authentication',
  'invalid',
  'supported',
  'transient',
  'unsupported',
]);
const PROBE_ERROR_CLASSES = new Set([
  'authentication',
  'configuration',
  'endpoint-unsupported',
  'invalid-schema',
  'model-unsupported',
  'network',
  'protocol-unsupported',
  'rate-limited',
  'request-rejected',
  'upstream-transient',
]);
const CLIENTS = Object.freeze({
  responses: 'codex',
  messages: 'claude-code',
});

function bridgeError(code) {
  const messages = {
    PROVIDER_ACCEPTANCE_BRIDGE_DISPOSED: 'Provider acceptance bridge is disposed.',
    PROVIDER_ACCEPTANCE_CALLBACK_FAILED: 'Provider acceptance state refresh failed.',
    PROVIDER_ACCEPTANCE_INVALID_MODELS: 'Provider acceptance model list is invalid.',
    PROVIDER_ACCEPTANCE_PROVIDER_NOT_FOUND: 'Provider was not found.',
    PROVIDER_ACCEPTANCE_PROBE_FAILED: 'Provider acceptance probe failed.',
    PROVIDER_ACCEPTANCE_ROUTE_CLOSE_FAILED: 'Provider acceptance route did not close cleanly.',
    PROVIDER_ACCEPTANCE_ROUTE_FAILED: 'Provider acceptance route failed.',
    PROVIDER_ACCEPTANCE_STORE_CONFLICT: 'Provider store changed during acceptance probing.',
    PROVIDER_ACCEPTANCE_STORE_UNAVAILABLE: 'Provider acceptance state is unavailable.',
  };
  const error = new Error(messages[code] || messages.PROVIDER_ACCEPTANCE_STORE_UNAVAILABLE);
  error.code = messages[code] ? code : 'PROVIDER_ACCEPTANCE_STORE_UNAVAILABLE';
  return error;
}

function dependency(name, value, predicate) {
  if (!predicate(value)) throw new TypeError(`${name} is required`);
  return value;
}

function safeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeStatus(value) {
  return CAPABILITY_STATUSES.has(value) ? value : 'unknown';
}

function agentFeatureSummary(value) {
  return Object.fromEntries(AGENT_FEATURES.map((name) => [name, safeStatus(value?.[name])]));
}

function routeFeatureSummary(value) {
  return Object.fromEntries(ROUTE_FEATURES.map((name) => [name, safeStatus(value?.[name])]));
}

function capabilitySummary(value) {
  return {
    status: safeStatus(value?.status),
    requestProfileRevision: safeRevision(value?.requestProfileRevision),
    modelListRevision: safeRevision(value?.modelListRevision),
    agentFeatures: agentFeatureSummary(value?.agentFeatures),
  };
}

function modelIdOf(value) {
  const modelId = typeof value === 'string' ? value : value?.id;
  return typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;
}

function providerSummary(provider) {
  const modelIds = [];
  const seen = new Set();
  const addModelId = (value) => {
    const modelId = modelIdOf(value);
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    modelIds.push(modelId);
  };
  for (const model of provider?.modelList?.models || []) addModelId(model);
  for (const capability of provider?.modelCapabilities || []) addModelId(capability?.modelId);
  return {
    id: typeof provider?.id === 'string' ? provider.id : '',
    name: typeof provider?.name === 'string' ? provider.name : '',
    revisions: {
      requestProfile: safeRevision(provider?.requestProfileRevision),
      modelList: safeRevision(provider?.modelList?.revision),
    },
    modelListStatus: safeStatus(provider?.modelList?.status),
    modelIds,
    capabilities: (provider?.modelCapabilities || []).flatMap((entry) => {
      const modelId = modelIdOf(entry?.modelId);
      if (!modelId) return [];
      return [{
        modelId,
        responses: capabilitySummary(entry.responses),
        chat: capabilitySummary(entry.chat),
        messages: capabilitySummary(entry.messages),
      }];
    }),
  };
}

function routeSummary(route, clientProtocol) {
  const upstreamProtocol = PROTOCOLS.has(route?.upstreamProtocol)
    ? route.upstreamProtocol
    : null;
  const ok = route?.ok === true && upstreamProtocol !== null;
  const reasonCode = ROUTE_REASON_CODES.has(route?.reasonCode)
    ? route.reasonCode
    : (ok ? 'selected' : 'unavailable');
  return {
    ok,
    clientProtocol,
    upstreamProtocol,
    conversion: ok
      ? (clientProtocol === upstreamProtocol
        ? 'native'
        : `${clientProtocol}-to-${upstreamProtocol}`)
      : null,
    reasonCode,
    features: routeFeatureSummary(route?.features),
  };
}

function probeReason(value) {
  return PROBE_REASONS.has(value) ? value : 'probe-failed';
}

function probeDiagnostic(value) {
  const protocols = {};
  for (const protocol of PROTOCOLS) {
    const capability = value?.capabilities?.[protocol];
    protocols[protocol] = {
      support: PROBE_SUPPORT.has(capability?.support) ? capability.support : 'invalid',
      errorClass: PROBE_ERROR_CLASSES.has(capability?.errorClass) ? capability.errorClass : null,
      nonStreaming: ['valid', 'invalid', 'not-tested'].includes(capability?.schema?.nonStreaming)
        ? capability.schema.nonStreaming
        : 'not-tested',
      agentFeatures: agentFeatureSummary(capability?.agentFeatures),
    };
  }
  return {
    protocols,
    attempts: Array.isArray(value?.tried) ? value.tried.flatMap((entry) => {
      if (typeof entry?.step !== 'string' || !entry.step) return [];
      return [{
        step: entry.step.slice(0, 80),
        status: Number.isInteger(entry.status) ? entry.status : 0,
        outcome: ['network', 'received'].includes(entry.outcome) ? entry.outcome : 'unknown',
      }];
    }).slice(0, 128) : [],
  };
}

function modelIdsForProbe(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw bridgeError('PROVIDER_ACCEPTANCE_INVALID_MODELS');
  }
  const output = [];
  const seen = new Set();
  for (const raw of value) {
    const modelId = typeof raw === 'string' ? raw.trim() : '';
    if (!modelId || modelId.length > 512 || /[\0\r\n]/.test(modelId)) {
      throw bridgeError('PROVIDER_ACCEPTANCE_INVALID_MODELS');
    }
    if (!seen.has(modelId)) {
      seen.add(modelId);
      output.push(modelId);
    }
  }
  return output;
}

function localRouteInfo(value) {
  let parsed;
  try { parsed = new URL(value?.origin); } catch {
    throw bridgeError('PROVIDER_ACCEPTANCE_ROUTE_FAILED');
  }
  const origin = parsed.origin;
  const loopback = ['127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  if (
    parsed.protocol !== 'http:'
    || !loopback
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || value?.origin !== origin
    || value?.openaiBaseUrl !== `${origin}/v1`
    || value?.anthropicBaseUrl !== origin
    || typeof value?.routeToken !== 'string'
    || !/^\S{16,512}$/.test(value.routeToken)
  ) {
    throw bridgeError('PROVIDER_ACCEPTANCE_ROUTE_FAILED');
  }
  return {
    origin,
    openaiBaseUrl: `${origin}/v1`,
    anthropicBaseUrl: origin,
    routeToken: value.routeToken,
  };
}

function mappedOperationalError(error, fallbackCode) {
  return bridgeError(error?.code === 'PROVIDER_STORE_CONFLICT'
    ? 'PROVIDER_ACCEPTANCE_STORE_CONFLICT'
    : fallbackCode);
}

export function createProviderAcceptanceBridge({
  store,
  secretService,
  runProviderManagerProbe,
  createUniversalProviderRoute,
  selectProviderRoute,
  resolveProviderRequestProfile,
  onProvidersChanged = () => {},
} = {}) {
  dependency('store', store, (value) => value
    && typeof value.list === 'function'
    && typeof value.get === 'function'
    && typeof value.readState === 'function'
    && typeof value.upsert === 'function');
  dependency('secretService', secretService, (value) => value && typeof value.resolve === 'function');
  dependency('runProviderManagerProbe', runProviderManagerProbe, (value) => typeof value === 'function');
  dependency('createUniversalProviderRoute', createUniversalProviderRoute, (value) => typeof value === 'function');
  dependency('selectProviderRoute', selectProviderRoute, (value) => typeof value === 'function');
  dependency('resolveProviderRequestProfile', resolveProviderRequestProfile, (value) => typeof value === 'function');
  dependency('onProvidersChanged', onProvidersChanged, (value) => typeof value === 'function');

  let activeRoute = null;
  let disposed = false;
  let disposePromise = null;
  let routeQueue = Promise.resolve();

  const readRevision = () => {
    try { return safeRevision(store.readState().revision); } catch {
      throw bridgeError('PROVIDER_ACCEPTANCE_STORE_UNAVAILABLE');
    }
  };

  const readProvider = (providerId) => {
    let provider;
    try { provider = store.get(String(providerId || '').trim()); } catch {
      throw bridgeError('PROVIDER_ACCEPTANCE_STORE_UNAVAILABLE');
    }
    if (!provider) throw bridgeError('PROVIDER_ACCEPTANCE_PROVIDER_NOT_FOUND');
    return provider;
  };

  const snapshot = () => {
    try {
      return {
        revision: safeRevision(store.readState().revision),
        providers: store.list().map(providerSummary),
      };
    } catch (error) {
      if (error?.code?.startsWith('PROVIDER_ACCEPTANCE_')) throw error;
      throw bridgeError('PROVIDER_ACCEPTANCE_STORE_UNAVAILABLE');
    }
  };

  const notifyProvidersChanged = async () => {
    try { await onProvidersChanged(snapshot()); } catch {
      throw bridgeError('PROVIDER_ACCEPTANCE_CALLBACK_FAILED');
    }
  };

  const assertUsable = () => {
    if (disposed) throw bridgeError('PROVIDER_ACCEPTANCE_BRIDGE_DISPOSED');
  };

  const summarizeSelectedRoutes = (provider, modelId) => ({
    codex: routeSummary(selectProviderRoute(provider, {
      client: 'codex',
      modelId,
      feature: 'generate',
    }), 'responses'),
    claude: routeSummary(selectProviderRoute(provider, {
      client: 'claude-code',
      modelId,
      feature: 'generate',
    }), 'messages'),
  });

  const routes = (providerId, rawModelIds) => {
    assertUsable();
    const wantedProviderId = String(providerId || '').trim();
    const modelIds = modelIdsForProbe(rawModelIds);
    const provider = readProvider(wantedProviderId);
    return {
      providerId: wantedProviderId,
      storeRevision: readRevision(),
      results: modelIds.map((modelId) => ({
        modelId,
        routes: summarizeSelectedRoutes(provider, modelId),
      })),
    };
  };

  const probeAll = async (providerId, rawModelIds) => {
    assertUsable();
    const wantedProviderId = String(providerId || '').trim();
    const modelIds = modelIdsForProbe(rawModelIds);
    readProvider(wantedProviderId);
    const initialRevision = readRevision();
    let changed = false;
    const results = [];
    try {
      for (const modelId of modelIds) {
        const provider = readProvider(wantedProviderId);
        const beforeRevision = readRevision();
        const probe = await runProviderManagerProbe(provider, {
          store,
          modelId,
          forceDetect: true,
          resolveRequestProfile: (entry, details) => resolveProviderRequestProfile(entry, {
            ...details,
            secretService,
          }),
        });
        const afterRevision = readRevision();
        changed = changed || beforeRevision !== afterRevision;
        const current = readProvider(wantedProviderId);
        const preferredProtocol = PROTOCOLS.has(probe?.preferredProtocol)
          ? probe.preferredProtocol
          : null;
        results.push({
          modelId,
          ok: probe?.ok === true,
          persisted: beforeRevision !== afterRevision,
          storeRevision: afterRevision,
          reason: probe?.ok === true ? null : probeReason(probe?.reason),
          preferredProtocol,
          diagnostic: probeDiagnostic(probe?.result),
          routes: summarizeSelectedRoutes(current, modelId),
        });
      }
    } catch (error) {
      changed = changed || readRevision() !== initialRevision;
      if (changed) {
        try { await notifyProvidersChanged(); } catch {}
      }
      throw mappedOperationalError(error, 'PROVIDER_ACCEPTANCE_PROBE_FAILED');
    }
    if (changed) await notifyProvidersChanged();
    return {
      providerId: wantedProviderId,
      storeRevision: readRevision(),
      results,
    };
  };

  const enqueueRoute = (operation) => {
    const next = routeQueue.then(operation, operation);
    routeQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  const closeActiveRoute = async () => {
    const closing = activeRoute;
    if (!closing) return { stopped: false, providerId: null };
    try { await closing.route.close(); } catch {
      throw bridgeError('PROVIDER_ACCEPTANCE_ROUTE_CLOSE_FAILED');
    }
    if (activeRoute === closing) activeRoute = null;
    return { stopped: true, providerId: closing.providerId };
  };

  const startRoute = (providerId) => enqueueRoute(async () => {
    assertUsable();
    await closeActiveRoute();
    const provider = readProvider(providerId);
    let route;
    try {
      route = createUniversalProviderRoute({
        provider,
        resolveCapability: ({ modelId, clientProtocol, feature = 'generate' }) => {
          const client = CLIENTS[clientProtocol];
          if (!client) {
            return {
              ok: false,
              upstreamProtocol: null,
              clientProtocol,
              reasonCode: 'invalid-request',
            };
          }
          return selectProviderRoute(provider, { client, modelId, feature });
        },
        resolveRequestProfile: (_entry, details) => resolveProviderRequestProfile(provider, {
          ...details,
          secretService,
        }),
      });
      if (!route || typeof route.start !== 'function' || typeof route.close !== 'function') {
        throw bridgeError('PROVIDER_ACCEPTANCE_ROUTE_FAILED');
      }
      activeRoute = { providerId: provider.id, route };
      const info = localRouteInfo(await route.start());
      return info;
    } catch (error) {
      let closed = false;
      try {
        await route?.close?.();
        closed = true;
      } catch {}
      if (closed && activeRoute?.route === route) activeRoute = null;
      if (error?.code?.startsWith('PROVIDER_ACCEPTANCE_')) throw error;
      throw bridgeError('PROVIDER_ACCEPTANCE_ROUTE_FAILED');
    }
  });

  const stopRoute = () => enqueueRoute(closeActiveRoute);

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = enqueueRoute(async () => {
      await closeActiveRoute();
      return { disposed: true };
    });
    return disposePromise;
  };

  return Object.freeze({ snapshot, routes, probeAll, startRoute, stopRoute, dispose });
}
