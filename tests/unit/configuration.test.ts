import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENDPOINT, validateConfiguration } from "../../src/configuration.js";

describe("validateConfiguration", () => {
  const validConfig = {
    endpoint: "http://localhost:4000",
    apiKey: "pulse_client_test_key_1234567890123456",
  };

  it("accepts valid configuration", () => {
    const result = validateConfiguration(validConfig);
    assert.equal(result.endpoint, "http://localhost:4000");
    assert.equal(result.apiKey, validConfig.apiKey);
    assert.equal(result.debug, false);
    assert.equal(result.flushIntervalMs, 5000);
    assert.equal(result.flushThreshold, 20);
    assert.equal(result.maxBufferSize, 10000);
  });

  it("strips trailing slash from endpoint", () => {
    const result = validateConfiguration({ ...validConfig, endpoint: "http://localhost:4000/" });
    assert.equal(result.endpoint, "http://localhost:4000");
  });

  it("rejects an explicitly empty endpoint", () => {
    assert.throws(
      () => validateConfiguration({ ...validConfig, endpoint: "" }),
      /endpoint is required/,
    );
    assert.throws(
      () => validateConfiguration({ ...validConfig, endpoint: null as unknown as string }),
      /endpoint is required/,
    );
    assert.throws(
      () => validateConfiguration({ ...validConfig, endpoint: 42 as unknown as string }),
      /endpoint is required/,
    );
  });

  it("falls back to the default endpoint when endpoint is omitted", () => {
    const { endpoint: _omitted, ...withoutEndpoint } = validConfig;
    const result = validateConfiguration(withoutEndpoint);
    assert.equal(result.endpoint, "https://ingest.pubkypulse.com");
  });

  it("falls back to the default endpoint when endpoint is explicitly undefined", () => {
    const result = validateConfiguration({ ...validConfig, endpoint: undefined });
    assert.equal(result.endpoint, "https://ingest.pubkypulse.com");
  });

  it("prefers a supplied endpoint over the default", () => {
    const result = validateConfiguration({ ...validConfig, endpoint: "https://pulse.example.com" });
    assert.equal(result.endpoint, "https://pulse.example.com");
  });

  it("exposes the default endpoint constant", () => {
    assert.equal(DEFAULT_ENDPOINT, "https://ingest.pubkypulse.com");
  });

  it("rejects invalid endpoint URL", () => {
    assert.throws(
      () => validateConfiguration({ ...validConfig, endpoint: "not-a-url" }),
      /invalid endpoint URL/,
    );
  });

  it("rejects empty apiKey", () => {
    assert.throws(
      () => validateConfiguration({ ...validConfig, apiKey: "" }),
      /apiKey is required/,
    );
  });

  it("rejects agent key prefix", () => {
    assert.throws(
      () => validateConfiguration({ ...validConfig, apiKey: "pulse_agent_abc123" }),
      /must start with "pulse_client_"/,
    );
  });

  it("rejects arbitrary key prefix", () => {
    assert.throws(
      () => validateConfiguration({ ...validConfig, apiKey: "some_random_key" }),
      /must start with "pulse_client_"/,
    );
  });

  it("applies custom options", () => {
    const result = validateConfiguration({
      ...validConfig,
      serviceName: "api-server",
      appVersion: "2.0.0",
      debug: true,
      flushIntervalMs: 1000,
      flushThreshold: 50,
      maxBufferSize: 5000,
    });

    assert.equal(result.serviceName, "api-server");
    assert.equal(result.appVersion, "2.0.0");
    assert.equal(result.debug, true);
    assert.equal(result.flushIntervalMs, 1000);
    assert.equal(result.flushThreshold, 50);
    assert.equal(result.maxBufferSize, 5000);
  });

  it("defaults serviceName to 'unknown'", () => {
    const result = validateConfiguration(validConfig);
    assert.equal(result.serviceName, "unknown");
  });
});
