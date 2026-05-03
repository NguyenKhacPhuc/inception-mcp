import * as gh from "./github.ts";
import { enrichIssue, indexBy, parseBlockedBy, labelValue } from "./inception.ts";
import type { IssueDetail, FeatureSummary } from "./types.ts";

async function loadAllIssues(feature?: string) {
  const raws = await gh.listIssues({ feature, state: "all" });
  const all = indexBy(raws);
  return { raws, all };
}

export async function listFeatures(): Promise<FeatureSummary[]> {
  const raws = await gh.listIssues({ state: "all" });
  const all = indexBy(raws);
  const bySlug = new Map<string, FeatureSummary>();
  for (const r of raws) {
    const slug = labelValue(r.labels.map((l) => l.name), "feature/");
    if (!slug) continue;
    const e = enrichIssue(r, all);
    const s = bySlug.get(slug) ?? { slug, total_issues: 0, ready_count: 0, in_progress_count: 0, done_count: 0 };
    s.total_issues++;
    if (e.status === "done") s.done_count++;
    else if (e.status === "in-progress") s.in_progress_count++;
    else if (e.ready_to_grab) s.ready_count++;
    bySlug.set(slug, s);
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function listIssues(args: { feature?: string; lane?: string; status?: "ready" | "in-progress" | "done" | "any" }): Promise<IssueDetail[]> {
  const { raws, all } = await loadAllIssues(args.feature);
  return raws
    .map((r) => enrichIssue(r, all))
    .filter((d) => !args.lane || d.lane === args.lane)
    .filter((d) => {
      if (!args.status || args.status === "any") return true;
      return d.status === args.status;
    });
}

export async function listReadyIssues(args: { feature?: string; lane?: string }): Promise<IssueDetail[]> {
  const { raws, all } = await loadAllIssues(args.feature);
  return raws
    .map((r) => enrichIssue(r, all))
    .filter((d) => d.ready_to_grab)
    .filter((d) => !args.lane || d.lane === args.lane)
    .sort((a, b) => (b.estimate ?? "0").localeCompare(a.estimate ?? "0")); // longer estimates first
}

export async function getIssue(args: { number: number }): Promise<IssueDetail> {
  const raws = await gh.listIssues({ state: "all" });
  const all = indexBy(raws);
  const target = all.get(args.number) ?? await gh.getIssue(args.number);
  return enrichIssue(target as any, all);
}

export async function nextUnblockedFor(args: { lane: string; feature?: string }): Promise<{ issue: IssueDetail; rationale: string } | { issue: null; rationale: string }> {
  const ready = await listReadyIssues({ lane: args.lane, feature: args.feature });
  if (ready.length === 0) return { issue: null, rationale: `no unblocked ${args.lane} issues currently` };
  const pick = ready[0];
  return { issue: pick, rationale: `wave ${pick.wave}; no open blockers; lane ${args.lane}` };
}

export async function claimIssue(args: { number: number; claimant: string }): Promise<{ ok: boolean; reason?: string }> {
  // Atomic claim: re-read state, verify all blockers closed, then assign + label.
  const raws = await gh.listIssues({ state: "all" });
  const all = indexBy(raws);
  const target = all.get(args.number);
  if (!target) return { ok: false, reason: "issue_not_found" };
  if (target.state === "closed") return { ok: false, reason: "issue_already_closed" };
  const labels = target.labels.map((l) => l.name);
  if (labels.includes("status/in-progress")) {
    const existing = target.assignees?.[0]?.login;
    if (existing && existing !== args.claimant) return { ok: false, reason: `already_claimed_by:${existing}` };
  }
  const blockers = parseBlockedBy(target.body);
  for (const n of blockers) {
    const b = all.get(n);
    if (b && b.state === "open") return { ok: false, reason: `blocker_open:#${n}` };
  }
  await gh.assign(args.number, args.claimant);
  await gh.replaceLabel(args.number, "status/", "in-progress");
  return { ok: true };
}

export async function releaseIssue(args: { number: number }): Promise<{ ok: boolean }> {
  await gh.assign(args.number, null);
  await gh.replaceLabel(args.number, "status/", "ready");
  return { ok: true };
}

export async function completeIssue(args: { number: number; pr_url?: string }): Promise<{ ok: boolean }> {
  const comment = args.pr_url ? `Resolved by ${args.pr_url}` : undefined;
  await gh.closeIssue(args.number, comment);
  return { ok: true };
}

export async function publishFeature(args: {
  feature_slug: string;
  files: Record<string, string>; // path-relative-to-feature-folder → content
  issues: { local_id: number; title: string; body: string; lane: string; estimate?: string; blocked_by_local: number[] }[];
}): Promise<{ ok: boolean; issues: { local_id: number; gh_number: number }[] }> {
  // 1) Commit markdown files first.
  const featurePath = `inception/${args.feature_slug}`;
  for (const [rel, content] of Object.entries(args.files)) {
    await gh.putFile(`${featurePath}/${rel}`, content, `inception(${args.feature_slug}): ${rel}`);
  }
  // 2) Create issues in topological order: blockers first, dependents after.
  const order = topoSort(args.issues);
  const localToGh = new Map<number, number>();
  for (const localId of order) {
    const it = args.issues.find((x) => x.local_id === localId)!;
    // Rewrite "Blocked by: #2, #4" inline references from local IDs to GH numbers.
    const ghBlockers = it.blocked_by_local.map((b) => localToGh.get(b)).filter((n): n is number => !!n);
    const body = injectBlockedBy(it.body, ghBlockers);
    const labels = [
      "inception",
      `feature/${args.feature_slug}`,
      `lane/${it.lane}`,
      "status/ready",
      ...(it.estimate ? [`est/${it.estimate}`] : []),
    ];
    const num = await gh.createIssue({ title: it.title, body, labels });
    localToGh.set(localId, num);
  }
  return { ok: true, issues: [...localToGh.entries()].map(([local_id, gh_number]) => ({ local_id, gh_number })) };
}

function topoSort(issues: { local_id: number; blocked_by_local: number[] }[]): number[] {
  const map = new Map(issues.map((i) => [i.local_id, i]));
  const order: number[] = [];
  const visited = new Set<number>();
  function visit(id: number, stack: Set<number>) {
    if (visited.has(id) || stack.has(id)) return;
    stack.add(id);
    for (const dep of map.get(id)?.blocked_by_local ?? []) visit(dep, stack);
    stack.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const it of issues) visit(it.local_id, new Set());
  return order;
}

function injectBlockedBy(body: string, ghBlockers: number[]): string {
  if (ghBlockers.length === 0) return body;
  const line = `Blocked by: ${ghBlockers.map((n) => `#${n}`).join(", ")}`;
  if (/^\s*Blocked\s+by:/im.test(body)) {
    return body.replace(/^\s*Blocked\s+by:.*$/im, line);
  }
  return `${line}\n\n${body}`;
}
