import { idHelpers } from '../ids.js';
import * as T from '../upstream/piped.types.js';
import * as M from '../types.js';
import { UserTrackFields } from '../db/user-data.js';
import { signStreamToken } from '../token.js';

export function withUserFields<TObj extends Record<string, any>>(obj: TObj, userFields?: UserTrackFields) {
  return {
    ...obj,
    playCount: userFields?.playCount ?? 0,
    favourite: userFields?.favourite ?? false,
    addedAt: userFields?.addedAt ?? Date.now(),
    lastPlayedAt: userFields?.lastPlayedAt ?? undefined,
  };
}

function sanitizeCount(val: number | null | undefined): number | null {
  if (val === undefined || val === null || val < 0) return null;
  return val;
}

function stripTitle(title: string): string {
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
}

function stripArtist(uploader: string | undefined): string {
  if (!uploader) return '';
  return uploader.replace(/\s*-\s*Topic$/i, '').trim();
}

function mapCodec(codec: string): string {
  if (codec.toLowerCase().includes('opus')) return 'OPUS';
  if (codec.toLowerCase().includes('mp4a')) return 'AAC';
  if (codec.toLowerCase().includes('aac')) return 'AAC';
  return codec;
}

export function proxyImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Use a 30-day token for images
  return `/api/v1/image/${signStreamToken(url, 30 * 24 * 3600 * 1000)}`;
}

export function normalizeStreamToTrack(streams: T.Streams, videoId: string, codecStr?: string, bitrate?: number, userFields?: UserTrackFields): M.Track & { thumbnail: string } {
  const durationSec = sanitizeCount(streams.duration);
  return withUserFields({
    id: idHelpers.prefixYt(videoId),
    title: stripTitle(streams.title),
    artistId: idHelpers.artistIdFromUrl(streams.uploaderUrl),
    artist: stripArtist(streams.uploader),
    albumId: null as any,
    album: null as any,
    durationMs: durationSec !== null ? durationSec * 1000 : null,
    source: 'server',
    codec: codecStr ? mapCodec(codecStr) : null,
    bitrateKbps: bitrate ? Math.floor(bitrate / 1000) : null,
    bitDepth: undefined,
    thumbnail: `/api/v1/tracks/${idHelpers.prefixYt(videoId)}/artwork`
  }, userFields);
}

export function normalizeStreamItemToTrack(item: T.StreamItem, userFields?: UserTrackFields): M.Track & { thumbnail: string } {
  let id = 'unknown';
  if (item.url?.startsWith('/watch?v=')) {
    id = item.url.substring(9);
  }

  const durationSec = sanitizeCount(item.duration);

  return withUserFields({
    id: idHelpers.prefixYt(id),
    title: stripTitle(item.title || item.name || ''),
    artistId: idHelpers.artistIdFromUrl(item.uploaderUrl),
    artist: stripArtist(item.uploaderName || item.uploader || item.author),
    albumId: null as any,
    album: null as any,
    durationMs: durationSec !== null ? durationSec * 1000 : null,
    source: 'server',
    codec: null as any,
    bitrateKbps: null as any,
    bitDepth: undefined,
    thumbnail: `/api/v1/tracks/${idHelpers.prefixYt(id)}/artwork`
  }, userFields);
}

export function normalizeStreamItemToArtist(item: any) {
  let id = idHelpers.extractChannelIdFromUrl(item.url) || item.url?.replace('/channel/', '') || 'unknown';
  if (id.startsWith('/')) id = 'unknown';
  const ytid = idHelpers.prefixYt(id);
  const rawName = item.name || item.title || item.uploaderName || item.uploader || '';
  return {
    id: ytid,
    name: stripArtist(rawName),
    albumCount: 0,
    localTrackCount: 0,
    following: false,
    monthlyListeners: sanitizeCount(item.views) ?? sanitizeCount(item.subscriberCount),
    thumbnail: id !== 'unknown' ? `/api/v1/artists/${ytid}/artwork` : proxyImageUrl(item.thumbnail)
  };
}

export function normalizeStreamItemToAlbum(item: any) {
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
    source: 'server',
    downloaded: false,
    thumbnail: id !== 'unknown' ? `/api/v1/albums/${ytid}/artwork` : proxyImageUrl(item.thumbnail)
  };
}

export function normalizeChannelTabAlbum(item: any) {
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
    source: 'server',
    downloaded: false,
    thumbnail: id !== 'unknown' ? `/api/v1/albums/${ytid}/artwork` : proxyImageUrl(thumb)
  };
}

export function normalizeChannelToArtist(channel: T.Channel, channelId: string): M.Artist & { thumbnail: string | undefined } {
  const ytid = idHelpers.prefixYt(channelId);
  return {
    id: ytid,
    name: stripArtist(channel.name),
    albumCount: 0,
    localTrackCount: 0,
    following: false,
    monthlyListeners: sanitizeCount(channel.subscriberCount),
    thumbnail: `/api/v1/artists/${ytid}/artwork`
  };
}

export function normalizePlaylistToAlbum(playlist: T.Playlist, playlistId: string): M.Album & { thumbnail: string | undefined } {
  let year = null;
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
    source: 'server',
    downloaded: false,
    thumbnail: `/api/v1/albums/${ytid}/artwork`
  };
}
