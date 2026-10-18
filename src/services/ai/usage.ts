import { sql as sqlExpr } from 'drizzle-orm';
import { db, sql } from '../../db/index.js';
import { aiUsageDaily } from '../../db/schema.js';
import { logger } from '../../logger.js';

// AI calls and tokens per UTC day, provider and feature (one small row each), for the admin
// analytics. Health checks count too: they use the same free quota.

export const AI_FEATURES = ['you-may-like', 'search', 'playlist', 'titles', 'health'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export interface AiUsageEntry {
  providerId: string;
  providerName: string;
  feature: AiFeature;
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
}

const tokens = (n: number | undefined): number =>
  Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0;

/** Adds one call. Never throws: losing a count must not fail the call it counts. */
export const recordAiUsage = async (entry: AiUsageEntry, now = new Date()): Promise<void> => {
  const promptTokens = tokens(entry.promptTokens);
  const completionTokens = tokens(entry.completionTokens);
  const failures = entry.ok ? 0 : 1;
  try {
    await db
      .insert(aiUsageDaily)
      .values({
        day: now.toISOString().slice(0, 10),
        providerId: entry.providerId,
        providerName: entry.providerName,
        feature: entry.feature,
        calls: 1,
        failures,
        promptTokens,
        completionTokens,
      })
      .onConflictDoUpdate({
        target: [aiUsageDaily.day, aiUsageDaily.providerId, aiUsageDaily.feature],
        set: {
          providerName: entry.providerName,
          calls: sqlExpr`${aiUsageDaily.calls} + 1`,
          failures: sqlExpr`${aiUsageDaily.failures} + ${failures}`,
          promptTokens: sqlExpr`${aiUsageDaily.promptTokens} + ${promptTokens}`,
          completionTokens: sqlExpr`${aiUsageDaily.completionTokens} + ${completionTokens}`,
        },
      });
  } catch (err) {
    logger.warn({ err }, 'AI: could not record usage');
  }
};

interface Totals {
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
}

const totals = (row: Record<string, unknown>): Totals => ({
  calls: Number(row.calls ?? 0),
  failures: Number(row.failures ?? 0),
  promptTokens: Number(row.prompt_tokens ?? 0),
  completionTokens: Number(row.completion_tokens ?? 0),
});

/** The last `days` UTC days, today included (GET /admin/analytics/ai). */
export const aiUsageReport = async (days: number) => {
  const since = sql`((now() AT TIME ZONE 'UTC')::date - ${days - 1}::int)`;
  const sums = sql`sum(calls)::int AS calls, sum(failures)::int AS failures,
    sum(prompt_tokens)::float8 AS prompt_tokens, sum(completion_tokens)::float8 AS completion_tokens`;

  const [all] = await sql`SELECT ${sums} FROM ai_usage_daily WHERE day >= ${since}`;
  const byProvider = await sql`
    SELECT provider_id, (array_agg(provider_name ORDER BY day DESC))[1] AS name, ${sums}
    FROM ai_usage_daily WHERE day >= ${since}
    GROUP BY provider_id
    ORDER BY sum(prompt_tokens + completion_tokens) DESC, sum(calls) DESC
  `;
  const byFeature = await sql`
    SELECT feature, ${sums} FROM ai_usage_daily WHERE day >= ${since}
    GROUP BY feature ORDER BY sum(prompt_tokens + completion_tokens) DESC, sum(calls) DESC
  `;
  const series = await sql`
    WITH days AS (
      SELECT generate_series(${since}, (now() AT TIME ZONE 'UTC')::date, interval '1 day')::date AS day
    )
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
           coalesce(sum(u.calls), 0)::int AS calls,
           coalesce(sum(u.failures), 0)::int AS failures,
           coalesce(sum(u.prompt_tokens), 0)::float8 AS prompt_tokens,
           coalesce(sum(u.completion_tokens), 0)::float8 AS completion_tokens
    FROM days LEFT JOIN ai_usage_daily u ON u.day = days.day
    GROUP BY days.day ORDER BY days.day
  `;

  return {
    days,
    totals: totals(all ?? {}),
    byProvider: byProvider.map((r) => ({ providerId: String(r.provider_id), name: String(r.name), ...totals(r) })),
    byFeature: byFeature.map((r) => ({ feature: String(r.feature) as AiFeature, ...totals(r) })),
    series: series.map((r) => ({ day: String(r.day), ...totals(r) })),
  };
};
