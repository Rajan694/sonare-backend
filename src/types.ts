export type Source = 'local' | 'server';
export type Mode = 'online' | 'offline';

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
  peaks?: number[];
  lyrics?: {
    synced: boolean;
    lines: { atMs: number; text: string }[];
    offsetMs: number;
  };
  thumbnail?: string; // Added by backend: not in frontend Track interface.
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
}

export interface Artist {
  id: string;
  name: string;
  albumCount: number;
  localTrackCount: number;
  following: boolean;
  monthlyListeners?: number | null;
}

export interface Playlist {
  id: string;
  name: string;
  kind: 'local' | 'synced' | 'online';
  trackCount: number | null;
  downloadedCount: number;
  updatedAt: number;
}
