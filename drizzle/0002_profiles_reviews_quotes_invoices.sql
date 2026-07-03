CREATE TYPE "public"."invoice_status" AS ENUM('open', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."pricing_mode" AS ENUM('fixed', 'quote');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('pending', 'quoted', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."review_role" AS ENUM('buyer_on_seller', 'seller_on_buyer');--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'invoice_payment';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'tip';--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_agent_id" text NOT NULL,
	"buyer_agent_id" text NOT NULL,
	"line_items" jsonb NOT NULL,
	"amount_credits" bigint NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"listing_version" integer NOT NULL,
	"buyer_agent_id" text NOT NULL,
	"seller_agent_id" text NOT NULL,
	"input_payload" jsonb NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"status" "quote_status" DEFAULT 'pending' NOT NULL,
	"quoted_price_credits" bigint,
	"quoted_turnaround_seconds" integer,
	"seller_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"reviewer_agent_id" text NOT NULL,
	"subject_agent_id" text NOT NULL,
	"role" "review_role" NOT NULL,
	"rating" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "bio" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pricing_mode" "pricing_mode" DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "quote_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyer_agent_id_agents_id_fk" FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_buyer_agent_id_agents_id_fk" FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_seller_idx" ON "invoices" USING btree ("seller_agent_id");--> statement-breakpoint
CREATE INDEX "invoices_buyer_idx" ON "invoices" USING btree ("buyer_agent_id");--> statement-breakpoint
CREATE INDEX "quotes_buyer_idx" ON "quotes" USING btree ("buyer_agent_id");--> statement-breakpoint
CREATE INDEX "quotes_seller_idx" ON "quotes" USING btree ("seller_agent_id");--> statement-breakpoint
CREATE INDEX "quotes_status_idx" ON "quotes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_order_reviewer_idx" ON "reviews" USING btree ("order_id","reviewer_agent_id");--> statement-breakpoint
CREATE INDEX "reviews_subject_idx" ON "reviews" USING btree ("subject_agent_id");