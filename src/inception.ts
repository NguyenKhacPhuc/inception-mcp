import type { IssueDetail, IssueStatus, RawIssue, BlockerRef } from "./types.ts";

const BLOCKED_BY_RE = /^\s*Blocked\s+by:\s*([#\d,\s]+)\s*$/im;

export function parseBlockedBy(body: string | null): number[] {
  if (!body) return [];
  const m = body.match(BLOCKED_BY_RE);
  if (!m) return [];
  return [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
}

export function labelValue(labels: string[], prefix: string): string | undefined {
  const found = labels.find((l) => l.startsWith(prefix));
  return found?.slice(prefix.length);
}

export function deriveStatus(raw: RawIssue): IssueStatus {
  if (raw.state === "closed") return "done";
  const labels = raw.labels.map((l) => l.name);
  if (labels.includes("status/in-progress")) return "in-progress";
  if (labels.includes("status/done")) return "done";
  return "ready";
}

function enrichBlocker(num: number, all: Map<number, RawIssue>): BlockerRef {
  const raw = all.get(num);
  if (!raw) return { number: num, title: `(unknown #${num})`, status: "unknown" };
  return {
    number: num,
    title: raw.title,
    status: deriveStatus(raw),
    assigned_to: raw.assignees?.[0]?.login,
  };
}

export function enrichIssue(raw: RawIssue, all: Map<number, RawIssue>): IssueDetail {
  const labels = raw.labels.map((l) => l.name);
  const blockerNumbers = parseBlockedBy(raw.body);
  const blockers = blockerNumbers.map((n) => enrichBlocker(n, all));
  const allBlockersDone = blockers.every((b) => b.status === "done");
  const status = deriveStatus(raw);
  const wave = computeWave(raw.number, all);
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    labels,
    assignees: (raw.assignees ?? []).map((a) => a.login),
    feature: labelValue(labels, "feature/"),
    lane: labelValue(labels, "lane/"),
    estimate: labelValue(labels, "est/"),
    status,
    blocked_by: blockers,
    ready_to_grab: status === "ready" && allBlockersDone,
    wave,
    url: raw.html_url,
  };
}

export function computeWave(number: number, all: Map<number, RawIssue>): number {
  const memo = new Map<number, number>();
  function walk(n: number, stack: Set<number>): number {
    if (memo.has(n)) return memo.get(n)!;
    if (stack.has(n)) return 0; // cycle guard
    const raw = all.get(n);
    if (!raw) return 0;
    if (raw.state === "closed") { memo.set(n, 0); return 0; }
    const blockers = parseBlockedBy(raw.body);
    const openBlockers = blockers.filter((b) => {
      const r = all.get(b);
      return r && r.state === "open";
    });
    if (openBlockers.length === 0) { memo.set(n, 0); return 0; }
    stack.add(n);
    const w = 1 + Math.max(...openBlockers.map((b) => walk(b, stack)));
    stack.delete(n);
    memo.set(n, w);
    return w;
  }
  return walk(number, new Set());
}

export function indexBy<T extends { number: number }>(items: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const it of items) m.set(it.number, it);
  return m;
}
