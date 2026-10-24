-- activity_daily: one row per (local-timezone day, actor, client), for DAU/WAU/MAU.
-- actor = user id when signed in, else the install id.
-- install = the install id paired with a signed-in request (lets us exclude guests who also signed in).
CREATE TABLE "activity_daily" (
  "day"     date    NOT NULL,
  "actor"   text    NOT NULL,
  "kind"    text    NOT NULL,
  "client"  text    NOT NULL,
  "install" text,
  CONSTRAINT "activity_daily_day_actor_client_pk" PRIMARY KEY ("day", "actor", "client")
);--> statement-breakpoint
CREATE INDEX "activity_daily_day_idx" ON "activity_daily" ("day");--> statement-breakpoint

-- api_usage_hourly: request counts, status classes, latency and histogram per endpoint per UTC hour.
-- hist[9]: upper bounds 25, 50, 100, 250, 500, 1000, 2500, 5000 ms and one open-ended bucket.
CREATE TABLE "api_usage_hourly" (
  "hour"       timestamp   NOT NULL,
  "method"     text        NOT NULL,
  "route"      text        NOT NULL,
  "count"      integer     NOT NULL DEFAULT 0,
  "s2xx"       integer     NOT NULL DEFAULT 0,
  "s3xx"       integer     NOT NULL DEFAULT 0,
  "s4xx"       integer     NOT NULL DEFAULT 0,
  "s5xx"       integer     NOT NULL DEFAULT 0,
  "total_ms"   bigint      NOT NULL DEFAULT 0,
  "max_ms"     integer     NOT NULL DEFAULT 0,
  "hist"       integer[]   NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0}',
  CONSTRAINT "api_usage_hourly_hour_method_route_pk" PRIMARY KEY ("hour", "method", "route")
);--> statement-breakpoint
CREATE INDEX "api_usage_hourly_hour_idx" ON "api_usage_hourly" ("hour");--> statement-breakpoint

-- signup_client: the X-Sonare-Client sent with the register request.
ALTER TABLE "users" ADD COLUMN "signup_client" text;--> statement-breakpoint

-- Backfill activity_daily from request_logs (signed-in requests only, one row per day/user/client).
INSERT INTO "activity_daily" ("day", "actor", "kind", "client")
SELECT
  ((at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS day,
  user_id::text AS actor,
  'user' AS kind,
  coalesce(client, 'other') AS client
FROM request_logs
WHERE user_id IS NOT NULL
GROUP BY 1, 2, 3, 4
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Backfill api_usage_hourly from request_logs.
INSERT INTO "api_usage_hourly" (
  "hour", "method", "route", "count",
  "s2xx", "s3xx", "s4xx", "s5xx",
  "total_ms", "max_ms", "hist"
)
SELECT
  date_trunc('hour', at) AS hour,
  method,
  route,
  count(*)::int,
  count(*) FILTER (WHERE status >= 200 AND status < 300)::int,
  count(*) FILTER (WHERE status >= 300 AND status < 400)::int,
  count(*) FILTER (WHERE status >= 400 AND status < 500)::int,
  count(*) FILTER (WHERE status >= 500)::int,
  coalesce(sum(duration_ms), 0)::bigint,
  coalesce(max(duration_ms), 0)::int,
  ARRAY[
    count(*) FILTER (WHERE duration_ms <=   25)::int,
    count(*) FILTER (WHERE duration_ms >    25 AND duration_ms <=   50)::int,
    count(*) FILTER (WHERE duration_ms >    50 AND duration_ms <=  100)::int,
    count(*) FILTER (WHERE duration_ms >   100 AND duration_ms <=  250)::int,
    count(*) FILTER (WHERE duration_ms >   250 AND duration_ms <=  500)::int,
    count(*) FILTER (WHERE duration_ms >   500 AND duration_ms <= 1000)::int,
    count(*) FILTER (WHERE duration_ms >  1000 AND duration_ms <= 2500)::int,
    count(*) FILTER (WHERE duration_ms >  2500 AND duration_ms <= 5000)::int,
    count(*) FILTER (WHERE duration_ms >  5000)::int
  ]
FROM request_logs
GROUP BY 1, 2, 3
ON CONFLICT DO NOTHING;--> statement-breakpoint

DROP TABLE "request_logs";
