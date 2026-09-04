# @synonymdev/pubky-pulse-node

Pubky Pulse Node.js server SDK — logging, errors, metrics and funnels for backend services.

[![Test](https://github.com/Jasonvdb/pubky-pulse-node/actions/workflows/test.yml/badge.svg)](https://github.com/Jasonvdb/pubky-pulse-node/actions/workflows/test.yml)

Zero runtime dependencies. Works with any Node.js framework, and on serverless runtimes.

## Install

```bash
npm install @synonymdev/pubky-pulse-node
# pnpm add @synonymdev/pubky-pulse-node
# yarn add @synonymdev/pubky-pulse-node
```

Requires Node.js 20+.

## Quick start

ESM:

```js
import { Pulse } from "@synonymdev/pubky-pulse-node";
```

CommonJS:

```js
const { Pulse } = require("@synonymdev/pubky-pulse-node");
```

Configure once at process start, then log from anywhere:

```js
Pulse.configure({
  endpoint: "https://api.pulse.pubky.org",
  apiKey: "pulse_client_...",
  serviceName: "api",
  appVersion: "1.4.2",
});

// Log events
Pulse.info("User signed up", { screen: "onboarding" });
Pulse.error(new Error("Payment failed"), "Checkout failed", { orderId: "abc123" });

// Track metrics
const op = Pulse.startOperation("api-request");
// ... do work ...
op.complete({ route: "/users" });

// Record funnel steps
Pulse.step("signup-started");

// Scope events to a user and a browser/app session
Pulse.withUser("user_123").withSession(sessionIdFromHeader).info("Cart updated");
```

## Use it in your environment

Create one module that configures the SDK exactly once and export it — importing that
module from your handlers avoids reconfiguring on every request.

```ts
// lib/pulse-server.ts
import { Pulse } from "@synonymdev/pubky-pulse-node";

Pulse.configure({
  endpoint: process.env.PULSE_ENDPOINT!,
  apiKey: process.env.PULSE_API_KEY!,
  serviceName: "web",
  appVersion: process.env.APP_VERSION,
});

export { Pulse };
```

### Express

```js
import express from "express";
import { Pulse } from "./lib/pulse-server.js";

const app = express();

app.use((req, _res, next) => {
  const sessionId = req.get("x-pulse-session-id");
  req.pulse = sessionId ? Pulse.withSession(sessionId) : Pulse;
  next();
});

app.post("/api/checkout", async (req, res) => {
  // req.user is populated by your auth middleware.
  const pulse = req.pulse.withUser(req.user.id);
  const op = pulse.startOperation("checkout", { item: req.body.item });
  try {
    const receipt = await charge(req.body);
    op.complete({ item: req.body.item });
    res.json(receipt);
  } catch (err) {
    pulse.error(err, "Checkout failed", { item: req.body.item });
    op.fail("charge_failed");
    res.status(500).json({ error: "Checkout failed" });
  }
});

// Drain the buffer on shutdown so in-flight events are not lost.
process.on("SIGTERM", async () => {
  await Pulse.shutdown();
  process.exit(0);
});
```

### Fastify

```js
import Fastify from "fastify";
import { Pulse } from "./lib/pulse-server.js";

const fastify = Fastify();

fastify.decorateRequest("pulse", null);
fastify.addHook("onRequest", async (request) => {
  const sessionId = request.headers["x-pulse-session-id"];
  request.pulse = sessionId ? Pulse.withSession(sessionId) : Pulse;
});

fastify.post("/api/greet", async (request) => {
  // request.user comes from your auth plugin.
  const pulse = request.pulse.withUser(request.user.id);
  pulse.info("Greeted", { name: request.body.name });
  return { message: `Hello, ${request.body.name}!` };
});

fastify.addHook("onClose", async () => {
  await Pulse.shutdown();
});
```

### Next.js — App Router route handler

```ts
// app/api/checkout/route.ts
import { getSession } from "@/lib/auth";
import { Pulse } from "@/lib/pulse-server";

export async function POST(req: Request) {
  const body = await req.json();
  // The user identity comes from your session helper, never from the body.
  const session = await getSession();
  const sessionId = req.headers.get("x-pulse-session-id");
  const pulse = sessionId
    ? Pulse.withUser(session.userId).withSession(sessionId)
    : Pulse.withUser(session.userId);

  const op = pulse.startOperation("checkout", { item: body.item });
  try {
    const receipt = await charge(body);
    op.complete();
    return Response.json(receipt);
  } catch (err) {
    pulse.error(err, "Checkout failed");
    op.fail("charge_failed");
    return Response.json({ error: "Checkout failed" }, { status: 500 });
  }
}
```

On a long-running server the SDK flushes on its own interval, but on serverless hosts
(Vercel functions, Lambda) wrap the handler with `Pulse.wrapHandler` so the buffer is
flushed before the function is frozen — see
[AWS Lambda / Vercel functions](#aws-lambda--vercel-functions) below.

### Next.js — server action

```ts
"use server";

import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { Pulse } from "@/lib/pulse-server";

export async function submitFeedback(message: string) {
  // The user identity comes from your session helper, never from the caller.
  const session = await getSession();
  const sessionId = (await headers()).get("x-pulse-session-id");
  const pulse = sessionId
    ? Pulse.withUser(session.userId).withSession(sessionId)
    : Pulse.withUser(session.userId);

  pulse.step("feedback-submitted");
  await pulse.sendFeedback(message);
}
```

The same applies here: on serverless hosts (Vercel functions, Lambda) wrap the handler with
`Pulse.wrapHandler` so the buffer is flushed before the function is frozen — see
[AWS Lambda / Vercel functions](#aws-lambda--vercel-functions) below.

### AWS Lambda / Vercel functions

Serverless runtimes can freeze the process the moment a handler returns, so the
background flush timer may never fire. Wrap the handler — `wrapHandler` awaits a flush in
a `finally` block, so buffered events leave before the runtime suspends.

```js
import { Pulse } from "./lib/pulse-server.js";

export const handler = Pulse.wrapHandler(async (event) => {
  // The caller's identity comes from the authorizer context.
  const userId = event.requestContext.authorizer.userId;
  const sessionId = event.headers?.["x-pulse-session-id"];
  const pulse = sessionId
    ? Pulse.withUser(userId).withSession(sessionId)
    : Pulse.withUser(userId);
  pulse.info("Job started", { jobId: event.jobId });
  const result = await run(event);
  return { statusCode: 200, body: JSON.stringify(result) };
});
```

### Pairing with the browser SDK

The browser half of Pubky Pulse is
[`@synonymdev/pubky-pulse-web`](https://github.com/Jasonvdb/pubky-pulse-web). It sends an
`X-Pulse-Session-Id` header with requests to your backend; pass that value into
`Pulse.withSession(...)` as shown above and browser and server events land on one session
timeline. Non-UUID values are ignored (the scope falls back to the process session ID), so
an untrusted header can never crash a handler.

## Logging

Four levels, all with the same shape. Attribute values are strings and are truncated if
they get long.

```js
Pulse.debug("Cache miss", { key });
Pulse.info("Order placed", { orderId, total: String(total) });
Pulse.warn("Payment gateway slow", { ms: String(elapsed) });
Pulse.error("Queue backed up", { depth: String(depth) });
```

Set `consoleLogging: false` to stop the SDK echoing events to the console, and
`debug: true` to see the SDK's own diagnostics.

## Errors

`error()` takes either a message or an error value. Passing the error extracts its type,
stack, `cause` chain, `AggregateError` children and Node `code`/`syscall`/`path` fields
into reserved `_error_*` attributes — the server fingerprints issues on `_error_type`, so
different error classes with the same wording stay on separate issues.

```js
try {
  await doWork();
} catch (err) {
  Pulse.error(err, "Work failed", { jobId });
}
```

Unhandled errors are captured automatically: `configure()` installs additive
`uncaughtException` and `unhandledRejection` listeners that record the error and then
preserve Node's default crash behaviour. Opt out with `captureUnhandled: false`.

## Metrics and operations

An operation measures a unit of work and emits start/complete/fail/cancel events carrying
its duration. Metric slugs should be lowercase letters, numbers and hyphens.

```js
const op = Pulse.startOperation("photo-conversion", { format: "heic" });
try {
  await convert();
  op.complete({ bytes: String(size) });
} catch (err) {
  op.fail("convert_failed", { reason: err.message });
}

// Or a single-shot metric with no duration:
Pulse.recordMetric("cache-warmed");
```

## Funnels

```js
Pulse.step("signup-started");
Pulse.step("signup-email-verified");
Pulse.step("signup-completed");
```

## Identity scoping

`withUser` and `withSession` return an immutable `ScopedPulse` and chain in either order.

```js
const pulse = Pulse.withUser("user_123").withSession(sessionId);
pulse.info("Settings saved");
pulse.startOperation("settings-save").complete();
```

## User properties

Properties merge server-side — keys you leave out are preserved, and an empty string value
removes a key.

```js
Pulse.setUserProperties("user_123", { plan: "pro", company: "Acme" });

// Or from a user-scoped instance:
Pulse.withUser("user_123").setUserProperties({ plan: "pro" });
```

## Feedback

Forward feedback your own frontend collected. Throws on failure, so wrap it in try/catch.

```js
try {
  const receipt = await Pulse.withUser(userId).sendFeedback(message, {
    name: "Ada",
    email: "ada@example.com",
  });
  console.log(receipt.id, receipt.createdAt);
} catch (err) {
  // 4xx responses surface as thrown errors carrying the server's message
}
```

## Attachments

Attach a file on disk or in-memory bytes to any event. Uploads run in the background and
are drained by `flush()` / `shutdown()`.

```js
Pulse.error("Import failed", { file: name }, {
  attachments: [
    { path: "/tmp/import.csv" },
    { buffer: Buffer.from(report), name: "report.json", contentType: "application/json" },
  ],
});
```

## Flush, shutdown and serverless

Events are buffered and flushed on a timer (`flushIntervalMs`) or once `flushThreshold`
events are queued. A `beforeExit` hook makes a best-effort final flush.

- `await Pulse.flush()` — send everything buffered now, keep the SDK usable.
- `await Pulse.shutdown()` — flush, remove the unhandled-error listeners and tear down.
- `Pulse.wrapHandler(fn)` — wrap a serverless handler so it flushes in a `finally`.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | — (required) | Pubky Pulse server URL; a trailing slash is stripped |
| `apiKey` | `string` | — (required) | Client key for a server-platform app; must start with `pulse_client_` |
| `serviceName` | `string` | `"unknown"` | Service name used for logging/debugging |
| `appVersion` | `string` | — | Application version reported with each event |
| `debug` | `boolean` | `false` | Print the SDK's own diagnostics to `console.error` |
| `flushIntervalMs` | `number` | `5000` | Background flush interval |
| `flushThreshold` | `number` | `20` | Buffered events that trigger an immediate flush |
| `maxBufferSize` | `number` | `10000` | Buffer cap; oldest events are dropped past it |
| `isDev` | `boolean` | `process.env.NODE_ENV !== "production"` | Mark events as development builds |
| `consoleLogging` | `boolean` | `true` | Echo events to the console |
| `captureUnhandled` | `boolean` | `true` | Auto-capture uncaught exceptions and unhandled rejections |

## Example

A runnable demo server lives at [`Examples/Demo/`](./Examples/Demo/). It exercises the full
SDK surface (operations, feedback, user properties, `wrapHandler`) and resolves the SDK via
`file:../..`, so it doubles as a pre-release smoke test.

## Development

```bash
npm ci
npm test          # build + unit tests
```

### Integration tests

Integration tests run against a live Pubky Pulse API server and are not part of CI. Point
them at your server with three environment variables:

| Variable | Description |
|---|---|
| `PULSE_TEST_ENDPOINT` | API server base URL (default `http://127.0.0.1:4112`) |
| `PULSE_TEST_SERVER_KEY` | A `pulse_client_` key for a server-platform app |
| `PULSE_TEST_AGENT_KEY` | A `pulse_agent_` key used to read events back for assertions |

```bash
PULSE_TEST_ENDPOINT=http://127.0.0.1:4112 \
PULSE_TEST_SERVER_KEY=pulse_client_... \
PULSE_TEST_AGENT_KEY=pulse_agent_... \
npm run test:integration
```

## Links

- [Docs](https://pulse.pubky.org/docs/sdks/node)
- [Main repo](https://github.com/Jasonvdb/pubky-pulse) — server, dashboard, CLI
- [Browser SDK](https://github.com/Jasonvdb/pubky-pulse-web)

## License

MIT — see [LICENSE](./LICENSE).
