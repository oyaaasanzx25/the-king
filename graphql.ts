// A focused GraphQL executor for the one endpoint the suite drives,
// POST /api/graphql. It is not a general GraphQL server: it parses exactly the
// documents the conformance suite sends (queries, mutations, aliases, variables,
// inline input objects and lists, inline fragments, __type introspection, and
// batched JSON arrays), validates field names against the small schema below,
// and executes against the shared store. Unknown fields fail with a 200 and an
// errors array naming the field, the way the suite expects; an unknown
// repository resolves to data.repository === null, not an error.

import { viewerLogin } from './scenario.ts';
import {
  decodeGlobalId,
  encodeGlobalId,
  ForgeError,
  notFound,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// schema: the field set of every type the suite can name
// ---------------------------------------------------------------------------------------------

const SCHEMA: Readonly<Record<string, ReadonlySet<string>>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  User: new Set(['login', 'id', 'name', 'email']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private',
  ]),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'createdAt', 'updatedAt']),
  PullRequest: new Set([
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'createdAt', 'mergedAt', 'mergeCommit',
  ]),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount', 'edges']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount', 'edges']),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt']),
  Ref: new Set(['name', 'target']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changes']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  Node: new Set(['id']),
};

/** The introspection members the suite asserts for each named type. */
const INTROSPECTION: Readonly<Record<string, { fields?: string[]; enumValues?: string[] }>> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'createdAt', 'updatedAt'] },
  PullRequest: {
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
      'headRefOid', 'baseRefOid', 'files', 'createdAt', 'mergedAt', 'mergeCommit',
    ],
  },
  Repository: {
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private',
    ],
  },
  SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

// ---------------------------------------------------------------------------------------------
// parser: a small recursive-descent reader for the documents the suite sends
// ---------------------------------------------------------------------------------------------

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

interface FieldNode {
  readonly alias: string;
  readonly name: string;
  readonly args: Record<string, Value>;
  readonly children: FieldNode[] | null;
  readonly fragmentType: string | null;
}

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Record<string, Value>;
  readonly fields: FieldNode[];
}

class Parser {
  readonly #text: string;
  #pos = 0;

  constructor(text: string) {
    this.#text = text;
  }

  #skipWhitespace(): void {
    while (this.#pos < this.#text.length) {
      const ch = this.#text[this.#pos] as string;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') this.#pos += 1;
      else if (ch === '#') {
        while (this.#pos < this.#text.length && this.#text[this.#pos] !== '\n') this.#pos += 1;
      } else break;
    }
  }

