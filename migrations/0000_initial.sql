-- FSSP control: empty relational schema.
-- This migration defines structure and invariants only. It inserts no business data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE orders_public_number_seq AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
CREATE SEQUENCE shipments_public_number_seq AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
CREATE SEQUENCE payment_events_public_number_seq AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TYPE user_role AS ENUM ('admin', 'editor', 'viewer');
CREATE TYPE employer_status AS ENUM ('active', 'inactive', 'needs_review');
CREATE TYPE order_status AS ENUM ('draft', 'needs_review', 'active', 'completed', 'archived');
CREATE TYPE field_review_status AS ENUM ('missing', 'incomplete', 'unreadable', 'needs_review', 'verified');
CREATE TYPE shipment_status AS ENUM ('draft', 'sent', 'delivered', 'returned', 'archived');
CREATE TYPE payment_stage AS ENUM ('fssp', 'uk');
CREATE TYPE payment_confirmation_status AS ENUM ('unconfirmed', 'confirmed', 'rejected');
CREATE TYPE action_status AS ENUM ('open', 'in_progress', 'done', 'cancelled');
CREATE TYPE document_status AS ENUM ('active', 'quarantined', 'archived');
CREATE TYPE import_batch_status AS ENUM ('queued', 'processing', 'ready_for_review', 'committed', 'failed', 'cancelled');
CREATE TYPE import_file_status AS ENUM ('queued', 'processing', 'ready', 'failed');
CREATE TYPE import_item_decision AS ENUM ('pending', 'confirmed', 'excluded');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text NOT NULL,
  email text,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'viewer',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_login_not_blank CHECK (char_length(btrim(login)) > 0),
  CONSTRAINT users_display_name_not_blank CHECK (char_length(btrim(display_name)) > 0),
  CONSTRAINT users_password_hash_not_blank CHECK (char_length(password_hash) > 0)
);

CREATE UNIQUE INDEX users_login_lower_unique ON users (lower(login));
CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email)) WHERE email IS NOT NULL;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_sessions_token_hash_not_blank CHECK (char_length(token_hash) > 0),
  CONSTRAINT user_sessions_expiry_after_created CHECK (expires_at > created_at),
  CONSTRAINT user_sessions_revoked_after_created CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX user_sessions_token_hash_unique ON user_sessions (token_hash);
CREATE INDEX user_sessions_active_expiry_idx ON user_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE debtors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  date_of_birth date,
  address text,
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debtors_full_name_not_blank CHECK (char_length(btrim(full_name)) > 0),
  CONSTRAINT debtors_external_ids_object CHECK (jsonb_typeof(external_ids) = 'object')
);

CREATE INDEX debtors_full_name_idx ON debtors (lower(full_name));
CREATE TRIGGER debtors_set_updated_at BEFORE UPDATE ON debtors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tax_id text,
  address text,
  contacts jsonb NOT NULL DEFAULT '{}'::jsonb,
  status employer_status NOT NULL DEFAULT 'needs_review',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employers_name_not_blank CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT employers_contacts_object CHECK (jsonb_typeof(contacts) = 'object')
);

CREATE INDEX employers_name_idx ON employers (lower(name));
CREATE INDEX employers_tax_id_idx ON employers (tax_id) WHERE tax_id IS NOT NULL;
CREATE TRIGGER employers_set_updated_at BEFORE UPDATE ON employers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE enforcement_proceedings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proceeding_number text,
  proceeding_date date,
  enforcement_document text,
  authority text,
  case_reference text,
  source_identifiers jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enforcement_proceedings_source_identifiers_object CHECK (jsonb_typeof(source_identifiers) = 'object')
);

CREATE INDEX enforcement_proceedings_number_idx ON enforcement_proceedings (proceeding_number);
CREATE TRIGGER enforcement_proceedings_set_updated_at BEFORE UPDATE ON enforcement_proceedings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  mime_type text NOT NULL,
  original_filename text NOT NULL,
  status document_status NOT NULL DEFAULT 'active',
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_storage_key_not_blank CHECK (char_length(storage_key) > 0),
  CONSTRAINT documents_sha256_format CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT documents_byte_size_nonnegative CHECK (byte_size >= 0),
  CONSTRAINT documents_mime_type_not_blank CHECK (char_length(btrim(mime_type)) > 0),
  CONSTRAINT documents_original_filename_not_blank CHECK (char_length(btrim(original_filename)) > 0)
);

