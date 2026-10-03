import { describe, expect, it } from 'vitest';
import type * as T from '../../src/upstream/piped.types.js';
import {
  albumThumbFor,
  normalizeChannelTabAlbum,
  normalizeChannelToArtist,
  normalizePlaylistToAlbum,
  normalizeStreamItemToAlbum,
  normalizeStreamItemToArtist,
  normalizeStreamItemToTrack,
  normalizeStreamToTrack,
  proxyImageUrl,
  withUserFields,
} from '../../src/normalize/index.js';

describe('normalize: Piped → Sonare mapping', () => {
  it('BE-NORM-001: withUserFields attaches user metadata to object', () => {
    const obj = { id: 'test', title: 'Song' };
    const res = withUserFields(obj, {
      playCount: 15,
      favourite: true,
      addedAt: 123456,
      lastPlayedAt: 78910,
    });
    expect(res.playCount).toBe(15);
    expect(res.favourite).toBe(true);
    expect(res.addedAt).toBe(123456);
    expect(res.lastPlayedAt).toBe(78910);
  });

  it('BE-NORM-002: proxyImageUrl returns signed image route or undefined', () => {
    expect(proxyImageUrl(undefined)).toBeUndefined();
    expect(proxyImageUrl('https://thumb.jpg')).toMatch(/^\/api\/v1\/image\//);
  });

  it('BE-NORM-003: normalizeStreamToTrack transforms full piped stream object', () => {
    const raw = {
      title: 'Never Gonna Give You Up (Official Music Video)',
      uploader: 'Rick Astley - Topic',
      uploaderUrl: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
      uploaderAvatar: 'https://avatar.jpg',
      thumbnailUrl: 'https://thumb.jpg',
      duration: 213,
      audioStreams: [],
      videoStreams: [],
    };

    const track = normalizeStreamToTrack(raw as unknown as T.Streams, 'dQw4w9WgXcQ', 'opus', 160000, {
      favourite: true,
      playCount: 10,
      lastPlayedAt: 1600000000000,
    });

    expect(track.id).toBe('yt:dQw4w9WgXcQ');
    expect(track.title).toBe('Never Gonna Give You Up');
    expect(track.artist).toBe('Rick Astley');
    expect(track.durationMs).toBe(213000);
    expect(track.codec).toBe('OPUS');
    expect(track.bitrateKbps).toBe(160);
    expect(track.favourite).toBe(true);
    expect(track.playCount).toBe(10);
    expect(track.lastPlayedAt).toBe(1600000000000);
  });

  it('BE-NORM-004: normalizeStreamToTrack handles missing uploader and empty duration', () => {
    const raw = {
      title: 'Unknown Title',
      duration: 0,
    };
    const track = normalizeStreamToTrack(raw as unknown as T.Streams, 'unk123');
    expect(track.id).toBe('yt:unk123');
    expect(track.title).toBe('Unknown Title');
    expect(track.artist).toBe('');
    expect(track.durationMs).toBe(0);
    expect(track.favourite).toBe(false);
  });

  it('BE-NORM-005: normalizeStreamItemToTrack converts search stream item', () => {
    const item = {
      url: '/watch?v=item123',
      title: 'Item Title (Official Video)',
      uploaderName: 'Artist Name - Topic',
      uploaderUrl: '/channel/UCart123',
      thumbnail: 'https://thumb.jpg',
      duration: 180,
    };
    const track = normalizeStreamItemToTrack(item as T.StreamItem);
    expect(track.id).toBe('yt:item123');
    expect(track.title).toBe('Item Title');
    expect(track.artist).toBe('Artist Name');
    expect(track.durationMs).toBe(180000);
  });

  it('BE-NORM-006: normalizeStreamItemToArtist converts search channel item', () => {
    const item = {
      url: '/channel/UCartistId',
      name: 'Superstar - Topic',
      thumbnail: 'https://artist.jpg',
      subscriberCount: 500000,
      verified: true,
    };
    const artist = normalizeStreamItemToArtist(item as T.StreamItem);
    expect(artist.id).toBe('yt:UCartistId');
    expect(artist.name).toBe('Superstar');
    expect(artist.monthlyListeners).toBe(500000);
  });

  it('BE-NORM-007: normalizeStreamItemToAlbum converts search playlist item', () => {
    const item = {
      url: '/playlist?list=PLalbumList1',
      name: 'Greatest Hits Album',
      uploaderName: 'Artist Name',
      uploaderUrl: '/channel/UCartistId',
      thumbnail: 'https://album.jpg',
      videos: 12,
    };
    const album = normalizeStreamItemToAlbum(item as T.StreamItem);
    expect(album.id).toBe('yt:PLalbumList1');
    expect(album.title).toBe('Greatest Hits Album');
    expect(album.artist).toBe('Artist Name');
    expect(album.trackCount).toBe(12);
  });

  it('BE-NORM-008: normalizeChannelTabAlbum handles album entries from channel tabs', () => {
    const tabItem = {
      url: '/playlist?list=OLAK5uy_tab1',
      title: 'Studio Album 1',
      thumbnail: 'https://cover.jpg',
      year: '2021',
    };
    const album = normalizeChannelTabAlbum(tabItem as T.ChannelTabItem);
    expect(album.id).toBe('yt:OLAK5uy_tab1');
    expect(album.title).toBe('Studio Album 1');
  });

  it('BE-NORM-009: normalizeChannelToArtist normalizes full channel object', () => {
    const channel = {
      id: 'UCchannel123',
      name: 'Official Band Name - Topic',
      avatarUrl: 'https://avatar.jpg',
      bannerUrl: 'https://banner.jpg',
      subscriberCount: 1200000,
      description: 'Band bio description here',
    };
    const artist = normalizeChannelToArtist(channel as unknown as T.Channel, 'UCchannel123');
    expect(artist.id).toBe('yt:UCchannel123');
    expect(artist.name).toBe('Official Band Name');
    expect(artist.thumbnail).toBe('/api/v1/artists/yt:UCchannel123/artwork');
  });

  it('BE-NORM-010: normalizePlaylistToAlbum builds full album view with tracks', () => {
    const playlist = {
      id: 'PLplaylistId',
      name: 'Album Title Here',
      uploader: 'Band Name',
      uploaderUrl: '/channel/UCband',
      thumbnailUrl: 'https://thumb.jpg',
      bannerUrl: 'https://banner.jpg',
      videos: 2,
      relatedStreams: [
        {
          url: '/watch?v=t1',
          title: 'Track 1',
          uploaderName: 'Band Name',
          duration: 200,
        },
        {
          url: '/watch?v=t2',
          title: 'Track 2',
          uploaderName: 'Band Name',
          duration: 250,
        },
      ],
    };
    const album = normalizePlaylistToAlbum(playlist as unknown as T.Playlist, 'PLplaylistId');
    expect(album.id).toBe('yt:PLplaylistId');
    expect(album.title).toBe('Album Title Here');
    expect(album.artist).toBe('Band Name');
    expect(album.trackCount).toBe(2);
  });

  it('BE-NORM-011: albumThumbFor returns cached or undefined correctly', () => {
    expect(albumThumbFor('unknown_id_xyz')).toBeUndefined();
  });
});

describe('normalize: helpers', () => {
  it('BE-NORM-HELP-001: normalizeStreamItemToArtist handles null name/uploader fallbacks', () => {
    const item = { url: '/channel/UCartistFallback', uploader: 'Fallback Artist' };
    const artist = normalizeStreamItemToArtist(item);
    expect(artist.name).toBe('Fallback Artist');
  });

  it('BE-NORM-HELP-002: normalizeStreamItemToArtist handles unknown channel id gracefully', () => {
    const item = { url: '/channel/' };
    const artist = normalizeStreamItemToArtist(item);
    expect(artist.id).toBe('yt:unknown');
  });

  it('BE-NORM-HELP-003: normalizePlaylistToAlbum extracts release year from playlist description', () => {
    const playlist = {
      id: 'PLwithYear',
      name: 'Classic Album',
      description: 'Released in 1994 by Music Records',
      relatedStreams: [],
    };
    const album = normalizePlaylistToAlbum(playlist as unknown as T.Playlist, 'PLwithYear');
    expect(album.year).toBe(1994);
  });

  it('BE-NORM-HELP-004: normalizePlaylistToAlbum credits top uploader from relatedStreams when uploader is missing', () => {
    const playlist = {
      id: 'PLnoUploader',
      name: 'VA Compilation',
      relatedStreams: [
        { uploaderName: 'Main Band', uploaderUrl: '/channel/UCmain' },
        { uploaderName: 'Main Band', uploaderUrl: '/channel/UCmain' },
        { uploaderName: 'Guest Band', uploaderUrl: '/channel/UCguest' },
      ],
    };
    const album = normalizePlaylistToAlbum(playlist as unknown as T.Playlist, 'PLnoUploader');
    expect(album.artist).toBe('Main Band');
    expect(album.artistId).toBe('yt:UCmain');
  });

  it('BE-NORM-HELP-005: normalizeStreamToTrack maps AAC and other codecs accurately', () => {
    const trackAac = normalizeStreamToTrack({ title: 'Song', duration: 100 } as T.Streams, 'vidAac', 'audio/mp4a.40.2');
    expect(trackAac.codec).toBe('AAC');

    const trackOther = normalizeStreamToTrack({ title: 'Song', duration: 100 } as T.Streams, 'vidFlac', 'flac');
    expect(trackOther.codec).toBe('flac');
  });
});
