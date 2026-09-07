import type { PulseConfiguration } from "./types.js";

const CLIENT_KEY_PREFIX = "pulse_client_";

/**
 * Pubky's own hosted ingest host, used when the caller omits `endpoint`.
 *
 * The fallback is silent, so self-hosters must pass their own ingest host
 * explicitly — nothing warns them that their data went to Pubky instead.
 */
export const DEFAULT_ENDPOINT = "https://ingest.pubkypulse.com";

export interface ValidatedConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  appVersion?: string;
  debug: boolean;
  isDev: boolean;
  flushIntervalMs: number;
  flushThreshold: number;
  maxBufferSize: number;
  consoleLogging: boolean;
  captureUnhandled: boolean;
}

export function validateConfiguration(config: PulseConfiguration): ValidatedConfig {
  // Only an absent `endpoint` falls back to the default. Any other unusable
  // value — "", null, a number — is still an error: an explicitly supplied
  // empty value is almost always an environment variable that failed to load,
  // and silently redirecting that traffic to Pubky's hosted instance would send
  // a self-hoster's data to the wrong company with nothing to tell them.
  const supplied = config.endpoint === undefined ? DEFAULT_ENDPOINT : config.endpoint;
  if (!supplied || typeof supplied !== "string") {
    throw new Error("Pubky Pulse: endpoint is required");
  }

  let endpoint = supplied;
  // Strip trailing slash
  if (endpoint.endsWith("/")) {
    endpoint = endpoint.slice(0, -1);
  }

  try {
    new URL(endpoint);
  } catch {
    throw new Error(`Pubky Pulse: invalid endpoint URL: ${endpoint}`);
  }

  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new Error("Pubky Pulse: apiKey is required");
  }

  if (!config.apiKey.startsWith(CLIENT_KEY_PREFIX)) {
    throw new Error(`Pubky Pulse: apiKey must start with "${CLIENT_KEY_PREFIX}"`);
  }

  return {
    endpoint,
    apiKey: config.apiKey,
    serviceName: config.serviceName || "unknown",
    appVersion: config.appVersion,
    debug: config.debug ?? false,
    isDev: config.isDev ?? (process.env.NODE_ENV !== "production"),
    flushIntervalMs: config.flushIntervalMs ?? 5000,
    flushThreshold: config.flushThreshold ?? 20,
    maxBufferSize: config.maxBufferSize ?? 10000,
    consoleLogging: config.consoleLogging ?? true,
    captureUnhandled: config.captureUnhandled ?? true,
  };
}
