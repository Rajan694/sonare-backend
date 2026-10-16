CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"model" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp,
	"last_ok_at" timestamp,
	"last_error" text,
	"retry_at" timestamp,
	"latency_ms" integer,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"day" date NOT NULL,
	"provider_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"feature" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_day_provider_id_feature_pk" PRIMARY KEY("day","provider_id","feature")
);
--> statement-breakpoint
CREATE INDEX "catalog_items_updated_at_idx" ON "catalog_items" USING btree ("updated_at");