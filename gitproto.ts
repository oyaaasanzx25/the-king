// The git smart-HTTP protocol: pkt-lines, the info/refs advertisements (v0 and
// v2), ls-refs, upload-pack (fetch v2 and v0) and receive-pack (push).
// Written against the client's own parser: every response shape below is the
// one the client's decoder accepts, including its edge cases (an empty fetch
// still carries a 32-byte empty pack in band 1; a v2 fetch never ends with a
// 0002 response-end packet; a refused push still reports `unpack ok`).

import {
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import { ForgeError, type Repo, type Store } from './store.ts';

export const AGENT = 'github-forge/0.1.0';

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** One pkt-line: a 4-hex-digit length (including the length itself) + the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65_520) throw new ForgeError(400, `pkt-line payload of ${body.length} bytes exceeds the 65520-byte limit`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a mixed sequence: strings/buffers become data packets; 'flush'/'delim' the controls. */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a truncated or malformed frame. */
export function decodePktLines(bytes: Uint8Array): PktLine[] {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new ForgeError(400, 'truncated pkt-line length prefix');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65_520) {
      throw new ForgeError(400, `invalid pkt-line length ${JSON.stringify(head)}`);
    }
    if (offset + length > buffer.length) throw new ForgeError(400, 'truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Decode pkt-lines with their byte ranges, so a caller can find where a section ends. */
export function decodePktLinesWithOffsets(bytes: Uint8Array): Array<{ packet: PktLine; start: number; end: number }> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out: Array<{ packet: PktLine; start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new ForgeError(400, 'truncated pkt-line length prefix');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      out.push({ packet: { kind: 'flush' }, start: offset, end: offset + 4 });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ packet: { kind: 'delim' }, start: offset, end: offset + 4 });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ packet: { kind: 'response-end' }, start: offset, end: offset + 4 });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65_520) {
      throw new ForgeError(400, `invalid pkt-line length ${JSON.stringify(head)}`);
    }
    if (offset + length > buffer.length) throw new ForgeError(400, 'truncated pkt-line payload');
    out.push({ packet: { kind: 'data', payload: buffer.subarray(offset + 4, offset + length) }, start: offset, end: offset + length });
    offset += length;
  }
  return out;
}

/**
 * Split a buffer at the first flush packet: the packets before it, and the bytes
 * after it (untouched — a push body carries raw pack bytes after the flush, which
 * are not pkt-lines and must never be decoded as such).
 */
function splitAtFlush(bytes: Uint8Array): { before: PktLine[]; after: Buffer } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const before: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new ForgeError(400, 'truncated pkt-line length prefix');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') return { before, after: buffer.subarray(offset + 4) };
    if (head === '0001') {
      before.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      before.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65_520) {
      throw new ForgeError(400, `invalid pkt-line length ${JSON.stringify(head)}`);
    }
    if (offset + length > buffer.length) throw new ForgeError(400, 'truncated pkt-line payload');
    before.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { before, after: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
}

/** Every ref the repository advertises, sorted by name, with HEAD first when it has a tip. */
function advertisedRefs(store: Store, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const tip = store.defaultTip(repo);
  if (tip) lines.push({ oid: tip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const object = store.object(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = store.object(target);
      if (targetObject?.type === 'commit') entry.peeled = target;
      else if (targetObject?.type === 'tag') entry.peeled = target;
    }
    lines.push(entry);
  }
  return lines;
}

function uploadPackV0Caps(repo: Repo): string {
  return [
    'side-band-64k',
    'multi_ack',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ].join(' ');
}

function receivePackV0Caps(repo: Repo): string {
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ].join(' ');
}

/**
 * The info/refs advertisement for a service. `version` 2 is used only when the
 * client asked for it (Git-Protocol: version=2); receive-pack is v0 only.
 * The answer is cached per repository state: it depends only on the ref map,
 * so the cache key is a fingerprint of it (a push changes the fingerprint).
 */
const AD_CACHE = new Map<string, { body: Buffer; contentType: string }>();
const AD_CACHE_MAX = 64;

