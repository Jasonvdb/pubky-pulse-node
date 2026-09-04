import { createServer } from "node:http";
import { Pulse } from "@synonymdev/pubky-pulse-node";

const PORT = 4007;
const API_KEY = "pulse_client_svr_0000000000000000000000000000000000000000";

Pulse.configure({
  endpoint: "http://localhost:4000",
  apiKey: API_KEY,
  serviceName: "demo-api",
  debug: true,
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Pulse-Session-Id",
  };
}

function scopedPulse(req, userId) {
  const headerSessionId = req.headers["x-pulse-session-id"];
  let pulse = userId ? Pulse.withUser(userId) : null;
  if (headerSessionId) {
    pulse = pulse ? pulse.withSession(headerSessionId) : Pulse.withSession(headerSessionId);
  }
  return pulse ?? Pulse;
}

function json(res, status, body) {
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const handleGreet = Pulse.wrapHandler(async (req, res) => {
  const body = await parseBody(req);
  const { name = "World", userId } = body;

  const pulse = scopedPulse(req, userId);
  const op = pulse.startOperation("greet", { name });

  const message = `Hello, ${name}!`;
  op.complete({ name });

  json(res, 200, { message });
});

const handleCheckout = Pulse.wrapHandler(async (req, res) => {
  const body = await parseBody(req);
  const { item = "unknown", userId } = body;

  const pulse = scopedPulse(req, userId);
  const op = pulse.startOperation("checkout", { item });
  pulse.warn("Payment gateway timeout", { item });
  op.fail("payment_provider_unreachable", { item });

  json(res, 500, { error: "Payment provider unreachable" });
});

const handleFeedback = Pulse.wrapHandler(async (req, res) => {
  const body = await parseBody(req);
  const { message, name, email, userId } = body;

  if (!message || typeof message !== "string") {
    json(res, 400, { error: "message is required" });
    return;
  }

  const pulse = scopedPulse(req, userId);

  try {
    const receipt = await pulse.sendFeedback(message, { name, email });
    json(res, 201, { id: receipt.id, createdAt: receipt.createdAt });
  } catch (err) {
    pulse.warn("feedback submission failed", { reason: err.message });
    json(res, 400, { error: err.message });
  }
});

const handleProfile = Pulse.wrapHandler(async (req, res) => {
  const body = await parseBody(req);
  const { userId, plan, company } = body;

  if (!userId) {
    json(res, 400, { error: "userId is required" });
    return;
  }

  const pulse = scopedPulse(req, userId);
  const properties = {};
  if (plan) properties.plan = plan;
  if (company) properties.company = company;

  pulse.setUserProperties(properties);
  pulse.info("Profile updated", { plan, company });

  json(res, 200, { updated: true, properties });
});

const server = createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/api/greet" && req.method === "POST") {
    await handleGreet(req, res);
    return;
  }

  if (url.pathname === "/api/checkout" && req.method === "POST") {
    await handleCheckout(req, res);
    return;
  }

  if (url.pathname === "/api/profile" && req.method === "POST") {
    await handleProfile(req, res);
    return;
  }

  if (url.pathname === "/api/feedback" && req.method === "POST") {
    await handleFeedback(req, res);
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Demo API server listening on http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  POST /api/greet     { name, userId? }");
  console.log("  POST /api/checkout  { item, userId? }");
  console.log("  POST /api/profile   { userId, plan?, company? }");
  console.log("  POST /api/feedback  { message, name?, email?, userId? }");
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await Pulse.shutdown();
  server.close();
  process.exit(0);
});
