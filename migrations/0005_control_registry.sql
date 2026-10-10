-- Control timeline fields, configurable intervals and optimistic locking.
ALTER TABLE actions
  ADD COLUMN control_basis text NOT NULL DEFAULT 'manual',
  ADD COLUMN manual_due_date date,
  ADD COLUMN source_event_type text,
  ADD COLUMN source_event_id uuid,
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE actions
  ADD CONSTRAINT actions_control_basis_valid
    CHECK (control_basis IN ('manual', 'shipment_sent', 'shipment_delivered', 'uk_payment')),
  ADD CONSTRAINT actions_version_positive CHECK (version > 0),
  ADD CONSTRAINT actions_source_event_consistency
    CHECK ((source_event_type IS NULL) = (source_event_id IS NULL));

ALTER TABLE control_settings
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE control_settings
  ADD CONSTRAINT control_settings_version_positive CHECK (version > 0);

CREATE INDEX actions_control_basis_idx ON actions (order_id, control_basis, status, updated_at DESC);
CREATE INDEX actions_source_event_idx ON actions (source_event_type, source_event_id)
  WHERE source_event_id IS NOT NULL;
