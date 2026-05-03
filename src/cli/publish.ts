#!/usr/bin/env bun
/**
 * publish-from-local: read a local Inception feature folder, POST to the MCP's
 * /publish-feature endpoint. Run once per feature, after Inception artifacts
 * are agreed by the mob.
 *
 * Usage:
 *   MCP_URL=https://...up.railway.app  MCP_TOKEN=...  bun src/cli/publish.ts <path-to-feature-folder>
 *
 * Reads:
 *   <path>/_index.md, PRD.md, api-contract.md, decisions.md, open-questions.md, out-of-scope.md
 *   <path>/issues/{backend,android,ios}/*.md
 *
 * Each issue file's frontmatter is parsed for `lane`, `estimate`, `blocked-by`.
 * `blocked-by` entries are wikilinks like `"[[02-extend-note-model]]"`; the
 * leading number becomes the local_id reference.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";

const MCP_URL = process.env.MCP_URL;
const MCP_TOKEN = process.env.MCP_TOKEN;
if (!MCP_URL || !MCP_TOKEN) {
  console.error("ERROR: set MCP_URL and MCP_TOKEN env vars (e.g., source .env).");
  process.exit(1);
}

const featurePathArg = process.argv[2];
if (!featurePathArg) {
  console.error("Usage: bun src/cli/publish.ts <path-to-feature-folder>");
  console.error("       e.g.   bun src/cli/publish.ts ../mindnote/inception/260503-1500-image-attachments");
  process.exit(1);
}
const featurePath = resolve(featurePathArg);
const slug = basename(featurePath);

// Minimal frontmatter parser: scalars + simple lists. Sufficient for our schema.
function splitFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, any> = {};
  let key: string | null = null;
  for (const raw of m[1].split("\n")) {
    if (/^\s*-\s/.test(raw) && key) {
      const v = raw.replace(/^\s*-\s+/, "").replace(/^"|"$/g, "");
      (fm[key] ||= []).push(v);
    } else {
      const kv = raw.match(/^([^:]+):\s*(.*)$/);
      if (!kv) continue;
      key = kv[1].trim();
      const value = kv[2].trim();
      if (value === "" || value === "[]") fm[key] = [];
      else fm[key] = value.replace(/^"|"$/g, "");
    }
  }
  return { fm, body: m[2] };
}

function extractTitle(body: string): string {
  for (const line of body.split("\n")) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return "(untitled)";
}

function localIdFromFilename(name: string): number {
  const m = name.match(/^(\d+)-/);
  return m ? Number(m[1]) : 0;
}

function parseBlockedByList(value: any): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((s: string) => {
      const m = String(s).match(/(\d+)/);
      return m ? Number(m[1]) : 0;
    })
    .filter((n: number) => n > 0);
}

const TOP_LEVEL_FILES = [
  "_index.md",
  "PRD.md",
  "api-contract.md",
  "decisions.md",
  "open-questions.md",
  "out-of-scope.md",
];

async function readTopLevelFiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of TOP_LEVEL_FILES) {
    try {
      out[f] = await readFile(join(featurePath, f), "utf8");
    } catch { /* file optional */ }
  }
  return out;
}

interface IssuePayload {
  local_id: number;
  title: string;
  body: string;
  lane: string;
  estimate?: string;
  blocked_by_local: number[];
}

async function readIssues(): Promise<IssuePayload[]> {
  const issuesDir = join(featurePath, "issues");
  let lanes: string[] = [];
  try { lanes = await readdir(issuesDir); } catch { return []; }
  const out: IssuePayload[] = [];
  for (const lane of lanes) {
    const dir = join(issuesDir, lane);
    if (!(await stat(dir)).isDirectory()) continue;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".md")) continue;
      const text = await readFile(join(dir, f), "utf8");
      const { fm, body } = splitFrontmatter(text);
      out.push({
        local_id: localIdFromFilename(f),
        title: extractTitle(body),
        body,
        lane: String(fm.lane ?? lane),
        estimate: fm.estimate ? String(fm.estimate) : undefined,
        blocked_by_local: parseBlockedByList(fm["blocked-by"]),
      });
    }
  }
  return out.sort((a, b) => a.local_id - b.local_id);
}

const files = await readTopLevelFiles();
const issues = await readIssues();

console.log(`Publishing feature: ${slug}`);
console.log(`  source folder: ${featurePath}`);
console.log(`  markdown files: ${Object.keys(files).length} (${Object.keys(files).join(", ")})`);
console.log(`  issues: ${issues.length}`);
const lanesCount: Record<string, number> = {};
for (const i of issues) lanesCount[i.lane] = (lanesCount[i.lane] ?? 0) + 1;
console.log(`  by lane: ${Object.entries(lanesCount).map(([l, n]) => `${l}=${n}`).join(", ")}`);

const url = `${MCP_URL.replace(/\/$/, "")}/publish-feature`;
console.log(`\nPOST ${url}`);

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${MCP_TOKEN}` },
  body: JSON.stringify({ feature_slug: slug, files, issues }),
});

if (!res.ok) {
  console.error(`\nFailed: ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}

const result = (await res.json()) as { ok: boolean; issues: { local_id: number; gh_number: number }[] };
console.log("\nDone. Local-ID → GitHub issue number:");
for (const { local_id, gh_number } of result.issues.sort((a, b) => a.local_id - b.local_id)) {
  console.log(`  ${String(local_id).padStart(3)} → #${gh_number}`);
}