  #peek(): string {
    this.#skipWhitespace();
    return this.#text[this.#pos] ?? '';
  }

  #expect(ch: string): void {
    this.#skipWhitespace();
    if (this.#text[this.#pos] !== ch) {
      throw new ForgeError(400, `expected ${JSON.stringify(ch)} at offset ${this.#pos} in the GraphQL document`);
    }
    this.#pos += 1;
  }

  #readName(): string {
    this.#skipWhitespace();
    const start = this.#pos;
    while (this.#pos < this.#text.length && /[A-Za-z0-9_]/.test(this.#text[this.#pos] as string)) this.#pos += 1;
    if (this.#pos === start) throw new ForgeError(400, `expected a name at offset ${this.#pos}`);
    return this.#text.slice(start, this.#pos);
  }

  #readString(): string {
    this.#skipWhitespace();
    if (this.#text[this.#pos] !== '"') throw new ForgeError(400, `expected a string at offset ${this.#pos}`);
    this.#pos += 1;
    let out = '';
    while (this.#pos < this.#text.length) {
      const ch = this.#text[this.#pos] as string;
      if (ch === '"') {
        this.#pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.#pos += 1;
        const escaped = this.#text[this.#pos] as string;
        out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
        this.#pos += 1;
        continue;
      }
      out += ch;
      this.#pos += 1;
    }
    throw new ForgeError(400, 'unterminated string in the GraphQL document');
  }

  #readValue(variables: Record<string, Value>): Value {
    this.#skipWhitespace();
    const ch = this.#text[this.#pos] as string;
    if (ch === '"') return this.#readString();
    if (ch === '$') {
      this.#pos += 1;
      const name = this.#readName();
      return variables[name] ?? null;
    }
    if (ch === '[') {
      this.#pos += 1;
      const items: Value[] = [];
      while (this.#peek() !== ']') items.push(this.#readValue(variables));
      this.#expect(']');
      return items;
    }
    if (ch === '{') {
      this.#pos += 1;
      const object: { [key: string]: Value } = {};
      while (this.#peek() !== '}') {
        const key = this.#readName();
        this.#expect(':');
        object[key] = this.#readValue(variables);
      }
      this.#expect('}');
      return object;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.#pos;
      while (this.#pos < this.#text.length && /[0-9.eE+-]/.test(this.#text[this.#pos] as string)) this.#pos += 1;
      const raw = this.#text.slice(start, this.#pos);
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new ForgeError(400, `bad number ${JSON.stringify(raw)}`);
      return number;
    }
    const name = this.#readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return name;
  }

  #readArguments(variables: Record<string, Value>): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.#peek() !== '(') return args;
    this.#expect('(');
    while (this.#peek() !== ')') {
      const name = this.#readName();
      this.#expect(':');
      args[name] = this.#readValue(variables);
    }
    this.#expect(')');
    return args;
  }

  #readSelectionSet(variables: Record<string, Value>): FieldNode[] {
    this.#expect('{');
    const fields: FieldNode[] = [];
    while (this.#peek() !== '}') {
      if (this.#text.slice(this.#pos, this.#pos + 3) === '...') {
        this.#pos += 3;
        this.#skipWhitespace();
        let fragmentType: string | null = null;
        if (this.#text.slice(this.#pos, this.#pos + 2) === 'on') {
          this.#pos += 2;
          fragmentType = this.#readName();
        } else {
          this.#readName();
        }
        const children = this.#readSelectionSet(variables);
        for (const child of children) {
          fields.push({ ...child, fragmentType });
        }
        continue;
      }
      const first = this.#readName();
      let alias = first;
      let name = first;
      if (this.#peek() === ':') {
        this.#pos += 1;
        name = this.#readName();
      }
      const args = this.#readArguments(variables);
      const children = this.#peek() === '{' ? this.#readSelectionSet(variables) : null;
      fields.push({ alias, name, args, children, fragmentType: null });
    }
    this.#expect('}');
    return fields;
  }

  parseOperation(variables: Record<string, Value>): Operation {
    this.#skipWhitespace();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const ch = this.#text[this.#pos];
    if (ch === '{') {
      return { kind, name, variables, fields: this.#readSelectionSet(variables) };
    }
    const keyword = this.#readName();
    if (keyword === 'mutation') kind = 'mutation';
    else if (keyword !== 'query') throw new ForgeError(400, `unsupported GraphQL operation ${JSON.stringify(keyword)}`);
    if (/[A-Za-z_]/.test(this.#peek())) name = this.#readName();
    // Variable definitions: ($name: Type! = default, ...) — the types are not
    // needed at execution time, so skip the whole parenthesised list.
    if (this.#peek() === '(') {
      let depth = 0;
      while (this.#pos < this.#text.length) {
        const c = this.#text[this.#pos] as string;
        this.#pos += 1;
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    return { kind, name, variables, fields: this.#readSelectionSet(variables) };
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  readonly store: Store;
  readonly errors: Array<{ message: string }>;
}

/** The internal shape of a resolved object: its GraphQL type plus its fields. */
type Resolved = { __typename: string; [key: string]: unknown } | null;

function repoObject(store: Store, repo: Repo): Resolved {
  return {
    __typename: 'Repository',
    id: encodeGlobalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: encodeGlobalId('User', repo.owner) },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    _repo: repo,
  };
}

function issueObject(store: Store, repo: Repo, issue: import('./store.ts').Issue): Resolved {
  return {
    __typename: 'Issue',
    id: encodeGlobalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    labels: issue.labels,
    author: { __typename: 'User', login: viewerLogin() },
    createdAt: new Date(issue.createdAt).toISOString(),
    updatedAt: new Date(issue.createdAt).toISOString(),
    _repo: repo,
    _issue: issue,
  };
}

function pullObject(store: Store, repo: Repo, pull: import('./store.ts').Pull): Resolved {
  return {
    __typename: 'PullRequest',
    id: encodeGlobalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha } : null,
    createdAt: new Date(pull.createdAt).toISOString(),
    _repo: repo,
    _pull: pull,
  };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return -1;
    const index = Number.parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isFinite(index) ? index : -1;
  } catch {
    return -1;
  }
}

function resolveField(context: ExecContext, parent: Resolved, field: FieldNode): unknown {
  const { store } = context;
  const type = parent?.__typename ?? 'Query';
  if (type === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: viewerLogin(), id: encodeGlobalId('User', viewerLogin()), name: viewerLogin(), email: `${viewerLogin()}@example.invalid` };
    }
    if (field.name === 'repository') {
      const owner = field.args['owner'];
      const name = field.args['name'];
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = store.getRepo(owner, name);
      return repo ? repoObject(store, repo) : null;
    }
    if (field.name === 'node') {
      const id = field.args['id'];
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repoId = Number.parseInt(decoded.coords[0] as string, 10);
        const repo = store.repoOrder.find((candidate) => candidate.id === repoId);
        return repo ? repoObject(store, repo) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = field.args['name'];
      if (typeof name !== 'string') return null;
      const info = INTROSPECTION[name];
      if (!info) return null;
      return {
        __typename: '__Type',
        name,
        kind: info.enumValues ? 'ENUM' : 'OBJECT',
        fields: info.fields ? info.fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })) : null,
        enumValues: info.enumValues ? info.enumValues.map((value) => ({ __typename: '__EnumValue', name: value })) : null,
      };
    }
  }
  if (type === 'Mutation') {
    return resolveMutation(context, field);
  }
  if (type === 'Repository' && parent) {
    const repo = parent['_repo'] as Repo;
    if (field.name === 'issue') {
      const number = field.args['number'];
      if (typeof number !== 'number') return null;
      const issue = store.getIssue(repo, number);
      return issue ? issueObject(store, repo, issue) : null;
    }
    if (field.name === 'issues') {
      const first = typeof field.args['first'] === 'number' ? field.args['first'] : 10;
      const after = field.args['after'];
      let issues = [...repo.issues];
      const states = field.args['states'];
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = field.args['orderBy'];
      if (orderBy && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
        const direction = (orderBy as Record<string, Value>)['direction'];
        if (direction === 'DESC') issues.sort((a, b) => b.number - a.number);
        else issues.sort((a, b) => a.number - b.number);
      }
      const start = indexFromCursor(after) + 1;
      const page = issues.slice(start, start + first);
      const endIndex = page.length ? start + page.length - 1 : start - 1;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueObject(store, repo, issue)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: start + page.length < issues.length,
          hasPreviousPage: start > 0,
          startCursor: page.length ? cursorFor(start) : null,
          endCursor: page.length ? cursorFor(endIndex) : null,
        },
        totalCount: issues.length,
      };
    }
    if (field.name === 'pullRequest') {
      const number = field.args['number'];
      if (typeof number !== 'number') return null;
      const pull = store.getPull(repo, number);
      return pull ? pullObject(store, repo, pull) : null;
    }
    if (field.name === 'pullRequests') {
      const first = typeof field.args['first'] === 'number' ? field.args['first'] : 10;
      const pulls = [...repo.pulls].slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: pulls.map((pull) => pullObject(store, repo, pull)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: repo.pulls.length > first,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: repo.pulls.length,
      };
    }
  }
  if (type === 'PullRequest' && parent) {
    const pull = parent['_pull'] as import('./store.ts').Pull;
    if (field.name === 'files') {
      const first = typeof field.args['first'] === 'number' ? field.args['first'] : 10;
      const nodes = pull.files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes }));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes,
        pageInfo: { __typename: 'PageInfo', hasNextPage: pull.files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: pull.files.length,
      };
    }
  }
  // A plain field on a resolved object: return its stored value.
  if (parent && field.name in parent) return parent[field.name];
  return null;
}

