ALTER TABLE "playlist_tracks" ADD COLUMN "added_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
-- Songs already in a playlist get the playlist's creation time, not the time of this migration.
UPDATE "playlist_tracks" pt SET "added_at" = p."created_at" FROM "playlists" p WHERE p."id" = pt."playlist_id";
