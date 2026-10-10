-- Registry fields for responsible assignment and server-side list filtering.
ALTER TABLE orders
  ADD COLUMN responsible_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX orders_responsible_idx ON orders (responsible_id, status);
CREATE INDEX orders_resolution_date_idx ON orders (resolution_date DESC NULLS LAST);