function resolveMutation(context: ExecContext, field: FieldNode): unknown {
  const { store } = context;
  const input = (field.args['input'] ?? {}) as Record<string, Value>;
  const repoFromId = (id: unknown): Repo | null => {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'Repository') return null;
    const repoId = Number.parseInt(decoded.coords[0] as string, 10);
    return store.repoOrder.find((candidate) => candidate.id === repoId) ?? null;
  };
  if (field.name === 'createIssue') {
    const repo = repoFromId(input['repositoryId']);
    if (!repo) throw new ForgeError(404, 'Repository not found');
    const issue = store.createIssue(repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
    return { __typename: 'CreateIssuePayload', issue: issueObject(store, repo, issue) };
  }
  if (field.name === 'closeIssue') {
    const issueId = input['issueId'];
    if (typeof issueId !== 'string') throw new ForgeError(404, 'Issue not found');
    const decoded = decodeGlobalId(issueId);
    if (!decoded || decoded.kind !== 'Issue') throw new ForgeError(404, 'Issue not found');
    const repoId = Number.parseInt(decoded.coords[0] as string, 10);
    const repo = store.repoOrder.find((candidate) => candidate.id === repoId);
    const issue = repo ? store.getIssue(repo, Number.parseInt(decoded.coords[1] as string, 10)) : undefined;
    if (!repo || !issue) throw new ForgeError(404, 'Issue not found');
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueObject(store, repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const repo = repoFromId(input['repositoryId']);
    if (!repo) throw new ForgeError(404, 'Repository not found');
    const pull = store.createPull(
      repo,
      String(input['title'] ?? ''),
      '',
      String(input['headRefName'] ?? ''),
      String(input['baseRefName'] ?? ''),
    );
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(store, repo, pull) };
  }
  if (field.name === 'mergePullRequest') {
    const pullRequestId = input['pullRequestId'];
    if (typeof pullRequestId !== 'string') throw new ForgeError(404, 'Pull request not found');
    const decoded = decodeGlobalId(pullRequestId);
    if (!decoded || decoded.kind !== 'PullRequest') throw new ForgeError(404, 'Pull request not found');
    const repoId = Number.parseInt(decoded.coords[0] as string, 10);
    const repo = store.repoOrder.find((candidate) => candidate.id === repoId);
    const pull = repo ? store.getPull(repo, Number.parseInt(decoded.coords[1] as string, 10)) : undefined;
    if (!repo || !pull) throw new ForgeError(404, 'Pull request not found');
    store.mergePull(repo, pull);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(store, repo, pull) };
  }
  if (field.name === 'addComment') {
    const subjectId = input['subjectId'];
    if (typeof subjectId !== 'string') throw new ForgeError(404, 'Issue not found');
    const decoded = decodeGlobalId(subjectId);
    if (!decoded || decoded.kind !== 'Issue') throw new ForgeError(404, 'Issue not found');
    const repoId = Number.parseInt(decoded.coords[0] as string, 10);
    const repo = store.repoOrder.find((candidate) => candidate.id === repoId);
    const issue = repo ? store.getIssue(repo, Number.parseInt(decoded.coords[1] as string, 10)) : undefined;
    if (!repo || !issue) throw new ForgeError(404, 'Issue not found');
    const comment = store.addComment(repo, issue, String(input['body'] ?? ''));
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: {
          __typename: 'IssueComment',
          id: encodeGlobalId('IssueComment', repo.id, issue.number, comment.id),
          body: comment.body,
        },
        cursor: cursorFor(0),
      },
    };
  }
  throw new ForgeError(400, `unknown mutation ${JSON.stringify(field.name)}`);
}

