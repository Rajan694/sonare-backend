ALTER TABLE "user_settings" ADD COLUMN "stream_quality" text DEFAULT 'high';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "download_format" text DEFAULT 'opus';--> statement-breakpoint
-- Until now download_quality doubled as the streaming quality, so carry it over.
-- YouTube has no lossless audio, so the old 'lossless' option becomes 'high'.
UPDATE "user_settings" SET "stream_quality" = CASE WHEN "download_quality" IN ('low', 'normal', 'high') THEN "download_quality" ELSE 'high' END;--> statement-breakpoint
UPDATE "user_settings" SET "download_quality" = 'high' WHERE "download_quality" IS NULL OR "download_quality" NOT IN ('low', 'normal', 'high');
