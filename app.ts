// The HTTP server: one process, one store, four surfaces. Routes:
//   GET  /healthz                                  — liveness, no auth
//   GET  /{owner}/{repo}.git/info/refs             — git advertisement (v0/v2)
//   POST /{owner}/{repo}.git/git-upload-pack       — fetch (v2/v0)
//   POST /{owner}/{repo}.git/git-receive-pack     — push (v0 only)
//   POST /api/graphql                             — GraphQL
//   *    /api/v3/...                              — REST v3
//   POST /mcp                                     — MCP (streamable HTTP)
// Every route except /healthz needs `Authorization: Bearer <token>`; any
// non-empty bearer token is the viewer (the token is opaque and the entry is
// never told the login — it derives it from the seeded scenario instead).
// A malformed git POST never crashes the server: it answers an error and keeps
// serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { advertisement, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleRest } from './rest.ts';
import { ForgeError, Store } from './store.ts';

const JSON_CONTENT = 'application/json';

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': JSON_CONTENT,
    'x-github-request-id': `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
    ...extraHeaders,
  });
  response.end(payload);
}

function sendError(response: ServerResponse, err: unknown): void {
  if (err instanceof ForgeError) {
    sendJson(response, err.status, { message: err.message });
    return;
  }
  process.stderr.write(`[forge] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  sendJson(response, 500, { message: 'Internal Server Error' });
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token ? token : null;
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function createApp(): Server {
  const store = new Store();

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const segments = decodeSegments(url.pathname);
        const method = request.method ?? 'GET';

        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(response, 200, { ok: true });
          return;
        }
        if (!bearerToken(request)) {
          sendJson(response, 401, { message: 'Requires authentication' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 3 && segments[1]?.endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(response, 404, { message: `Repository ${owner}/${repoName} not found` });
            return;
          }
          const gitProtocol = request.headers['git-protocol'] === 'version=2' ? 2 : 0;
          if (method === 'GET' && segments[2] === 'info' && segments[3] === 'refs') {
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(response, 400, { message: 'info/refs needs a service query parameter' });
              return;
            }
            // Receive-pack is v0 only, whatever the client asked for.
            const version = service === 'git-receive-pack' ? 0 : gitProtocol;
            const ad = advertisement(store, repo, service, version);
            response.writeHead(200, { 'content-type': ad.contentType });
            response.end(ad.body);
            return;
          }
          if (method === 'POST' && segments[2] === 'git-upload-pack') {
            const body = await readBody(request);
            const result = handleUploadPack(store, repo, body, gitProtocol);
            response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
            response.end(result);
            return;
          }
          if (method === 'POST' && segments[2] === 'git-receive-pack') {
            const body = await readBody(request);
            const result = handleReceivePack(store, repo, body);
            response.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
            response.end(result);
            return;
          }
          sendJson(response, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL.
        if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          const body = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(response, 400, { message: 'request body is not valid JSON' });
            return;
          }
          const result = handleGraphQL(store, parsed);
          sendJson(response, 200, result, { 'x-github-request-id': `gql-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}` });
          return;
        }

        // MCP.
        if (method === 'POST' && segments.length === 1 && segments[0] === 'mcp') {
          const body = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
            sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const { handleMcp } = await import('./mcp.ts');
          const result = handleMcp(store, parsed);
          if (result === null) {
            // A notification: HTTP 202, no body.
            response.writeHead(202);
            response.end();
            return;
          }
          sendJson(response, 200, result);
          return;
        }

        // MCP session teardown (a legacy client closes its session this way).
        if (method === 'DELETE' && segments.length === 1 && segments[0] === 'mcp') {
          response.writeHead(204);
          response.end();
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          let parsed: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const body = await readBody(request);
            if (body.length) {
              try {
                parsed = JSON.parse(body.toString('utf8'));
              } catch {
                sendJson(response, 400, { message: 'request body is not valid JSON' });
                return;
              }
            }
          }
          const result = handleRest(store, {
            method,
            segments,
            query: url.searchParams,
            body: parsed,
            host: request.headers.host ?? 'localhost',
          });
          if (result.body === null) {
            response.writeHead(result.status, result.headers);
            response.end();
            return;
          }
          sendJson(response, result.status, result.body, result.headers);
          return;
        }

        sendJson(response, 404, { message: 'Not Found' });
      } catch (err) {
        if (!response.headersSent) sendError(response, err);
        else response.end();
      }
    })();
  });

  return server;
}
