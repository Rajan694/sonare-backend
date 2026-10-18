// GENERATED from sonare-frontend/shared/catalog/normalize.ts by scripts/sync-shared-catalog.mjs (root repo).
// Do not edit here: change the frontend file and run the script again.

// Normalizers: Piped JSON to Sonare API shapes (shared/apiTypes). The backend uses a copy of
// this file (scripts/sync-shared-catalog.mjs in the root repo), so both always agree.

import type { Channel, ChannelTabItem, Playlist, StreamItem, Streams } from './pipedTypes.js';
import type { Track, Album, Artist } from '../apiTypes.js';
import { idHelpers } from './ids.js';
import { directImageUrl, trackThumbUrl } from './images.js';
import { applyTitleFix } from './titleFixes.js';

/**
 * Where artwork urls point. The apps use the CDN directly; the backend points at its own
 * artwork routes (which also remember album covers), and sets that with setCatalogImages.
 * `ytid` is the item's `yt:` id (`yt:unknown` when it had none); `raw` the url Piped gave.
 */
export interface CatalogImages {
  track: (videoId: string) => string;
  artist: (ytid: string, raw: string | undefined) => string | undefined;
  album: (ytid: string, raw: string | undefined) => string | undefined;
}

const directImages: CatalogImages = {
  track: trackThumbUrl,
  artist: (_ytid, raw) => (raw ? directImageUrl(raw) : undefined),
  album: (_ytid, raw) => (raw ? directImageUrl(raw) : undefined),
};

let images: CatalogImages = directImages;

export const setCatalogImages = (impl: CatalogImages): void => {
  images = impl;
};

export interface UserTrackFields {
  playCount?: number;
  favourite?: boolean;
  addedAt?: number;
  lastPlayedAt?: number;
}

export const withUserFields = <TObj extends object>(obj: TObj, userFields?: UserTrackFields) => {
  return {
    ...obj,
    playCount: userFields?.playCount ?? 0,
    favourite: userFields?.favourite ?? false,
    addedAt: userFields?.addedAt ?? Date.now(),
    lastPlayedAt: userFields?.lastPlayedAt ?? undefined,
  };
};

const sanitizeCount = (val: number | null | undefined): number | null => {
  if (val === undefined || val === null || val < 0) return null;
  return val;
};

