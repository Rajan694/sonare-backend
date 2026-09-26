import { CachedPiped } from '../cache.js';
import { normalizeStreamToTrack } from '../normalize/index.js';
import { idHelpers } from '../ids.js';
import { UpstreamError } from '../upstream/piped.js';
import { getUserTrackDataMap, UserTrackFields } from './user-data.js';

export interface TrackRefInput {
  trackRefKind: string;
  trackRefId: string;
  addedAt?: number;
  favourite?: boolean;
  playCount?: number;
  lastPlayedAt?: number;
}

export interface HydrateOptions {
  /**
   * Fail the request when Piped is unreachable, instead of stubbing every server track.
   * History shelves want this: a list of "Unknown Title" rows reads as data, not an outage.
   * Favourites keep the stubs - mobile reads its heart state from them once, at sign-in.
   */
  failIfPipedDown?: boolean;
}

export async function hydrateTracks(
  userId: string | undefined,
  inputs: TrackRefInput[],
  { failIfPipedDown = false }: HydrateOptions = {}
) {
  const allIds = inputs.map(i => 
    i.trackRefKind === 'server' ? idHelpers.prefixYt(i.trackRefId) : idHelpers.prefixLocal(i.trackRefId)
  );
  const userDataMap = userId ? await getUserTrackDataMap(userId, allIds) : new Map<string, UserTrackFields>();

  const results = await Promise.all(inputs.map(async (input) => {
    const fullId = input.trackRefKind === 'server' 
      ? idHelpers.prefixYt(input.trackRefId) 
      : idHelpers.prefixLocal(input.trackRefId);

    const userFields = userDataMap.get(fullId) || {
      playCount: input.playCount ?? 0,
      favourite: input.favourite ?? false,
      addedAt: input.addedAt ?? Date.now(),
      lastPlayedAt: input.lastPlayedAt,
    };

    if (input.trackRefKind === 'server') {
      try {
        const streams = await CachedPiped.getStream(input.trackRefId);
        return normalizeStreamToTrack(streams, input.trackRefId, undefined, undefined, userFields);
      } catch (e) {
        if (failIfPipedDown && e instanceof UpstreamError && e.unreachable) throw e;
        // Degrade to safe stub when Piped is offline or metadata unavailable
        return {
          id: fullId,
          title: 'Unknown Title',
          artistId: idHelpers.prefixYt('unknown'),
          artist: 'Unknown Artist',
          albumId: null,
          album: null,
          durationMs: 0,
          source: 'server' as const,
          playCount: userFields.playCount,
          favourite: userFields.favourite,
          addedAt: userFields.addedAt,
          lastPlayedAt: userFields.lastPlayedAt,
          thumbnail: `/api/v1/tracks/${fullId}/artwork`,
        };
      }
    } else {
      return {
        id: fullId,
        title: 'Local Track',
        artistId: idHelpers.prefixLocal('unknown'),
        artist: 'Local Artist',
        albumId: null,
        album: null,
        durationMs: 0,
        source: 'local' as const,
        playCount: userFields.playCount,
        favourite: userFields.favourite,
        addedAt: userFields.addedAt,
        lastPlayedAt: userFields.lastPlayedAt,
      };
    }
  }));

  return results;
}
