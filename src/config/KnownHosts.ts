import { createHash, createHmac } from 'node:crypto';

export type HostKeyStatus = 'trusted' | 'revoked' | 'mismatch' | 'unknown';

export interface KnownHostEntry {
  marker?: '@revoked' | '@cert-authority';
  patterns: string[];
  keyType: string;
  key: string;
}

/** OpenSSH-style fingerprint: "SHA256:" + unpadded base64 of the SHA-256 digest of the key blob. */
export const fingerprintSha256 = (key: Buffer): string => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** The host token OpenSSH writes into known_hosts: "host" for port 22, "[host]:port" otherwise. */
export const hostToken = (host: string, port: number): string => (port === 22 ? host : `[${host}]:${port}`);

export const parseKnownHosts = (text: string): KnownHostEntry[] => {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let marker: KnownHostEntry['marker'];
    if (parts[0] === '@revoked' || parts[0] === '@cert-authority') marker = parts.shift() as KnownHostEntry['marker'];
    if (parts.length < 3) continue;
    entries.push({ marker, patterns: parts[0].split(','), keyType: parts[1], key: parts[2] });
  }
  return entries;
};

const matchesHashed = (pattern: string, token: string): boolean => {
  const [, kind, salt, hash] = pattern.split('|');
  if (kind !== '1' || !salt || !hash) return false;
  return createHmac('sha1', Buffer.from(salt, 'base64')).update(token).digest('base64') === hash;
};

/** OpenSSH patterns only know "*" and "?"; everything else (including "[" in "[host]:port") is literal. */
const wildcardMatch = (pattern: string, value: string): boolean => {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i').test(value);
};

/** Applies OpenSSH host pattern rules: comma-separated, wildcards, "!" negation, hashed names. */
export const hostMatches = (patterns: string[], host: string, port: number): boolean => {
  const token = hostToken(host, port);
  let matched = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    const pat = negated ? p.slice(1) : p;
    const hit = pat.startsWith('|1|') ? matchesHashed(pat, token) : wildcardMatch(pat, token);
    if (hit && negated) return false;
    if (hit) matched = true;
  }
  return matched;
};

export const checkHostKey = (entries: KnownHostEntry[], host: string, port: number, keyType: string, key: Buffer): HostKeyStatus => {
  const keyB64 = key.toString('base64');
  let sawSameType = false;
  for (const e of entries) {
    if (e.marker === '@cert-authority' || !hostMatches(e.patterns, host, port)) continue;
    if (e.key === keyB64) return e.marker === '@revoked' ? 'revoked' : 'trusted';
  }
  for (const e of entries) {
    if (e.marker || !hostMatches(e.patterns, host, port)) continue;
    if (e.keyType === keyType) sawSameType = true;
  }
  return sawSameType ? 'mismatch' : 'unknown';
};

/** Revocations anywhere in the file apply regardless of host. */
export const isRevoked = (entries: KnownHostEntry[], key: Buffer): boolean => {
  const keyB64 = key.toString('base64');
  return entries.some((e) => e.marker === '@revoked' && e.key === keyB64);
};