CREATE UNIQUE INDEX documents_storage_key_unique ON documents (storage_key);
CREATE INDEX documents_sha256_idx ON documents (sha256);
CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL DEFAULT ('П-' || lpad(nextval('orders_public_number_seq')::text, 4, '0')),
  debtor_id uuid NOT NULL REFERENCES debtors(id) ON DELETE RESTRICT,
  proceeding_id uuid REFERENCES enforcement_proceedings(id) ON DELETE RESTRICT,
  employer_id uuid REFERENCES employers(id) ON DELETE RESTRICT,
  employer_snapshot jsonb,
  resolution_number text,
  resolution_date date,
  withholding_percent numeric(5, 2),
  status order_status NOT NULL DEFAULT 'draft',
  manual_effective_date date,
  archived_at timestamptz,
  archived_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_public_code_format CHECK (public_code ~ '^П-[0-9]+$'),
  CONSTRAINT orders_employer_snapshot_object CHECK (employer_snapshot IS NULL OR jsonb_typeof(employer_snapshot) = 'object'),
  CONSTRAINT orders_withholding_percent_range CHECK (withholding_percent IS NULL OR (withholding_percent >= 0 AND withholding_percent <= 100)),
  CONSTRAINT orders_version_positive CHECK (version > 0),
  CONSTRAINT orders_archive_consistency CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX orders_public_code_unique ON orders (public_code);
CREATE INDEX orders_debtor_idx ON orders (debtor_id);
CREATE INDEX orders_proceeding_idx ON orders (proceeding_id);
CREATE INDEX orders_employer_idx ON orders (employer_id);
CREATE INDEX orders_status_idx ON orders (status);
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_field_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  status field_review_status NOT NULL,
  extracted_value jsonb,
  manual_value jsonb,
  source_page_start integer,
  source_page_end integer,
  source_excerpt text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_field_reviews_field_key_not_blank CHECK (char_length(btrim(field_key)) > 0),
  CONSTRAINT order_field_reviews_pages_valid CHECK (source_page_start IS NULL OR (source_page_start > 0 AND (source_page_end IS NULL OR source_page_end >= source_page_start)))
);

CREATE INDEX order_field_reviews_order_idx ON order_field_reviews (order_id, field_key, created_at DESC);
CREATE INDEX order_field_reviews_status_idx ON order_field_reviews (status);
CREATE TRIGGER order_field_reviews_set_updated_at BEFORE UPDATE ON order_field_reviews
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL DEFAULT ('К-' || lpad(nextval('shipments_public_number_seq')::text, 4, '0')),
  recipient_name text,
  recipient_address text,
  composition text,
  tracking_number text,
  status shipment_status NOT NULL DEFAULT 'draft',
  sent_at timestamptz,
  delivered_at timestamptz,
  returned_at timestamptz,
  responsible_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipments_public_code_format CHECK (public_code ~ '^К-[0-9]+$'),
  CONSTRAINT shipments_version_positive CHECK (version > 0),
  CONSTRAINT shipments_delivered_after_sent CHECK (delivered_at IS NULL OR sent_at IS NOT NULL),
  CONSTRAINT shipments_returned_after_sent CHECK (returned_at IS NULL OR sent_at IS NOT NULL),
  CONSTRAINT shipments_delivered_returned_order CHECK (delivered_at IS NULL OR returned_at IS NULL OR returned_at >= delivered_at)
);

