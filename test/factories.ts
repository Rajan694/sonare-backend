import bcrypt from 'bcrypt';
import { db } from '../src/db/index.js';
import { users, adminUsers, refreshTokens } from '../src/db/schema.js';
import { signAccessToken, generateRefreshToken, hashToken } from '../src/middleware/auth.js';
import { signAdminToken } from '../src/middleware/adminAuth.js';
import crypto from 'node:crypto';

export async function createUser(override: Partial<typeof users.$inferInsert> = {}) {
  const email = override.email ?? `user_${crypto.randomBytes(6).toString('hex')}@example.com`;
  const displayName = override.displayName ?? 'Test User';
  const password = 'password123';
  const passwordHash = override.passwordHash ?? (await bcrypt.hash(password, 10));

  const [user] = await db
    .insert(users)
    .values({
      email,
      displayName,
      passwordHash,
      ...override,
    })
    .returning();

  const token = signAccessToken({ id: user.id, email: user.email });
  const refreshToken = generateRefreshToken();

  await db.insert(refreshTokens).values({
    userId: user.id,
    token: hashToken(refreshToken),
  });

  return { user, token, refreshToken, rawPassword: password };
}

export async function createAdminUser(override: Partial<typeof adminUsers.$inferInsert> = {}) {
  const username = override.username ?? `admin_${crypto.randomBytes(4).toString('hex')}`;
  const password = 'adminpassword123';
  const passwordHash = override.passwordHash ?? (await bcrypt.hash(password, 12));

  const [admin] = await db
    .insert(adminUsers)
    .values({
      username,
      passwordHash,
      tokenVersion: 1,
      ...override,
    })
    .returning();

  const token = signAdminToken(admin);
  return { admin, token, rawPassword: password };
}

export function samplePipedStream(id: string = 'dQw4w9WgXcQ') {
  return {
    id,
    title: 'Never Gonna Give You Up',
    description: 'A music video track',
    uploader: 'Rick Astley',
    uploaderUrl: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
    uploaderAvatar: 'https://piped.video/avatar.jpg',
    thumbnailUrl: 'https://piped.video/thumb.jpg',
    duration: 213,
    views: 1000000,
    audioStreams: [
      {
        url: 'https://audio.googlevideo.com/videoplayback?itag=251',
        format: 'opus',
        quality: 'medium',
        mimeType: 'audio/webm; codecs="opus"',
        codec: 'opus',
        audioTrackName: null,
        audioTrackId: null,
        audioTrackType: null,
        audioTrackLocale: null,
        videoOnly: false,
        itag: 251,
        bitrate: 160000,
        initStart: 0,
        initEnd: 200,
        indexStart: 201,
        indexEnd: 400,
        width: 0,
        height: 0,
        fps: 0,
        contentLength: 4200000,
      },
      {
        url: 'https://audio.googlevideo.com/videoplayback?itag=140',
        format: 'm4a',
        quality: 'medium',
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        codec: 'mp4a.40.2',
        audioTrackName: null,
        audioTrackId: null,
        audioTrackType: null,
        audioTrackLocale: null,
        videoOnly: false,
        itag: 140,
        bitrate: 128000,
        initStart: 0,
        initEnd: 200,
        indexStart: 201,
        indexEnd: 400,
        width: 0,
        height: 0,
        fps: 0,
        contentLength: 3500000,
      },
    ],
    videoStreams: [],
    relatedStreams: [
      {
        url: '/watch?v=related12345',
        title: 'Together Forever',
        uploaderName: 'Rick Astley',
        uploaderUrl: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
        uploaderAvatar: 'https://piped.video/avatar.jpg',
        thumbnail: 'https://piped.video/related.jpg',
        duration: 204,
        views: 50000,
        uploadedDate: '2 years ago',
        shortDescription: null,
        uploaded: 1600000000000,
        uploaderVerified: true,
      },
    ],
  };
}

export function samplePipedSearchItem(id: string = 'dQw4w9WgXcQ') {
  return {
    url: `/watch?v=${id}`,
    title: 'Never Gonna Give You Up',
    uploaderName: 'Rick Astley',
    uploaderUrl: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
    uploaderAvatar: 'https://piped.video/avatar.jpg',
    thumbnail: 'https://piped.video/thumb.jpg',
    duration: 213,
    views: 1000000,
    uploadedDate: '10 years ago',
    shortDescription: null,
    uploaded: 1500000000000,
    uploaderVerified: true,
  };
}

export function samplePipedPlaylist(id: string = 'PL1234567890') {
  return {
    id,
    name: 'Greatest Hits Album',
    thumbnailUrl: 'https://piped.video/playlist_thumb.jpg',
    bannerUrl: 'https://piped.video/playlist_banner.jpg',
    uploader: 'Rick Astley',
    uploaderUrl: '/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
    uploaderAvatar: 'https://piped.video/avatar.jpg',
    videos: 1,
    relatedStreams: [samplePipedSearchItem('dQw4w9WgXcQ')],
    nextpage: null,
  };
}

export function samplePipedChannel(id: string = 'UCuAXFkgsw1L7xaCfnd5JJOw') {
  return {
    id,
    name: 'Rick Astley',
    avatarUrl: 'https://piped.video/artist_avatar.jpg',
    bannerUrl: 'https://piped.video/artist_banner.jpg',
    description: 'Official artist channel for Rick Astley.',
    subscriberCount: 3000000,
    verified: true,
    relatedStreams: [samplePipedSearchItem('dQw4w9WgXcQ')],
    tabs: [
      {
        name: 'Albums',
        data: 'tab_data_albums',
        content: [
          {
            url: '/playlist?list=OLAK5uy_sample',
            title: 'Whenever You Need Somebody',
            thumbnail: 'https://piped.video/album_thumb.jpg',
            uploaderName: 'Rick Astley',
            uploaderUrl: `/channel/${id}`,
            uploaderAvatar: 'https://piped.video/artist_avatar.jpg',
            videos: 10,
          },
        ],
      },
    ],
    nextpage: null,
  };
}
