import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import { config } from '../config.js';
import type { appReleases } from '../db/schema.js';

// App builds the admin page uploads and Settings → About offers for download. Files sit in
// RELEASES_DIR under their row id, so nothing a client sends ever becomes part of a path.

export const PLATFORMS = ['android', 'linux', 'windows'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Longest extensions first, so `.tar.gz` wins over `.gz`. */
const FORMATS: { ext: string; format: string; platforms: Platform[] }[] = [
  { ext: '.tar.gz', format: 'tar.gz', platforms: ['linux'] },
  { ext: '.appimage', format: 'appimage', platforms: ['linux'] },
  { ext: '.apk', format: 'apk', platforms: ['android'] },
  { ext: '.deb', format: 'deb', platforms: ['linux'] },
  { ext: '.rpm', format: 'rpm', platforms: ['linux'] },
  { ext: '.exe', format: 'exe', platforms: ['windows'] },
  { ext: '.msi', format: 'msi', platforms: ['windows'] },
  { ext: '.zip', format: 'zip', platforms: ['linux', 'windows'] },
];

/** The file types each platform accepts, for error messages and the admin page. */
export const acceptedExtensions = (platform: Platform): string[] => {
  return FORMATS.filter((f) => f.platforms.includes(platform)).map((f) => f.ext);
};

/** The format a file name is for on that platform, or null when the platform doesn't take it. */
export const formatFor = (platform: Platform, fileName: string): { format: string; ext: string } | null => {
  const lower = fileName.toLowerCase();
  const match = FORMATS.find((f) => lower.endsWith(f.ext));
  return match && match.platforms.includes(platform) ? { format: match.format, ext: match.ext } : null;
};

/** A download name safe for Content-Disposition: the base name, printable ASCII only. */
export const cleanFileName = (fileName: string): string => {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return base
    .replace(/[^\w.+~-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);
};

export const maxUploadBytes = () => config.RELEASE_MAX_MB * 1024 * 1024;

export const releasesDir = (): string => {
  return path.resolve(config.RELEASES_DIR);
};

export const releasePath = (release: Pick<typeof appReleases.$inferSelect, 'id' | 'format'>): string => {
  const ext = FORMATS.find((f) => f.format === release.format)?.ext ?? '';
  return path.join(releasesDir(), `${release.id}${ext}`);
};

export class UploadTooLargeError extends Error {
  constructor() {
    super(`The file is larger than ${config.RELEASE_MAX_MB} MB`);
  }
}

/**
 * Streams the request body into a temporary file in RELEASES_DIR, hashing it on the way.
 * Leaves nothing behind when it fails; the caller renames the file into place.
 */
export const receiveUpload = async (req: Request): Promise<{ tmpPath: string; size: number; sha256: string }> => {
  const limit = maxUploadBytes();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new UploadTooLargeError();

  await fs.mkdir(releasesDir(), { recursive: true });
  const tmpPath = path.join(releasesDir(), `.upload-${crypto.randomUUID()}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > limit) return done(new UploadTooLargeError());
      hash.update(chunk);
      done(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(tmpPath));
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
  return { tmpPath, size, sha256: hash.digest('hex') };
};

/** The fields the apps and the admin page see. */
export const releaseView = (r: typeof appReleases.$inferSelect) => {
  return {
    id: r.id,
    platform: r.platform,
    format: r.format,
    version: r.version,
    fileName: r.fileName,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    notes: r.notes,
    uploadedAt: r.uploadedAt,
  };
};
