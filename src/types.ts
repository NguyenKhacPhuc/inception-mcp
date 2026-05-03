export type IssueStatus = "ready" | "in-progress" | "done" | "unknown";

export interface BlockerRef {
  number: number;
  title: string;
  status: IssueStatus;
  assigned_to?: string;
}

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  feature?: string;
  lane?: string;
  estimate?: string;
  status: IssueStatus;
  blocked_by: BlockerRef[];
  ready_to_grab: boolean;
  wave: number;
  url: string;
}

export interface FeatureSummary {
  slug: string;
  total_issues: number;
  ready_count: number;
  in_progress_count: number;
  done_count: number;
}

export interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { name: string }[];
  assignees: { login: string }[];
  html_url: string;
}
