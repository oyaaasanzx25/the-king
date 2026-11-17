// The MCP endpoint: POST /mcp, JSON-RPC 2.0 over Streamable HTTP, speaking the
// modern 2026-07-28 revision (server/discover, no handshake, no session) and
// the legacy initialize handshake for servers that predate discover. One JSON
// body answers each request; notifications (no id) answer HTTP 202 with no
// body. Every tool runs against the shared store, so a repository or issue
// created over MCP is the same object over REST.
//
// The six tools are github-mcp-server's canonical names, with the documented
// argument contract: create_repo {name, description?, private?};
// get_repo {owner, repo}; create_issue {owner, repo, title, body?};
// list_issues {owner, repo, state?}; create_pull_request {owner, repo, title,
// head, base}; merge_pull_request {owner, repo, pull_number}. A tool's
// `required` list holds only properties the suite can fill, so a call is
// never refused for an argument the suite has no value for.

import { viewerLogin } from './scenario.ts';
import { ForgeError, notFound, type Repo, type Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-forge';
export const MCP_SERVER_VERSION = '0.1.0';

/** The revisions this server speaks, newest first. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, { type: string; description: string }>;
  readonly required: string[];
}

/** The tool list: a module-level constant, so two tools/list answers are byte-identical. */
export const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
]);

function toolJson(tool: McpToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  };
}

function serverInfo(): Record<string, string> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    created_at: new Date(repo.createdAt).toISOString(),
    updated_at: new Date(repo.createdAt).toISOString(),
    has_issues: true,
  };
}

function issueJson(repo: Repo, issue: import('./store.ts').Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: viewerLogin() },
    comments: issue.comments.length,
    created_at: new Date(issue.createdAt).toISOString(),
    updated_at: new Date(issue.createdAt).toISOString(),
  };
}

function pullJson(repo: Repo, pull: import('./store.ts').Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: viewerLogin() },
    created_at: new Date(pull.createdAt).toISOString(),
    updated_at: new Date(pull.createdAt).toISOString(),
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argsObject(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value === 'string' && value !== '') return value;
  throw new ForgeError(-32602, `Missing required argument: ${field}`);
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === 'string' ? value : undefined;
}

/** Run one tool by name against the store. Throws ForgeError(-32602) on bad arguments. */
function callTool(store: Store, name: string, args: unknown): Record<string, unknown> {
  const params = argsObject(args);
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ForgeError(-32602, `Unknown tool: ${name}`);
  // The suite maps its documented arguments onto the schema's property names;
  // a missing required property is a tool error, not a crash.
  for (const field of tool.required) {
    if (params[field] === undefined || params[field] === '') {
      return toolError(`Missing required argument: ${field}`);
    }
  }
  try {
    if (name === 'create_repo') {
      const repo = store.createRepo(viewerLogin(), requireString(params, 'name'), {
        description: optionalString(params, 'description'),
        private: params['private'] === true,
      });
      return toolResult(repoJson(repo));
    }
    const owner = requireString(params, 'owner');
    const repoName = requireString(params, 'repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) throw notFound(`Repository ${owner}/${repoName} not found`);
    if (name === 'get_repo') return toolResult(repoJson(repo));
    if (name === 'create_issue') {
      const issue = store.createIssue(
        repo,
        requireString(params, 'title'),
        optionalString(params, 'body') ?? '',
        [],
      );
      return toolResult(issueJson(repo, issue));
    }
    if (name === 'list_issues') {
      const state = optionalString(params, 'state') ?? 'open';
      const issues = store.listIssues(repo, { state: state === 'all' ? undefined : state, direction: 'asc' });
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    if (name === 'create_pull_request') {
      const pull = store.createPull(
        repo,
        requireString(params, 'title'),
        optionalString(params, 'body') ?? '',
        requireString(params, 'head'),
        requireString(params, 'base'),
      );
      return toolResult(pullJson(repo, pull));
    }
    if (name === 'merge_pull_request') {
      const pullNumber = params['pull_number'];
      const number = typeof pullNumber === 'number' ? pullNumber : Number.parseInt(String(pullNumber ?? ''), 10);
      if (!Number.isFinite(number)) return toolError('Missing required argument: pull_number');
      const pull = store.requirePull(repo, number);
      const commitSha = store.mergePull(repo, pull);
      return toolResult({ sha: commitSha, merged: true, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`, number: pull.number });
    }
    throw new ForgeError(-32602, `Unknown tool: ${name}`);
  } catch (err) {
    if (err instanceof ForgeError && err.status === 404) return toolError(err.message);
    if (err instanceof ForgeError && err.status === 422) return toolError(err.message);
    if (err instanceof ForgeError && err.status === 405) return toolError(err.message);
    throw err;
  }
}

/**
 * Handle one JSON-RPC request object. Returns the response object, or null for
 * a notification (no id — the transport answers HTTP 202 with no body).
 */
export function handleMcpRpc(store: Store, body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const request = body as Record<string, unknown>;
  const id = 'id' in request ? request['id'] : undefined;
  const method = typeof request['method'] === 'string' ? request['method'] : '';
  const params = (request['params'] ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;
  const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  });

  if (isNotification) {
    // Notifications (notifications/initialized and friends) need no answer.
    return null;
  }
  try {
    if (method === 'server/discover') {
      const info = serverInfo();
      return respond({
        resultType: 'DiscoverResult',
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: capabilities(),
        serverInfo: info,
        _meta: { 'io.modelcontextprotocol/serverInfo': info },
      });
    }
    if (method === 'initialize') {
      const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : null;
      if (negotiated === null) {
        return fail(-32602, `Unsupported protocol version: ${offered || '(none)'}`);
      }
      return respond({ protocolVersion: negotiated, capabilities: capabilities(), serverInfo: serverInfo() });
    }
    if (method === 'ping') return respond({});
    if (method === 'tools/list') {
      return respond({ tools: MCP_TOOLS.map(toolJson) });
    }
    if (method === 'tools/call') {
      const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
      if (!toolName) return fail(-32602, 'tools/call needs a tool name');
      try {
        const result = callTool(store, toolName, params['arguments']);
        return respond(result);
      } catch (err) {
        if (err instanceof ForgeError && err.status === -32602) return fail(-32602, err.message);
        throw err;
      }
    }
    return fail(-32601, `Method not found: ${method}`);
  } catch (err) {
    if (err instanceof ForgeError) return fail(-32602, err.message);
    throw err;
  }
}

/** Handle a POST /mcp body (already parsed JSON). Notifications return null; a batch returns an array. */
export function handleMcp(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    // A batch: one response per request, in order (the suite never sends one,
    // but the shape is cheap to honour).
    return body
      .map((request) => handleMcpRpc(store, request))
      .filter((response) => response !== null);
  }
  return handleMcpRpc(store, body);
}
