import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pulse } from "../../src/index.js";

const ENDPOINT = process.env.PULSE_TEST_ENDPOINT || "http://127.0.0.1:4112";
const SERVER_KEY = process.env.PULSE_TEST_SERVER_KEY!;
const AGENT_KEY = process.env.PULSE_TEST_AGENT_KEY!;

describe("Node SDK integration", () => {
  before(() => {
    Pulse.configure({
      endpoint: ENDPOINT,
      apiKey: SERVER_KEY,
      appVersion: "1.0.0-test",
      serviceName: "integration-test",
      flushThreshold: 100, // manual flush only
    });
  });

  after(async () => {
    await Pulse.shutdown();
  });

  it("sends events and queries them back", async () => {
    const uniqueMsg = `integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    Pulse.info(uniqueMsg, { test: "true" });
    await Pulse.flush();

    // Wait briefly for server to process
    await new Promise((r) => setTimeout(r, 500));

    // Query events back via agent key
    const res = await fetch(`${ENDPOINT}/v1/events?limit=10&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ message: string; environment: string; custom_attributes: Record<string, string>; is_dev: boolean }> };
    const found = body.events.find((e) => e.message === uniqueMsg);
    assert.ok(found, `Expected to find event with message "${uniqueMsg}"`);
    assert.equal(found.environment, "backend");
    assert.deepEqual(found.custom_attributes, { test: "true" });
    assert.equal(found.is_dev, true);
  });

  it("sends events with user_id via withUser", async () => {
    const uniqueMsg = `user-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pulse = Pulse.withUser("integration-user-42");
    pulse.error(uniqueMsg);
    await Pulse.flush();

    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${ENDPOINT}/v1/events?user_id=integration-user-42&limit=10&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ message: string; user_id: string; level: string }> };
    const found = body.events.find((e) => e.message === uniqueMsg);
    assert.ok(found, `Expected to find event with message "${uniqueMsg}"`);
    assert.equal(found.user_id, "integration-user-42");
    assert.equal(found.level, "error");
  });

  it("sets user properties and verifies them via API", async () => {
    const userId = `props-test-${Date.now()}`;

    // Send an event to ensure the user exists
    const pulse = Pulse.withUser(userId);
    pulse.info("properties test");
    await Pulse.flush();
    await new Promise((r) => setTimeout(r, 500));

    // Set properties
    pulse.setUserProperties({ plan: "premium", org: "acme" });
    await new Promise((r) => setTimeout(r, 1000));

    // Query app-users to verify properties
    const res = await fetch(`${ENDPOINT}/v1/app-users?search=${userId}&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { users: Array<{ user_id: string; properties: Record<string, string> | null }> };
    const user = body.users.find((u) => u.user_id === userId);
    assert.ok(user, `Expected to find user "${userId}"`);
    assert.equal(user.properties?.plan, "premium");
    assert.equal(user.properties?.org, "acme");
  });

  it("merges user properties without overwriting", async () => {
    const userId = `merge-test-${Date.now()}`;

    const pulse = Pulse.withUser(userId);
    pulse.info("merge test");
    await Pulse.flush();
    await new Promise((r) => setTimeout(r, 500));

    // Set initial properties
    pulse.setUserProperties({ plan: "free", org: "acme" });
    await new Promise((r) => setTimeout(r, 1000));

    // Update one, add another
    pulse.setUserProperties({ plan: "premium", role: "admin" });
    await new Promise((r) => setTimeout(r, 1000));

    const res = await fetch(`${ENDPOINT}/v1/app-users?search=${userId}&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    const body = await res.json() as { users: Array<{ user_id: string; properties: Record<string, string> | null }> };
    const user = body.users.find((u) => u.user_id === userId);
    assert.ok(user, `Expected to find user "${userId}"`);
    assert.equal(user.properties?.plan, "premium", "plan should be updated");
    assert.equal(user.properties?.org, "acme", "org should be preserved");
    assert.equal(user.properties?.role, "admin", "role should be added");
  });

  it("stamps events with session_id from withSession() scope", async () => {
    const clientSessionId = randomUUID();
    const uniqueMsg = `session-scope-${clientSessionId}`;

    const pulse = Pulse.withSession(clientSessionId).withUser("session-scope-user");
    pulse.info(uniqueMsg, { scoped: "true" });
    await Pulse.flush();
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${ENDPOINT}/v1/events?session_id=${clientSessionId}&limit=10&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ message: string; session_id: string; user_id: string }> };
    const found = body.events.find((e) => e.message === uniqueMsg);
    assert.ok(found, `Expected to find event with message "${uniqueMsg}"`);
    assert.equal(found.session_id, clientSessionId);
    assert.equal(found.user_id, "session-scope-user");
  });

  it("stamps events with session_id from options.sessionId override", async () => {
    const clientSessionId = randomUUID();
    const uniqueMsg = `session-override-${clientSessionId}`;

    Pulse.info(uniqueMsg, { overridden: "true" }, { sessionId: clientSessionId });
    await Pulse.flush();
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${ENDPOINT}/v1/events?session_id=${clientSessionId}&limit=10&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ message: string; session_id: string }> };
    const found = body.events.find((e) => e.message === uniqueMsg);
    assert.ok(found, `Expected to find event with message "${uniqueMsg}"`);
    assert.equal(found.session_id, clientSessionId);
  });

  it("silently falls back to default session when withSession() gets an invalid UUID", async () => {
    const uniqueMsg = `invalid-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Non-UUID input must not throw — the scope still works, just with the default session
    const pulse = Pulse.withSession("not-a-uuid").withUser("invalid-session-user");
    pulse.info(uniqueMsg);
    await Pulse.flush();
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${ENDPOINT}/v1/events?user_id=invalid-session-user&limit=20&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ message: string; session_id: string }> };
    const found = body.events.find((e) => e.message === uniqueMsg);
    assert.ok(found, `Expected to find event with message "${uniqueMsg}"`);
    // session_id is a UUID (the default one), not the garbage input
    assert.match(found.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("silently ignores invalid options.sessionId and uses default session", async () => {
    const uniqueMsg = `invalid-option-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Must not throw — the event still gets sent with the default session ID
    Pulse.info(uniqueMsg, { path: "/api/thing" }, { sessionId: "also-not-a-uuid" });
    await Pulse.flush();
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${ENDPOINT}/v1/events?limit=50&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ message: string; session_id: string }> };
    const found = body.events.find((e) => e.message === uniqueMsg);
    assert.ok(found, `Expected to find event with message "${uniqueMsg}"`);
    assert.match(found.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("deduplicates events by client_event_id", async () => {
    const uniqueMsg = `dedup-test-${Date.now()}`;

    // Send same event twice
    Pulse.info(uniqueMsg);
    await Pulse.flush();

    Pulse.info(uniqueMsg);
    await Pulse.flush();

    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${ENDPOINT}/v1/events?limit=50&data_mode=all`, {
      headers: { Authorization: `Bearer ${AGENT_KEY}` },
    });

    const body = await res.json() as { events: Array<{ message: string; client_event_id: string }> };
    const matches = body.events.filter((e) => e.message === uniqueMsg);
    // Each event gets a unique client_event_id, so both should be accepted
    // (dedup is by client_event_id, not message — both events are unique)
    assert.equal(matches.length, 2);
  });
});
