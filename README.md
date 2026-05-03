# inception-mcp

Remote MCP server that exposes the **AI-SDLC Inception phase** as live, queryable state. Backed by GitHub Issues + repo markdown. Multiple dev agents read it concurrently and pick up unblocked work in parallel without ever cloning the inception folder.

Pairs with the [ai-sdlc](https://github.com/your-org/ai-sdlc) skill that produces the Inception artifacts.

## Why

A static markdown folder is great for the kickoff snapshot. It's the wrong source of truth once devs start working in parallel:

- "Is issue #2 done?" requires opening a file.
- "What can I grab right now?" requires walking the dependency graph by hand.
- Two agents claiming the same issue need a lock somewhere.

The MCP centralizes this. State lives in **GitHub Issues**; the MCP computes wave/ready-status on the fly and provides atomic claim/complete tools.

## Architecture

```
┌─────────────┐                ┌───────────────────────┐                ┌────────────┐
│ Dev A agent │ ◄──HTTP+SSE──► │ inception-mcp (Bun)   │ ◄──Octokit────►│ GitHub API │
└─────────────┘                │  - resources          │                └────────────┘
┌─────────────┐                │  - tools              │
│ Dev B agent │ ◄──HTTP+SSE──► │  - wave compute       │
└─────────────┘                │  - bearer-token auth  │
                               └───────────────────────┘
```

## Storage mapping

| Inception field      | GitHub representation                                |
|---|---|
| Issue body           | GitHub Issue body (markdown, agent-executable)        |
| `feature: <slug>`    | label `feature/<slug>`                                |
| `lane: <android>`    | label `lane/android`                                  |
| `wave: N`             | computed at query time (not stored)                   |
| `status: ready`       | label `status/ready` + open + unassigned              |
| `status: in-progress` | label `status/in-progress` + assignee                 |
| `status: done`        | issue closed                                          |
| `estimate: 60m`       | label `est/60m`                                       |
| `blocked-by: [[..]]`  | line `Blocked by: #123, #124` in issue body           |
| PRD, decisions, etc.  | files in the repo at `inception/<slug>/*.md`          |

## Tools

| Tool | Purpose |
|---|---|
| `list_features` | Summarize all features (counts: ready / in-progress / done). |
| `list_issues` | Filter by feature / lane / status. |
| `list_ready_issues` | Issues whose blockers are all closed — *grabbable now*. |
| `get_issue` | Full body + live blocker status for one issue. |
| `next_unblocked_for` | Auto-pick highest-priority ready issue for a lane. |
| `claim_issue` | Atomic claim: rejects if any blocker reopened mid-flight. |
| `release_issue` | Hand back to ready. |
| `complete_issue` | Close as done; optionally comment with PR URL. |
| `publish_feature` | One-time bootstrap: commit markdown + create issues with linkage. |

## Resources

| URI | What |
|---|---|
| `inception://features` | JSON list of feature slugs |
| `inception://feature/<slug>` | Feature index (`_index.md`) |
| `inception://feature/<slug>/prd` | PRD markdown |
| `inception://feature/<slug>/api-contract` | API contract markdown |
| `inception://feature/<slug>/decisions` | Decisions log |
| `inception://feature/<slug>/open-questions` | Open questions |
| `inception://feature/<slug>/out-of-scope` | Out of scope |

## Setup

### 1. Configure

```bash
cp .env.example .env
# fill in: GH_TOKEN (PAT with `repo`), GH_REPO (owner/name), MCP_TOKEN (random)
```

### 2. Install + run locally

```bash
bun install
bun run dev    # http://localhost:8787
```

Health check: `curl http://localhost:8787/health`.

### 3. Deploy to Railway

```bash
railway init
railway up
# set env vars in Railway dashboard: GH_TOKEN, GH_REPO, MCP_TOKEN
railway domain
```

### 4. Connect from a dev's Claude Code

Add to `~/.claude/mcp.json` (or whatever your client expects):

```json
{
  "mcpServers": {
    "inception": {
      "url": "https://your-railway-domain.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

### 5. Bootstrap a feature

The driver runs `publish_feature` once, passing the locally-produced Inception artifacts. The MCP commits the markdown to the repo and creates GH issues with proper labels and `Blocked by:` linkage.

```js
// pseudocode for the driver-side payload
publish_feature({
  feature_slug: "260503-1500-image-attachments",
  files: {
    "PRD.md":            "<contents>",
    "api-contract.md":   "<contents>",
    "decisions.md":      "<contents>",
    "out-of-scope.md":   "<contents>",
    "open-questions.md": "<contents>",
    "_index.md":         "<contents>",
  },
  issues: [
    { local_id: 1, title: "[Android] Add Coil dependency", body: "...", lane: "android", estimate: "15m", blocked_by_local: [] },
    { local_id: 2, title: "[Android] Extend Note model...", body: "...", lane: "android", estimate: "30m", blocked_by_local: [] },
    { local_id: 8, title: "[Android] Plumb picked URIs...", body: "...", lane: "android", estimate: "60m", blocked_by_local: [2, 4, 7] },
    // ...
  ],
});
```

The MCP commits files, creates issues in topological order (so `local_id`s can be remapped to GH issue numbers in `Blocked by:` lines), and returns the `local_id → gh_number` mapping.

## Daily flow for devs

```
agent ──→ MCP.next_unblocked_for(lane: "android")
       ←── { issue: { number: 4, title: "ImageStorageService.import...", ... }, rationale: "wave 0; no blockers" }
agent ──→ MCP.claim_issue(4, "bob")
       ←── { ok: true }
agent ──→ MCP.get_issue(4)   # full body for execution
       ←── { number: 4, body: "<implementation steps + acceptance>", blocked_by: [], ready_to_grab: false (now claimed), ... }
[bob's agent implements; opens PR]
agent ──→ MCP.complete_issue(4, "https://github.com/.../pull/12")
       ←── { ok: true }
```

Meanwhile Alice's agent sees `next_unblocked_for("android")` returns issue #2 (no overlap), claims it, and they ship in parallel.

## Scope (v0.1)

In:
- Read tools, claim/complete tools, publish bootstrap
- Bearer-token auth (single team token)
- HTTP transport, Railway deploy
- 30s in-memory cache for GH responses

Out (deferred):
- Per-user RBAC, audit log
- GitHub webhook → MCP `notifications/resourcesUpdated` push
- Construction-phase tools (run tests, open PRs, etc.)
- Multi-tenant (multiple teams on one server)
- Linear / Jira / GitLab backends

## Notes on the implementation

- This is a v0.1 scaffold. The HTTP <-> MCP transport bridge in `src/server.ts` may need adjustment depending on the `@modelcontextprotocol/sdk` version you install — verify `bun run dev` boots and the `/mcp` endpoint accepts the SDK's protocol handshake before deploying.
- `parseBlockedBy` matches a single line `Blocked by: #1, #2`. Keep that format consistent in issue bodies.
- Wave is computed every call. Cheap for ≤500 issues per feature; paginate or memoize across requests if you grow past that.
