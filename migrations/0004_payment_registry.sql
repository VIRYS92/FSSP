-- Payment registry fields, optimistic locking, duplicate review and strict totals.
ALTER TABLE payment_transfers
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE payment_events
  ADD COLUMN payment_document text,
  ADD COLUMN note text,
  ADD COLUMN duplicate_override boolean NOT NULL DEFAULT false,
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE payment_transfers
  ADD CONSTRAINT payment_transfers_version_positive CHECK (version > 0);

ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_version_positive CHECK (version > 0),
  ADD CONSTRAINT payment_events_payment_document_not_blank
    CHECK (payment_document IS NULL OR char_length(btrim(payment_document)) > 0),
  ADD CONSTRAINT payment_events_note_not_blank
    CHECK (note IS NULL OR char_length(btrim(note)) > 0);

CREATE INDEX payment_transfers_date_idx ON payment_transfers (transfer_date DESC NULLS LAST);
CREATE INDEX payment_events_updated_idx ON payment_events (updated_at DESC);
CREATE INDEX payment_events_confirmation_idx ON payment_events (confirmation_status, enforcement_reconciled);
CREATE INDEX payment_events_unknown_id_idx ON payment_events (unknown_external_id) WHERE unknown_external_id IS NOT NULL;

CREATE OR REPLACE VIEW valid_payment_events AS
WITH eligible AS (
  SELECT
    pe.*,
    row_number() OVER (
      PARTITION BY pe.order_id, pe.stage, pe.source, pe.payment_date, pe.amount,
                   pe.period_start, pe.period_end
      ORDER BY pe.duplicate_override DESC, pe.updated_at ASC, pe.id
    ) AS duplicate_rank
  FROM payment_events pe
  JOIN orders o ON o.id = pe.order_id
  LEFT JOIN enforcement_proceedings p ON p.id = o.proceeding_id
  WHERE pe.order_id IS NOT NULL
    AND pe.confirmation_status = 'confirmed'
    AND pe.enforcement_reconciled = true
    AND pe.source = 'Этот работодатель'
    AND char_length(btrim(coalesce(p.proceeding_number, ''))) > 0
)
SELECT
  order_id,
  stage,
  count(*)::bigint AS payment_event_count,
  sum(amount)::numeric(18, 2) AS total_amount,
  min(payment_date) AS first_payment_date,
  max(payment_date) AS last_payment_date
FROM eligible
WHERE duplicate_rank = 1
GROUP BY order_id, stage;

CREATE OR REPLACE VIEW payment_rejections AS
SELECT
  pe.id,
  pe.public_code,
  pe.order_id,
  pe.unknown_external_id,
  pe.stage,
  pe.amount,
  pe.payment_date,
  concat_ws('; ',
    CASE WHEN pe.confirmation_status <> 'confirmed' THEN 'not_confirmed' END,
    CASE WHEN pe.enforcement_reconciled = false THEN 'not_reconciled' END,
    CASE WHEN pe.order_id IS NULL THEN 'unknown_order' END,
    CASE WHEN pe.source <> 'Этот работодатель' THEN 'source_not_employer' END,
    CASE WHEN pe.order_id IS NOT NULL AND char_length(btrim(coalesce(p.proceeding_number, ''))) = 0 THEN 'proceeding_number_missing' END,
    NULLIF(pe.rejection_reason, '')
  ) AS reason
FROM payment_events pe
LEFT JOIN orders o ON o.id = pe.order_id
LEFT JOIN enforcement_proceedings p ON p.id = o.proceeding_id
WHERE pe.confirmation_status <> 'confirmed'
   OR pe.enforcement_reconciled = false
   OR pe.order_id IS NULL
   OR pe.source <> 'Этот работодатель'
   OR (pe.order_id IS NOT NULL AND char_length(btrim(coalesce(p.proceeding_number, ''))) = 0);
