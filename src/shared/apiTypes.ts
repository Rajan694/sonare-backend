// GENERATED from sonare-frontend/shared/apiTypes.ts by scripts/sync-shared-catalog.mjs (root repo).
// Do not edit here: change the frontend file and run the script again.

// Shapes the Sonare API returns (../../docs/api-contract.md), shared by the desktop/web app
// and the mobile app. Types only: no runtime code and no imports, so each app can pull it in
// with `import type` / `export type *` and no bundler ever has to load this file.
//
// Ids are namespaced: `yt:…` for server content, `sonare:…` for the user's own playlists,
// `local:…` for device files.

export type Source = "local" | "server";

export interface Page<T> {
  items: T[];
  meta?: {
    nextCursor?: string;
    total?: number;
  };
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  /** Missing on sessions saved before email verification existed. */
  emailVerified?: boolean;
  /** ISO timestamp (GET /me); not sent with sign-in responses. */
  createdAt?: string;
}

export interface Track {
  id: string;
  title: string;
  artistId: string;
  artist: string;
  albumId: string | null;
  album: string | null;
  durationMs: number | null;
  source: Source;
  localPath?: string;
  codec?: string | null;
  bitrateKbps?: number | null;
  bitDepth?: number;
  playCount: number;
  favourite: boolean;
  addedAt: number;
  lastPlayedAt?: number;
  thumbnail?: string;
  /** In an own playlist's song list: that row of the playlist, so the same song twice can be told apart. */
  entryId?: string;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  year: number | null;
  trackCount: number | null;
  genre: string | null;
  source: Source;
  downloaded: boolean;
  thumbnail?: string;
}

export interface Artist {
  id: string;
  name: string;
  albumCount: number;
  localTrackCount: number;
  following: boolean;
  monthlyListeners?: number | null;
  thumbnail?: string;
  /** Library only: liked or playlisted songs by an artist the user doesn't follow. */
  songCount?: number;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string | null;
  kind: "local" | "synced" | "online";
  trackCount: number | null;
  downloadedCount: number;
  /** The user's own playlists only; YouTube playlists (GET /playlists/:id) have no date. */
  updatedAt?: number;
  thumbnail?: string;
}

/** Search results carry a `kind` discriminator. */
export type SearchItem =
  | ({ kind: "track" } & Track)
  | ({ kind: "album" } & Album)
  | ({ kind: "artist" } & Artist)
  // Playlist has its own `kind` (local/synced/online); search replaces it with the discriminator.
  | ({ kind: "playlist" } & Omit<Playlist, "kind">);

export interface LyricsLine {
  atMs: number;
  text: string;
}

/** GET /tracks/:id/lyrics. */
export interface Lyrics {
  synced: boolean;
  /** lrclib, genius or user (an override saved by the user). */
  provider: string;
  offsetMs: number;
  lines: LyricsLine[];
  plain?: string;
  /** Genius results carry only a link to the lyrics. */
  attribution?: { name: string; url: string };
}

/** GET /tracks/:id/stream. */
export interface StreamInfo {
  url: string;
  mimeType: string;
  codec: string;
  bitrateKbps: number;
  contentLength: number;
  expiresAt: number;
  muxed?: boolean;
  itag?: number;
}

export type ReleasePlatform = "android" | "linux" | "windows";

/** An app build: an asset of the latest GitHub release (GET /releases). */
export interface AppRelease {
  /** The GitHub asset id; GET /releases/:id/download redirects to the file. */
  id: string;
  platform: ReleasePlatform;
  /** apk | appimage | deb | tar.gz | exe */
  format: string;
  version: string;
  /** What the download is saved as. */
  fileName: string;
  sizeBytes: number;
  /** GitHub's digest of the file; null for assets uploaded before GitHub recorded one. */
  sha256: string | null;
  notes: string | null;
  uploadedAt: string;
  /** The file on GitHub. */
  url?: string;
}

/** GET /app-config. */
export interface AppConfig {
  inAppYoutube: boolean;
  youtubeClients: string[];
  updatedAt: number;
  /**
   * At least one AI provider the admin enabled is answering. False (or missing, on an older
   * backend) hides every AI feature; the apps show nothing in their place.
   */
  ai?: boolean;
}

// ---- AI (the backend asks an LLM; the apps find the songs with their own search) ----

/** A song the AI suggested, by name only: the apps look it up with their usual search. */
export interface AiPick {
  title: string;
  artist: string;
  /** A short "because ..." line, when the AI gave one. */
  reason?: string;
}

/** GET /me/ai/you-may-like. `picks` is empty when the listening history is too short. */
export interface AiYouMayLike {
  picks: AiPick[];
  /** The artists the picks were based on, most played first. */
  basedOn: string[];
  generatedAt: number;
}

/** GET /ai/search?q=: what to search for to answer a request in plain words. */
export interface AiSearchPlan {
  /** Up to 4 ordinary search queries, best first. */
  queries: string[];
  /** One line on how the request was read, e.g. "Sad Punjabi songs from the 2010s". */
  summary?: string;
}

/** POST /me/ai/playlist: a playlist the AI drafted. Nothing is saved until the app creates it. */
export interface AiPlaylistDraft {
  name: string;
  description: string;
  picks: AiPick[];
}

/** A cleaner title and artist for a YouTube upload (POST /ai/titles), keyed by raw video id. */
export interface AiTitleFix {
  title: string;
  artist: string;
}

/** POST /ai/titles answer: fixes the backend already has. The rest are worked out later; ask again. */
export interface AiTitleFixes {
  fixes: Record<string, AiTitleFix>;
}

// Catalog metadata for tracks, albums, and artists stored in row metadata or catalog_items table.
// Used for offline/fallback display when Piped is unreachable.

export interface TrackMeta {
  title: string;
  artist: string;
  artistId: string;
  album?: string;
  albumId?: string;
  durationMs: number | null;
  thumbnail?: string;
}

export interface AlbumMeta {
  title: string;
  artist: string;
  artistId: string;
  year?: number | null;
  trackCount?: number | null;
  thumbnail?: string;
}

export interface ArtistMeta {
  name: string;
  thumbnail?: string;
  monthlyListeners?: number | null;
}

