import * as gh from "./github.ts";

export interface Resource { uri: string; name: string; description: string; mimeType: string }

export async function listResources(): Promise<Resource[]> {
  // Discover features by listing top-level dirs under inception/.
  const featureDirs = await gh.listDir("inception");
  const out: Resource[] = [{ uri: "inception://features", name: "All features", description: "Index of all Inception features in the repo.", mimeType: "application/json" }];
  for (const slug of featureDirs) {
    out.push(
      { uri: `inception://feature/${slug}`,                name: `${slug} — index`,        description: `Feature index (_index.md)`,            mimeType: "text/markdown" },
      { uri: `inception://feature/${slug}/prd`,            name: `${slug} — PRD`,          description: `Product requirements (PRD.md)`,         mimeType: "text/markdown" },
      { uri: `inception://feature/${slug}/api-contract`,   name: `${slug} — API contract`, description: `API contract (api-contract.md)`,        mimeType: "text/markdown" },
      { uri: `inception://feature/${slug}/decisions`,      name: `${slug} — decisions`,    description: `Decisions log (decisions.md)`,          mimeType: "text/markdown" },
      { uri: `inception://feature/${slug}/open-questions`, name: `${slug} — open Qs`,      description: `Open questions (open-questions.md)`,    mimeType: "text/markdown" },
      { uri: `inception://feature/${slug}/out-of-scope`,   name: `${slug} — out of scope`, description: `Out of scope (out-of-scope.md)`,        mimeType: "text/markdown" },
    );
  }
  return out;
}

export async function readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
  if (uri === "inception://features") {
    const features = await gh.listDir("inception");
    return { uri, mimeType: "application/json", text: JSON.stringify(features, null, 2) };
  }
  const m = uri.match(/^inception:\/\/feature\/([^/]+)(?:\/(.+))?$/);
  if (!m) throw new Error(`unknown resource uri: ${uri}`);
  const [, slug, kind] = m;
  const fileMap: Record<string, string> = {
    "":                "_index.md",
    "prd":             "PRD.md",
    "api-contract":    "api-contract.md",
    "decisions":       "decisions.md",
    "open-questions":  "open-questions.md",
    "out-of-scope":    "out-of-scope.md",
  };
  const file = fileMap[kind ?? ""];
  if (!file) throw new Error(`unknown resource kind: ${kind}`);
  const text = await gh.getFile(`inception/${slug}/${file}`);
  if (text === null) throw new Error(`not found: inception/${slug}/${file}`);
  return { uri, mimeType: "text/markdown", text };
}