const stripTitle = (title: string): string => {
  if (!title) return '';
  return title
    .replace(/\(Official (Music )?Video\)/gi, '')
    .replace(/\[Official (Music )?Video\]/gi, '')
    .replace(/\[Official Audio\]/gi, '')
    .replace(/\(Official Audio\)/gi, '')
    .replace(/\(Lyrics?\)/gi, '')
    .replace(/\[Lyrics?\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const stripArtist = (uploader: string | undefined): string => {
  if (!uploader) return '';
  return uploader.replace(/\s*-\s*Topic$/i, '').trim();
};

export const cleanTitle = stripTitle;
export const cleanArtist = stripArtist;

const mapCodec = (codec: string): string => {
  if (codec.toLowerCase().includes('opus')) return 'OPUS';
  if (codec.toLowerCase().includes('mp4a')) return 'AAC';
  if (codec.toLowerCase().includes('aac')) return 'AAC';
  return codec;
};

export const normalizeStreamToTrack = (
  streams: Streams,
  videoId: string,
  codecStr?: string,
  bitrate?: number,
  userFields?: UserTrackFields,
): Track & { thumbnail: string } => {
  const durationSec = sanitizeCount(streams.duration);
  // A cleaner title the AI found for this upload, if any (shared/catalog/titleFixes.ts).
  const named = applyTitleFix(videoId, stripTitle(streams.title), stripArtist(streams.uploader), streams.uploader);
  return withUserFields(
    {
      id: idHelpers.prefixYt(videoId),
      title: named.title,
      artistId: idHelpers.artistIdFromUrl(streams.uploaderUrl),
      artist: named.artist,
      albumId: null,
      album: null,
      durationMs: durationSec !== null ? durationSec * 1000 : null,
      source: 'server' as const,
      codec: codecStr ? mapCodec(codecStr) : null,
      bitrateKbps: bitrate ? Math.floor(bitrate / 1000) : null,
      bitDepth: undefined,
      thumbnail: images.track(videoId),
    },
    userFields,
  );
};

export const normalizeStreamItemToTrack = (
  item: StreamItem,
  userFields?: UserTrackFields,
): Track & { thumbnail: string } => {
  let id = 'unknown';
  if (item.url?.startsWith('/watch?v=')) {
    id = item.url.substring(9);
  }

  const durationSec = sanitizeCount(item.duration);
  const uploader = item.uploaderName || item.uploader || item.author;
  const named = applyTitleFix(id, stripTitle(item.title || item.name || ''), stripArtist(uploader), uploader);

  return withUserFields(
    {
      id: idHelpers.prefixYt(id),
      title: named.title,
      artistId: idHelpers.artistIdFromUrl(item.uploaderUrl),
      artist: named.artist,
      albumId: null,
      album: null,
      durationMs: durationSec !== null ? durationSec * 1000 : null,
      source: 'server' as const,
      codec: null,
      bitrateKbps: null,
      bitDepth: undefined,
      thumbnail: images.track(id),
    },
    userFields,
  );
};

export const normalizeStreamItemToArtist = (item: StreamItem): Artist & { thumbnail: string | undefined } => {
  let id = idHelpers.extractChannelIdFromUrl(item.url) || item.url?.replace('/channel/', '') || 'unknown';
  if (id.startsWith('/')) id = 'unknown';
  const ytid = idHelpers.prefixYt(id);
  const rawName = item.name || item.title || item.uploaderName || item.uploader || '';
  const rawThumb = item.thumbnail || item.uploaderAvatar;
  return {
    id: ytid,
    name: stripArtist(rawName),
    albumCount: 0,
    localTrackCount: 0,
    following: false,
    monthlyListeners: sanitizeCount(item.views) ?? sanitizeCount(item.subscriberCount),
    thumbnail: images.artist(ytid, rawThumb),
  };
};

export const normalizeStreamItemToAlbum = (item: StreamItem): Album & { thumbnail: string | undefined } => {
  const id = idHelpers.extractListIdFromUrl(item.url) || 'unknown';
  const ytid = idHelpers.prefixYt(id);
  return {
    id: ytid,
    title: item.name || item.title || '',
    artist: stripArtist(item.uploaderName || item.uploader || item.author || ''),
    artistId: idHelpers.artistIdFromUrl(item.uploaderUrl),
    year: null,
    trackCount: sanitizeCount(item.videos),
    genre: null,
    source: 'server' as const,
    downloaded: false,
    thumbnail: images.album(ytid, item.thumbnail),
  };
};

export const normalizeChannelTabAlbum = (item: ChannelTabItem): Album & { thumbnail: string | undefined } => {
  const id = idHelpers.extractListIdFromUrl(item.url) || item.playlistId || 'unknown';
  const ytid = idHelpers.prefixYt(id);
  const thumb = item.thumbnail || item.thumbnails?.[0]?.url;
  return {
    id: ytid,
    title: item.name || item.title || '',
    artist: stripArtist(item.uploaderName || item.author || item.uploader || ''),
    artistId: idHelpers.artistIdFromUrl(item.uploaderUrl),
    year: null,
    trackCount: sanitizeCount(item.videos) ?? sanitizeCount(item.videoCount),
    genre: null,
    source: 'server' as const,
    downloaded: false,
    thumbnail: images.album(ytid, thumb),
  };
};

export const normalizeChannelToArtist = (
  channel: Channel,
  channelId: string,
): Artist & { thumbnail: string | undefined } => {
  const ytid = idHelpers.prefixYt(channelId);
  return {
    id: ytid,
    name: stripArtist(channel.name),
    albumCount: 0,
    localTrackCount: 0,
    following: false,
    monthlyListeners: sanitizeCount(channel.subscriberCount),
    thumbnail: images.artist(ytid, channel.avatarUrl),
  };
};

export const normalizePlaylistToAlbum = (
  playlist: Playlist,
  playlistId: string,
): Album & { thumbnail: string | undefined } => {
  let year: number | null = null;
  if (playlist.description) {
    const match = playlist.description.match(/\b(19|20)\d{2}\b/);
    if (match) year = parseInt(match[0], 10);
  }
  const ytid = idHelpers.prefixYt(playlistId);
  // YouTube Music albums (OLAK… ids) have no uploader; credit the channel that uploaded
  // most of their tracks instead, so the album has an artist and a link to it.
  let uploader = playlist.uploader;
  let uploaderUrl = playlist.uploaderUrl;
  if (!uploader) {
    const counts = new Map<string, { n: number; url?: string }>();
    for (const s of playlist.relatedStreams ?? []) {
      if (!s.uploaderName) continue;
      const c = counts.get(s.uploaderName) ?? { n: 0, url: s.uploaderUrl };
      counts.set(s.uploaderName, { n: c.n + 1, url: c.url ?? s.uploaderUrl });
    }
    const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (top) [uploader, uploaderUrl] = [top[0], top[1].url ?? ''];
  }
  return {
    id: ytid,
    // YouTube prefixes album titles with "Album – ".
    title: playlist.name.replace(/^Album\s+[–-]\s+/, ''),
    artist: stripArtist(uploader),
    artistId: idHelpers.artistIdFromUrl(uploaderUrl),
    year,
    trackCount: sanitizeCount(playlist.videos),
    genre: null,
    source: 'server' as const,
    downloaded: false,
    thumbnail: images.album(ytid, playlist.thumbnailUrl),
  };
};
