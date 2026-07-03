-- Ledger integrity constraints (see docs/DESIGN.md).

-- Every entry is one half of a pair; the pair is cross-linked. Deferrable so
-- both rows of a pair can be inserted in a single statement/transaction.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_balancing_fk"
  FOREIGN KEY ("balancing_entry_id") REFERENCES "ledger_entries"("id")
  DEFERRABLE INITIALLY DEFERRED;

-- A zero-amount movement is meaningless and would break pair invariants.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("amount" <> 0);

-- Exactly one settlement per order, enforced at the database layer: at most
-- one escrow-outflow (negative platform:escrow side) settlement entry may
-- exist per order. The fee pair shares the settlement but has its own type.
CREATE UNIQUE INDEX "ledger_entries_one_settlement_per_order_idx"
  ON "ledger_entries" ("order_id")
  WHERE "entry_type" IN ('escrow_release', 'escrow_refund', 'override_payment')
    AND "amount" < 0;

-- At most one escrow hold per order.
CREATE UNIQUE INDEX "ledger_entries_one_hold_per_order_idx"
  ON "ledger_entries" ("order_id")
  WHERE "entry_type" = 'escrow_hold' AND "amount" < 0;