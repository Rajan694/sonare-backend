import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { desc, eq, sql } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { catalogItems, playHistory, requestLogs } from '../../src/db/schema.js';
import { PLAY_HISTORY_MAX_PER_USER, prunePlayHistory } from '../../src/services/playHistory.js';
import { pruneCatalogItems } from '../../src/services/catalogMeta.js';
import { pruneRequestLogs, REQUEST_LOG_MAX_ROWS } from '../../src/services/telemetry.js';
import { createUser } from '../factories.js';

const playsOf = async (userId: string) =>
  db
    .select({ id: playHistory.trackRefId, at: playHistory.playedAt })
    .from(playHistory)
    .where(eq(playHistory.userId, userId))
    .orderBy(desc(playHistory.playedAt));

const insertPlays = async (userId: string, count: number, startAt: number) => {
  const rows = Array.from({ length: count }, (_, i) => ({
    userId,
    trackRefKind: 'server',
    trackRefId: `track${String(i).padStart(5, '0')}`,
    playedAt: new Date(startAt + i * 1000),
    msPlayed: 1000,
  }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(playHistory).values(rows.slice(i, i + 500));
};

describe('Storage caps', () => {
  beforeEach(async () => {
    await db.delete(catalogItems);
    await db.delete(requestLogs);
  });
  afterAll(async () => {
    await db.delete(catalogItems);
    await db.delete(requestLogs);
  });

  it('BE-CAP-001: prunePlayHistory keeps each user’s newest plays only', async () => {
    const a = await createUser();
    const b = await createUser();
    await insertPlays(a.user.id, 8, 1_700_000_000_000);
    await insertPlays(b.user.id, 3, 1_700_000_000_000);
    await prunePlayHistory(5);
    const left = await playsOf(a.user.id);
    expect(left.map((p) => p.id)).toEqual(['track00007', 'track00006', 'track00005', 'track00004', 'track00003']);
    expect(await playsOf(b.user.id)).toHaveLength(3);
  });

  it('BE-CAP-002: a sync that goes past 1000 plays drops that user’s oldest', async () => {
    expect(PLAY_HISTORY_MAX_PER_USER).toBe(1000);
    const { user, token } = await createUser();
    const start = Date.now() - 10 * 86_400_000;
    await insertPlays(user.id, 1000, start);
    const res = await request(createApp())
      .post('/api/v1/me/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({
        plays: [1, 2, 3].map((n) => ({
          trackRef: { kind: 'server', id: `fresh${n}` },
          at: Date.now() - n * 1000,
          ms: 40_000,
        })),
      });
    expect(res.status).toBe(200);
    const left = await playsOf(user.id);
    expect(left).toHaveLength(1000);
    expect(left.slice(0, 3).map((p) => p.id)).toEqual(['fresh1', 'fresh2', 'fresh3']);
    expect(left.some((p) => p.id === 'track00000' || p.id === 'track00002')).toBe(false);
    expect(left.some((p) => p.id === 'track00003')).toBe(true);
  });

  it('BE-CAP-003: pruneCatalogItems keeps the most recently written rows', async () => {
    await db.insert(catalogItems).values(
      Array.from({ length: 6 }, (_, i) => ({
        kind: i % 2 ? 'track' : 'album',
        id: `item${i}`,
        data: { n: i },
        updatedAt: new Date(1_700_000_000_000 + i * 60_000),
      })),
    );
    await pruneCatalogItems(4);
    const left = await db.select({ id: catalogItems.id }).from(catalogItems);
    expect(left.map((r) => r.id).sort()).toEqual(['item2', 'item3', 'item4', 'item5']);
  });

  it('BE-CAP-004: request logs are kept by count (the newest 2.1 million), not by age', async () => {
    expect(REQUEST_LOG_MAX_ROWS).toBe(2_100_000);
    const old = new Date(Date.now() - 365 * 86_400_000);
    await db
      .insert(requestLogs)
      .values(
        Array.from({ length: 7 }, (_, i) => ({ at: old, method: 'GET', route: `/r${i}`, status: 200, durationMs: 1 })),
      );
    await pruneRequestLogs(3);
    const left = await db.select({ route: requestLogs.route }).from(requestLogs).orderBy(requestLogs.id);
    expect(left.map((r) => r.route)).toEqual(['/r4', '/r5', '/r6']);

    // Under the cap nothing goes, however old.
    await pruneRequestLogs(10);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(requestLogs);
    expect(n).toBe(3);
  });
});
