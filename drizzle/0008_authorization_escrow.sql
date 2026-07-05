ALTER TABLE "orders" ADD COLUMN "settlement_mode" text DEFAULT 'custodial' NOT NULL;
--> statement-breakpoint
CREATE TABLE "payment_authorizations" (
	"order_id" text PRIMARY KEY NOT NULL,
	"header_hash" text NOT NULL,
	"payment_header" text NOT NULL,
	"requirements" jsonb NOT NULL,
	"payer_wallet" text NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD CONSTRAINT "payment_authorizations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_auth_header_idx" ON "payment_authorizations" ("header_hash");