/** Validate the operation's fields against the schema; returns the error messages found. */
function validate(operation: Operation): string[] {
  const errors: string[] = [];
  const walk = (fields: readonly FieldNode[], type: string): void => {
    const known = SCHEMA[type];
    for (const field of fields) {
      if (field.fragmentType) {
        if (field.children) walk(field.children, field.fragmentType);
        continue;
      }
      if (!known?.has(field.name)) {
        errors.push(`Cannot query field "${field.name}" on type "${type}".`);
        continue;
      }
      if (!field.children) continue;
      // The child's type depends on the field and, for `node`, on the parent:
      // Query.node resolves a global id to a Repository, while an
      // IssueCommentEdge's node is the comment itself.
      const childType = childTypeOf(type, field.name);
      if (childType !== 'Unknown') walk(field.children, childType);
    }
  };
  walk(operation.fields, operation.kind === 'mutation' ? 'Mutation' : 'Query');
  return errors;
}

function childTypeOf(parentType: string, fieldName: string): string {
  if (fieldName === 'node' && parentType === 'IssueCommentEdge') return 'IssueComment';
  switch (fieldName) {
    case 'viewer':
    case 'owner':
    case 'author':
      return 'User';
    case 'repository':
    case 'node':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'issues':
      return 'IssueConnection';
    case 'pullRequest':
      return 'PullRequest';
    case 'pullRequests':
      return 'PullRequestConnection';
    case 'files':
      return 'PullRequestChangedFileConnection';
    case 'nodes':
      return parentType === 'IssueConnection'
        ? 'Issue'
        : parentType === 'PullRequestConnection'
          ? 'PullRequest'
          : 'PullRequestChangedFile';
    case 'pageInfo':
      return 'PageInfo';
    case 'defaultBranchRef':
      return 'Ref';
    case '__type':
      return '__Type';
    case 'fields':
      return '__Field';
    case 'enumValues':
      return '__EnumValue';
    case 'createIssue':
      return 'CreateIssuePayload';
    case 'closeIssue':
      return 'CloseIssuePayload';
    case 'createPullRequest':
      return 'CreatePullRequestPayload';
    case 'mergePullRequest':
      return 'MergePullRequestPayload';
    case 'addComment':
      return 'AddCommentPayload';
    case 'commentEdge':
      return 'IssueCommentEdge';
    default:
      return 'Unknown';
  }
}

