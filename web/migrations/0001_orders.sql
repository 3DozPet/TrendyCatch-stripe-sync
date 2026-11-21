-- Initial order-storage foundation. Applied only after a database is provisioned.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  shipping_name TEXT,
  shipping_address_json TEXT,
  billing_address_json TEXT,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  payment_status TEXT NOT NULL,
  fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled' CHECK (fulfillment_status IN ('unfulfilled', 'fulfilled', 'cancelled')),
  tracking_number TEXT,
  tracking_carrier TEXT,
  tracking_url TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  stripe_line_id TEXT NOT NULL UNIQUE,
  product_id TEXT,
  title TEXT NOT NULL,
  variant TEXT,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_amount_minor INTEGER CHECK(unit_amount_minor >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS orders_created_at ON orders(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id, created_at);
