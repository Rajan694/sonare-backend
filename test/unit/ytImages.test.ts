import { describe, expect, it } from 'vitest';
import { directImageUrl, ytThumbUrl } from '../../src/upstream/ytImages.js';

describe('ytImages.ts', () => {
  it('BE-YTIMG-001: directImageUrl turns Piped-proxied thumbnails and covers into Google CDN urls', () => {
    expect(directImageUrl('http://localhost:8091/vi_webp/abc/maxresdefault.webp?host=i.ytimg.com')).toBe(
      'https://i.ytimg.com/vi_webp/abc/maxresdefault.webp',
    );
    expect(directImageUrl('http://proxy.example:8091/AbC=w544-h544-l90-rw?host=yt3.googleusercontent.com')).toBe(
      'https://yt3.googleusercontent.com/AbC=w544-h544-l90-rw',
    );
  });

  it('BE-YTIMG-002: directImageUrl keeps a signed cover query byte-for-byte, dropping host and qhash', () => {
    const proxied =
      'http://localhost:8091/s_p/OLAK5uy_x/maxresdefault.jpg?days_since_epoch=20730&host=i9.ytimg.com&rs=AOn4CLBk&sqp=CMS7iNYG%3D&qhash=deadbeef&';
    expect(directImageUrl(proxied)).toBe(
      'https://i9.ytimg.com/s_p/OLAK5uy_x/maxresdefault.jpg?days_since_epoch=20730&rs=AOn4CLBk&sqp=CMS7iNYG%3D',
    );
  });

  it('BE-YTIMG-003: directImageUrl leaves other urls alone; ytThumbUrl builds i.ytimg urls', () => {
    expect(directImageUrl('https://i.ytimg.com/vi/abc/mqdefault.jpg')).toBe('https://i.ytimg.com/vi/abc/mqdefault.jpg');
    expect(directImageUrl('http://localhost:8091/x.jpg?host=evil.example')).toBe(
      'http://localhost:8091/x.jpg?host=evil.example',
    );
    expect(ytThumbUrl('dQw4w9WgXcQ', 'hq720')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg');
  });
});
