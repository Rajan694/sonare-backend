CREATE TABLE "artist_follows" (
	"user_id" uuid NOT NULL,
	"artist_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artist_follows_user_id_artist_id_pk" PRIMARY KEY("user_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "favourite_albums" (
	"user_id" uuid NOT NULL,
	"album_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "favourite_albums_user_id_album_id_pk" PRIMARY KEY("user_id","album_id")
);
--> statement-breakpoint
CREATE TABLE "favourite_tracks" (
	"user_id" uuid NOT NULL,
	"track_ref_kind" text NOT NULL,
	"track_ref_id" text NOT NULL,
	"matched_server_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "favourite_tracks_user_id_track_ref_kind_track_ref_id_pk" PRIMARY KEY("user_id","track_ref_kind","track_ref_id")
);
--> statement-breakpoint
CREATE TABLE "lyrics_overrides" (
	"user_id" uuid NOT NULL,
	"track_id" text NOT NULL,
	"lrc" text,
	"plain" text,
	"offset_ms" integer DEFAULT 0,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lyrics_overrides_user_id_track_id_pk" PRIMARY KEY("user_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "play_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"track_ref_kind" text NOT NULL,
	"track_ref_id" text NOT NULL,
	"matched_server_id" text,
	"played_at" timestamp NOT NULL,
	"ms_played" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"track_ref_kind" text,
	"track_ref_id" text,
	"position_ms" integer DEFAULT 0,
	"queue" jsonb DEFAULT '[]'::jsonb,
	"index" integer DEFAULT 0,
	"shuffle" boolean DEFAULT false,
	"repeat" text DEFAULT 'off',
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" text NOT NULL,
	"position" integer NOT NULL,
	"track_ref_kind" text NOT NULL,
	"track_ref_id" text NOT NULL,
	"matched_server_id" text
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"eq_preset" text DEFAULT 'Flat',
	"gapless" boolean DEFAULT false,
	"normalization" boolean DEFAULT true,
	"download_quality" text DEFAULT 'high',
	"stay_offline" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "artist_follows" ADD CONSTRAINT "artist_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourite_albums" ADD CONSTRAINT "favourite_albums_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourite_tracks" ADD CONSTRAINT "favourite_tracks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics_overrides" ADD CONSTRAINT "lyrics_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_history" ADD CONSTRAINT "play_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_state" ADD CONSTRAINT "player_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "play_history_user_played_at_idx" ON "play_history" USING btree ("user_id","played_at");--> statement-breakpoint
CREATE INDEX "play_history_user_track_ref_idx" ON "play_history" USING btree ("user_id","track_ref_kind","track_ref_id");--> statement-breakpoint
CREATE INDEX "playlist_tracks_playlist_position_idx" ON "playlist_tracks" USING btree ("playlist_id","position");