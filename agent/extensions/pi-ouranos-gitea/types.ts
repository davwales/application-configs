/**
 * Shared TypeScript types for pi-ouranos-gitea.
 *
 * All Gitea API response shapes use optional fields liberally — the Gitea API
 * varies between versions/instances (Forgejo, Codeberg) and we never want a
 * missing field to crash a tool. Payloads we *return* to the model are pruned
 * to a small known set (see tools/*.ts), so the raw shapes here just need to be
 * permissive enough to read from JSON.
 */

// ─── Gitea API response shapes ────────────────────────────────────────────────

export interface GiteaUser {
  id?: number;
  login?: string;
  full_name?: string;
  email?: string;
  avatar_url?: string;
  html_url?: string;
  is_admin?: boolean;
}

export interface GiteaLabel {
  id?: number;
  name?: string;
  color?: string;
  description?: string;
  exclusive?: boolean;
  url?: string;
}

export interface GiteaMilestone {
  id?: number;
  title?: string;
  description?: string;
  state?: string;
  open_issues?: number;
  closed_issues?: number;
  due_on?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  url?: string;
}

export interface GiteaComment {
  id?: number;
  body?: string;
  user?: GiteaUser;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  issue_url?: string;
}

export interface GiteaIssue {
  id?: number;
  number?: number;
  title?: string;
  body?: string;
  labels?: GiteaLabel[];
  milestone?: GiteaMilestone | null;
  assignees?: GiteaUser[];
  state?: string;
  is_locked?: boolean;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  due_date?: string | null;
  user?: GiteaUser;
  html_url?: string;
  url?: string;
  pull_request?: { merged?: boolean; merged_at?: string | null } | null;
  reactions?: Record<string, number>;
}

export interface GiteaPullRequest {
  id?: number;
  number?: number;
  title?: string;
  body?: string;
  labels?: GiteaLabel[];
  milestone?: GiteaMilestone | null;
  assignees?: GiteaUser[];
  state?: string;
  is_locked?: boolean;
  comments?: number;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean;
  merged_at?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  user?: GiteaUser;
  html_url?: string;
  url?: string;
  diff_url?: string;
  patch_url?: string;
  head?: { ref?: string; sha?: string; label?: string; repo?: GiteaRepository };
  base?: { ref?: string; sha?: string; label?: string; repo?: GiteaRepository };
}

export interface GiteaPRReview {
  id?: number;
  user?: GiteaUser;
  body?: string;
  state?: string; // APPROVED, CHANGES_REQUESTED, COMMENT, PENDING, ...
  official?: boolean;
  submitted_at?: string;
  updated_at?: string;
  html_url?: string;
  comments?: GiteaPRReviewComment[];
}

export interface GiteaPRReviewComment {
  id?: number;
  body?: string;
  path?: string;
  line?: number;
  side?: string;
  user?: GiteaUser;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  diff_hunk?: string;
}

export interface GiteaPRFile {
  sha?: string;
  filename?: string;
  previous_filename?: string | null;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

export interface GiteaRepository {
  id?: number;
  name?: string;
  full_name?: string;
  owner?: GiteaUser;
  description?: string;
  private?: boolean;
  fork?: boolean;
  template?: boolean;
  archived?: boolean;
  html_url?: string;
  clone_url?: string;
  ssh_url?: string;
  website?: string;
  language?: string;
  // Gitea/Forgejo return stars_count / watchers_count. Older Gitea versions
  // used stars / watchers — keep both as optional and prefer *_count everywhere.
  stars?: number;
  stars_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  watchers?: number;
  watchers_count?: number;
  default_branch?: string;
  created_at?: string;
  updated_at?: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface GiteaCommitStats {
  additions?: number;
  deletions?: number;
  total?: number;
}

export interface GiteaCommitFile {
  sha?: string;
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

export interface GiteaCommit {
  sha?: string;
  commit?: {
    message?: string;
    url?: string;
    author?: { name?: string; email?: string; username?: string; date?: string };
    committer?: { name?: string; email?: string; username?: string; date?: string };
  };
  author?: GiteaUser | null;
  committer?: GiteaUser | null;
  html_url?: string;
  url?: string;
  files?: GiteaCommitFile[];
  stats?: GiteaCommitStats;
  created?: string;
}

export interface GiteaBranch {
  name?: string;
  commit?: { id?: string; sha?: string; url?: string; message?: string };
  protected?: boolean;
  user_can_push?: boolean;
  user_can_merge?: boolean;
}

export interface GiteaTag {
  name?: string;
  id?: string;
  commit?: { sha?: string; url?: string };
  zipball_url?: string;
  tarball_url?: string;
}

export interface GiteaReleaseAsset {
  id?: number;
  name?: string;
  size?: number;
  download_count?: number;
  created_at?: string;
  browser_download_url?: string;
  api_url?: string;
}

export interface GiteaRelease {
  id?: number;
  name?: string | null;
  tag_name?: string;
  target_commitish?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  created_at?: string;
  published_at?: string | null;
  author?: GiteaUser;
  html_url?: string;
  tarball_url?: string;
  zipball_url?: string;
  assets?: GiteaReleaseAsset[];
}

export interface GiteaFileContent {
  type?: string; // "file" | "dir" | "symlink" | "submodule"
  encoding?: string; // "base64" | "plain"
  content?: string;
  name?: string;
  path?: string;
  sha?: string;
  size?: number;
  url?: string;
  html_url?: string;
  download_url?: string | null;
  target?: string | null;
  commit?: { url?: string; sha?: string };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface InstanceConfig {
  host: string;
  apiBase: string;
  alias?: string;
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

export interface GiteaConfig {
  instances?: InstanceConfig[];
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
  instanceAlias?: string;
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

export type GiteaErrorKind =
  | "not_found"
  | "private_repo"
  | "rate_limited"
  | "network_error"
  | "invalid_params";

export interface GiteaErrorResponse {
  error: GiteaErrorKind;
  message: string;
  statusCode?: number;
  retryAfterSeconds?: number;
}