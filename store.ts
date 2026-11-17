// The forge's store: every repository, ref, git object, issue, pull request,
// label and comment, held in memory and shared by the git, REST, GraphQL and
// MCP surfaces. One store per process, one object pool for all repositories
// (objects only ever reach a client when they are reachable from that
// repository's own refs, so sharing the pool is invisible to clients).
//
// Global ids are opaque base64 of a type prefix plus the numeric coordinates,
// e.g. `Repository:12` -> `UmVwb3NpdG9yeToxMg==`; they decode back to the same
// coordinates, are stable across reads, and never equal the bare number.
// Timestamps come from a logical clock (one second per commit, starting at
// 2025-01-01) so the same request sequence builds the same commits on every
// run, live or replayed.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { viewerId, viewerLogin } from './scenario.ts';

export type IssueState = 'open' | 'closed';
export type PullState = 'open' | 'closed';

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: number;
}

export interface Issue {
  readonly id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  comments: Comment[];
  readonly createdAt: number;
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed' | 'changed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface Pull {
  readonly id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  readonly createdAt: number;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: number;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export interface RepoView {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  readonly description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

/** A failure with an HTTP status, the way the surfaces report errors. */
export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(message: string): ForgeError {
  return new ForgeError(404, message);
}

export function conflict(message: string): ForgeError {
  return new ForgeError(409, message);
}

export function unprocessable(message: string): ForgeError {
  return new ForgeError(422, message);
}

/** Encode a global id: base64 of `Type:coord:coord`. */
export function encodeGlobalId(kind: string, ...coords: Array<string | number>): string {
  return Buffer.from(`${kind}:${coords.join(':')}`, 'utf8').toString('base64');
}

/** Decode a global id made by encodeGlobalId; null when it is not one. */
export function decodeGlobalId(id: string): { kind: string; coords: string[] } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0] as string;
  if (!/^[A-Za-z]+$/.test(kind)) return null;
  // Round-trip check: the id must have been produced by the encoder.
  if (encodeGlobalId(kind, ...parts.slice(1)) !== id) return null;
  return { kind, coords: parts.slice(1) };
}

/** The flat file map of a tree: path -> {mode, oid} for every blob in it. */
export type FlatTree = Map<string, { mode: string; oid: string }>;

/** Flatten a tree (following subtrees) into path -> blob. */
export function flattenTree(treeOid: string, lookup: (oid: string) => GitObject | undefined): FlatTree {
  const flat: FlatTree = new Map();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') flat.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return flat;
}

/** Build a tree object from a flat file map, creating every subtree. Returns the root tree oid. */
export function buildTreeFromFlat(flat: FlatTree, store: (type: GitObjectType, data: Buffer) => string): string {
  interface Node {
    entries: Map<string, { mode: string; oid: string; isDir: boolean }>;
  }
  const root: Node = { entries: new Map() };
  const nodes = new Map<string, Node>([['', root]]);
  const nodeFor = (dir: string): Node => {
    let node = nodes.get(dir);
    if (node) return node;
    node = { entries: new Map() };
    nodes.set(dir, node);
    const slash = dir.lastIndexOf('/');
    const parent = slash < 0 ? '' : dir.slice(0, slash);
    const name = slash < 0 ? dir : dir.slice(slash + 1);
    nodeFor(parent).entries.set(name, { mode: '40000', oid: '', isDir: true });
    return node;
  };
  for (const [path, file] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    nodeFor(dir).entries.set(name, { mode: file.mode, oid: file.oid, isDir: false });
  }
  const build = (dir: string): string => {
    const node = nodes.get(dir) as Node;
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.entries) {
      const oid = entry.isDir ? build(`${dir ? `${dir}/` : ''}${name}`) : entry.oid;
      entries.push({ mode: entry.mode, name, oid });
    }
    return store('tree', buildTree(entries));
  };
  return build('');
}

/** A line diff between two texts: lines added and lines removed, via longest common subsequence. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline makes the last split element '' on both sides; drop it so
  // a file that only gains a final newline is not counted as changed.
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i * cols + j] =
        oldLines[i - 1] === newLines[j - 1]
          ? table[(i - 1) * cols + (j - 1)] + 1
          : Math.max(table[(i - 1) * cols + j], table[i * cols + (j - 1)]);
    }
  }
  const common = table[oldLines.length * cols + newLines.length];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The file-level diff between two flat trees, in filename order. */