function executeFields(context: ExecContext, parent: Resolved, fields: readonly FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType && parent?.__typename !== field.fragmentType) continue;
    let value: unknown;
    try {
      value = resolveField(context, parent, field);
    } catch (err) {
      context.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[field.alias] = null;
      continue;
    }
    if (field.children && value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        out[field.alias] = value.map((item) => executeFields(context, item as Resolved, field.children as FieldNode[]));
      } else {
        out[field.alias] = executeFields(context, value as Resolved, field.children);
      }
    } else {
      out[field.alias] = value;
    }
  }
  return out;
}

/** Execute one GraphQL operation object ({query, variables, operationName}). */
export function executeGraphQL(store: Store, body: unknown): Record<string, unknown> {
  const context: ExecContext = { store, errors: [] };
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ForgeError(400, 'GraphQL request body must be an object');
  }
  const query = (body as Record<string, unknown>)['query'];
  if (typeof query !== 'string') throw new ForgeError(400, 'GraphQL request needs a query string');
  const variables = (body as Record<string, unknown>)['variables'];
  const variableValues: Record<string, Value> =
    variables && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, Value>)
      : {};
  let operation: Operation;
  try {
    operation = new Parser(query).parseOperation(variableValues);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const validationErrors = validate(operation);
  if (validationErrors.length) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const root: Resolved = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeFields(context, root, operation.fields);
  if (context.errors.length) return { data, errors: context.errors };
  return { data };
}

/** Handle a POST /api/graphql body: one operation, or a JSON array of operations (batching). */
export function handleGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((operation) => {
      try {
        return executeGraphQL(store, operation);
      } catch (err) {
        return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
      }
    });
  }
  return executeGraphQL(store, body);
}
