// The REST v3 API: repositories, refs, branches, commits, contents, labels,
// issues, comments and pull requests, over the shared store. Every reply is
// JSON with a non-empty X-GitHub-Request-Id; errors are {"message": string}.
// The handler is transport-free: it takes a method, path segments, query and
// body, and returns a status, headers and a JSON-serialisable body.

import { isObjectId } from './gitobj.ts';
import { viewerLogin } from './scenario.ts';
import { ForgeError, notFound, unprocessable, type Repo, type Store } from './store.ts';

export interface RestResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface RestRequest {
  readonly method: string;
  /** Path segments, already percent-decoded, without a leading empty segment. */
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** The request's Host header, for building absolute pagination URLs. */
  readonly host: string;
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `${Date.now().toString(16)}-${requestCounter.toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return { status, headers: { 'x-github-request-id': requestId(), ...extraHeaders }, body };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const created = new Date(repo.createdAt).toISOString();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    created_at: created,
    updated_at: created,
    has_issues: true,
  };
}

function issueJson(repo: Repo, issue: import('./store.ts').Issue): Record<string, unknown> {
  const created = new Date(issue.createdAt).toISOString();
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: viewerLogin() },
    comments: issue.comments.length,
    created_at: created,
    updated_at: created,
  };
}

function pullJson(repo: Repo, pull: import('./store.ts').Pull): Record<string, unknown> {
  const created = new Date(pull.createdAt).toISOString();
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, repo: { name: repo.name, owner: { login: repo.owner } } },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: { name: repo.name, owner: { login: repo.owner } } },
    user: { login: viewerLogin() },
    created_at: created,
    updated_at: created,
  };
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ForgeError(400, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, field: string, required = true): string {
  const value = body[field];
  if (typeof value === 'string') return value;
  if (!required && value === undefined) return '';
  throw new ForgeError(400, `field ${field} must be a string`);
}

function bodyStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  throw new ForgeError(400, `field ${field} must be an array of strings`);
}

/** The Link header for a paginated list: first/prev/next/last with absolute URLs. */
function paginationLinks(host: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (pageNumber: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(pageNumber));
    params.set('per_page', String(perPage));
    return `http://${host}${path}?${params.toString()}`;
  };
  const links: string[] = [`<${urlFor(1)}>; rel="first"`, `<${urlFor(lastPage)}>; rel="last"`];
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (page < lastPage) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  return links.join(', ');
}

