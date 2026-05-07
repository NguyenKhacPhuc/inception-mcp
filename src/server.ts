import { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as tools from "./tools.ts";
import { listResources, readResource } from "./resources.ts";

const PORT = Number(process.env.PORT ?? 8787);
const MCP_TOKEN = process.env.MCP_TOKEN;
if (!MCP_TOKEN) throw new Error("MCP_TOKEN must be set");

function buildMcpServer() {
  const server = new Server(
    { name: "orchestration-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "list_features",      description: "Summarize all Inception features in the repo (counts per status).", inputSchema: { type: "object", properties: {} } },
      { name: "list_issues",        description: "List issues, optionally filtered by feature/lane/status.",          inputSchema: { type: "object", properties: { feature: { type: "string" }, lane: { type: "string", enum: ["backend","android","ios"] }, status: { type: "string", enum: ["ready","in-progress","done","any"] } } } },
      { name: "list_ready_issues",  description: "List issues whose blockers are all closed (grabbable now).",        inputSchema: { type: "object", properties: { feature: { type: "string" }, lane: { type: "string", enum: ["backend","android","ios"] } } } },
      { name: "get_issue",          description: "Full agent-executable brief for one issue, with live blocker status.", inputSchema: { type: "object", required: ["number"], properties: { number: { type: "number" } } } },
      { name: "next_unblocked_for", description: "Pick the highest-priority unblocked issue for a lane.",             inputSchema: { type: "object", required: ["lane"], properties: { lane: { type: "string", enum: ["backend","android","ios"] }, feature: { type: "string" } } } },
      { name: "claim_issue",        description: "Claim an issue (atomic; rejects if any blocker is still open).",   inputSchema: { type: "object", required: ["number","claimant"], properties: { number: { type: "number" }, claimant: { type: "string", description: "GitHub login" } } } },
      { name: "release_issue",      description: "Release a claimed issue back to ready.",                            inputSchema: { type: "object", required: ["number"], properties: { number: { type: "number" } } } },
      { name: "complete_issue",     description: "Close an issue as done; optionally comment with a PR URL.",         inputSchema: { type: "object", required: ["number"], properties: { number: { type: "number" }, pr_url: { type: "string" } } } },
      { name: "publish_feature",    description: "One-time bootstrap: commit feature markdown to repo + create GH issues with proper labels and Blocked-by linkage.", inputSchema: { type: "object", required: ["feature_slug","files","issues"], properties: { feature_slug: { type: "string" }, files: { type: "object" }, issues: { type: "array" } } } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = args ?? {};
    let result: unknown;
    switch (name) {
      case "list_features":      result = await tools.listFeatures(); break;
      case "list_issues":        result = await tools.listIssues(a as any); break;
      case "list_ready_issues":  result = await tools.listReadyIssues(a as any); break;
      case "get_issue":          result = await tools.getIssue(a as any); break;
      case "next_unblocked_for": result = await tools.nextUnblockedFor(a as any); break;
      case "claim_issue":        result = await tools.claimIssue(a as any); break;
      case "release_issue":      result = await tools.releaseIssue(a as any); break;
      case "complete_issue":     result = await tools.completeIssue(a as any); break;
      case "publish_feature":    result = await tools.publishFeature(a as any); break;
      default: throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await listResources() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = await readResource(req.params.uri);
    return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text }] };
  });

  return server;
}

// --- Custom Streamable-HTTP-ish transport over plain JSON ---
// Bridges Hono's Web Request/Response to the MCP Server without trying to
// fake a Node ServerResponse. One Server instance per session; sessions are
// keyed by Mcp-Session-Id (issued on the initialize response).

class MemoryTransport {
  onmessage?: (m: any) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;

  private waiters = new Map<string | number, (m: any) => void>();

  async start() {}
  async close() { this.onclose?.(); }

  // Server -> client: route by id back to whoever is awaiting.
  async send(message: any) {
    if (message?.id !== undefined && this.waiters.has(message.id)) {
      const cb = this.waiters.get(message.id)!;
      this.waiters.delete(message.id);
      cb(message);
    }
    // Server-initiated messages with no waiter are dropped (we don't push to clients).
  }

  // Client -> server: deliver, optionally await the matched response.
  async dispatch(message: any, timeoutMs = 30_000): Promise<any | undefined> {
    if (!this.onmessage) throw new Error("transport not connected");
    if (message?.id === undefined) {
      this.onmessage(message);
      return undefined;
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(message.id);
        reject(new Error("MCP response timeout"));
      }, timeoutMs);
      this.waiters.set(message.id, (m) => { clearTimeout(timer); resolve(m); });
      this.onmessage!(message);
    });
  }
}

interface Session { server: Server; transport: MemoryTransport; lastUsed: number }
const sessions = new Map<string, Session>();
const SESSION_IDLE_MS = 30 * 60_000;

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if (s.lastUsed < cutoff) {
      s.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 5 * 60_000);

async function getOrCreateSession(sessionId: string | undefined): Promise<{ session: Session; sessionId: string; created: boolean }> {
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId)!;
    s.lastUsed = Date.now();
    return { session: s, sessionId, created: false };
  }
  const newId = sessionId ?? crypto.randomUUID();
  const transport = new MemoryTransport();
  const server = buildMcpServer();
  await server.connect(transport);
  const session: Session = { server, transport, lastUsed: Date.now() };
  sessions.set(newId, session);
  return { session, sessionId: newId, created: true };
}

const app = new Hono();

app.get("/health", (c) => c.text("ok"));

// Bootstrap REST endpoint for the publish-from-local CLI.
app.post("/publish-feature", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${MCP_TOKEN}`) return c.text("unauthorized", 401);
  try {
    const body = await c.req.json();
    const result = await tools.publishFeature(body);
    return c.json(result);
  } catch (e: any) {
    console.error("publish-feature error:", e);
    return c.json({ ok: false, error: e?.message ?? "unknown" }, 500);
  }
});

app.post("/mcp", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${MCP_TOKEN}`) return c.text("unauthorized", 401);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.text("invalid JSON body", 400);

  const incomingSessionId = c.req.header("mcp-session-id") ?? undefined;
  const { session, sessionId } = await getOrCreateSession(incomingSessionId);

  const incoming = Array.isArray(body) ? body : [body];
  const outgoing: any[] = [];

  try {
    for (const msg of incoming) {
      const response = await session.transport.dispatch(msg);
      if (response) outgoing.push(response);
    }
  } catch (e: any) {
    console.error("MCP dispatch error:", e?.message ?? e);
    const id = incoming.find((m: any) => m?.id !== undefined)?.id ?? null;
    return c.json({ jsonrpc: "2.0", id, error: { code: -32000, message: e?.message ?? "internal error" } }, 500);
  }

  c.header("Mcp-Session-Id", sessionId);

  if (outgoing.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? outgoing : outgoing[0]);
});

// MCP also defines GET /mcp for server-initiated SSE notifications. We don't
// push anything, so respond 405 — clients fall back to plain request/response.
app.get("/mcp", (c) => c.text("method not allowed", 405));

// Explicit session termination per the Streamable HTTP spec.
app.delete("/mcp", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${MCP_TOKEN}`) return c.text("unauthorized", 401);
  const sid = c.req.header("mcp-session-id");
  if (sid && sessions.has(sid)) {
    await sessions.get(sid)!.transport.close().catch(() => {});
    sessions.delete(sid);
  }
  return c.body(null, 204);
});

export default { port: PORT, fetch: app.fetch };

console.log(`orchestration-mcp listening on :${PORT}`);