export function diffFlatTrees(
  oldFlat: FlatTree,
  newFlat: FlatTree,
  lookup: (oid: string) => GitObject | undefined,
): PullFile[] {
  const files: PullFile[] = [];
  const paths = new Set([...oldFlat.keys(), ...newFlat.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = oldFlat.get(path);
    const newEntry = newFlat.get(path);
    if (oldEntry && !newEntry) {
      const oldText = lookup(oldEntry.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineDiff(oldText, '');
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!oldEntry && newEntry) {
      const newText = lookup(newEntry.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineDiff('', newText);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      const oldText = lookup(oldEntry.oid)?.data.toString('utf8') ?? '';
      const newText = lookup(newEntry.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

export class Store {
  /** Every git object in the process, keyed by oid. */
  readonly objects = new Map<string, GitObject>();
  /** Repositories keyed by `owner/name`. */
  readonly repos = new Map<string, Repo>();
  /** Repository ids in creation order (for GET /user/repos pagination). */
  readonly repoOrder: Repo[] = [];
  #nextRepoId = 1;
  /** The logical clock: seconds since the epoch, one tick per commit. */
  #clock = 1_735_689_600;
  /** Bumped whenever an object enters the pool; the fetch pack cache keys on it. */
  generation = 0;

  /** The next commit timestamp, one second after the last. */
  tick(): number {
    this.#clock += 1;
    return this.#clock;
  }

  object(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.generation += 1;
    }
    return oid;
  }

  putObjects(objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!this.objects.has(oid)) {
        this.objects.set(oid, { type: object.type, data: object.data });
        this.generation += 1;
      }
    }
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  requireRepo(owner: string, name: string): Repo {
    const repo = this.getRepo(owner, name);
    if (!repo) throw notFound(`Repository ${owner}/${name} not found`);
    return repo;
  }

  /** Create a repository owned by `owner`. 422 when the name already exists under that owner. */
  createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    if (!name || name.includes('/')) throw unprocessable('Repository name is invalid');
    if (this.repos.has(this.repoKey(owner, name))) {
      throw unprocessable(`Repository ${owner}/${name} already exists`);
    }
    const repo: Repo = {
      id: this.#nextRepoId,
      name,
      owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: this.#clock * 1000,
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.#nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const repo = this.requireRepo(owner, name);
    this.repos.delete(this.repoKey(owner, name));
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
  }

  /** The repositories owned by `login`, in creation order. */
  reposOf(login: string): Repo[] {
    return this.repoOrder.filter((repo) => repo.owner === login);
  }

  // -------------------------------------------------------------------------------------------
  // refs and commits
  // -------------------------------------------------------------------------------------------

  /** The oid a ref points at, or undefined. `ref` is a full refname like `refs/heads/main`. */
  refOid(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Set a ref. `sha` must be an existing object (or the zero oid to delete). */
  setRef(repo: Repo, ref: string, sha: string): void {
    if (sha === ZERO_OID) {
      repo.refs.delete(ref);
      return;
    }
    if (!isObjectId(sha) || !this.objects.has(sha)) throw notFound(`Object ${sha} not found`);
    repo.refs.set(ref, sha);
  }

  /** The tip of a branch name, or undefined when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The tip of the default branch, or undefined when the repository is empty. */
  defaultTip(repo: Repo): string | undefined {
    return this.branchTip(repo, repo.defaultBranch);
  }

  /** The tree oid of a commit, or undefined when the commit is missing. */
  commitTree(commitOid: string): string | undefined {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /** The commit view for an oid, or undefined. */
  commitView(commitOid: string): ReturnType<typeof parseCommit> | undefined {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** Every commit reachable from `tip`, newest first (by commit time, then by walk order). */
  listCommits(tip: string): Array<{ sha: string; message: string; timestamp: number }> {
    const reachable = collectReachable([tip], (oid) => this.objects.get(oid), { allowMissing: true });
    const commits: Array<{ sha: string; message: string; timestamp: number }> = [];
    for (const oid of reachable) {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      const author = view.author.match(/ (\d+) [+-]\d{4}$/);
      commits.push({ sha: oid, message: view.message, timestamp: author ? Number(author[1]) : 0 });
    }
    commits.sort((a, b) => b.timestamp - a.timestamp || (a.sha < b.sha ? -1 : 1));
    return commits;
  }

  /** The first common ancestor of two commits (the merge-base), or undefined when there is none. */
  mergeBase(a: string, b: string): string | undefined {
    const aAncestors = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop() as string;
      if (aAncestors.has(oid)) continue;
      aAncestors.add(oid);
      const view = this.commitView(oid);
      if (view) queueA.push(...view.parents);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (aAncestors.has(oid)) return oid;
      const view = this.commitView(oid);
      if (view) queueB.push(...view.parents);
    }
    return undefined;
  }

  /** Is `ancestor` reachable from `descendant` (or the same commit)? */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const queue = [descendant];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitView(oid);
      if (!view) continue;
      if (view.parents.includes(ancestor)) return true;
      queue.push(...view.parents);
    }
    return false;
  }

  /** Build a commit on top of `parents` with the viewer's identity and store it. Returns its oid. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const timestamp = this.tick();
    const identity = `${viewerLogin()} <${viewerLogin()}@example.invalid>`;
    const data = buildCommit({
      tree,
      parents,
      message,
      author: identity,
      committer: identity,
      timestamp,
    });
    return this.putObject('commit', data);
  }

  /** The flat file map of a commit's tree, or an empty map when the commit is missing. */
  flatTreeOf(commitOid: string): FlatTree {
    const tree = this.commitTree(commitOid);
    if (!tree) return new Map();
    return flattenTree(tree, (oid) => this.objects.get(oid));
  }

  // -------------------------------------------------------------------------------------------
  // contents
  // -------------------------------------------------------------------------------------------

  /**
   * Resolve a path inside a commit's tree. Returns the blob entry for a file, or the
   * tree entries for a directory, or null when the path does not exist.
   */
  resolvePath(
    commitOid: string,
    path: string,
  ): { kind: 'file'; entry: TreeEntry } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const treeOid = this.commitTree(commitOid);
    if (!treeOid) return null;
    const parts = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entries = parseTree(object.data);
      const entry = entries.find((candidate) => candidate.name === parts[i]);
      if (!entry) return null;
      const isLast = i === parts.length - 1;
      if (isLast) {
        if (entry.mode === '40000') {
          const dirObject = this.objects.get(entry.oid);
          if (!dirObject || dirObject.type !== 'tree') return null;
          return { kind: 'dir', entries: parseTree(dirObject.data) };
        }
        return { kind: 'file', entry };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const root = this.objects.get(current);
    if (!root || root.type !== 'tree') return null;
    return { kind: 'dir', entries: parseTree(root.data) };
  }

  /**
   * Write a file into a branch: create or update it, build the new tree and a
   * commit, move the branch. Returns the commit oid and the new blob oid.
   * Throws 409 when `expectedSha` is given and the file's current blob differs.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const tip = this.branchTip(repo, branch);
    const flat = tip ? this.flatTreeOf(tip) : new Map<string, { mode: string; oid: string }>();
    const existing = flat.get(path);
    if (expectedSha !== undefined) {
      if (!existing || existing.oid !== expectedSha) {
        throw conflict(`sha ${expectedSha} does not match the current blob for ${path}`);
      }
    }
    const created = !existing;
    const blobSha = this.putObject('blob', content);
    flat.set(path, { mode: '100644', oid: blobSha });
    const treeOid = buildTreeFromFlat(flat, (type, data) => this.putObject(type, data));
    const commitSha = this.makeCommit(treeOid, tip ? [tip] : [], message);
    this.setRef(repo, `refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha, created };
  }

  /**
   * Delete a file from a branch. Returns the new commit oid.
   * Throws 404 when the file does not exist, 409 when `expectedSha` mismatches.
   */
  deleteFile(repo: Repo, branch: string, path: string, message: string, expectedSha?: string): string {
    const tip = this.branchTip(repo, branch);
    if (!tip) throw notFound(`Branch ${branch} does not exist`);
    const flat = this.flatTreeOf(tip);
    const existing = flat.get(path);
    if (!existing) throw notFound(`File ${path} not found`);
    if (expectedSha !== undefined && existing.oid !== expectedSha) {
      throw conflict(`sha ${expectedSha} does not match the current blob for ${path}`);
    }
    flat.delete(path);
    const treeOid = buildTreeFromFlat(flat, (type, data) => this.putObject(type, data));
    const commitSha = this.makeCommit(treeOid, [tip], message);
    this.setRef(repo, `refs/heads/${branch}`, commitSha);
    return commitSha;
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (repo.labels.has(name)) throw unprocessable(`Label ${name} already exists`);
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue. 422 when a named label does not exist on the repository. */
  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    for (const name of labels) {
      if (!repo.labels.has(name)) throw unprocessable(`Label ${name} does not exist`);
    }
    const issue: Issue = {
      id: repo.id * 1_000_000 + repo.nextIssueNumber,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: this.#clock * 1000,
    };
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  requireIssue(repo: Repo, number: number): Issue {
    const issue = this.getIssue(repo, number);
    if (!issue) throw notFound(`Issue #${number} not found`);
    return issue;
  }

  /** Issues filtered by state and ordered by creation (asc or desc). */
  listIssues(repo: Repo, options: { state?: string; direction?: 'asc' | 'desc' }): Issue[] {
    let issues = [...repo.issues];
    if (options.state === 'open' || options.state === 'closed') {
      issues = issues.filter((issue) => issue.state === options.state);
    }
    issues.sort((a, b) =>
      options.direction === 'desc' ? b.number - a.number : a.number - b.number,
    );
    return issues;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: repo.nextCommentId,
      body,
      user: viewerLogin(),
      createdAt: this.#clock * 1000,
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  /** The diff between two commits' trees, as the pull-request file list. */
  filesBetween(baseCommit: string, headCommit: string): PullFile[] {
    const baseFlat = this.flatTreeOf(baseCommit);
    const headFlat = this.flatTreeOf(headCommit);
    return diffFlatTrees(baseFlat, headFlat, (oid) => this.objects.get(oid));
  }

  /** Create a pull request from `head` branch onto `base` branch. */
  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const headName = head.includes(':') ? (head.split(':').slice(1).join(':') as string) : head;
    const baseName = base.includes(':') ? (base.split(':').slice(1).join(':') as string) : base;
    const headSha = this.branchTip(repo, headName);
    if (!headSha) throw notFound(`Branch ${headName} not found`);
    const baseSha = this.branchTip(repo, baseName);
    if (!baseSha) throw notFound(`Branch ${baseName} not found`);
    const pull: Pull = {
      id: repo.id * 1_000_000 + repo.nextPullNumber,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: headName,
      baseRef: baseName,
      headSha,
      baseSha,
      files: this.filesBetween(baseSha, headSha),
      createdAt: this.#clock * 1000,
    };
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  requirePull(repo: Repo, number: number): Pull {
    const pull = this.getPull(repo, number);
    if (!pull) throw notFound(`Pull request #${number} not found`);
    return pull;
  }

  /** Pull requests: `all` lists open and closed; anything else lists open only. */
  listPulls(repo: Repo, state?: string): Pull[] {
    if (state === 'all') return [...repo.pulls];
    return repo.pulls.filter((pull) => pull.state === 'open');
  }

  /** Is this pull request mergeable (no file changed differently on both sides of its merge-base)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const base = this.mergeBase(pull.baseSha, pull.headSha);
    if (!base) return true;
    const baseFlat = this.flatTreeOf(base);
    const headFlat = this.flatTreeOf(pull.headSha);
    const targetFlat = this.flatTreeOf(pull.baseSha);
    for (const path of new Set([...headFlat.keys(), ...baseFlat.keys()])) {
      const atBase = baseFlat.get(path)?.oid;
      const atHead = headFlat.get(path)?.oid;
      const atTarget = targetFlat.get(path)?.oid;
      if (atHead !== atBase && atTarget !== atBase && atHead !== atTarget) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose tree is
   * the three-way merge of base + head over their merge-base, parented on the
   * base tip. Returns the merge commit oid. Throws 405 when the merge conflicts.
   */
  mergePull(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') throw new ForgeError(405, `Pull request #${pull.number} is not open`);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (!baseTip) throw notFound(`Branch ${pull.baseRef} not found`);
    const headTip = this.branchTip(repo, pull.headRef);
    if (!headTip) throw notFound(`Branch ${pull.headRef} not found`);
    const base = this.mergeBase(baseTip, headTip);
    const baseFlat = base ? this.flatTreeOf(base) : new Map<string, { mode: string; oid: string }>();
    const headFlat = this.flatTreeOf(headTip);
    const targetFlat = this.flatTreeOf(baseTip);
    const merged: FlatTree = new Map(targetFlat);
    for (const path of new Set([...headFlat.keys(), ...baseFlat.keys()])) {
      const atBase = baseFlat.get(path);
      const atHead = headFlat.get(path);
      const atTarget = targetFlat.get(path);
      if (atHead?.oid === atBase?.oid) {
        // Unchanged on the head side: keep the target's version.
        continue;
      }
      if (atTarget?.oid === atBase?.oid) {
        // Unchanged on the target side: take the head's version.
        if (atHead) merged.set(path, { mode: atHead.mode, oid: atHead.oid });
        else merged.delete(path);
        continue;
      }
      if (atHead?.oid === atTarget?.oid) continue;
      // Changed on both sides to different contents: a real conflict.
      throw new ForgeError(405, `Merge conflict in ${path}`);
    }
    const treeOid = buildTreeFromFlat(merged, (type, data) => this.putObject(type, data));
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commitSha = this.makeCommit(treeOid, [baseTip], message);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(this.#clock * 1000).toISOString();
    pull.mergeCommitSha = commitSha;
    pull.baseSha = commitSha;
    return commitSha;
  }

  /** The viewer id, for the GraphQL viewer field and REST user endpoints. */
  viewerNumericId(): number {
    return viewerId();
  }
}
