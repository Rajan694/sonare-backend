// GENERATED from sonare-frontend/shared/catalog/ids.ts by scripts/sync-shared-catalog.mjs (root repo).
// Do not edit here: change the frontend file and run the script again.

// ID helpers for YouTube catalog - port of backend/src/ids.ts
// Pure functions, no Node APIs.

export type SourceId = `yt:${string}` | `local:${string}` | `sonare:${string}`;

export class CatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogInputError';
  }
}

export const idHelpers = {
  prefixYt(id: string): `yt:${string}` {
    return `yt:${id}`;
  },

  prefixLocal(hash: string): `local:${string}` {
    return `local:${hash}`;
  },

  prefixSonare(uuid: string): `sonare:${string}` {
    return `sonare:${uuid}`;
  },

  extractYtId(fullId: string): string {
    if (!fullId.startsWith('yt:')) {
      throw new CatalogInputError(`Invalid yt ID: ${fullId}`);
    }
    return fullId.substring(3);
  },

  extractChannelIdFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/\/channel\/(UC[\w-]+)/);
    if (match) return match[1];
    return null;
  },

  /**
   * Artist id for a catalog item: `yt:<channelId>` only when the uploader URL names a real
   * channel. Without a channel, artist is empty (clients hide "Go to artist").
   */
  artistIdFromUrl(url: string | undefined | null): string {
    const channelId = idHelpers.extractChannelIdFromUrl(url ?? undefined);
    return channelId ? idHelpers.prefixYt(channelId) : '';
  },

  extractListIdFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  },
};
