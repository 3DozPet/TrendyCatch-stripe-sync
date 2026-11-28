-- Extends the order lifecycle beyond unfulfilled/fulfilled/cancelled so the
-- admin dashboard can show Delivered and a Returns/Refund track without
-- touching the existing fulfillment_status column (and its CHECK
-- constraint, which SQLite can't alter in place without rebuilding the
-- table). All three columns are additive and nullable, so this is a plain
-- ALTER TABLE ADD COLUMN — safe to run on a live table with existing rows.
--
-- delivered_at: set by the admin dashboard when a fulfilled/shipped order is
--   marked delivered. NULL until then.
-- return_status: one of 'requested', 'received', 'refunded', or NULL (no
--   return in progress). Validated in application code rather than a CHECK
--   constraint, consistent with how this project validates writes.
-- return_updated_at: timestamp of the last return_status change, for the
--   order-detail timeline.
ALTER TABLE orders ADD COLUMN delivered_at TEXT;
ALTER TABLE orders ADD COLUMN return_status TEXT;
ALTER TABLE orders ADD COLUMN return_updated_at TEXT;