function refsFingerprint(repo: Repo): string {
  const parts: string[] = [];
  for (const name of [...repo.refs.keys()].sort()) parts.push(`${name}=${repo.refs.get(name)}`);
  return parts.join(',');
}

export function advertisement(
  store: Store,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  version: 2 | 0,
): { body: Buffer; contentType: string } {
  const cacheKey = `${repo.id}|${service}|${version}|${refsFingerprint(repo)}`;
  const cached = AD_CACHE.get(cacheKey);
  if (cached) return cached;
  const result = buildAdvertisement(store, repo, service, version);
  AD_CACHE.set(cacheKey, result);
  if (AD_CACHE.size > AD_CACHE_MAX) {
    const oldest = AD_CACHE.keys().next().value as string | undefined;
    if (oldest !== undefined) AD_CACHE.delete(oldest);
  }
  return result;
}

function buildAdvertisement(
  store: Store,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  version: 2 | 0,
): { body: Buffer; contentType: string } {
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  const serviceLine = `# service=${service}\n`;
  if (version === 2) {
    const caps = [
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow filter',
      'object-format=sha1',
    ];
    return {
      body: encodePktLines([serviceLine, 'flush', 'version 2\n', ...caps.map((cap) => `${cap}\n`), 'flush']),
      contentType,
    };
  }
  const refs = advertisedRefs(store, repo);
  const caps = service === 'git-upload-pack' ? uploadPackV0Caps(repo) : receivePackV0Caps(repo);
  const items: Array<string | 'flush'> = [serviceLine, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${caps}` : '';
      items.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.peeled) items.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  items.push('flush');
  return { body: encodePktLines(items), contentType };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

export interface LsRefsRequest {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: string[];
}

/** Parse a v2 ls-refs request body into its arguments. */
export function parseLsRefsRequest(body: Buffer): LsRefsRequest {
  const packets = decodePktLines(body);
  let command = '';
  let afterDelim = false;
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length));
  }
  if (command !== 'ls-refs') throw new ForgeError(400, `expected command=ls-refs, got ${JSON.stringify(command)}`);
  return request;
}

/** Answer a v2 ls-refs request: one line per matching ref, then flush. Cached per ref state and arguments. */
const LSREFS_CACHE = new Map<string, Buffer>();
const LSREFS_CACHE_MAX = 64;

export function handleLsRefs(store: Store, repo: Repo, request: LsRefsRequest): Buffer {
  const cacheKey = `${repo.id}|${refsFingerprint(repo)}|${request.peel ? 1 : 0}${request.symrefs ? 1 : 0}${request.unborn ? 1 : 0}|${request.prefixes.join(',')}`;
  const cached = LSREFS_CACHE.get(cacheKey);
  if (cached) return cached;
  const result = buildLsRefs(store, repo, request);
  LSREFS_CACHE.set(cacheKey, result);
  if (LSREFS_CACHE.size > LSREFS_CACHE_MAX) {
    const oldest = LSREFS_CACHE.keys().next().value as string | undefined;
    if (oldest !== undefined) LSREFS_CACHE.delete(oldest);
  }
  return result;
}

function buildLsRefs(store: Store, repo: Repo, request: LsRefsRequest): Buffer {
  const lines: string[] = [];
  const matches = (name: string): boolean =>
    request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  const tip = store.defaultTip(repo);
  if (!tip && request.unborn && matches('HEAD')) {
    lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  if (tip && matches('HEAD')) {
    const suffix = request.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${tip} HEAD${suffix}\n`);
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (request.peel) {
      const object = store.object(oid);
      if (object?.type === 'tag') {
        const target = parseTag(object.data).object;
        if (store.object(target)?.type === 'commit') suffix = ` peeled:${target}`;
      }
    }
    lines.push(`${oid} ${name}${suffix}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// fetch (upload-pack)
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  /** The client's current shallow boundaries, from its `shallow` lines. */
  readonly shallow: string[];
  /** deepen N, or null for a full fetch. */
  readonly depth: number | null;
  /** A partial-clone filter, e.g. `blob:none` or `tree:0`, or null. */
  readonly filter: string | null;
}

const EMPTY_PACK = writePack([]);

/**
 * The objects a walk from `roots` reaches, following commits to their trees and
 * parents (and tags to their targets). `stopAt` are shallow boundaries: the
 * boundary commit itself is included, its parents are not. `maxDepth` caps the
 * commit distance from the roots; commits at distance maxDepth-1 are the
 * frontier and are returned separately.
 */
function walkReachable(
  store: Store,
  roots: readonly string[],
  options: { stopAt?: ReadonlySet<string>; maxDepth?: number } = {},
): { objects: Set<string>; frontier: Set<string> } {
  const objects = new Set<string>();
  const frontier = new Set<string>();
  const seenCommits = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const root of roots) {
    if (!isObjectId(root)) continue;
    const object = store.object(root);
    if (!object) continue;
    if (object.type === 'commit') queue.push({ oid: root, distance: 0 });
    else if (object.type === 'tag') {
      objects.add(root);
      const target = parseTag(object.data).object;
      const targetObject = store.object(target);
      if (targetObject?.type === 'commit') queue.push({ oid: target, distance: 0 });
      else if (targetObject) objects.add(target);
    } else if (object.type === 'tree') {
      objects.add(root);
      for (const oid of collectReachable([root], (id) => store.object(id), { allowMissing: true })) objects.add(oid);
    } else {
      objects.add(root);
    }
  }
  while (queue.length) {
    const { oid, distance } = queue.shift() as { oid: string; distance: number };
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const view = store.commitView(oid);
    if (!view) continue;
    objects.add(oid);
    for (const reached of collectReachable([view.tree], (id) => store.object(id), { allowMissing: true })) {
      objects.add(reached);
    }
    const atFrontier = options.maxDepth !== undefined && distance >= options.maxDepth - 1;
    if (atFrontier) {
      frontier.add(oid);
      continue;
    }
    if (options.stopAt?.has(oid)) continue;
    for (const parent of view.parents) {
      if (!seenCommits.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
    }
  }
  return { objects, frontier };
}

/** Parse a v2 fetch request body. */
export function parseFetchV2(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  let command = '';
  let afterDelim = false;
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('filter ')) request.filter = line.slice(7).trim();
  }
  if (command !== 'fetch') throw new ForgeError(400, `expected command=fetch, got ${JSON.stringify(command)}`);
  return request;
}

/** Parse a v0 fetch request body (two sections split by a flush). */
export function parseFetchV0(body: Buffer): FetchRequest {
  const { before, after } = splitAtFlush(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  const parseLine = (line: string, section: 1 | 2): void => {
    if (line.startsWith('want ')) {
      // The first want line carries the negotiated capabilities after the oid.
      const rest = line.slice(5).trim();
      const space = rest.indexOf(' ');
      request.wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    else if (section === 2 && line.startsWith('have ')) request.haves.push(line.slice(5).trim());
  };
  for (const packet of before) {
    if (packet.kind === 'data') parseLine(packet.payload.toString('utf8').replace(/\n$/, ''), 1);
  }
  for (const packet of decodePktLines(after)) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') parseLine(packet.payload.toString('utf8').replace(/\n$/, ''), 2);
  }
  return request;
}

interface FetchPlan {
  /** The pack's objects, in deterministic order. */
  readonly packObjects: Array<{ type: GitObjectType; data: Buffer }>;
  /** The new shallow boundaries (commits whose parents were not sent). */
  readonly shallow: string[];
  /** Previous shallow boundaries whose parents are now sent. */
  readonly unshallow: string[];
  /** Whether every have is known to the store. */
  readonly acksKnown: boolean;
}

/**
 * Plan a fetch: which objects to send, which shallow boundaries move, whether
 * the client's haves are known. The pack holds only what the client lacks:
 * reachable from the wants, minus everything the client already has (its haves
 * walked fully, except that a shallow boundary's parents are not had).
 */
function planFetch(store: Store, request: FetchRequest): FetchPlan {
  for (const want of request.wants) {
    if (!store.object(want)) throw new ForgeError(404, `Object ${want} not found`);
  }
  const clientShallow = new Set(request.shallow);
  const haveWalk = walkReachable(store, request.haves, { stopAt: clientShallow });
  const hasSet = haveWalk.objects;
  const acksKnown = request.haves.every((have) => store.object(have) !== undefined);

  let wanted: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (request.depth !== null && Number.isFinite(request.depth) && request.depth > 0) {
    const region = walkReachable(store, request.wants, { maxDepth: request.depth });
    wanted = region.objects;
    shallow = [...region.frontier];
    // A previous boundary is unshallowed when it sits inside the fetched region
    // and its parents are now sent (or it is the frontier's parent side).
    for (const boundary of clientShallow) {
      if (!wanted.has(boundary)) continue;
      const view = store.commitView(boundary);
      if (!view) continue;
      if (view.parents.every((parent) => wanted.has(parent) || hasSet.has(parent))) {
        unshallow.push(boundary);
      }
    }
  } else {
    wanted = walkReachable(store, request.wants).objects;
    // A full fetch completes every previous shallow boundary whose parents arrive.
    for (const boundary of clientShallow) {
      const view = store.commitView(boundary);
      if (!view) continue;
      if (view.parents.every((parent) => wanted.has(parent))) unshallow.push(boundary);
    }
  }
  const toSend = [...wanted].filter((oid) => !hasSet.has(oid));
  // A partial-clone filter drops object kinds from the pack, never from the walk.
  const filtered = toSend.filter((oid) => {
    const object = store.object(oid);
    if (!object) return false;
    if (request.filter === 'blob:none' && object.type === 'blob') return false;
    if (request.filter === 'tree:0' && (object.type === 'tree' || object.type === 'blob')) return false;
    return true;
  });
  const packObjects = filtered
    .sort()
    .map((oid) => {
      const object = store.object(oid) as GitObject;
      return { type: object.type, data: object.data };
    });
  return { packObjects, shallow, unshallow, acksKnown };
}

/** Split a pack into sideband packets (band 1), each a pkt-line of at most 65520 bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65_520 - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), EMPTY_PACK])));
  return chunks;
}

interface CachedFetch {
  /** The whole fetch response, ready to send: sections, packfile, flush. */
  readonly response: Buffer;
}

/**
 * A small cache of fetch answers. A fetch's response is a pure function of its
 * wants, haves, shallow boundaries, depth and filter over a fixed object pool
 * (objects are content-addressed and never change), so the store's generation
 * — bumped on every object added — makes the key safe. The clone workload
 * sends the same shallow fetch fifty times concurrently, and this turns
 * forty-nine of them into a cache hit. Bounded to 16 entries, oldest evicted.
 */
const FETCH_CACHE = new Map<string, CachedFetch>();
const FETCH_CACHE_MAX = 16;

function fetchCacheKey(store: Store, request: FetchRequest, version: 2 | 0): string {
  return [
    version,
    store.generation,
    request.depth ?? '',
    request.filter ?? '',
    [...request.wants].sort().join(','),
    [...request.haves].sort().join(','),
    [...request.shallow].sort().join(','),
  ].join('|');
}

function fetchCached(store: Store, repo: Repo, request: FetchRequest, version: 2 | 0): Buffer {
  const key = fetchCacheKey(store, request, version);
  const hit = FETCH_CACHE.get(key);
  if (hit) return hit.response;
  const plan = planFetch(store, request);
  const pack = plan.packObjects.length ? writePack(plan.packObjects) : EMPTY_PACK;
  let response: Buffer;
  if (version === 2) {
    const parts: Buffer[] = [];
    const ackLines: string[] = [];
    if (request.haves.length === 0 || !plan.acksKnown) ackLines.push('NAK\n');
    else {
      for (const have of request.haves) ackLines.push(`ACK ${have}\n`);
      ackLines.push('ready\n');
    }
    parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'delim']));
    if (plan.shallow.length || plan.unshallow.length) {
      const lines = [
        ...plan.shallow.map((oid) => `shallow ${oid}\n`),
        ...plan.unshallow.map((oid) => `unshallow ${oid}\n`),
      ];
      parts.push(encodePktLines(['shallow-info\n', ...lines, 'delim']));
    }
    parts.push(encodePktLine('packfile\n'));
    parts.push(Buffer.concat(sidebandPack(pack)));
    parts.push(pktLineFlush());
    response = Buffer.concat(parts);
  } else {
    const lines: string[] = [];
    if (request.haves.length === 0 || !plan.acksKnown) lines.push('NAK\n');
    else for (const have of request.haves) lines.push(`ACK ${have}\n`);
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    response = Buffer.concat([encodePktLines(lines), Buffer.concat(sidebandPack(pack)), pktLineFlush()]);
  }
  FETCH_CACHE.set(key, { response });
  if (FETCH_CACHE.size > FETCH_CACHE_MAX) {
    const oldest = FETCH_CACHE.keys().next().value as string | undefined;
    if (oldest !== undefined) FETCH_CACHE.delete(oldest);
  }
  return response;
}

/** Answer a v2 fetch: named sections, then the packfile section, then flush. Never a 0002. */
export function handleFetchV2(store: Store, repo: Repo, request: FetchRequest): Buffer {
  return fetchCached(store, repo, request, 2);
}

/** Answer a v0 fetch: NAK/ACK and shallow lines, then the pack as sideband, then flush. */
export function handleFetchV0(store: Store, repo: Repo, request: FetchRequest): Buffer {
  return fetchCached(store, repo, request, 0);
}

/**
 * Route an upload-pack POST body: a v2 command (ls-refs or fetch) when the
 * client spoke protocol v2, otherwise a v0 fetch. Returns the response body.
 */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, version: 2 | 0): Buffer {
  if (version === 2) {
    const packets = decodePktLines(body);
    let command = '';
    for (const packet of packets) {
      if (packet.kind === 'delim' || packet.kind === 'flush') break;
      if (packet.kind === 'data') {
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('command=')) command = line.slice('command='.length);
      }
    }
    if (command === 'ls-refs') return handleLsRefs(store, repo, parseLsRefsRequest(body));
    if (command === 'fetch') return handleFetchV2(store, repo, parseFetchV2(body));
    throw new ForgeError(400, `unknown v2 upload-pack command ${JSON.stringify(command)}`);
  }
  return handleFetchV0(store, repo, parseFetchV0(body));
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse a receive-pack request: command lines, then the pack bytes after the flush. */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const { before, after } = splitAtFlush(body);
  const commands: PushCommand[] = [];
  for (const packet of before) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const head = nul < 0 ? line : line.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length < 3) throw new ForgeError(400, `malformed push command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) {
      throw new ForgeError(400, `push command names a bad object id ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new ForgeError(400, 'push carries no commands');
  return { commands, pack: after.length ? after : null };
}

/**
 * Answer a receive-pack POST: unpack the pack, apply the commands, and report.
 * A refused ref still reports `unpack ok` with an `ng <ref> non-fast-forward`
 * line; only the ok refs move. A delete-only push carries no pack.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parsePush(body);
  const reportLines: string[] = [];
  if (pack !== null) {
    const checksum = verifyPackChecksum(pack);
    if (!checksum.ok) {
      reportLines.push(`unpack ${`pack trailer ${checksum.actual} does not match its bytes ${checksum.expected}`}\n`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
      return encodeReport(reportLines);
    }
    let read: ReturnType<typeof readPack>;
    try {
      read = readPack(pack, { resolveBase: (oid) => store.object(oid) });
    } catch (err) {
      reportLines.push(`unpack ${(err as Error).message}\n`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
      return encodeReport(reportLines);
    }
    store.putObjects(read.objects.values());
  }
  reportLines.push('unpack ok\n');
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!store.object(command.newOid)) {
      reportLines.push(`ng ${command.ref} object ${command.newOid} not found\n`);
      continue;
    }
    if (current === undefined) {
      // Create.
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update.
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    } else if (store.isAncestor(current, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }
  return encodeReport(reportLines);
}

/** The report-status stream inside band-1 sideband packets, then flush. */
function encodeReport(lines: string[]): Buffer {
  const inner = encodePktLines([...lines, 'flush']);
  const parts: Buffer[] = [];
  const maxData = 65_520 - 4 - 1;
  for (let offset = 0; offset < inner.length; offset += maxData) {
    const slice = inner.subarray(offset, Math.min(inner.length, offset + maxData));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}
