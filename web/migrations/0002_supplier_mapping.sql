-- Supplier mappings are administrative records. Adding a mapping does not
-- submit an order, transfer customer data, or enable automatic purchasing.
CREATE TABLE IF NOT EXISTS supplier_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  variant_sku TEXT NOT NULL,
  supplier_platform TEXT NOT NULL CHECK (supplier_platform IN ('aliexpress', 'alibaba')),
  supplier_product_url TEXT NOT NULL,
  supplier_variant_sku TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (product_id, variant_sku, supplier_platform)
);
CREATE INDEX IF NOT EXISTS supplier_mappings_product ON supplier_mappings(product_id, variant_sku, active);