CREATE UNIQUE INDEX shipments_public_code_unique ON shipments (public_code);
CREATE INDEX shipments_sent_at_idx ON shipments (sent_at DESC NULLS LAST);
CREATE INDEX shipments_status_idx ON shipments (status);
CREATE TRIGGER shipments_set_updated_at BEFORE UPDATE ON shipments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE shipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  item_position integer NOT NULL,
  order_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_items_position_positive CHECK (item_position > 0),
  CONSTRAINT shipment_items_snapshot_object CHECK (jsonb_typeof(order_snapshot) = 'object'),
  CONSTRAINT shipment_items_position_unique UNIQUE (shipment_id, item_position),
  CONSTRAINT shipment_items_shipment_order_unique UNIQUE (shipment_id, order_id)
);

CREATE INDEX shipment_items_order_idx ON shipment_items (order_id);

CREATE TABLE order_shipment_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  reason text,
  selected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_shipment_preferences_pair_fk FOREIGN KEY (shipment_id, order_id)
    REFERENCES shipment_items (shipment_id, order_id) ON DELETE RESTRICT,
  CONSTRAINT order_shipment_preferences_order_unique UNIQUE (order_id)
);

CREATE INDEX order_shipment_preferences_shipment_idx ON order_shipment_preferences (shipment_id);
CREATE TRIGGER order_shipment_preferences_set_updated_at BEFORE UPDATE ON order_shipment_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_reference text,
  transfer_date date,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_transfers_external_reference_unique
  ON payment_transfers (external_reference) WHERE external_reference IS NOT NULL;
CREATE TRIGGER payment_transfers_set_updated_at BEFORE UPDATE ON payment_transfers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL DEFAULT ('С-' || lpad(nextval('payment_events_public_number_seq')::text, 4, '0')),
  order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  unknown_external_id text,
  transfer_id uuid REFERENCES payment_transfers(id) ON DELETE SET NULL,
  stage payment_stage NOT NULL,
  source text NOT NULL,
  payment_date date NOT NULL,
  amount numeric(18, 2) NOT NULL,
  confirmation_status payment_confirmation_status NOT NULL DEFAULT 'unconfirmed',
  enforcement_reconciled boolean NOT NULL DEFAULT false,
  period_start date,
  period_end date,
  rejection_reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_public_code_format CHECK (public_code ~ '^С-[0-9]+$'),
  CONSTRAINT payment_events_exact_target CHECK ((order_id IS NOT NULL) <> (unknown_external_id IS NOT NULL)),
  CONSTRAINT payment_events_unknown_id_not_blank CHECK (unknown_external_id IS NULL OR char_length(btrim(unknown_external_id)) > 0),
  CONSTRAINT payment_events_source_not_blank CHECK (char_length(btrim(source)) > 0),
  CONSTRAINT payment_events_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT payment_events_period_valid CHECK (period_start IS NULL OR (period_end IS NULL OR period_end >= period_start)),
  CONSTRAINT payment_events_rejection_reason_required CHECK (confirmation_status <> 'rejected' OR char_length(btrim(coalesce(rejection_reason, ''))) > 0)
);

CREATE UNIQUE INDEX payment_events_public_code_unique ON payment_events (public_code);
CREATE INDEX payment_events_order_stage_idx ON payment_events (order_id, stage, payment_date);
CREATE INDEX payment_events_transfer_idx ON payment_events (transfer_id);
CREATE TRIGGER payment_events_set_updated_at BEFORE UPDATE ON payment_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  due_date date,
  status action_status NOT NULL DEFAULT 'open',
  result text,
  completed_at timestamptz,
  reminder_sent_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_title_not_blank CHECK (char_length(btrim(title)) > 0),
  CONSTRAINT actions_completion_consistency CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

CREATE INDEX actions_order_idx ON actions (order_id);
CREATE INDEX actions_due_idx ON actions (due_date, status) WHERE status IN ('open', 'in_progress');
CREATE TRIGGER actions_set_updated_at BEFORE UPDATE ON actions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status import_batch_status NOT NULL DEFAULT 'queued',
  parser_version text NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batches_parser_version_not_blank CHECK (char_length(btrim(parser_version)) > 0),
  CONSTRAINT import_batches_confirmation_consistency CHECK ((status = 'committed') = (confirmed_at IS NOT NULL))
);