export function handleRest(store: Store, request: RestRequest): RestResponse {
  const { method, segments } = request;
  // GET /api/v3/ — the API root.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (method !== 'GET') throw new ForgeError(405, 'Method not allowed');
    return json(200, {}, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    if (method !== 'GET') throw new ForgeError(405, 'Method not allowed');
    return json(200, { installed_version: '0.1.0' });
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
    if (method === 'GET') return json(200, { login: viewerLogin(), id: 1000, type: 'User' });
    throw new ForgeError(405, 'Method not allowed');
  }
  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      const body = bodyObject(request.body);
      const repo = store.createRepo(viewerLogin(), bodyString(body, 'name'), {
        description: body['description'] === undefined ? undefined : bodyString(body, 'description'),
        private: body['private'] === true,
        defaultBranch: body['default_branch'] === undefined ? undefined : bodyString(body, 'default_branch'),
      });
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(request.query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(request.query.get('page') ?? '1', 10) || 1);
      const repos = store.reposOf(viewerLogin());
      const slice = repos.slice((page - 1) * perPage, page * perPage);
      const link = paginationLinks(request.host, '/api/v3/user/repos', request.query, page, perPage, repos.length);
      return json(200, slice.map((repo) => repoJson(repo)), { link });
    }
    throw new ForgeError(405, 'Method not allowed');
  }
  // Everything below is /api/v3/repos/{owner}/{repo}[...]
  if (segments.length < 5 || segments[0] !== 'api' || segments[1] !== 'v3' || segments[2] !== 'repos') {
    throw notFound('Not Found');
  }
  const owner = segments[3] as string;
  const repoName = segments[4] as string;
  const repo = store.getRepo(owner, repoName);
  const tail = segments.slice(5);

  // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
  if (tail.length === 0) {
    if (!repo) throw notFound(`Repository ${owner}/${repoName} not found`);
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = bodyObject(request.body);
      if (body['description'] !== undefined) repo.description = bodyString(body, 'description');
      if (body['private'] !== undefined) repo.private = body['private'] === true;
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, headers: { 'x-github-request-id': requestId() }, body: null };
    }
    throw new ForgeError(405, 'Method not allowed');
  }
  if (!repo) throw notFound(`Repository ${owner}/${repoName} not found`);

  // POST /git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
    const body = bodyObject(request.body);
    const ref = bodyString(body, 'ref');
    const sha = bodyString(body, 'sha');
    if (!ref.startsWith('refs/')) throw unprocessable('ref must start with refs/');
    if (!isObjectId(sha) || !store.object(sha)) throw unprocessable(`Object ${sha} not found`);
    store.setRef(repo, ref, sha);
    return json(201, { ref, object: { sha } });
  }
  // GET /branches
  if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((name) => name.startsWith('refs/heads/'))
      .sort()
      .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) } }));
    return json(200, branches);
  }
  // GET /branches/{branch}
  if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
    const sha = store.branchTip(repo, tail[1] as string);
    if (!sha) throw notFound(`Branch ${tail[1]} not found`);
    return json(200, { name: tail[1], commit: { sha } });
  }
  // GET /git/refs/{ref...} — one ref by name, e.g. refs/heads/main.
  if (tail.length >= 3 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
    const ref = `refs/${tail.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (!sha) throw notFound(`Reference ${ref} not found`);
    return json(200, { ref, object: { sha } });
  }
  // GET /commits
  if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
    const shaParam = request.query.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = isObjectId(shaParam) ? shaParam : store.branchTip(repo, shaParam);
      if (!tip || !store.object(tip)) throw notFound(`Commit ${shaParam} not found`);
    } else {
      tip = store.defaultTip(repo);
      if (!tip) return json(200, []);
    }
    const commits = store.listCommits(tip).map((commit) => {
      const view = store.commitView(commit.sha);
      const authorLine = view?.author ?? '';
      const authorName = authorLine.split(' <')[0] ?? '';
      const authorEmail = authorLine.match(/<([^>]*)>/)?.[1] ?? '';
      return {
        sha: commit.sha,
        commit: {
          message: commit.message,
          author: { name: authorName, email: authorEmail, date: new Date(commit.timestamp * 1000).toISOString() },
          committer: { name: authorName, email: authorEmail, date: new Date(commit.timestamp * 1000).toISOString() },
        },
        parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    });
    return json(200, commits);
  }
  // PUT/GET/DELETE /contents/{path}
  if (tail.length >= 2 && tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    return handleContents(store, repo, request, path);
  }
  // POST /labels, GET /labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'POST') {
      const body = bodyObject(request.body);
      const label = store.createLabel(repo, bodyString(body, 'name'), bodyString(body, 'color'));
      return json(201, { name: label.name, color: label.color });
    }
    if (method === 'GET') {
      return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    throw new ForgeError(405, 'Method not allowed');
  }
  // Issues: /issues, /issues/{n}, /issues/{n}/comments
  if (tail[0] === 'issues') {
    return handleIssues(store, repo, request, tail.slice(1));
  }
  // Pulls: /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
  if (tail[0] === 'pulls') {
    return handlePulls(store, repo, request, tail.slice(1));
  }
  throw notFound('Not Found');
}

function handleContents(store: Store, repo: Repo, request: RestRequest, path: string): RestResponse {
  const { method } = request;
  const branch = request.query.get('ref') ?? undefined;
  if (method === 'GET') {
    const tip = branch ? (isObjectId(branch) ? branch : store.branchTip(repo, branch)) : store.defaultTip(repo);
    if (!tip) throw notFound(`Branch ${branch ?? repo.defaultBranch} not found`);
    const resolved = store.resolvePath(tip, path);
    if (!resolved) throw notFound(`File ${path} not found`);
    if (resolved.kind === 'file') {
      const object = store.object(resolved.entry.oid);
      if (!object) throw notFound(`File ${path} not found`);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: resolved.entry.oid,
        size: object.data.length,
        name: path.split('/').pop(),
        path,
      });
    }
    const entries = [...resolved.entries]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
      }));
    return json(200, entries);
  }
  if (method === 'PUT') {
    const body = bodyObject(request.body);
    const message = bodyString(body, 'message');
    const contentBase64 = bodyString(body, 'content');
    const branchName = body['branch'] === undefined ? repo.defaultBranch : bodyString(body, 'branch');
    const expectedSha = body['sha'] === undefined ? undefined : bodyString(body, 'sha');
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    } catch {
      throw new ForgeError(400, 'content is not valid base64');
    }
    const result = store.writeFile(repo, branchName, path, content, message, expectedSha);
    return json(result.created ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'DELETE') {
    const body = bodyObject(request.body);
    const message = bodyString(body, 'message');
    const branchName = body['branch'] === undefined ? repo.defaultBranch : bodyString(body, 'branch');
    const expectedSha = body['sha'] === undefined ? undefined : bodyString(body, 'sha');
    const commitSha = store.deleteFile(repo, branchName, path, message, expectedSha);
    return json(200, { commit: { sha: commitSha, message } });
  }
  throw new ForgeError(405, 'Method not allowed');
}

function handleIssues(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResponse {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(request.body);
      const issue = store.createIssue(
        repo,
        bodyString(body, 'title'),
        body['body'] === undefined ? '' : bodyString(body, 'body'),
        bodyStringArray(body, 'labels'),
      );
      return json(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const direction = request.query.get('direction') === 'desc' ? 'desc' : 'asc';
      const issues = store.listIssues(repo, {
        state: state === 'all' ? undefined : state,
        direction,
      });
      return json(200, issues.map((issue) => issueJson(repo, issue)));
    }
    throw new ForgeError(405, 'Method not allowed');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isFinite(number)) throw notFound('Not Found');
  const issue = store.requireIssue(repo, number);
  if (tail.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = bodyObject(request.body);
      if (body['state'] === 'open' || body['state'] === 'closed') issue.state = body['state'];
      if (body['title'] !== undefined) issue.title = bodyString(body, 'title');
      if (body['body'] !== undefined) issue.body = bodyString(body, 'body');
      return json(200, issueJson(repo, issue));
    }
    throw new ForgeError(405, 'Method not allowed');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = bodyObject(request.body);
      const comment = store.addComment(repo, issue, bodyString(body, 'body'));
      return json(201, { id: comment.id, body: comment.body, user: { login: comment.user } });
    }
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.user } })));
    }
    throw new ForgeError(405, 'Method not allowed');
  }
  throw notFound('Not Found');
}

function handlePulls(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResponse {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(request.body);
      const pull = store.createPull(
        repo,
        bodyString(body, 'title'),
        body['body'] === undefined ? '' : bodyString(body, 'body'),
        bodyString(body, 'head'),
        bodyString(body, 'base'),
      );
      return json(201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = request.query.get('state');
      const pulls = store.listPulls(repo, state === 'all' ? 'all' : undefined);
      return json(200, pulls.map((pull) => pullJson(repo, pull)));
    }
    throw new ForgeError(405, 'Method not allowed');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isFinite(number)) throw notFound('Not Found');
  const pull = store.requirePull(repo, number);
  if (tail.length === 1) {
    if (method === 'GET') return json(200, pullJson(repo, pull));
    throw new ForgeError(405, 'Method not allowed');
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    return json(200, pull.files);
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const commitSha = store.mergePull(repo, pull);
    return json(200, {
      sha: commitSha,
      merged: true,
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
    });
  }
  throw notFound('Not Found');
}
