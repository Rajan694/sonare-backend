export type SourceId = `yt:${string}` | `local:${string}` | `sonare:${string}`;

import { BadRequestError } from './errors.js';

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
    if (!fullId.startsWith('yt:')) throw new BadRequestError(`Invalid yt ID: ${fullId}`);
    return fullId.substring(3);
  },

  extractChannelIdFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/\/channel\/(UC[\w-]+)/);
    if (match) return match[1];
    return null;
  },

  extractListIdFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  }
};