CREATE INDEX import_batches_status_idx ON import_batches (status, created_at);
CREATE TRIGGER import_batches_set_updated_at BEFORE UPDATE ON import_batches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE import_batch_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  checksum text NOT NULL,
  page_count integer,
  status import_file_status NOT NULL DEFAULT 'queued',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batch_files_checksum_format CHECK (checksum ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT import_batch_files_page_count_positive CHECK (page_count IS NULL OR page_count > 0),
  CONSTRAINT import_batch_files_error_consistency CHECK (status <> 'failed' OR char_length(btrim(coalesce(error_message, ''))) > 0)
);

CREATE UNIQUE INDEX import_batch_files_checksum_unique ON import_batch_files (batch_id, checksum);
CREATE INDEX import_batch_files_batch_idx ON import_batch_files (batch_id, status);
CREATE TRIGGER import_batch_files_set_updated_at BEFORE UPDATE ON import_batch_files
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_file_id uuid NOT NULL REFERENCES import_batch_files(id) ON DELETE CASCADE,
  page_start integer NOT NULL,
  page_end integer NOT NULL,
  raw_text text,
  extracted_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  manual_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_state text NOT NULL DEFAULT 'unknown',
  decision import_item_decision NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_items_page_range_valid CHECK (page_start > 0 AND page_end >= page_start),
  CONSTRAINT import_items_extracted_object CHECK (jsonb_typeof(extracted_data) = 'object'),
  CONSTRAINT import_items_manual_object CHECK (jsonb_typeof(manual_data) = 'object'),
  CONSTRAINT import_items_warnings_array CHECK (jsonb_typeof(warnings) = 'array'),
  CONSTRAINT import_items_duplicate_state_not_blank CHECK (char_length(btrim(duplicate_state)) > 0),
  CONSTRAINT import_items_file_pages_valid CHECK (page_end IS NOT NULL)
);

CREATE INDEX import_items_file_idx ON import_items (batch_file_id, page_start);
CREATE INDEX import_items_decision_idx ON import_items (decision);
CREATE TRIGGER import_items_set_updated_at BEFORE UPDATE ON import_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE control_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timezone text NOT NULL DEFAULT 'Asia/Yekaterinburg',
  after_sent_days integer NOT NULL DEFAULT 7,
  after_delivered_days integer NOT NULL DEFAULT 30,
  after_uk_check_days integer NOT NULL DEFAULT 30,
  reminder_before_days integer NOT NULL DEFAULT 3,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_settings_timezone_not_blank CHECK (char_length(btrim(timezone)) > 0),
  CONSTRAINT control_settings_after_sent_positive CHECK (after_sent_days > 0),
  CONSTRAINT control_settings_after_delivered_positive CHECK (after_delivered_days > 0),
  CONSTRAINT control_settings_after_uk_check_positive CHECK (after_uk_check_days > 0),
  CONSTRAINT control_settings_reminder_nonnegative CHECK (reminder_before_days >= 0)
);

CREATE INDEX control_settings_effective_idx ON control_settings (effective_from DESC);
CREATE TRIGGER control_settings_set_updated_at BEFORE UPDATE ON control_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  entity_type text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  request_id text,
  CONSTRAINT audit_log_entity_type_not_blank CHECK (char_length(btrim(entity_type)) > 0),
  CONSTRAINT audit_log_action_not_blank CHECK (char_length(btrim(action)) > 0)
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, occurred_at DESC);

CREATE TABLE order_documents (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  attached_by uuid REFERENCES users(id) ON DELETE SET NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, document_id),
  CONSTRAINT order_documents_type_not_blank CHECK (char_length(btrim(document_type)) > 0)
);

CREATE TABLE shipment_documents (
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  attached_by uuid REFERENCES users(id) ON DELETE SET NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shipment_id, document_id),
  CONSTRAINT shipment_documents_type_not_blank CHECK (char_length(btrim(document_type)) > 0)
);

