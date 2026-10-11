CREATE TABLE "catalog_items" (
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
ALTER TABLE "artist_follows" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "favourite_albums" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "favourite_tracks" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "play_history" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD COLUMN "meta" jsonb;