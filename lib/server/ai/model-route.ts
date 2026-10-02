import type { RuntimeBindings } from '@/db';

export type ModelProviderProfile = 'default' | 'reading';
export type ModelRouteSnapshot = {
  provider: string;
  model: string;
  providerProfile: ModelProviderProfile;
  providerBaseUrl: string | null;
};

/** Keep legacy/default fingerprints unchanged so existing paid artifacts are
 * reused. A separately configured reading service has its own identity. */
export function readingRouteIdentity(profile: unknown, baseUrl: unknown) {
  return profile === 'reading' ? {provider_profile:'reading',provider_base_url:baseUrl ?? null} : {};
}

/** Endpoints are non-secret route metadata. Credentials stay in bindings. */
export function modelBaseUrl(provider: string | undefined, configured?: string): string | null {
  const address = configured?.trim() || (provider === 'openai' ? 'https://api.openai.com/v1'
    : provider === 'deepseek' ? 'https://api.deepseek.com/v1' : '');
  if (!address) return null;
  try {
    const url = new URL(address);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function configuredRoute(bindings: RuntimeBindings, profile: ModelProviderProfile) {
  const reading = profile === 'reading';
  const provider = (reading ? bindings.AI_READING_PROVIDER : bindings.AI_PROVIDER)?.trim()
    || (reading ? bindings.AI_PROVIDER?.trim() : '') || '';
  // An explicit provider or endpoint uses its own key. Never forward the
  // primary credential to an independently configured service.
  const explicitReadingService = Boolean(bindings.AI_READING_PROVIDER?.trim() || bindings.AI_READING_API_BASE_URL?.trim());
  const configuredBase = reading
    ? bindings.AI_READING_API_BASE_URL?.trim() || (!explicitReadingService ? bindings.AI_API_BASE_URL : undefined)
    : bindings.AI_API_BASE_URL;
  const apiKey = reading ? bindings.AI_READING_API_KEY?.trim() : bindings.AI_API_KEY?.trim();
  return {provider, baseUrl:modelBaseUrl(provider,configuredBase), apiKey};
}

export function readingModelSnapshot(bindings: RuntimeBindings, fallback: {provider:string;model:string}): ModelRouteSnapshot {
  const providerProfile: ModelProviderProfile = [bindings.AI_READING_PROVIDER,bindings.AI_READING_API_BASE_URL,bindings.AI_READING_API_KEY]
    .some(value=>Boolean(value?.trim())) ? 'reading' : 'default';
  const route = configuredRoute(bindings,providerProfile);
  return {
    provider:route.provider || fallback.provider,
    model:bindings.AI_READING_MODEL?.trim() || fallback.model,
    providerProfile,
    providerBaseUrl:route.baseUrl,
  };
}

/** A retry uses its frozen route. Changed configuration pauses that lane
 * instead of sending an old response ID or another service's key elsewhere. */
export function resolveModelConnection(bindings: RuntimeBindings, execution: {
  provider?: string;
  model?: string;
  providerProfile?: ModelProviderProfile;
  providerBaseUrl?: string | null;
} = {}) {
  const profile = execution.providerProfile ?? 'default';
  const route = configuredRoute(bindings,profile);
  const provider = execution.provider?.trim() || route.provider;
  const model = execution.model?.trim() || (profile === 'reading' ? bindings.AI_READING_MODEL?.trim() : '') || bindings.AI_MODEL?.trim();
  if (!provider || !model || !route.apiKey || !route.baseUrl || provider !== route.provider) return null;
  // undefined denotes a historical task that has no route snapshot.
  if (execution.providerBaseUrl !== undefined && execution.providerBaseUrl !== route.baseUrl) return null;
  return {provider,model,apiKey:route.apiKey,baseUrl:route.baseUrl};
}
