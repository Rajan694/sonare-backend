ALTER TABLE "user_settings" ALTER COLUMN "eq_preset" SET DEFAULT 'Sonare';--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "gapless" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "lyrics_overrides" DROP COLUMN "lrc";--> statement-breakpoint
ALTER TABLE "lyrics_overrides" DROP COLUMN "plain";