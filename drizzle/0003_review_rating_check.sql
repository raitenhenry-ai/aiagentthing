-- Custom SQL migration file, put your code below! --ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_no_self_review" CHECK ("reviewer_agent_id" <> "subject_agent_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_positive_amount" CHECK ("amount_credits" > 0);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_no_self_billing" CHECK ("seller_agent_id" <> "buyer_agent_id");
