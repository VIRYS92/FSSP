-- Shipment registry fields and database-level immutability after dispatch.
ALTER TABLE shipments
  ADD COLUMN shipment_type text,
  ADD COLUMN return_reason text;

ALTER TABLE shipments
  ADD CONSTRAINT shipments_type_not_blank
    CHECK (shipment_type IS NULL OR char_length(btrim(shipment_type)) > 0),
  ADD CONSTRAINT shipments_return_reason_not_blank
    CHECK (return_reason IS NULL OR char_length(btrim(return_reason)) > 0);

CREATE INDEX shipments_responsible_idx ON shipments (responsible_id, status);
CREATE INDEX shipments_updated_idx ON shipments (updated_at DESC);

CREATE OR REPLACE FUNCTION prevent_sent_shipment_item_mutations() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_sent_at timestamptz;
  new_sent_at timestamptz;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT sent_at INTO old_sent_at FROM shipments WHERE id = OLD.shipment_id;
    IF old_sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'sent shipment % cannot change composition', OLD.shipment_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT sent_at INTO new_sent_at FROM shipments WHERE id = NEW.shipment_id;
    IF new_sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'sent shipment % cannot change composition', NEW.shipment_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER shipment_items_prevent_sent_mutations
BEFORE INSERT OR UPDATE OR DELETE ON shipment_items
FOR EACH ROW EXECUTE FUNCTION prevent_sent_shipment_item_mutations();
