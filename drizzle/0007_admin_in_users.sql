ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp;--> statement-breakpoint
-- The admin login moves into users with role 'admin', signing in by email. It keeps its id and
-- token version, so an open admin session stays signed in. admin_users only ever had changes
-- made through the password form, so a version above 0 means updated_at is the password change.
INSERT INTO "users" ("id", "email", "password_hash", "display_name", "email_verified_at", "role",
                     "token_version", "last_login_at", "password_changed_at", "created_at")
SELECT "id", 'admin@sonare.dev', "password_hash", 'Admin', "created_at", 'admin',
       "token_version", "last_login_at", CASE WHEN "token_version" > 0 THEN "updated_at" END, "created_at"
FROM "admin_users"
ORDER BY "created_at"
LIMIT 1
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "admin_users" CASCADE;--> statement-breakpoint
-- The Piped settings live in .env files now (PIPED_API_URL here, sonare-piped-backend/.env).
DROP TABLE "system_configuration" CASCADE;