CREATE TABLE payment_documents (
  payment_event_id uuid NOT NULL REFERENCES payment_events(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  attached_by uuid REFERENCES users(id) ON DELETE SET NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_event_id, document_id),
  CONSTRAINT payment_documents_type_not_blank CHECK (char_length(btrim(document_type)) > 0)
);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_chunks_page_positive CHECK (page_number > 0),
  CONSTRAINT document_chunks_index_nonnegative CHECK (chunk_index >= 0),
  CONSTRAINT document_chunks_content_not_blank CHECK (char_length(btrim(content)) > 0),
  CONSTRAINT document_chunks_position_unique UNIQUE (document_id, page_number, chunk_index)
);

CREATE INDEX document_chunks_document_idx ON document_chunks (document_id, page_number, chunk_index);
CREATE INDEX document_chunks_search_idx ON document_chunks USING gin (search_vector);

CREATE OR REPLACE FUNCTION prevent_sent_shipment_edits() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sent_at IS NOT NULL AND (
    NEW.recipient_name IS DISTINCT FROM OLD.recipient_name OR
    NEW.recipient_address IS DISTINCT FROM OLD.recipient_address OR
    NEW.composition IS DISTINCT FROM OLD.composition
  ) THEN
    RAISE EXCEPTION 'sent shipment % cannot change recipient or composition', OLD.public_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shipments_prevent_sent_edits BEFORE UPDATE ON shipments
FOR EACH ROW EXECUTE FUNCTION prevent_sent_shipment_edits();

CREATE VIEW valid_payment_events AS
SELECT
  pe.order_id,
  pe.stage,
  count(*)::bigint AS payment_event_count,
  sum(pe.amount)::numeric(18, 2) AS total_amount,
  min(pe.payment_date) AS first_payment_date,
  max(pe.payment_date) AS last_payment_date
FROM payment_events pe
WHERE pe.order_id IS NOT NULL
  AND pe.confirmation_status = 'confirmed'
  AND pe.enforcement_reconciled = true
GROUP BY pe.order_id, pe.stage;

CREATE VIEW payment_totals_fssp AS
SELECT order_id, total_amount, payment_event_count, first_payment_date, last_payment_date
FROM valid_payment_events
WHERE stage = 'fssp';

CREATE VIEW payment_totals_uk AS
SELECT order_id, total_amount, payment_event_count, first_payment_date, last_payment_date
FROM valid_payment_events
WHERE stage = 'uk';

CREATE VIEW payment_rejections AS
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
    NULLIF(pe.rejection_reason, '')
  ) AS reason
FROM payment_events pe
WHERE pe.confirmation_status <> 'confirmed'
   OR pe.enforcement_reconciled = false
   OR pe.order_id IS NULL;

CREATE VIEW current_shipments AS
WITH sent_items AS (
  SELECT DISTINCT
    si.order_id,
    s.id AS shipment_id,
    s.public_code,
    s.sent_at,
    s.delivered_at,
    s.returned_at,
    s.status
  FROM shipment_items si
  JOIN shipments s ON s.id = si.shipment_id
  WHERE s.sent_at IS NOT NULL
), latest_dates AS (
  SELECT order_id, max(sent_at) AS latest_sent_at
  FROM sent_items
  GROUP BY order_id
), latest_candidates AS (
  SELECT si.*
  FROM sent_items si
  JOIN latest_dates ld ON ld.order_id = si.order_id AND ld.latest_sent_at = si.sent_at
)
SELECT
  order_id,
  CASE WHEN count(*) = 1 THEN (array_agg(shipment_id ORDER BY shipment_id))[1] ELSE NULL END AS shipment_id,
  CASE WHEN count(*) = 1 THEN min(public_code) ELSE NULL END AS public_code,
  max(sent_at) AS sent_at,
  CASE WHEN count(*) = 1 THEN min(delivered_at) ELSE NULL END AS delivered_at,
  CASE WHEN count(*) = 1 THEN min(returned_at) ELSE NULL END AS returned_at,
  CASE WHEN count(*) = 1 THEN min(status::text) ELSE 'ambiguous' END AS selection_status
FROM latest_candidates
GROUP BY order_id;
