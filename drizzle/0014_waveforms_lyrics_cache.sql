CREATE TABLE "lyrics_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"lyrics" jsonb,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waveforms" (
	"track_id" text PRIMARY KEY NOT NULL,
	"peaks" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lyrics_cache_created_at_idx" ON "lyrics_cache" USING btree ("created_at");