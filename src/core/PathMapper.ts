import { posix, win32 } from 'node:path';
import { minimatch } from 'minimatch';
import type { Mapping } from '../config/schema';

export interface MappableServer {
  rootPath: string;
  webUrl?: string;
  mappings: Mapping[];
  excludedLocal: string[];
  excludedRemote: string[];
}

interface ResolvedMapping {
  /** Normalized absolute local path with forward slashes, no trailing slash. */
  local: string;
  /** Absolute remote path, no trailing slash (except "/"). */
  remote: string;
  web: string;
}

/** Converts an OS path to forward slashes without a trailing separator (drive roots keep theirs). */
export const toSlash = (p: string): string => {
  const s = p.replace(/\\/g, '/');
  return s.length > 1 && s.endsWith('/') && !/^[a-zA-Z]:\/$/.test(s) ? s.slice(0, -1) : s;
};

const normRemote = (p: string): string => {
  const n = posix.normalize(p.replace(/\\/g, '/') || '/');
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
};

/** Returns the path of `child` relative to `parent`, or undefined when it is not inside it. */
const relativeInside = (parent: string, child: string, caseInsensitive: boolean): string | undefined => {
  const a = caseInsensitive ? parent.toLowerCase() : parent;
  const b = caseInsensitive ? child.toLowerCase() : child;
  if (a === b) return '';
  const prefix = a === '/' || a.endsWith('/') ? a : `${a}/`;
  return b.startsWith(prefix) ? child.slice(prefix.length) : undefined;
};

export class PathMapper {
  private readonly mappings: ResolvedMapping[];
  private readonly excludedLocal: string[];
  private readonly excludedRemote: string[];
  private readonly caseInsensitive: boolean;
  private readonly localPath: typeof posix;

  constructor(
    private readonly projectRoot: string,
    private readonly server: MappableServer,
    private readonly excludeNames: string[],
    platform: NodeJS.Platform = process.platform,
  ) {
    this.caseInsensitive = platform === 'win32';
    this.localPath = platform === 'win32' ? win32 : posix;
    const root = toSlash(projectRoot);
    const localAbs = (p: string) => toSlash(!p || p === '.' ? root : this.localPath.isAbsolute(p) ? p : this.localPath.resolve(projectRoot, p));
    this.mappings = server.mappings
      .filter((m) => m.remote !== undefined && m.remote !== null)
      .map((m) => ({
        local: localAbs(m.local),
        remote: normRemote(posix.join(server.rootPath || '/', m.remote || '/')),
        web: m.web || '/',
      }));
    this.excludedLocal = server.excludedLocal.filter(Boolean).map(localAbs);
    this.excludedRemote = server.excludedRemote.filter(Boolean).map(normRemote);
  }

  get hasMappings(): boolean {
    return this.mappings.length > 0;
  }

  /** Remote directories that are the targets of mappings (used to seed sync and the Remote Host view). */
  get remoteRoots(): string[] {
    return this.mappings.map((m) => m.remote);
  }

  get localRoots(): string[] {
    return this.mappings.map((m) => m.local);
  }

  private matchLocal(localPath: string): { m: ResolvedMapping; rel: string } | undefined {
    const p = toSlash(localPath);
    let best: { m: ResolvedMapping; rel: string } | undefined;
    for (const m of this.mappings) {
      const rel = relativeInside(m.local, p, this.caseInsensitive);
      if (rel !== undefined && (!best || m.local.length > best.m.local.length)) best = { m, rel };
    }
    return best;
  }

  private matchRemote(remotePath: string): { m: ResolvedMapping; rel: string } | undefined {
    const p = normRemote(remotePath);
    let best: { m: ResolvedMapping; rel: string } | undefined;
    for (const m of this.mappings) {
      const rel = relativeInside(m.remote, p, false);
      if (rel !== undefined && (!best || m.remote.length > best.m.remote.length)) best = { m, rel };
    }
    return best;
  }

  /** Absolute remote path for a local file, or undefined when the file is not mapped. */
  toRemote(localPath: string): string | undefined {
    const hit = this.matchLocal(localPath);
    return hit ? normRemote(posix.join(hit.m.remote, hit.rel)) : undefined;
  }

  /** OS-native local path for a remote file, or undefined when the remote path is not mapped. */
  toLocal(remotePath: string): string | undefined {
    const hit = this.matchRemote(remotePath);
    if (!hit) return undefined;
    return this.localPath.normalize(hit.rel ? `${hit.m.local}/${hit.rel}` : hit.m.local);
  }

  /** Web URL for a local or remote path, when the server has a web URL. */
  webUrlForRemote(remotePath: string): string | undefined {
    const base = this.server.webUrl?.trim();
    const hit = this.matchRemote(remotePath);
    if (!base || !hit) return undefined;
    const path = posix.join('/', hit.m.web, hit.rel).split('/').map(encodeURIComponent).join('/');
    return base.replace(/\/+$/, '') + path;
  }

  webUrlForLocal(localPath: string): string | undefined {
    const remote = this.toRemote(localPath);
    return remote ? this.webUrlForRemote(remote) : undefined;
  }

  private nameExcluded(rel: string): boolean {
    if (!rel || this.excludeNames.length === 0) return false;
    const segments = rel.split('/').filter(Boolean);
    return segments.some((seg) => this.excludeNames.some((pat) => minimatch(seg, pat, { dot: true, nocase: this.caseInsensitive })));
  }

  isLocalExcluded(localPath: string): boolean {
    const p = toSlash(localPath);
    if (this.excludedLocal.some((ex) => relativeInside(ex, p, this.caseInsensitive) !== undefined)) return true;
    const hit = this.matchLocal(p);
    const rel = hit ? hit.rel : (relativeInside(toSlash(this.projectRoot), p, this.caseInsensitive) ?? p);
    return this.nameExcluded(rel);
  }

  isRemoteExcluded(remotePath: string): boolean {
    const p = normRemote(remotePath);
    if (this.excludedRemote.some((ex) => relativeInside(ex, p, false) !== undefined)) return true;
    const hit = this.matchRemote(p);
    return this.nameExcluded(hit ? hit.rel : p);
  }

  /** Mapped and not excluded: eligible for upload. */
  isDeployable(localPath: string): boolean {
    return this.toRemote(localPath) !== undefined && !this.isLocalExcluded(localPath);
  }
}
