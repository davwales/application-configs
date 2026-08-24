/**
 * Shared TypeScript types for pi-ouranos-github.
 *
 * All GitHub REST API response shapes use optional fields liberally — we never
 * want a missing field to crash a tool. Payloads we *return* to the model are
 * pruned to a small known set (see tools/*.ts), so the raw shapes here just
 * need to be permissive enough to read from JSON.
 */

// ─── GitHub API response shapes ──────────────────────────────────────────────

export interface GitHubUser {
  id?: number;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
  html_url?: string;
  type?: string;
}

export interface GitHubLabel {
  id?: number;
  name?: string;
  color?: string;
  description?: string | null;
  default?: boolean;
  url?: string;
}

export interface GitHubMilestone {
  id?: number;
  number?: number;
  title?: string;
  description?: string | null;
  state?: string;
  open_issues?: number;
  closed_issues?: number;
  due_on?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  html_url?: string;
  url?: string;
}

export interface GitHubComment {
  id?: number;
  body?: string;
  user?: GitHubUser;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  issue_url?: string;
}

/** The `pull_request` field GitHub attaches to an Issue when it's actually a PR. */
export interface GitHubIssuePullRequestRef {
  url?: string;
  html_url?: string;
  diff_url?: string;
  patch_url?: string;
  merged_at?: string | null;
}

export interface GitHubIssue {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  labels?: GitHubLabel[];
  milestone?: GitHubMilestone | null;
  assignees?: GitHubUser[];
  state?: string;
  locked?: boolean;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  author_association?: string;
  user?: GitHubUser;
  html_url?: string;
  url?: string;
  pull_request?: GitHubIssuePullRequestRef | null;
  reactions?: Record<string, number>;
}

export interface GitHubPRRef {
  label?: string;
  ref?: string;
  sha?: string;
  repo?: GitHubRepository | null;
}

export interface GitHubPullRequest {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  labels?: GitHubLabel[];
  milestone?: GitHubMilestone | null;
  assignees?: GitHubUser[];
  state?: string;
  locked?: boolean;
  comments?: number;
  review_comments?: number;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  merged_at?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  user?: GitHubUser;
  html_url?: string;
  url?: string;
  diff_url?: string;
  patch_url?: string;
  head?: GitHubPRRef;
  base?: GitHubPRRef;
}

export interface GitHubPRReview {
  id?: number;
  user?: GitHubUser;
  body?: string | null;
  state?: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING, ...
  submitted_at?: string;
  commit_id?: string;
  html_url?: string;
  pull_request_url?: string;
  comments?: GitHubPRReviewComment[]; // populated by the tool (separate endpoint)
}

export interface GitHubPRReviewComment {
  id?: number;
  body?: string | null;
  path?: string;
  line?: number | null;
  side?: string;
  start_line?: number | null;
  user?: GitHubUser;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  diff_hunk?: string;
  pull_request_review_id?: number | null;
  in_reply_to_id?: number | null;
  commit_id?: string;
}

export interface GitHubPRFile {
  sha?: string;
  filename?: string;
  previous_filename?: string | null;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  blob_url?: string;
  raw_url?: string;
  contents_url?: string;
}

export interface GitHubRepository {
  id?: number;
  name?: string;
  full_name?: string;
  owner?: GitHubUser;
  description?: string | null;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  html_url?: string;
  clone_url?: string;
  ssh_url?: string;
  homepage?: string | null;
  language?: string | null;
  stargazers_count?: number;
  stars?: number; // compat alias (Gitea field name)
  watchers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  default_branch?: string;
  created_at?: string;
  updated_at?: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface GitHubCommitStats {
  additions?: number;
  deletions?: number;
  total?: number;
}

export interface GitHubCommitFile {
  sha?: string;
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

export interface GitHubCommit {
  sha?: string;
  commit?: {
    message?: string;
    url?: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  };
  author?: GitHubUser | null;
  committer?: GitHubUser | null;
  html_url?: string;
  url?: string;
  files?: GitHubCommitFile[];
  stats?: GitHubCommitStats;
}

export interface GitHubBranch {
  name?: string;
  commit?: { sha?: string; id?: string; url?: string };
  protected?: boolean;
}

export interface GitHubReleaseAsset {
  id?: number;
  name?: string;
  label?: string | null;
  size?: number;
  download_count?: number;
  created_at?: string;
  updated_at?: string;
  browser_download_url?: string;
  api_url?: string;
}

export interface GitHubRelease {
  id?: number;
  name?: string | null;
  tag_name?: string;
  target_commitish?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  created_at?: string;
  published_at?: string | null;
  author?: GitHubUser;
  html_url?: string;
  tarball_url?: string;
  zipball_url?: string;
  assets?: GitHubReleaseAsset[];
}

export interface GitHubFileContent {
  type?: string; // "file" | "dir" | "symlink" | "submodule"
  encoding?: string; // "base64" | "none"
  content?: string;
  name?: string;
  path?: string;
  sha?: string;
  size?: number;
  url?: string;
  git_url?: string;
  html_url?: string;
  download_url?: string | null;
  target?: string | null;
  _links?: Record<string, string>;
}

export interface GitHubSearchResult<T> {
  total_count?: number;
  incomplete_results?: boolean;
  items: T[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface InstanceConfig {
  host: string;
  apiBase: string;
  alias?: string;
}

export interface AuthConfig {
  /** Optional GitHub Personal Access Token (or fine-grained token with read scope). */
  token?: string;
}

export interface PaginationConfig {
  defaultLimit?: number;
  maxLimit?: number;
}

export interface CacheConfig {
  ttl?: Record<string, number>;
  maxBytes?: number;
}

export interface TruncationConfig {
  maxBodyChars?: number;
  maxPatchChars?: number;
}

export interface GitHubConfig {
  auth?: AuthConfig;
  cache?: CacheConfig;
  pagination?: PaginationConfig;
  truncation?: TruncationConfig;
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  cached_at: string;
  ttl_seconds: number;
  data: T;
}

export interface CacheStatus {
  count: number;
  bytes: number;
  oldestAt?: string;
  newestAt?: string;
}

// ─── Detection ──────────────────────────────────────────────────────────────────

export interface DetectedRepo {
  detected: true;
  host: string;
  owner: string;
  repo: string;
  remoteUrl: string;
  apiBase: string;
}

export interface UndetectedRepo {
  detected: false;
  reason: string;
  remoteUrl?: string;
}

export type RepoDetectionResult = DetectedRepo | UndetectedRepo;

export interface ResolvedRepoContext {
  host: string;
  apiBase: string;
  owner: string;
  repo: string;
  explicit: boolean;
}

export interface ParsedRef {
  resolved: boolean;
  raw: string;
  host?: string;
  owner?: string;
  repo?: string;
  type?: "issue" | "pr";
  number?: number;
  error?: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────────

export type GitHubErrorKind =
  | "not_found"
  | "private_repo"
  | "rate_limited"
  | "network_error"
  | "invalid_params";

export interface GitHubErrorResponse {
  error: GitHubErrorKind;
  message: string;
  statusCode?: number;
  retryAfterSeconds?: number;
}
