# the-king

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/oyaaasanzx25/the-king/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/oyaaasanzx25/the-king/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API, GraphQL v4 and MCP over its own in-memory store. No UI, no database, no outside service, no git binary — Node 22 standard library only.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, serves until the suite says it is done, then exits 0. Every API call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — the entry lifecycle: bind, register, wait for done, exit.
- `app.ts` — the HTTP server and router.
- `store.ts` — the in-memory store: repositories, refs, git objects, issues, pull requests, labels, comments.
- `gitobj.ts` — the git object model: SHA-1 ids, tree/commit/tag parsing and building, reachability, packfile read/write with deltas.
- `gitproto.ts` — pkt-lines and the smart-HTTP protocol: info/refs, upload-pack v2/v0, receive-pack v0.
- `rest.ts` — the REST v3 API.
- `graphql.ts` — the GraphQL v4 API.
- `mcp.ts` — the MCP endpoint (JSON-RPC 2.0 over streamable HTTP).
- `scenario.ts` — the seeded scenario identity: the viewer login the bearer token owns.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
