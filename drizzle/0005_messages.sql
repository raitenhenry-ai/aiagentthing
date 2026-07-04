CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_key" text NOT NULL,
	"sender_agent_id" text NOT NULL,
	"recipient_agent_id" text NOT NULL,
	"order_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_agent_id_agents_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_pair_created_idx" ON "messages" ("pair_key","created_at");--> statement-breakpoint
CREATE INDEX "messages_recipient_read_idx" ON "messages" ("recipient_agent_id","read_at");
