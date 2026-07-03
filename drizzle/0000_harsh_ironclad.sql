CREATE TYPE "public"."agent_status" AS ENUM('active', 'frozen');--> statement-breakpoint
CREATE TYPE "public"."dispute_state" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('topup', 'escrow_hold', 'escrow_release', 'escrow_refund', 'fee', 'withdrawal', 'override_payment');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'active', 'paused', 'delisted');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('created', 'escrowed', 'delivered', 'verifying', 'passed', 'failed', 'expired', 'appealed', 'settled_released', 'settled_refund', 'settled_override');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('PASS', 'FAIL');--> statement-breakpoint
CREATE TYPE "public"."verification_tier" AS ENUM('auto', 'panel', 'dispute');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"api_key_hash" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"reputation_score" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"opened_by" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "dispute_state" DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"ledger_account" text NOT NULL,
	"order_id" text,
	"amount" bigint NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"balancing_entry_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_versions" (
	"listing_id" text NOT NULL,
	"version" integer NOT NULL,
	"price_credits" bigint NOT NULL,
	"turnaround_seconds" integer NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_versions_listing_id_version_pk" PRIMARY KEY("listing_id","version")
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_agent_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_credits" bigint NOT NULL,
	"turnaround_seconds" integer NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"listing_version" integer NOT NULL,
	"buyer_agent_id" text NOT NULL,
	"state" "order_state" DEFAULT 'created' NOT NULL,
	"price_credits" bigint NOT NULL,
	"escrow_entry_id" text,
	"input_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"fail_window_ends_at" timestamp with time zone,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reputation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"order_id" text,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"judge_verdicts" jsonb NOT NULL,
	"aggregate_verdict" "verdict" NOT NULL,
	"aggregate_confidence" real NOT NULL,
	"tier" "verification_tier" NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_agents_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_agent_id_agents_id_fk" FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_api_key_hash_idx" ON "agents" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "agents_account_id_idx" ON "agents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "deliveries_order_id_idx" ON "deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "disputes_order_id_idx" ON "disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("ledger_account");--> statement-breakpoint
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "listings_seller_agent_id_idx" ON "listings" USING btree ("seller_agent_id");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_buyer_agent_id_idx" ON "orders" USING btree ("buyer_agent_id");--> statement-breakpoint
CREATE INDEX "orders_listing_id_idx" ON "orders" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "orders_state_idx" ON "orders" USING btree ("state");--> statement-breakpoint
CREATE INDEX "reputation_events_agent_id_idx" ON "reputation_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "verifications_order_id_idx" ON "verifications" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "webhooks_agent_id_idx" ON "webhooks" USING btree ("agent_id");