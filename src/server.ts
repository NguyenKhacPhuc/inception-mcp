import { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
    { name: "inception-mcp", version: "0.1.0" },
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

const app = new Hono();

app.get("/health", (c) => c.text("ok"));

// Bootstrap REST endpoint for the publish-from-local CLI.
// Same bearer auth as the MCP endpoint; calls the same tool implementation.
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

app.all("/mcp", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${MCP_TOKEN}`) return c.text("unauthorized", 401);

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  // Bridge Hono's Web Request/Response with the MCP transport.
  const body = c.req.method === "POST" ? await c.req.json().catch(() => ({})) : undefined;
  const res = new Response(
    new ReadableStream({
      async start(controller) {
        const fakeRes = {
          writeHead: () => fakeRes,
          write: (chunk: string | Uint8Array) => controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk),
          end: () => controller.close(),
          setHeader: () => {},
          headersSent: false,
        };
        // @ts-expect-error - minimal Node res shim
        await transport.handleRequest({ method: c.req.method, headers: Object.fromEntries(c.req.raw.headers), url: c.req.url, body }, fakeRes);
      },
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
  );
  return res;
});

export default { port: PORT, fetch: app.fetch };

console.log(`inception-mcp listening on :${PORT}`);
