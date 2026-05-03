import { Octokit } from "@octokit/rest";
import type { RawIssue } from "./types.ts";

const TTL_MS = (Number(process.env.CACHE_TTL_SECONDS ?? 30)) * 1000;

interface CacheEntry<T> { value: T; expires: number }
const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return loader().then((value) => {
    cache.set(key, { value, expires: Date.now() + TTL_MS });
    return value;
  });
}

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

const octo = new Octokit({ auth: process.env.GH_TOKEN });
const [owner, repo] = (process.env.GH_REPO ?? "").split("/");
const branch = process.env.GH_BRANCH ?? "main";
if (!owner || !repo) throw new Error("GH_REPO must be set as 'owner/name'");

export async function listIssues(filter: { feature?: string; lane?: string; state?: "open" | "closed" | "all" } = {}): Promise<RawIssue[]> {
  const labels: string[] = ["inception"];
  if (filter.feature) labels.push(`feature/${filter.feature}`);
  if (filter.lane) labels.push(`lane/${filter.lane}`);
  const key = `issues:${labels.join(",")}:${filter.state ?? "all"}`;
  return cached(key, async () => {
    const data = await octo.paginate(octo.rest.issues.listForRepo, {
      owner, repo, state: filter.state ?? "all", labels: labels.join(","), per_page: 100,
    });
    return data as unknown as RawIssue[];
  });
}

export async function getIssue(number: number): Promise<RawIssue> {
  return cached(`issue:${number}`, async () => {
    const { data } = await octo.rest.issues.get({ owner, repo, issue_number: number });
    return data as unknown as RawIssue;
  });
}

export async function getFile(path: string): Promise<string | null> {
  return cached(`file:${path}`, async () => {
    try {
      const { data } = await octo.rest.repos.getContent({ owner, repo, path, ref: branch });
      if (Array.isArray(data) || data.type !== "file") return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
  });
}

export async function listDir(path: string): Promise<string[]> {
  return cached(`dir:${path}`, async () => {
    try {
      const { data } = await octo.rest.repos.getContent({ owner, repo, path, ref: branch });
      if (!Array.isArray(data)) return [];
      return data.filter((d) => d.type === "dir" || d.type === "file").map((d) => d.name);
    } catch (e: any) {
      if (e?.status === 404) return [];
      throw e;
    }
  });
}

export async function putFile(path: string, content: string, message: string): Promise<void> {
  let sha: string | undefined;
  try {
    const { data } = await octo.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(data) && data.type === "file") sha = data.sha;
  } catch (e: any) { if (e?.status !== 404) throw e; }
  await octo.rest.repos.createOrUpdateFileContents({
    owner, repo, path, message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch, sha,
  });
  invalidate(`file:${path}`);
  invalidate(`dir:${path.split("/").slice(0, -1).join("/")}`);
}

export async function createIssue(args: { title: string; body: string; labels: string[] }): Promise<number> {
  const { data } = await octo.rest.issues.create({ owner, repo, title: args.title, body: args.body, labels: args.labels });
  invalidate("issues:");
  return data.number;
}

export async function setLabels(number: number, labels: string[]): Promise<void> {
  await octo.rest.issues.setLabels({ owner, repo, issue_number: number, labels });
  invalidate("issues:"); invalidate(`issue:${number}`);
}

export async function replaceLabel(number: number, prefix: string, newValue: string): Promise<void> {
  const { data } = await octo.rest.issues.get({ owner, repo, issue_number: number });
  const kept = data.labels.map((l: any) => typeof l === "string" ? l : l.name).filter((n: string) => !n.startsWith(prefix));
  await setLabels(number, [...kept, `${prefix}${newValue}`]);
}

export async function assign(number: number, login: string | null): Promise<void> {
  const { data } = await octo.rest.issues.get({ owner, repo, issue_number: number });
  const current = data.assignees?.map((a: any) => a.login) ?? [];
  if (current.length) await octo.rest.issues.removeAssignees({ owner, repo, issue_number: number, assignees: current });
  if (login) await octo.rest.issues.addAssignees({ owner, repo, issue_number: number, assignees: [login] });
  invalidate("issues:"); invalidate(`issue:${number}`);
}

export async function closeIssue(number: number, comment?: string): Promise<void> {
  if (comment) await octo.rest.issues.createComment({ owner, repo, issue_number: number, body: comment });
  await octo.rest.issues.update({ owner, repo, issue_number: number, state: "closed" });
  invalidate("issues:"); invalidate(`issue:${number}`);
}

export const ghContext = { owner, repo, branch };
