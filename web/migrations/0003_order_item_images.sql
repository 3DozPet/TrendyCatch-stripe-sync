-- Adds a small product-thumbnail column to order_items so the admin
-- dashboard can show a product picture next to each order line item.
-- Nullable: older rows (and any product with no image set in Stripe) simply
-- render with no thumbnail. Backfilled opportunistically for existing rows
-- whenever recordOrderHistory() sees that session again (e.g. a repeat
-- Sync from Stripe click) — see _lib/stripe-orders.ts.
ALTER TABLE order_items ADD COLUMN image_url TEXT;
