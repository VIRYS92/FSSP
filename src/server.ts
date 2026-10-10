import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import ExcelJS from "exceljs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeLogin,
  readSessionToken,
  requireAuth,
  requireRole,
  setSessionCookie,
  type AuthUser,
  type UserRole,
  validatePassword,
  verifyPassword,
} from "./auth.js";
import { DocumentStorage, sanitizeFilename } from "./storage.js";
import { parsePdfPreview, PDF_PARSER_VERSION, type PdfPreview } from "./import/pdf.js";
import { normalizeSearchMode, normalizeSearchText, searchPredicate, type SearchMode } from "./search.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const databaseRequired = process.env.DB_REQUIRED === "true";
const maxUploadBytes = Number(process.env.DOCUMENT_MAX_BYTES ?? 25 * 1024 * 1024);
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const app = Fastify({
  logger: process.env.NODE_ENV !== "test",
  bodyLimit: maxUploadBytes + 1024 * 1024,
});
app.addHook("onSend", async (request, reply) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), geolocation=(), microphone=()");
  reply.header("content-security-policy", "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
});
const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const documentStorage = new DocumentStorage(
  process.env.DOCUMENTS_ROOT ?? path.resolve(process.cwd(), "var/documents"),
);

type JsonObject = Record<string, unknown>;

type UserRow = {
  id: string;
  login: string;
  email: string | null;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  password_hash?: string;
};

type DocumentRow = {
  id: string;
  storage_key: string;
  sha256: string;
  byte_size: string | number;
  mime_type: string;
  original_filename: string;
  status: "active" | "quarantined" | "archived";
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
};

type ImportItemRow = {
  id: string;
  batch_id: string;
  batch_status: string;
  parser_version: string;
  batch_created_at: string;
  batch_file_id: string;
  file_status: "queued" | "processing" | "ready" | "failed";
  source_document_id: string;
  original_filename: string;
  page_count: number | null;
  page_start: number;
  page_end: number;
  raw_text: string | null;
  extracted_data: JsonObject;
  manual_data: JsonObject;
  warnings: unknown[];
  duplicate_state: string;
  decision: string;
};

type PreparedPdf = {
  filename: string;
  contents: Buffer;
  preview: PdfPreview | null;
  parseError: string | null;
};

type RegisteredImport = {
  batchId: string;
  files: Array<{
    id: string;
    sourceDocumentId: string;
    filename: string;
    pageCount: number | null;
    status: "ready" | "failed";
    error: string | null;
  }>;
  items: Array<{
    id: string;
    batchFileId: string;
    filename: string;
    fileStatus: "ready" | "failed";
    error: string | null;
    pageStart: number;
    pageEnd: number;
    extracted: JsonObject;
    manualFields: JsonObject;
    warnings: unknown[];
    duplicateState: string;
  }>;
  hasFailedFiles: boolean;
};

type CommitImportRow = {
  item_id: string;
  batch_file_id: string;
  source_document_id: string;
  file_status: "queued" | "processing" | "ready" | "failed";
  filename: string;
  page_start: number;
  page_end: number;
  extracted_data: JsonObject;
  manual_data: JsonObject;
  warnings: unknown[];
  duplicate_state: string;
  decision: "pending" | "confirmed" | "excluded";
};

type OrderListRow = {
  id: string;
  public_code: string;
  status: string;
  version: string | number;
  resolution_number: string | null;
  resolution_date: string | Date | null;
  withholding_percent: string | number | null;
  manual_effective_date: string | Date | null;
  created_at: string;
  updated_at: string;
  debtor_id: string;
  debtor_name: string;
  debtor_tax_id: string | null;
  debtor_birth_date: string | Date | null;
  debtor_address: string | null;
  proceeding_id: string | null;
  proceeding_number: string | null;
  proceeding_date: string | Date | null;
  proceeding_document: string | null;
  proceeding_authority: string | null;
  proceeding_case_reference: string | null;
  employer_id: string | null;
  employer_name: string | null;
  employer_tax_id: string | null;
  employer_address: string | null;
  employer_status: string | null;
  responsible_id: string | null;
  responsible_name: string | null;
  review_rows: unknown[];
  incomplete: boolean;
};

type ShipmentListRow = {
  id: string;
  public_code: string;
  recipient_name: string | null;
  recipient_address: string | null;
  composition: string | null;
  tracking_number: string | null;
  shipment_type: string | null;
  return_reason: string | null;
  status: string;
  sent_at: string | Date | null;
  delivered_at: string | Date | null;
  returned_at: string | Date | null;
  responsible_id: string | null;
  responsible_name: string | null;
  version: string | number;
  created_at: string;
  updated_at: string;
  item_rows: unknown[];
};

type ShipmentOrderRow = {
  id: string;
  public_code: string;
  status: string;
  debtor_name: string;
  employer_name: string | null;
  employer_tax_id: string | null;
  employer_address: string | null;
  order_incomplete: boolean;
  employer_verified: boolean;
  resolution_number: string | null;
  proceeding_number: string | null;
};

const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown) => (typeof value === "string" ? value : null);

const userResponse = (row: UserRow): AuthUser => ({
  id: row.id,
  login: row.login,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  isActive: row.is_active,
});

const validUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const validRole = (value: unknown): value is UserRole =>
  value === "admin" || value === "editor" || value === "viewer";

const validDocumentStatus = (value: unknown): value is DocumentRow["status"] =>
  value === "active" || value === "quarantined" || value === "archived";

const dbOrReply = (reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) => {
  if (!pool) {
    reply.code(503).send({ error: "database_unavailable" });
    return null;
  }
  return pool;
};

const headerValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const audit = async (
  client: PoolClient,
  event: {
    actorId?: string | null;
    entityType: string;
    entityId?: string | null;
    action: string;
    oldValues?: unknown;
    newValues?: unknown;
    requestId?: string | null;
  },
) => {
  await client.query(
    `
      INSERT INTO audit_log
        (actor_id, entity_type, entity_id, action, old_values, new_values, request_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
    `,
    [
      event.actorId ?? null,
      event.entityType,
      event.entityId ?? null,
      event.action,
      event.oldValues === undefined ? null : JSON.stringify(event.oldValues),
      event.newValues === undefined ? null : JSON.stringify(event.newValues),
      event.requestId ?? null,
    ],
  );
};

const jsonObject = (value: unknown): JsonObject => (isRecord(value) ? value : {});
const jsonArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const emptyPdfExtracted = (): JsonObject => ({
  resolutionNumber: null,
  resolutionDate: null,
  proceedingNumber: null,
  proceedingDate: null,
  debtorName: null,
  debtorTaxId: null,
  debtorBirthDate: null,
  employerName: null,
  employerTaxId: null,
  employerAddress: null,
  withholdingPercent: null,
  sources: {},
});

const manualEmployerFields = (): JsonObject => ({
  employerName: null,
  employerTaxId: null,
  employerAddress: null,
});

const extractedString = (extracted: unknown, key: string) => {
  const value = jsonObject(extracted)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const duplicateKeyFor = (extracted: unknown) => {
  const data = jsonObject(extracted);
  const resolution = extractedString(data, "resolutionNumber");
  if (resolution) return `resolution:${resolution.toLowerCase()}`;
  const proceeding = extractedString(data, "proceedingNumber");
  const debtorTaxId = extractedString(data, "debtorTaxId");
  const debtorName = extractedString(data, "debtorName");
  if (proceeding && (debtorTaxId || debtorName)) {
    return `proceeding:${proceeding.toLowerCase()}:${(debtorTaxId ?? debtorName)?.toLowerCase()}`;
  }
  return null;
};

const databaseDate = (value: unknown) => {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    candidate.getUTCFullYear() !== Number(year)
    || candidate.getUTCMonth() !== Number(month) - 1
    || candidate.getUTCDate() !== Number(day)
  ) return null;
  return `${year}-${month}-${day}`;
};

const normalizeDateValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [year, month, day] = value.trim().split("-").map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
      ? value.trim()
      : null;
  }
  return databaseDate(value);
};

const orderStatusValues = new Set(["draft", "needs_review", "active", "completed", "archived"]);
const orderSortColumns: Record<string, string> = {
  publicCode: "o.public_code",
  debtor: "lower(d.full_name)",
  employer: "lower(coalesce(e.name, ''))",
  resolutionDate: "o.resolution_date",
  status: "o.status",
  responsible: "lower(coalesce(u.display_name, ''))",
  updatedAt: "o.updated_at",
};

const apiDateValue = (value: string | Date | null) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" ? value.slice(0, 10) : String(value).slice(0, 10);
};

const orderSelectSql = `
  SELECT o.id, o.public_code, o.status, o.version, o.resolution_number, o.resolution_date,
         o.withholding_percent, o.manual_effective_date, o.created_at, o.updated_at,
         d.id AS debtor_id, d.full_name AS debtor_name,
         d.external_ids->>'inn' AS debtor_tax_id, d.date_of_birth AS debtor_birth_date,
         d.address AS debtor_address,
         p.id AS proceeding_id, p.proceeding_number, p.proceeding_date,
         p.enforcement_document AS proceeding_document, p.authority AS proceeding_authority,
         p.case_reference AS proceeding_case_reference,
         e.id AS employer_id, e.name AS employer_name, e.tax_id AS employer_tax_id,
         e.address AS employer_address, e.status AS employer_status,
         u.id AS responsible_id, u.display_name AS responsible_name,
         COALESCE((
           SELECT json_agg(json_build_object(
             'fieldKey', r.field_key, 'status', r.status,
             'extractedValue', r.extracted_value, 'manualValue', r.manual_value,
             'sourcePageStart', r.source_page_start, 'sourcePageEnd', r.source_page_end,
             'updatedAt', r.updated_at
           ) ORDER BY r.field_key)
           FROM (
             SELECT DISTINCT ON (field_key) *
             FROM order_field_reviews
             WHERE order_id = o.id
             ORDER BY field_key, updated_at DESC, id DESC
           ) r
         ), '[]'::json) AS review_rows,
         (
           o.employer_id IS NULL OR EXISTS (
             SELECT 1 FROM (
               SELECT DISTINCT ON (field_key) field_key, status
               FROM order_field_reviews
               WHERE order_id = o.id
                 AND field_key IN ('employer_name', 'employer_tax_id', 'employer_address')
               ORDER BY field_key, updated_at DESC, id DESC
             ) incomplete_review
             WHERE incomplete_review.status <> 'verified'
           )
         ) AS incomplete
  FROM orders o
  JOIN debtors d ON d.id = o.debtor_id
  LEFT JOIN enforcement_proceedings p ON p.id = o.proceeding_id
  LEFT JOIN employers e ON e.id = o.employer_id
  LEFT JOIN users u ON u.id = o.responsible_id
`;

const orderResponse = (row: OrderListRow) => ({
  id: row.id,
  publicCode: row.public_code,
  status: row.status,
  version: Number(row.version),
  resolutionNumber: row.resolution_number,
  resolutionDate: apiDateValue(row.resolution_date),
  withholdingPercent: row.withholding_percent === null ? null : Number(row.withholding_percent),
  manualEffectiveDate: apiDateValue(row.manual_effective_date),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  debtor: {
    id: row.debtor_id,
    fullName: row.debtor_name,
    taxId: row.debtor_tax_id,
    birthDate: apiDateValue(row.debtor_birth_date),
    address: row.debtor_address,
  },
  proceeding: row.proceeding_id
    ? {
      id: row.proceeding_id,
      number: row.proceeding_number,
      date: apiDateValue(row.proceeding_date),
      enforcementDocument: row.proceeding_document,
      authority: row.proceeding_authority,
      caseReference: row.proceeding_case_reference,
    }
    : null,
  employer: row.employer_id
    ? {
      id: row.employer_id,
      name: row.employer_name,
      taxId: row.employer_tax_id,
      address: row.employer_address,
      status: row.employer_status,
    }
    : null,
  responsible: row.responsible_id ? { id: row.responsible_id, displayName: row.responsible_name } : null,
  incomplete: Boolean(row.incomplete),
  fieldReviews: jsonArray(row.review_rows),
});

const shipmentStatusValues = new Set(["draft", "sent", "delivered", "returned", "archived"]);
const shipmentSortColumns: Record<string, string> = {
  publicCode: "s.public_code",
  recipient: "lower(coalesce(s.recipient_name, ''))",
  status: "s.status",
  sentAt: "s.sent_at",
  updatedAt: "s.updated_at",
};

const shipmentSelectSql = `
  SELECT s.id, s.public_code, s.recipient_name, s.recipient_address, s.composition,
         s.tracking_number, s.shipment_type, s.return_reason, s.status,
         s.sent_at, s.delivered_at, s.returned_at, s.responsible_id,
         u.display_name AS responsible_name, s.version, s.created_at, s.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object(
             'id', si.id, 'position', si.item_position, 'orderId', o.id,
             'publicCode', o.public_code, 'debtorName', d.full_name,
             'employerName', e.name, 'employerTaxId', e.tax_id,
             'employerAddress', e.address,
             'orderIncomplete', (
               o.employer_id IS NULL OR EXISTS (
                 SELECT 1 FROM (
                   SELECT DISTINCT ON (field_key) field_key, status
                   FROM order_field_reviews
                   WHERE order_id = o.id
                     AND field_key IN ('employer_name', 'employer_tax_id', 'employer_address')
                   ORDER BY field_key, updated_at DESC, id DESC
                 ) latest_review
                 WHERE latest_review.status <> 'verified'
               )
             ),
             'employerVerified', (
               o.employer_id IS NOT NULL
               AND e.name IS NOT NULL AND e.address IS NOT NULL
               AND (
                 SELECT count(*)
                 FROM (
                   SELECT DISTINCT ON (field_key) field_key, status
                   FROM order_field_reviews
                   WHERE order_id = o.id
                     AND field_key IN ('employer_name', 'employer_address')
                   ORDER BY field_key, updated_at DESC, id DESC
                 ) latest_required_review
                 WHERE latest_required_review.status = 'verified'
               ) = 2
             ),
             'resolutionNumber', o.resolution_number,
             'proceedingNumber', p.proceeding_number
           ) ORDER BY si.item_position)
           FROM shipment_items si
           JOIN orders o ON o.id = si.order_id
           JOIN debtors d ON d.id = o.debtor_id
           LEFT JOIN employers e ON e.id = o.employer_id
           LEFT JOIN enforcement_proceedings p ON p.id = o.proceeding_id
           WHERE si.shipment_id = s.id
         ), '[]'::json) AS item_rows
  FROM shipments s
  LEFT JOIN users u ON u.id = s.responsible_id
`;

const timestampValue = (value: string | Date | null) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
};

const readTimestamp = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

type ShipmentItemApi = {
  id: string;
  position: number;
  orderId: string;
  publicCode: string;
  debtorName: string;
  employerName: string | null;
  employerTaxId: string | null;
  employerAddress: string | null;
  orderIncomplete: boolean;
  employerVerified: boolean;
  resolutionNumber: string | null;
  proceedingNumber: string | null;
};

type ShipmentWarning = { code: string; message: string };

const shipmentItemsFromRow = (row: ShipmentListRow): ShipmentItemApi[] => jsonArray(row.item_rows)
  .filter(isRecord)
  .map((item) => ({
    id: stringValue(item.id) ?? "",
    position: Number(item.position ?? 0),
    orderId: stringValue(item.orderId) ?? "",
    publicCode: stringValue(item.publicCode) ?? "",
    debtorName: stringValue(item.debtorName) ?? "",
    employerName: stringValue(item.employerName),
    employerTaxId: stringValue(item.employerTaxId),
    employerAddress: stringValue(item.employerAddress),
    orderIncomplete: Boolean(item.orderIncomplete),
    employerVerified: Boolean(item.employerVerified),
    resolutionNumber: stringValue(item.resolutionNumber),
    proceedingNumber: stringValue(item.proceedingNumber),
  }));

const shipmentWarningsFor = (
  row: Pick<ShipmentListRow, "recipient_name" | "recipient_address">,
  items: ShipmentItemApi[],
): ShipmentWarning[] => {
  const warnings: ShipmentWarning[] = [];
  const add = (code: string, message: string) => {
    if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message });
  };
  if (items.length === 0) add("empty_composition", "В конверте нет постановлений.");
  if (!row.recipient_name) add("recipient_missing", "Не указан получатель.");
  if (!row.recipient_address) add("address_missing", "Не указан адрес получателя.");
  const employerKeys = new Set(
    items
      .filter((item) => item.employerName || item.employerAddress)
      .map((item) => `${(item.employerName ?? "").trim().toLocaleLowerCase()}|${(item.employerAddress ?? "").trim().toLocaleLowerCase()}`),
  );
  if (employerKeys.size > 1) add("different_employers", "В составе разные работодатели или адреса; отправку нужно разделить.");
  if (items.some((item) => !item.employerVerified)) add("unverified_recipient", "Получатель или адрес хотя бы одного постановления не проверен.");
  if (items.some((item) => item.employerName && row.recipient_name && item.employerName.trim().toLocaleLowerCase() !== row.recipient_name.trim().toLocaleLowerCase())) {
    add("recipient_mismatch", "Получатель конверта не совпадает с работодателем постановления.");
  }
  if (items.some((item) => item.employerAddress && row.recipient_address && item.employerAddress.trim().toLocaleLowerCase() !== row.recipient_address.trim().toLocaleLowerCase())) {
    add("address_mismatch", "Адрес конверта не совпадает с адресом работодателя постановления.");
  }
  return warnings;
};

const shipmentResponse = (row: ShipmentListRow) => {
  const items = shipmentItemsFromRow(row);
  return {
    id: row.id,
    publicCode: row.public_code,
    recipientName: row.recipient_name,
    recipientAddress: row.recipient_address,
    composition: row.composition,
    trackingNumber: row.tracking_number,
    shipmentType: row.shipment_type,
    returnReason: row.return_reason,
    status: row.status,
    sentAt: timestampValue(row.sent_at),
    deliveredAt: timestampValue(row.delivered_at),
    returnedAt: timestampValue(row.returned_at),
    responsible: row.responsible_id ? { id: row.responsible_id, displayName: row.responsible_name } : null,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    warnings: shipmentWarningsFor(row, items),
  };
};

const shipmentInput = (body: JsonObject) => {
  const read = (value: unknown, maxLength: number) => readTextField(value, maxLength);
  const orderIdsRaw = body.orderIds;
  const orderIdsValid = orderIdsRaw === undefined || (Array.isArray(orderIdsRaw) && orderIdsRaw.every((value) => typeof value === "string"));
  const orderIds = Array.isArray(orderIdsRaw) ? orderIdsRaw.filter((value): value is string => typeof value === "string") : [];
  const recipientName = read(body.recipientName, 500);
  const recipientAddress = read(body.recipientAddress, 1000);
  const composition = read(body.composition, 2000);
  const trackingNumber = read(body.trackingNumber, 200);
  const shipmentType = read(body.shipmentType, 100);
  const returnReason = read(body.returnReason, 1000);
  const responsibleProvided = body.responsibleId !== undefined && body.responsibleId !== null && body.responsibleId !== "";
  const responsibleId = responsibleProvided ? stringValue(body.responsibleId) : null;
  const sentAt = readTimestamp(body.sentAt);
  const deliveredAt = readTimestamp(body.deliveredAt);
  const returnedAt = readTimestamp(body.returnedAt);
  const status = body.status === undefined ? "draft" : stringValue(body.status);
  const uniqueOrderIds = [...new Set(orderIds)];
  return {
    valid: orderIdsValid && orderIds.length === uniqueOrderIds.length
      && uniqueOrderIds.every(validUuid)
      && recipientName.ok && recipientAddress.ok && composition.ok && trackingNumber.ok
      && shipmentType.ok && returnReason.ok
      && (responsibleId === null ? !responsibleProvided : validUuid(responsibleId))
      && (body.sentAt === undefined || body.sentAt === null || body.sentAt === "" || sentAt !== null)
      && (body.deliveredAt === undefined || body.deliveredAt === null || body.deliveredAt === "" || deliveredAt !== null)
      && (body.returnedAt === undefined || body.returnedAt === null || body.returnedAt === "" || returnedAt !== null)
      && status !== null && shipmentStatusValues.has(status),
    orderIds: uniqueOrderIds,
    recipientName: recipientName.value,
    recipientAddress: recipientAddress.value,
    composition: composition.value,
    trackingNumber: trackingNumber.value,
    shipmentType: shipmentType.value,
    returnReason: returnReason.value,
    responsibleId,
    sentAt,
    deliveredAt,
    returnedAt,
    status,
  };
};

const shipmentSnapshot = (row: ShipmentOrderRow) => ({
  orderId: row.id,
  publicCode: row.public_code,
  debtorName: row.debtor_name,
  employerName: row.employer_name,
  employerTaxId: row.employer_tax_id,
  employerAddress: row.employer_address,
  resolutionNumber: row.resolution_number,
  proceedingNumber: row.proceeding_number,
});

const shipmentOrderQuery = async (client: PoolClient, orderIds: string[]) => {
  if (orderIds.length === 0) return [] as ShipmentOrderRow[];
  const result = await client.query<ShipmentOrderRow>(
    `
      SELECT o.id, o.public_code, o.status, d.full_name AS debtor_name,
             e.name AS employer_name, e.tax_id AS employer_tax_id, e.address AS employer_address,
             o.resolution_number, p.proceeding_number,
             (
               o.employer_id IS NOT NULL AND e.name IS NOT NULL AND e.address IS NOT NULL
               AND (
                 SELECT count(*)
                 FROM (
                   SELECT DISTINCT ON (field_key) field_key, status
                   FROM order_field_reviews
                   WHERE order_id = o.id AND field_key IN ('employer_name', 'employer_address')
                   ORDER BY field_key, updated_at DESC, id DESC
                 ) latest_required_review
                 WHERE latest_required_review.status = 'verified'
               ) = 2
             ) AS employer_verified,
             (
               o.employer_id IS NULL OR EXISTS (
                 SELECT 1 FROM (
                   SELECT DISTINCT ON (field_key) field_key, status
                   FROM order_field_reviews
                   WHERE order_id = o.id
                     AND field_key IN ('employer_name', 'employer_tax_id', 'employer_address')
                   ORDER BY field_key, updated_at DESC, id DESC
                 ) latest_review
                 WHERE latest_review.status <> 'verified'
               )
             ) AS order_incomplete
      FROM orders o
      JOIN debtors d ON d.id = o.debtor_id
      LEFT JOIN employers e ON e.id = o.employer_id
      LEFT JOIN enforcement_proceedings p ON p.id = o.proceeding_id
      WHERE o.id = ANY($1::uuid[])
      ORDER BY array_position($1::uuid[], o.id)
    `,
    [orderIds],
  );
  return result.rows;
};

type PaymentEventRow = {
  id: string;
  public_code: string;
  order_id: string | null;
  unknown_external_id: string | null;
  transfer_id: string | null;
  stage: "fssp" | "uk";
  source: string;
  payment_date: string | Date;
  amount: string;
  confirmation_status: "unconfirmed" | "confirmed" | "rejected";
  enforcement_reconciled: boolean;
  period_start: string | Date | null;
  period_end: string | Date | null;
  rejection_reason: string | null;
  payment_document: string | null;
  note: string | null;
  duplicate_override: boolean;
  transfer_external_reference: string | null;
  transfer_date: string | Date | null;
  transfer_note: string | null;
  order_public_code: string | null;
  debtor_name: string | null;
  employer_name: string | null;
  proceeding_number: string | null;
  version: string | number;
  created_at: string;
  updated_at: string;
  document_rows: unknown[];
  duplicate_rows: unknown[];
};

type PaymentTransferRow = {
  id: string;
  external_reference: string | null;
  transfer_date: string | Date | null;
  note: string | null;
  version: string | number;
  created_at: string;
  updated_at: string;
};

const paymentStageValues = new Set(["fssp", "uk"]);
const paymentConfirmationValues = new Set(["unconfirmed", "confirmed", "rejected"]);
const paymentSortColumns: Record<string, string> = {
  publicCode: "pe.public_code",
  paymentDate: "pe.payment_date",
  amount: "pe.amount",
  stage: "pe.stage",
  status: "pe.confirmation_status",
  updatedAt: "pe.updated_at",
};

const paymentSelectSql = `
  SELECT pe.id, pe.public_code, pe.order_id, pe.unknown_external_id, pe.transfer_id,
         pe.stage, pe.source, pe.payment_date, pe.amount, pe.confirmation_status,
         pe.enforcement_reconciled, pe.period_start, pe.period_end, pe.rejection_reason,
         pe.payment_document, pe.note, pe.duplicate_override, pe.version,
         pe.created_at, pe.updated_at,
         pt.external_reference AS transfer_external_reference,
         pt.transfer_date, pt.note AS transfer_note,
         o.public_code AS order_public_code, d.full_name AS debtor_name,
         e.name AS employer_name, p.proceeding_number,
         COALESCE((
           SELECT json_agg(json_build_object(
             'id', pd.document_id, 'filename', doc.original_filename,
             'documentType', pd.document_type
           ) ORDER BY doc.original_filename)
           FROM payment_documents pd
           JOIN documents doc ON doc.id = pd.document_id
           WHERE pd.payment_event_id = pe.id
         ), '[]'::json) AS document_rows,
         COALESCE((
           SELECT json_agg(json_build_object(
             'id', duplicate.id, 'publicCode', duplicate.public_code,
             'confirmationStatus', duplicate.confirmation_status,
             'amount', duplicate.amount, 'paymentDate', duplicate.payment_date,
             'transferId', duplicate.transfer_id
           ) ORDER BY duplicate.created_at, duplicate.id)
           FROM payment_events duplicate
           WHERE duplicate.id <> pe.id
             AND duplicate.stage = pe.stage
             AND duplicate.payment_date = pe.payment_date
             AND duplicate.amount = pe.amount
             AND duplicate.order_id IS NOT DISTINCT FROM pe.order_id
             AND duplicate.unknown_external_id IS NOT DISTINCT FROM pe.unknown_external_id
             AND duplicate.confirmation_status <> 'rejected'
         ), '[]'::json) AS duplicate_rows
  FROM payment_events pe
  LEFT JOIN payment_transfers pt ON pt.id = pe.transfer_id
  LEFT JOIN orders o ON o.id = pe.order_id
  LEFT JOIN debtors d ON d.id = o.debtor_id
  LEFT JOIN employers e ON e.id = o.employer_id
  LEFT JOIN enforcement_proceedings p ON p.id = o.proceeding_id
`;

type PaymentWarning = { code: string; message: string };

const paymentWarningsFor = (row: PaymentEventRow): PaymentWarning[] => {
  const warnings: PaymentWarning[] = [];
  const add = (code: string, message: string) => {
    if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message });
  };
  if (row.duplicate_rows.length > 0) add("possible_duplicate", "Найден возможный дубль с той же суммой, датой, этапом и получателем.");
  if (!row.order_id) add("unknown_order", "Постановление не сопоставлено; сохранён исходный внешний ID.");
  if (row.confirmation_status !== "confirmed") add("not_confirmed", "Поступление не подтверждено и не входит в итог.");
  if (!row.enforcement_reconciled) add("not_reconciled", "Номер ИП не сверён.");
  if (row.source !== "Этот работодатель") add("source_not_employer", "Источник не отмечен как «Этот работодатель»; запись исключена из итогов.");
  if (row.order_id && !row.proceeding_number) add("proceeding_number_missing", "У постановления не указан номер ИП; запись исключена из итогов.");
  if (row.confirmation_status === "rejected") add("rejected", `Поступление отклонено${row.rejection_reason ? `: ${row.rejection_reason}` : "."}`);
  return warnings;
};

const paymentResponse = (row: PaymentEventRow) => {
  const warnings = paymentWarningsFor(row);
  const eligibleForTotals = Boolean(
    row.order_id
      && row.confirmation_status === "confirmed"
      && row.enforcement_reconciled
      && row.source === "Этот работодатель"
      && row.proceeding_number,
  );
  return {
    id: row.id,
    publicCode: row.public_code,
    target: row.order_id
      ? { orderId: row.order_id, publicCode: row.order_public_code, debtorName: row.debtor_name, employerName: row.employer_name, proceedingNumber: row.proceeding_number }
      : null,
    unknownExternalId: row.unknown_external_id,
    stage: row.stage,
    source: row.source,
    paymentDate: apiDateValue(row.payment_date),
    amount: row.amount,
    confirmationStatus: row.confirmation_status,
    enforcementReconciled: row.enforcement_reconciled,
    periodStart: apiDateValue(row.period_start),
    periodEnd: apiDateValue(row.period_end),
    paymentDocument: row.payment_document,
    note: row.note,
    rejectionReason: row.rejection_reason,
    duplicateOverride: row.duplicate_override,
    transfer: row.transfer_id ? {
      id: row.transfer_id,
      externalReference: row.transfer_external_reference,
      transferDate: apiDateValue(row.transfer_date),
      note: row.transfer_note,
    } : null,
    documents: jsonArray(row.document_rows),
    duplicateCandidates: jsonArray(row.duplicate_rows),
    warnings,
    eligibleForTotals,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const readMoney = (value: unknown) => {
  if (typeof value !== "string") return { ok: false, value: null as string | null };
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(normalized)) return { ok: false, value: null as string | null };
  return { ok: true, value: normalized };
};

const paymentInput = (body: JsonObject) => {
  const orderId = body.orderId === undefined || body.orderId === null || body.orderId === "" ? null : stringValue(body.orderId);
  const unknownExternalIdField = readTextField(body.unknownExternalId, 200);
  const unknownExternalId = unknownExternalIdField.value;
  const stage = stringValue(body.stage);
  const source = readTextField(body.source, 200, true);
  const paymentDate = normalizeDateValue(body.paymentDate);
  const amount = readMoney(body.amount);
  const confirmationStatus = body.confirmationStatus === undefined ? "unconfirmed" : stringValue(body.confirmationStatus);
  const enforcementReconciled = body.enforcementReconciled === undefined ? false : body.enforcementReconciled;
  const periodStart = normalizeDateValue(body.periodStart);
  const periodEnd = normalizeDateValue(body.periodEnd);
  const paymentDocument = readTextField(body.paymentDocument, 300);
  const note = readTextField(body.note, 2000);
  const rejectionReason = readTextField(body.rejectionReason, 1000);
  const transferId = body.transferId === undefined || body.transferId === null || body.transferId === "" ? null : stringValue(body.transferId);
  const documentIdsRaw = body.documentIds;
  const documentIdsValid = documentIdsRaw === undefined || (Array.isArray(documentIdsRaw) && documentIdsRaw.every((id) => typeof id === "string" && validUuid(id)));
  const documentIds = Array.isArray(documentIdsRaw) ? [...new Set(documentIdsRaw.filter((id): id is string => typeof id === "string"))] : [];
  const uniqueTarget = (orderId !== null ? 1 : 0) + (unknownExternalId !== null ? 1 : 0);
  return {
    valid: uniqueTarget === 1
      && (orderId === null || validUuid(orderId))
      && unknownExternalIdField.ok
      && stage !== null && paymentStageValues.has(stage)
      && source.ok && paymentDate !== null && amount.ok
      && paymentDocument.ok && note.ok && rejectionReason.ok
      && (confirmationStatus !== null && paymentConfirmationValues.has(confirmationStatus))
      && typeof enforcementReconciled === "boolean"
      && (body.periodStart === undefined || body.periodStart === null || body.periodStart === "" || periodStart !== null)
      && (body.periodEnd === undefined || body.periodEnd === null || body.periodEnd === "" || periodEnd !== null)
      && (periodStart === null || periodEnd === null || periodEnd >= periodStart)
      && (confirmationStatus !== "rejected" || Boolean(rejectionReason.value))
      && (transferId === null || validUuid(transferId))
      && documentIdsValid && documentIds.length === (Array.isArray(documentIdsRaw) ? documentIdsRaw.length : documentIds.length),
    orderId,
    unknownExternalId,
    stage,
    source: source.value,
    paymentDate,
    amount: amount.value,
    confirmationStatus,
    enforcementReconciled,
    periodStart,
    periodEnd,
    paymentDocument: paymentDocument.value,
    note: note.value,
    rejectionReason: rejectionReason.value,
    transferId,
    documentIds,
    duplicateOverride: body.duplicateOverride === true,
  };
};

const paymentTransferInput = (body: JsonObject) => {
  const externalReference = readTextField(body.externalReference, 200);
  const transferDate = normalizeDateValue(body.transferDate);
  const note = readTextField(body.note, 2000);
  return {
    valid: externalReference.ok && note.ok
      && (body.transferDate === undefined || body.transferDate === null || body.transferDate === "" || transferDate !== null),
    externalReference: externalReference.value,
    transferDate,
    note: note.value,
  };
};

const paymentRowFor = async (queryable: Pick<Pool, "query"> | PoolClient, id: string) => {
  const result = await queryable.query<PaymentEventRow>(`${paymentSelectSql} WHERE pe.id = $1`, [id]);
  return result.rows[0] ?? null;
};

const paymentDuplicateRows = async (
  client: PoolClient,
  input: ReturnType<typeof paymentInput>,
  excludeId: string | null = null,
) => {
  const values: unknown[] = [input.stage, input.paymentDate, input.amount, excludeId];
  const targetClause = input.orderId ? "duplicate.order_id = $5" : "duplicate.unknown_external_id = $5";
  values.push(input.orderId ?? input.unknownExternalId);
  const result = await client.query<{ id: string; public_code: string; confirmation_status: string; amount: string; payment_date: string; transfer_id: string | null }>(
    `SELECT duplicate.id, duplicate.public_code, duplicate.confirmation_status,
            duplicate.amount, duplicate.payment_date, duplicate.transfer_id
     FROM payment_events duplicate
     WHERE duplicate.id <> COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND duplicate.stage = $1
       AND duplicate.payment_date = $2::date
       AND duplicate.amount = $3::numeric
       AND ${targetClause}
       AND duplicate.confirmation_status <> 'rejected'
     ORDER BY duplicate.created_at, duplicate.id`,
    values,
  );
  return result.rows;
};

type ControlSettingsRow = {
  id: string;
  timezone: string;
  after_sent_days: number;
  after_delivered_days: number;
  after_uk_check_days: number;
  reminder_before_days: number;
  effective_from: string;
  version: string | number;
};

type ActionRow = {
  id: string;
  order_id: string;
  title: string;
  description: string | null;
  due_date: string | Date | null;
  manual_due_date: string | Date | null;
  control_basis: string;
  source_event_type: string | null;
  source_event_id: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  result: string | null;
  completed_at: string | Date | null;
  assigned_to: string | null;
  assigned_name: string | null;
  version: string | number;
  created_at: string;
  updated_at: string;
  order_public_code: string;
  debtor_name: string;
  order_status: string;
};

const controlSettingsDefaults = {
  timezone: "Asia/Yekaterinburg",
  afterSentDays: 7,
  afterDeliveredDays: 30,
  afterUkCheckDays: 30,
  reminderBeforeDays: 3,
};

const controlStatusValues = new Set(["open", "in_progress", "done", "cancelled"]);
const controlBasisValues = new Set(["manual", "shipment_sent", "shipment_delivered", "uk_payment"]);

const isValidTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

const localDateInTimezone = (timezone: string, value = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const controlSettingsResponse = (row: ControlSettingsRow | null) => row ? ({
  id: row.id,
  timezone: row.timezone,
  afterSentDays: row.after_sent_days,
  afterDeliveredDays: row.after_delivered_days,
  afterUkCheckDays: row.after_uk_check_days,
  reminderBeforeDays: row.reminder_before_days,
  effectiveFrom: row.effective_from,
  version: Number(row.version),
}) : ({
  id: null,
  timezone: controlSettingsDefaults.timezone,
  afterSentDays: controlSettingsDefaults.afterSentDays,
  afterDeliveredDays: controlSettingsDefaults.afterDeliveredDays,
  afterUkCheckDays: controlSettingsDefaults.afterUkCheckDays,
  reminderBeforeDays: controlSettingsDefaults.reminderBeforeDays,
  effectiveFrom: null,
  version: 0,
});

const controlSettingsInput = (body: JsonObject) => {
  const timezone = readTextField(body.timezone, 100, true);
  const readDays = (key: string, fallback: number, minimum: number) => {
    const raw = body[key] === undefined ? fallback : Number(body[key]);
    return Number.isInteger(raw) && raw >= minimum && raw <= 3650 ? raw : null;
  };
  const afterSentDays = readDays("afterSentDays", controlSettingsDefaults.afterSentDays, 1);
  const afterDeliveredDays = readDays("afterDeliveredDays", controlSettingsDefaults.afterDeliveredDays, 1);
  const afterUkCheckDays = readDays("afterUkCheckDays", controlSettingsDefaults.afterUkCheckDays, 1);
  const reminderBeforeDays = readDays("reminderBeforeDays", controlSettingsDefaults.reminderBeforeDays, 0);
  return {
    valid: timezone.ok && Boolean(timezone.value && isValidTimezone(timezone.value))
      && afterSentDays !== null && afterDeliveredDays !== null && afterUkCheckDays !== null && reminderBeforeDays !== null,
    timezone: timezone.value,
    afterSentDays,
    afterDeliveredDays,
    afterUkCheckDays,
    reminderBeforeDays,
  };
};

const actionInput = (body: JsonObject) => {
  const orderId = stringValue(body.orderId);
  const title = readTextField(body.title, 500, true);
  const description = readTextField(body.description, 4000);
  const dueDate = normalizeDateValue(body.dueDate);
  const manualDueDate = normalizeDateValue(body.manualDueDate);
  const assignedTo = body.assignedTo === undefined || body.assignedTo === null || body.assignedTo === "" ? null : stringValue(body.assignedTo);
  const status = body.status === undefined ? "open" : stringValue(body.status);
  const result = readTextField(body.result, 4000);
  const controlBasis = body.controlBasis === undefined ? "manual" : stringValue(body.controlBasis);
  const sourceEventType = body.sourceEventType === undefined || body.sourceEventType === null || body.sourceEventType === "" ? null : stringValue(body.sourceEventType);
  const sourceEventId = body.sourceEventId === undefined || body.sourceEventId === null || body.sourceEventId === "" ? null : stringValue(body.sourceEventId);
  const effectiveManualDueDate = manualDueDate ?? (controlBasis === "manual" ? dueDate : null);
  const effectiveDueDate = effectiveManualDueDate ?? dueDate;
  return {
    valid: orderId !== null && validUuid(orderId) && title.ok && description.ok && result.ok
      && (body.dueDate === undefined || body.dueDate === null || body.dueDate === "" || dueDate !== null)
      && (body.manualDueDate === undefined || body.manualDueDate === null || body.manualDueDate === "" || manualDueDate !== null)
      && (assignedTo === null || validUuid(assignedTo))
      && status !== null && controlStatusValues.has(status)
      && controlBasis !== null && controlBasisValues.has(controlBasis)
      && (sourceEventId === null || validUuid(sourceEventId))
      && ((sourceEventType === null) === (sourceEventId === null)),
    orderId,
    title: title.value,
    description: description.value,
    dueDate: effectiveDueDate,
    manualDueDate: effectiveManualDueDate,
    assignedTo,
    status,
    result: result.value,
    controlBasis,
    sourceEventType,
    sourceEventId,
  };
};

const actionResponse = (row: ActionRow) => ({
  id: row.id,
  orderId: row.order_id,
  order: { publicCode: row.order_public_code, debtorName: row.debtor_name, status: row.order_status },
  title: row.title,
  description: row.description,
  dueDate: apiDateValue(row.due_date),
  manualDueDate: apiDateValue(row.manual_due_date),
  controlBasis: row.control_basis,
  sourceEventType: row.source_event_type,
  sourceEventId: row.source_event_id,
  status: row.status,
  result: row.result,
  completedAt: timestampValue(row.completed_at),
  assignedTo: row.assigned_to ? { id: row.assigned_to, displayName: row.assigned_name } : null,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const controlSettingsFor = async (queryable: Pick<Pool, "query"> | PoolClient) => {
  const result = await queryable.query<ControlSettingsRow>(
    `SELECT id, timezone, after_sent_days, after_delivered_days, after_uk_check_days,
            reminder_before_days, effective_from, version
     FROM control_settings ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1`,
  );
  return result.rows[0] ?? null;
};

type ReportOrderRow = OrderListRow & {
  shipment_public_code: string | null;
  shipment_sent_at: string | Date | null;
  shipment_delivered_at: string | Date | null;
  shipment_status: string | null;
  shipment_selection_status: string | null;
  fssp_total: string | null;
  uk_total: string | null;
  fssp_event_count: string | number | null;
  uk_event_count: string | number | null;
  uk_last_payment_date: string | Date | null;
  action_id: string | null;
  action_title: string | null;
  action_status: "open" | "in_progress" | "done" | "cancelled" | null;
  action_due_date: string | Date | null;
  action_manual_due_date: string | Date | null;
  action_assigned_to: string | null;
  action_assigned_name: string | null;
  action_result: string | null;
};

const reportOrderSelectSql = `
  WITH registry AS (
    ${orderSelectSql}
  )
  SELECT registry.*,
         cs.public_code AS shipment_public_code,
         cs.sent_at AS shipment_sent_at,
         cs.delivered_at AS shipment_delivered_at,
         cs.selection_status AS shipment_status,
         cs.selection_status AS shipment_selection_status,
         fssp.total_amount::text AS fssp_total,
         uk.total_amount::text AS uk_total,
         fssp.payment_event_count AS fssp_event_count,
         uk.payment_event_count AS uk_event_count,
         uk.last_payment_date AS uk_last_payment_date,
         ca.id AS action_id,
         ca.title AS action_title,
         ca.status AS action_status,
         ca.due_date AS action_due_date,
         ca.manual_due_date AS action_manual_due_date,
         ca.assigned_to AS action_assigned_to,
         ca.assigned_name AS action_assigned_name,
         ca.result AS action_result
  FROM registry
  LEFT JOIN current_shipments cs ON cs.order_id = registry.id
  LEFT JOIN payment_totals_fssp fssp ON fssp.order_id = registry.id
  LEFT JOIN payment_totals_uk uk ON uk.order_id = registry.id
  LEFT JOIN LATERAL (
    SELECT a.id, a.title, a.status, a.due_date, a.manual_due_date,
           a.assigned_to, u.display_name AS assigned_name, a.result
    FROM actions a
    LEFT JOIN users u ON u.id = a.assigned_to
    WHERE a.order_id = registry.id
    ORDER BY CASE WHEN a.status IN ('open', 'in_progress') THEN 0 ELSE 1 END,
             a.updated_at DESC, a.id DESC
    LIMIT 1
  ) ca ON true
`;

const reportSortColumns: Record<string, string> = {
  publicCode: "registry.public_code",
  debtor: "lower(registry.debtor_name)",
  employer: "lower(coalesce(registry.employer_name, ''))",
  resolutionDate: "registry.resolution_date",
  status: "registry.status",
  responsible: "lower(coalesce(registry.responsible_name, ''))",
  sentAt: "shipment_sent_at",
  deliveredAt: "shipment_delivered_at",
  ukPayments: "uk_total",
  updatedAt: "registry.updated_at",
};

const reportDefaultColumns = [
  "publicCode", "id", "debtor", "account", "employer", "proceeding", "resolutionNumber", "resolutionDate",
  "sentAt", "deliveredAt", "execution", "ukPayments", "control", "status", "responsible",
] as const;

const reportColumnDefinitions: Record<string, { header: string; width: number; kind?: "date" | "money" | "text" }> = {
  publicCode: { header: "Код постановления", width: 20, kind: "text" },
  id: { header: "ID", width: 38, kind: "text" },
  debtor: { header: "Должник", width: 28, kind: "text" },
  account: { header: "Лицевой счёт", width: 18, kind: "text" },
  debtorTaxId: { header: "ИНН должника", width: 16, kind: "text" },
  debtorAddress: { header: "Адрес должника", width: 34, kind: "text" },
  employer: { header: "Работодатель", width: 30, kind: "text" },
  employerTaxId: { header: "ИНН работодателя", width: 18, kind: "text" },
  employerAddress: { header: "Адрес работодателя", width: 34, kind: "text" },
  proceeding: { header: "Номер ИП", width: 24, kind: "text" },
  resolutionNumber: { header: "Номер постановления", width: 24, kind: "text" },
  resolutionDate: { header: "Дата постановления", width: 18, kind: "date" },
  sentAt: { header: "Отправка", width: 18, kind: "date" },
  deliveredAt: { header: "Вручение", width: 18, kind: "date" },
  shipment: { header: "Конверт", width: 22, kind: "text" },
  execution: { header: "Исполнение", width: 18, kind: "text" },
  fsspPayments: { header: "Подтверждено ФССП", width: 20, kind: "money" },
  ukPayments: { header: "Подтверждено УК", width: 20, kind: "money" },
  control: { header: "Контроль", width: 28, kind: "text" },
  status: { header: "Состояние", width: 18, kind: "text" },
  responsible: { header: "Ответственный", width: 24, kind: "text" },
  incomplete: { header: "Реквизиты", width: 22, kind: "text" },
  warning: { header: "Предупреждения", width: 28, kind: "text" },
  note: { header: "Примечание", width: 28, kind: "text" },
};

const reportStatusLabels: Record<string, string> = {
  draft: "Черновик",
  needs_review: "Нужно проверить",
  active: "Активно",
  completed: "Завершено",
  archived: "Архив",
};

const reportControlStateLabels: Record<string, string> = {
  overdue: "Просрочено",
  today: "Сегодня",
  soon: "Скоро",
  scheduled: "Запланировано",
  assign_action: "Назначить действие",
  assign_responsible: "Назначить ответственного",
  completed: "Завершена",
  archived: "Архив",
};

type ReportFilter = {
  whereSql: string;
  values: unknown[];
  includeArchived: boolean;
  search: string;
  searchMode: SearchMode;
  status: string;
  responsibleId: string;
  incomplete: boolean;
  ids: string[];
};

type ReportRowsResult = ReportFilter & {
  sortKey: string;
  direction: "ASC" | "DESC";
  rows: ReportOrderRow[];
  settings: ReturnType<typeof controlSettingsResponse>;
  today: string;
} | { error: string };

const reportDateText = (value: unknown) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
};

const reportAddDays = (value: string | null, days: number) => {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

type ReportControlSnapshot = {
  basis: string | null;
  baseDate: string | null;
  dueDate: string | null;
  reminderDate: string | null;
  state: string;
  warning: string | null;
};

const reportControlSnapshot = (row: ReportOrderRow, settings: ReturnType<typeof controlSettingsResponse>, today: string): ReportControlSnapshot => {
  const sentDate = reportDateText(row.shipment_sent_at);
  const deliveredDate = reportDateText(row.shipment_delivered_at);
  const ukPaymentDate = reportDateText(row.uk_last_payment_date);
  const basis = ukPaymentDate
    ? "uk_payment"
    : deliveredDate ? "shipment_delivered"
      : sentDate ? "shipment_sent" : null;
  const baseDate = basis === "uk_payment" ? ukPaymentDate
    : basis === "shipment_delivered" ? deliveredDate
      : basis === "shipment_sent" ? sentDate : null;
  const manualDate = reportDateText(row.action_manual_due_date);
  const dueDate = manualDate ?? (basis === "uk_payment" && baseDate
    ? reportAddDays(baseDate, settings.afterUkCheckDays)
    : basis === "shipment_delivered" && baseDate
      ? reportAddDays(baseDate, settings.afterDeliveredDays)
      : basis === "shipment_sent" && baseDate
        ? reportAddDays(baseDate, settings.afterSentDays) : null);
  let state = "assign_action";
  if (row.status === "archived") state = "archived";
  else if (row.action_status === "done") state = "completed";
  else if (row.action_status === "cancelled" || !basis) state = "assign_action";
  else if (row.action_id && !row.action_assigned_to) state = "assign_responsible";
  else if (!row.action_id || !dueDate) state = "assign_action";
  else if (dueDate < today) state = "overdue";
  else if (dueDate === today) state = "today";
  else if (dueDate <= (reportAddDays(today, settings.reminderBeforeDays) ?? today)) state = "soon";
  else state = "scheduled";
  return {
    basis,
    baseDate,
    dueDate,
    reminderDate: dueDate ? reportAddDays(dueDate, -settings.reminderBeforeDays) : null,
    state,
    warning: row.incomplete ? "Реквизиты требуют проверки" : null,
  };
};

const reportFilterValues = (query: JsonObject, includeArchivedOverride?: boolean): ReportFilter | { error: string } => {
  const search = normalizeSearchText(query.q);
  const searchMode = normalizeSearchMode(query.mode);
  const status = typeof query.status === "string" ? query.status : "";
  const responsibleId = typeof query.responsibleId === "string" && query.responsibleId ? query.responsibleId : "";
  const incomplete = query.incomplete === true || query.incomplete === "true";
  const includeArchived = includeArchivedOverride ?? (query.includeArchived === true || query.includeArchived === "true" || status === "all" || status === "archived");
  const rawIds = typeof query.ids === "string" ? query.ids.split(",").map((value) => value.trim()).filter(Boolean) : [];
  const ids = [...new Set(rawIds)];
  if (!searchMode) return { error: "invalid_search_mode" };
  if (status && status !== "all" && !orderStatusValues.has(status)) return { error: "invalid_order_status" };
  if (responsibleId && !validUuid(responsibleId)) return { error: "invalid_responsible_id" } as const;
  if (ids.length > 5000 || ids.some((id) => !validUuid(id))) return { error: "invalid_order_ids" } as const;
  const where: string[] = [];
  const values: unknown[] = [];
  if (!includeArchived) where.push("registry.status <> 'archived'");
  if (status && status !== "all") {
    values.push(status);
    where.push(`registry.status = $${values.length}`);
  }
  if (search) {
    values.push(searchMode === "fulltext" ? search : `%${search.toLowerCase()}%`);
    where.push(searchPredicate(
      ["registry.public_code", "registry.debtor_name", "registry.debtor_tax_id", "registry.employer_name", "registry.employer_tax_id", "registry.resolution_number", "registry.proceeding_number"],
      searchMode,
      `$${values.length}`,
    ));
  }
  if (responsibleId) {
    values.push(responsibleId);
    where.push(`registry.responsible_id = $${values.length}`);
  }
  if (incomplete) where.push("registry.incomplete = true");
  if (ids.length > 0) {
    values.push(ids);
    where.push(`registry.id = ANY($${values.length}::uuid[])`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", values, includeArchived, search, searchMode, status, responsibleId, incomplete, ids };
};

const reportRowsFor = async (db: Pool, query: JsonObject, includeArchivedOverride?: boolean): Promise<ReportRowsResult> => {
  const filter = reportFilterValues(query, includeArchivedOverride);
  if ("error" in filter) return filter;
  const sortKey = typeof query.sort === "string" && reportSortColumns[query.sort] ? query.sort : "updatedAt";
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const result = await db.query<ReportOrderRow>(
    `${reportOrderSelectSql} ${filter.whereSql} ORDER BY ${reportSortColumns[sortKey]} ${direction}, registry.id`,
    filter.values,
  );
  const settings = controlSettingsResponse(await controlSettingsFor(db));
  const today = localDateInTimezone(settings.timezone);
  return { ...filter, sortKey, direction, rows: result.rows, settings, today };
};

const reportMoneyCents = (value: string | number | null | undefined) => {
  const normalized = String(value ?? "0").trim();
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return 0n;
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
};

const reportMoneyText = (cents: bigint) => {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};

const reportMoneyNumber = (value: string | number | null | undefined) => Number(reportMoneyText(reportMoneyCents(value)));

const reportExcelDate = (value: string | null) => value ? new Date(`${value}T12:00:00.000Z`) : null;

const reportDateDisplay = (value: string | null) => value ? value.split("-").reverse().join(".") : "";

const reportControlText = (row: ReportOrderRow, control: ReportControlSnapshot) => {
  const parts = [reportControlStateLabels[control.state] ?? control.state];
  if (control.dueDate) parts.push(`срок ${reportDateDisplay(control.dueDate)}`);
  if (row.action_title) parts.push(row.action_title);
  if (row.action_assigned_name) parts.push(row.action_assigned_name);
  return parts.join("; ");
};

const reportCellValue = (key: string, row: ReportOrderRow, control: ReportControlSnapshot): unknown => {
  switch (key) {
    case "publicCode": return row.public_code;
    case "id": return row.id;
    case "debtor": return row.debtor_name;
    case "account": return "";
    case "debtorTaxId": return row.debtor_tax_id ?? "";
    case "debtorAddress": return row.debtor_address ?? "";
    case "employer": return row.employer_name ?? "";
    case "employerTaxId": return row.employer_tax_id ?? "";
    case "employerAddress": return row.employer_address ?? "";
    case "proceeding": return row.proceeding_number ?? "";
    case "resolutionNumber": return row.resolution_number ?? "";
    case "resolutionDate": return reportExcelDate(reportDateText(row.resolution_date));
    case "sentAt": return reportExcelDate(reportDateText(row.shipment_sent_at));
    case "deliveredAt": return reportExcelDate(reportDateText(row.shipment_delivered_at));
    case "shipment": return row.shipment_selection_status === "ambiguous" ? "Неоднозначно" : row.shipment_public_code ?? "";
    case "execution": return reportStatusLabels[row.status] ?? row.status;
    case "fsspPayments": return reportMoneyNumber(row.fssp_total);
    case "ukPayments": return reportMoneyNumber(row.uk_total);
    case "control": return reportControlText(row, control);
    case "status": return reportStatusLabels[row.status] ?? row.status;
    case "responsible": return row.responsible_name ?? "";
    case "incomplete": return row.incomplete ? "Требует проверки" : "Проверено";
    case "warning": return [row.incomplete ? "Реквизиты работодателя требуют проверки" : "", row.shipment_selection_status === "ambiguous" ? "Актуальный конверт неоднозначен" : ""].filter(Boolean).join("; ");
    case "note": return "";
    default: return "";
  }
};

const reportFilterDescription = (filter: { search: string; searchMode?: SearchMode; status: string; responsibleId: string; incomplete: boolean; includeArchived: boolean; ids: string[] }) => {
  const parts = [
    filter.search ? `поиск: ${filter.search}${filter.searchMode === "fulltext" ? " (полнотекстовый)" : ""}` : "",
    filter.status && filter.status !== "all" ? `статус: ${reportStatusLabels[filter.status] ?? filter.status}` : "",
    filter.responsibleId ? `ответственный: ${filter.responsibleId}` : "",
    filter.incomplete ? "только неполные реквизиты" : "",
    filter.includeArchived ? "архив включён" : "архив исключён",
    filter.ids.length > 0 ? `выбрано записей: ${filter.ids.length}` : "вся выборка",
  ].filter(Boolean);
  return parts.join("; ");
};

const reportSummaryFor = async (db: Pool, result: ReportRowsResult) => {
  if ("error" in result) return result;
  const controls = result.rows.map((row) => reportControlSnapshot(row, result.settings, result.today));
  const statusCounts: Record<string, number> = {};
  const controlCounts: Record<string, number> = {};
  let incomplete = 0;
  let deliveredWithoutUkPayment = 0;
  let fsspTotal = 0n;
  let ukTotal = 0n;
  for (const [index, row] of result.rows.entries()) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    const control = controls[index];
    if (!control) continue;
    controlCounts[control.state] = (controlCounts[control.state] ?? 0) + 1;
    if (row.incomplete) incomplete += 1;
    if (row.shipment_delivered_at && !row.uk_last_payment_date) deliveredWithoutUkPayment += 1;
    fsspTotal += reportMoneyCents(row.fssp_total);
    ukTotal += reportMoneyCents(row.uk_total);
  }
  const rejectedResult = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM payment_rejections");
  return {
    generatedAt: new Date().toISOString(),
    today: result.today,
    timezone: result.settings.timezone,
    filters: reportFilterDescription(result),
    total: result.rows.length,
    statusCounts,
    incomplete,
    deliveredWithoutUkPayment,
    paymentsToClarify: Number(rejectedResult.rows[0]?.count ?? 0),
    controlCounts,
    payments: { fssp: reportMoneyText(fsspTotal), uk: reportMoneyText(ukTotal) },
  };
};

const buildOrderWorkbook = async (
  rows: ReportOrderRow[],
  settings: ReturnType<typeof controlSettingsResponse>,
  today: string,
  columns: string[],
  filterDescription: string,
  paymentsToClarify: number,
) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FSSP Control";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;
  const controls = rows.map((row) => reportControlSnapshot(row, settings, today));
  const summary = workbook.addWorksheet("Сводка");
  summary.columns = [{ width: 34 }, { width: 24 }, { width: 42 }];
  summary.mergeCells("A1:C1");
  summary.getCell("A1").value = "Отчёт по постановлениям ФССП";
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "173B63" } };
  summary.getCell("A2").value = "Сформирован";
  summary.getCell("B2").value = new Date();
  summary.getCell("B2").numFmt = "dd.mm.yyyy hh:mm";
  summary.getCell("A3").value = "Часовой пояс";
  summary.getCell("B3").value = settings.timezone;
  summary.getCell("A4").value = "Выборка";
  summary.mergeCells("B4:C4");
  summary.getCell("B4").value = filterDescription || "вся выборка";
  summary.getCell("A5").value = "Записей";
  summary.getCell("B5").value = rows.length;
  summary.getCell("A6").value = "Контрольная дата";
  summary.getCell("B6").value = reportDateDisplay(today);
  const summaryHeader = summary.addRow(["Показатель", "Значение", "Комментарий"]);
  summaryHeader.font = { bold: true, color: { argb: "FFFFFF" } };
  summaryHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "173B63" } };
  summary.addRow(["Подтверждено ФССП", reportMoneyNumber(reportMoneyText(rows.reduce((sum, row) => sum + reportMoneyCents(row.fssp_total), 0n))), "Отдельный этап платежа"]);
  summary.addRow(["Подтверждено УК", reportMoneyNumber(reportMoneyText(rows.reduce((sum, row) => sum + reportMoneyCents(row.uk_total), 0n))), "Отдельный этап платежа"]);
  const statusCounts: Record<string, number> = {};
  const controlCounts: Record<string, number> = {};
  rows.forEach((row, index) => {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    controlCounts[controls[index].state] = (controlCounts[controls[index].state] ?? 0) + 1;
  });
  summary.addRow(["Неполные реквизиты", rows.filter((row) => row.incomplete).length, "Требуют проверки"]);
  summary.addRow(["Вручено без подтверждённого платежа УК", rows.filter((row) => row.shipment_delivered_at && !row.uk_last_payment_date).length, "Для уточнения"]);
  summary.addRow(["Платежи к уточнению", paymentsToClarify, "События с блокирующими предупреждениями"]);
  summary.addRow(["Состояния контроля", Object.entries(controlCounts).map(([key, count]) => `${reportControlStateLabels[key] ?? key}: ${count}`).join(", "), ""]);
  summary.addRow(["Состояния постановлений", Object.entries(statusCounts).map(([key, count]) => `${reportStatusLabels[key] ?? key}: ${count}`).join(", "), ""]);
  summary.eachRow((row) => {
    row.eachCell((cell) => { cell.alignment = { vertical: "top", wrapText: true }; });
  });
  summary.views = [{ state: "frozen", ySplit: 7 }];
  summary.pageSetup = { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  const registry = workbook.addWorksheet("Реестр");
  registry.columns = columns.map((key) => ({ key, width: reportColumnDefinitions[key].width }));
  registry.mergeCells(1, 1, 1, columns.length);
  registry.getCell(1, 1).value = "Реестр постановлений ФССП";
  registry.getCell(1, 1).font = { bold: true, size: 15, color: { argb: "173B63" } };
  registry.mergeCells(2, 1, 2, columns.length);
  registry.getCell(2, 1).value = `${filterDescription || "вся выборка"}; сформирован ${new Date().toLocaleString("ru-RU")} (${settings.timezone})`;
  registry.getCell(2, 1).alignment = { wrapText: true };
  registry.mergeCells(3, 1, 3, columns.length);
  registry.getCell(3, 1).value = `Записей: ${rows.length}. Денежные суммы подтверждённых событий разделены по этапам ФССП и УК.`;
  registry.addRow([]);
  registry.addRow([]);
  registry.addRow([]);
  const headerRow = registry.addRow(columns.map((key) => reportColumnDefinitions[key].header));
  headerRow.font = { bold: true, color: { argb: "FFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "173B63" } };
  headerRow.alignment = { vertical: "middle", wrapText: true };
  headerRow.height = 32;
  rows.forEach((row, index) => {
    const excelRow = registry.addRow(columns.map((key) => reportCellValue(key, row, controls[index])));
    excelRow.eachCell((cell, columnNumber) => {
      const key = columns[columnNumber - 1];
      const definition = reportColumnDefinitions[key];
      cell.alignment = { vertical: "top", wrapText: true };
      if (definition.kind === "date") cell.numFmt = "dd.mm.yyyy";
      if (definition.kind === "money") cell.numFmt = '#,##0.00';
      if (definition.kind === "text") cell.numFmt = "@";
    });
  });
  if (columns.length > 0) registry.autoFilter = { from: { row: 7, column: 1 }, to: { row: Math.max(7, 7 + rows.length), column: columns.length } };
  registry.views = [{ state: "frozen", ySplit: 7 }];
  registry.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  registry.pageSetup.printTitlesRow = "7:7";
  registry.headerFooter.oddFooter = "Страница &P из &N";
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const actionSelectSql = `
  SELECT a.id, a.order_id, a.title, a.description, a.due_date, a.manual_due_date,
         a.control_basis, a.source_event_type, a.source_event_id, a.status, a.result,
         a.completed_at, a.assigned_to, u.display_name AS assigned_name, a.version,
         a.created_at, a.updated_at, o.public_code AS order_public_code,
         d.full_name AS debtor_name, o.status AS order_status
  FROM actions a
  JOIN orders o ON o.id = a.order_id
  JOIN debtors d ON d.id = o.debtor_id
  LEFT JOIN users u ON u.id = a.assigned_to
`;

const actionRowFor = async (queryable: Pick<Pool, "query"> | PoolClient, id: string) => {
  const result = await queryable.query<ActionRow>(`${actionSelectSql} WHERE a.id = $1`, [id]);
  return result.rows[0] ?? null;
};

const preparePdf = async (filename: string, contents: Buffer): Promise<PreparedPdf> => {
  try {
    return { filename: sanitizeFilename(filename), contents, preview: await parsePdfPreview(contents), parseError: null };
  } catch {
    return {
      filename: sanitizeFilename(filename),
      contents,
      preview: null,
      parseError: "Не удалось прочитать текстовый слой PDF; OCR не выполнялся.",
    };
  }
};

const registerImportBatch = async (
  db: Pool,
  prepared: PreparedPdf[],
  actorId: string,
  requestId: string,
  requestLog: { error: (error: unknown, message?: string) => void },
): Promise<RegisteredImport> => {
  if (prepared.length === 0) throw new Error("empty_import_package");
  const batchId = randomUUID();
  const stored: Array<{ storageKey: string; documentId: string; file: PreparedPdf }> = [];
  const client = await db.connect();
  try {
    for (const file of prepared) {
      const documentId = randomUUID();
      const storageKey = `${new Date().toISOString().slice(0, 10)}/${documentId}-${file.filename}`;
      await documentStorage.put(storageKey, file.contents);
      stored.push({ storageKey, documentId, file });
    }

    await client.query("BEGIN");
    const resolutionNumbers = prepared
      .map((file) => extractedString(file.preview?.extracted, "resolutionNumber"))
      .filter((value): value is string => Boolean(value));
    const hashes = prepared.map((file) => createHash("sha256").update(file.contents).digest("hex"));
    const existingResolutions = await client.query<{ resolution_number: string }>(
      "SELECT resolution_number FROM orders WHERE resolution_number = ANY($1::text[]) AND status <> 'archived'",
      [resolutionNumbers],
    );
    const existingHashes = await client.query<{ sha256: string }>(
      "SELECT sha256 FROM documents WHERE sha256 = ANY($1::text[])",
      [hashes],
    );
    const existingResolutionSet = new Set(existingResolutions.rows.map((row) => row.resolution_number.toLowerCase()));
    const existingHashSet = new Set(existingHashes.rows.map((row) => row.sha256.toLowerCase()));
    const seenKeys = new Set<string>();
    const files: RegisteredImport["files"] = [];
    const items: RegisteredImport["items"] = [];
    let hasFailedFiles = false;

    await client.query(
      `
        INSERT INTO import_batches (id, created_by, status, parser_version)
        VALUES ($1, $2, 'ready_for_review', $3)
      `,
      [batchId, actorId, PDF_PARSER_VERSION],
    );

    for (const [index, storedFile] of stored.entries()) {
      const file = storedFile.file;
      const preview = file.preview;
      const documentId = storedFile.documentId;
      const digest = hashes[index];
      const batchFileId = randomUUID();
      const itemId = randomUUID();
      const fileFailed = !preview;
      const fileWarnings: unknown[] = preview
        ? [...preview.warnings]
        : [{ code: "pdf_extraction_failed", message: file.parseError ?? "Не удалось прочитать PDF." }];
      const extracted = preview ? (preview.extracted as unknown as JsonObject) : emptyPdfExtracted();
      const key = duplicateKeyFor(extracted);
      const duplicateReasons: string[] = [];
      if (key && seenKeys.has(key)) duplicateReasons.push("same_batch");
      if (key && key.startsWith("resolution:") && existingResolutionSet.has(key.slice("resolution:".length))) {
        duplicateReasons.push("existing_order");
      }
      if (existingHashSet.has(digest.toLowerCase())) duplicateReasons.push("same_file");
      if (duplicateReasons.length > 0) {
        fileWarnings.push({
          code: "possible_duplicate",
          message: `Возможный дубль: ${duplicateReasons.join(", ")}. Проверьте перед подтверждением.`,
        });
      }
      if (key) seenKeys.add(key);
      const duplicateState = duplicateReasons.length > 0 ? "possible_duplicate" : "unknown";
      const pageCount = preview?.pageCount ?? null;
      await client.query(
        `
          INSERT INTO documents
            (id, storage_key, sha256, byte_size, mime_type, original_filename, uploaded_by)
          VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6)
        `,
        [documentId, storedFile.storageKey, digest, file.contents.length, file.filename, actorId],
      );
      await client.query(
        `
          INSERT INTO import_batch_files
            (id, batch_id, source_document_id, checksum, page_count, status, error_message)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [batchFileId, batchId, documentId, digest, pageCount, fileFailed ? "failed" : "ready", file.parseError],
      );
      await client.query(
        `
          INSERT INTO import_items
            (id, batch_file_id, page_start, page_end, raw_text, extracted_data, manual_data, warnings, duplicate_state)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
        `,
        [
          itemId,
          batchFileId,
          preview?.pageStart ?? 1,
          preview?.pageEnd ?? 1,
          preview?.rawText ?? null,
          JSON.stringify(extracted),
          JSON.stringify(manualEmployerFields()),
          JSON.stringify(fileWarnings),
          duplicateState,
        ],
      );
      files.push({
        id: batchFileId,
        sourceDocumentId: documentId,
        filename: file.filename,
        pageCount,
        status: fileFailed ? "failed" : "ready",
        error: file.parseError,
      });
      items.push({
        id: itemId,
        batchFileId,
        filename: file.filename,
        fileStatus: fileFailed ? "failed" : "ready",
        error: file.parseError,
        pageStart: preview?.pageStart ?? 1,
        pageEnd: preview?.pageEnd ?? 1,
        extracted,
        manualFields: manualEmployerFields(),
        warnings: fileWarnings,
        duplicateState,
      });
      hasFailedFiles ||= fileFailed;
    }
    await audit(client, {
      actorId,
      entityType: "import_batch",
      entityId: batchId,
      action: "preview_created",
      newValues: {
        fileCount: files.length,
        itemCount: items.length,
        failedFileCount: files.filter((file) => file.status === "failed").length,
        parserVersion: PDF_PARSER_VERSION,
      },
      requestId,
    });
    await client.query("COMMIT");
    return { batchId, files, items, hasFailedFiles };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    for (const file of stored) {
      await documentStorage.remove(file.storageKey).catch((cleanupError) => requestLog.error(cleanupError, "PDF cleanup failed"));
    }
    throw error;
  } finally {
    client.release();
  }
};

const importItemResponse = (row: ImportItemRow) => ({
  id: row.id,
  batchId: row.batch_id,
  batchStatus: row.batch_status,
  parserVersion: row.parser_version,
  filename: row.original_filename,
  sourceDocumentId: row.source_document_id,
  fileStatus: row.file_status,
  pageCount: row.page_count,
  pageStart: row.page_start,
  pageEnd: row.page_end,
  extracted: jsonObject(row.extracted_data),
  manualFields: {
    employerName: extractedString(row.manual_data, "employerName"),
    employerTaxId: extractedString(row.manual_data, "employerTaxId"),
    employerAddress: extractedString(row.manual_data, "employerAddress"),
  },
  exclusionReason: extractedString(row.manual_data, "exclusionReason"),
  warnings: jsonArray(row.warnings),
  duplicateState: row.duplicate_state,
  decision: row.decision,
});

const safeUserSnapshot = (row: UserRow) => ({
  id: row.id,
  login: row.login,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  isActive: row.is_active,
});

const allowedMimeTypes = new Set([
  "application/octet-stream",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
]);

for (const contentType of ["application/octet-stream", "application/pdf", "image/jpeg", "image/png", "text/plain"]) {
  app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
}

await app.register(fastifyMultipart, {
  limits: { files: 20, fileSize: maxUploadBytes, parts: 24 },
  throwFileSizeLimit: true,
});

app.get("/healthz", async () => ({
  status: "ok",
  service: "fssp-control",
  stage: "auth",
}));

app.get("/readyz", async (request, reply) => {
  if (!pool) {
    if (databaseRequired) {
      return reply.code(503).send({ status: "not_ready", reason: "DATABASE_URL is not configured" });
    }
    return { status: "ready", database: "not_configured", stage: "auth" };
  }

  try {
    await pool.query("select 1");
    const migrationTable = await pool.query<{ present: boolean }>(
      "select to_regclass('public.schema_migrations') is not null as present",
    );
    if (!migrationTable.rows[0]?.present) {
      return reply.code(503).send({ status: "not_ready", reason: "database_schema_not_migrated" });
    }
    const appliedMigrations = await pool.query("select 1 from schema_migrations limit 1");
    if (appliedMigrations.rowCount === 0) {
      return reply.code(503).send({ status: "not_ready", reason: "database_schema_not_migrated" });
    }
    return { status: "ready", database: "connected", stage: "auth" };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ status: "not_ready", reason: "database_unavailable" });
  }
});

app.get("/api/bootstrap", async () => ({
  application: "fssp-control",
  stage: "auth",
  features: {
    authentication: true,
    documents: true,
    audit: true,
    pdfImport: true,
    orderRegistry: true,
    shipmentRegistry: true,
    excelImport: false,
    xlsxExport: true,
    paymentRegistry: true,
    control: true,
    domainSchema: true,
  },
}));

app.post("/api/auth/bootstrap", async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  if (process.env.ALLOW_BOOTSTRAP !== "true") {
    return reply.code(403).send({ error: "bootstrap_disabled" });
  }

  const body = isRecord(request.body) ? request.body : {};
  const login = stringValue(body.login);
  const displayName = stringValue(body.displayName);
  const password = body.password;
  const email = body.email === undefined || body.email === null ? null : stringValue(body.email);
  if (!login || !displayName || !validatePassword(password) || normalizeLogin(login).length < 3) {
    return reply.code(400).send({ error: "invalid_bootstrap_payload" });
  }
  if (body.email !== undefined && body.email !== null && (!email || email.length > 320)) {
    return reply.code(400).send({ error: "invalid_email" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(74829301)");
    const existing = await client.query("SELECT 1 FROM users LIMIT 1");
    if (existing.rowCount !== 0) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "bootstrap_already_completed" });
    }
    const passwordHash = await hashPassword(password);
    const inserted = await client.query<UserRow>(
      `
        INSERT INTO users (login, email, display_name, password_hash, role)
        VALUES ($1, $2, $3, $4, 'admin')
        RETURNING id, login, email, display_name, role, is_active
      `,
      [normalizeLogin(login), email, displayName.trim(), passwordHash],
    );
    const user = inserted.rows[0];
    await audit(client, {
      actorId: user.id,
      entityType: "user",
      entityId: user.id,
      action: "bootstrap_created",
      newValues: safeUserSnapshot(user),
      requestId: request.id,
    });
    await client.query("COMMIT");
    return reply.code(201).send({ user: userResponse(user) });
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error(error);
    return reply.code(500).send({ error: "bootstrap_failed" });
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const body = isRecord(request.body) ? request.body : {};
  const login = stringValue(body.login);
  const password = stringValue(body.password);
  if (!login || !password) {
    return reply.code(400).send({ error: "login_and_password_required" });
  }

  const result = await db.query<UserRow>(
    `
      SELECT id, login, email, display_name, role, is_active, password_hash
      FROM users
      WHERE lower(login) = lower($1) AND is_active = true
    `,
    [login],
  );
  const user = result.rows[0];
  if (!user?.password_hash) {
    return reply.code(401).send({ error: "invalid_credentials" });
  }

  let passwordMatches = false;
  try {
    passwordMatches = await verifyPassword(user.password_hash, password);
  } catch (error) {
    request.log.error(error);
  }
  if (!passwordMatches) {
    return reply.code(401).send({ error: "invalid_credentials" });
  }

  const token = createSessionToken();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const session = await client.query<{ id: string }>(
      `
        INSERT INTO user_sessions (user_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '8 hours')
        RETURNING id
      `,
      [user.id, hashSessionToken(token)],
    );
    await audit(client, {
      actorId: user.id,
      entityType: "user_session",
      entityId: session.rows[0].id,
      action: "login",
      newValues: { userId: user.id },
      requestId: request.id,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error(error);
    return reply.code(500).send({ error: "login_failed" });
  } finally {
    client.release();
  }

  setSessionCookie(reply, token);
  return { user: userResponse(user) };
});

app.post("/api/auth/logout", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser || !request.authSessionId) return;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [request.authSessionId]);
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "user_session",
      entityId: request.authSessionId,
      action: "logout",
      requestId: request.id,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error(error);
    return reply.code(500).send({ error: "logout_failed" });
  } finally {
    client.release();
  }
  clearSessionCookie(reply);
  return { ok: true };
});

app.get("/api/auth/me", { preHandler: requireAuth(pool) }, async (request) => ({
  user: request.authUser,
}));

app.get("/api/users", { preHandler: requireRole(pool, ["admin"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const result = await db.query<UserRow>(
    `
      SELECT id, login, email, display_name, role, is_active
      FROM users
      ORDER BY lower(display_name), lower(login)
    `,
  );
  return { users: result.rows.map(userResponse) };
});

app.post("/api/users", { preHandler: requireRole(pool, ["admin"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const body = isRecord(request.body) ? request.body : {};
  const login = stringValue(body.login);
  const displayName = stringValue(body.displayName);
  const password = body.password;
  const email = body.email === undefined || body.email === null ? null : stringValue(body.email);
  const role = body.role;
  if (!login || normalizeLogin(login).length < 3 || !displayName || !validatePassword(password) || !validRole(role)) {
    return reply.code(400).send({ error: "invalid_user_payload" });
  }
  if (body.email !== undefined && body.email !== null && (!email || email.length > 320)) {
    return reply.code(400).send({ error: "invalid_email" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<UserRow>(
      `
        INSERT INTO users (login, email, display_name, password_hash, role)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, login, email, display_name, role, is_active
      `,
      [normalizeLogin(login), email, displayName.trim(), await hashPassword(password), role],
    );
    const user = inserted.rows[0];
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "user",
      entityId: user.id,
      action: "created",
      newValues: safeUserSnapshot(user),
      requestId: request.id,
    });
    await client.query("COMMIT");
    return reply.code(201).send({ user: userResponse(user) });
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") {
      return reply.code(409).send({ error: "login_or_email_already_exists" });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "user_creation_failed" });
  } finally {
    client.release();
  }
});

app.patch<{ Params: { id: string } }>(
  "/api/users/:id",
  { preHandler: requireRole(pool, ["admin"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_user_id" });
    const body = isRecord(request.body) ? request.body : {};
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<UserRow>(
        "SELECT id, login, email, display_name, role, is_active FROM users WHERE id = $1 FOR UPDATE",
        [request.params.id],
      );
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "user_not_found" });
      }

      const nextRole = body.role === undefined ? current.role : body.role;
      const nextActive = body.isActive === undefined ? current.is_active : body.isActive;
      if (!validRole(nextRole) || typeof nextActive !== "boolean") {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "invalid_user_update" });
      }
      if (current.id === request.authUser.id && (nextRole !== "admin" || nextActive === false)) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "cannot_disable_or_demote_current_admin" });
      }
      if (current.role === "admin" && current.is_active && (nextRole !== "admin" || nextActive === false)) {
        const admins = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM users WHERE role = 'admin' AND is_active = true AND id <> $1",
          [current.id],
        );
        if (Number(admins.rows[0].count) === 0) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "last_active_admin" });
        }
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        values.push(value);
        updates.push(`${sql} $${values.length}`);
      };
      if (body.login !== undefined) {
        const login = stringValue(body.login);
        if (!login || normalizeLogin(login).length < 3) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "invalid_login" });
        }
        add("login =", normalizeLogin(login));
      }
      if (body.email !== undefined) {
        if (body.email !== null && (typeof body.email !== "string" || body.email.length > 320)) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "invalid_email" });
        }
        add("email =", body.email);
      }
      if (body.displayName !== undefined) {
        const displayName = stringValue(body.displayName);
        if (!displayName?.trim()) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "invalid_display_name" });
        }
        add("display_name =", displayName.trim());
      }
      if (body.role !== undefined) add("role =", nextRole);
      if (body.isActive !== undefined) add("is_active =", nextActive);
      if (body.password !== undefined) {
        if (!validatePassword(body.password)) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "invalid_password" });
        }
        add("password_hash =", await hashPassword(body.password));
      }
      if (updates.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "no_changes" });
      }
      updates.push("updated_at = now()");
      values.push(request.params.id);
      const updated = await client.query<UserRow>(
        `
          UPDATE users SET ${updates.join(", ")}
          WHERE id = $${values.length}
          RETURNING id, login, email, display_name, role, is_active
        `,
        values,
      );
      const user = updated.rows[0];
      await audit(client, {
        actorId: request.authUser.id,
        entityType: "user",
        entityId: user.id,
        action: "updated",
        oldValues: safeUserSnapshot(current),
        newValues: safeUserSnapshot(user),
        requestId: request.id,
      });
      await client.query("COMMIT");
      return { user: userResponse(user) };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "login_or_email_already_exists" });
      }
      request.log.error(error);
      return reply.code(500).send({ error: "user_update_failed" });
    } finally {
      client.release();
    }
  },
);

app.get("/api/audit", { preHandler: requireRole(pool, ["admin"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const requestedLimit = Number(query.limit ?? 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const result = await db.query(
    `
      SELECT id, actor_id, occurred_at, entity_type, entity_id, action, old_values, new_values, request_id
      FROM audit_log
      ORDER BY occurred_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return { entries: result.rows };
});

const readTextField = (value: unknown, maxLength: number, required = false) => {
  if (value === undefined) return { ok: !required, value: null as string | null };
  if (value === null) return { ok: !required, value: null as string | null };
  if (typeof value !== "string") return { ok: false, value: null as string | null };
  const normalized = value.trim();
  if (required && !normalized) return { ok: false, value: null as string | null };
  if (normalized.length > maxLength) return { ok: false, value: null as string | null };
  return { ok: true, value: normalized || null };
};

const orderInput = (body: JsonObject) => {
  const debtor = isRecord(body.debtor) ? body.debtor : body;
  const employer = body.employer === null ? null : isRecord(body.employer) ? body.employer : {};
  const proceeding = body.proceeding === null ? null : isRecord(body.proceeding) ? body.proceeding : {};
  const fullName = readTextField(debtor.fullName ?? debtor.name, 500, true);
  const debtorTaxId = readTextField(debtor.taxId, 20);
  const debtorBirthDate = normalizeDateValue(debtor.birthDate);
  const debtorAddress = readTextField(debtor.address, 1000);
  const employerName = readTextField(employer?.name, 500);
  const employerTaxId = readTextField(employer?.taxId, 20);
  const employerAddress = readTextField(employer?.address, 1000);
  const proceedingNumber = readTextField(proceeding?.number, 200);
  const proceedingDate = normalizeDateValue(proceeding?.date);
  const proceedingDocument = readTextField(proceeding?.enforcementDocument, 500);
  const proceedingAuthority = readTextField(proceeding?.authority, 500);
  const proceedingCaseReference = readTextField(proceeding?.caseReference, 200);
  const resolutionNumber = readTextField(body.resolutionNumber, 200);
  const resolutionDate = normalizeDateValue(body.resolutionDate);
  const manualEffectiveDate = normalizeDateValue(body.manualEffectiveDate);
  const optionalDateValid = (raw: unknown, normalized: string | null) => raw === undefined || raw === null || raw === "" || normalized !== null;
  const withholding = body.withholdingPercent === undefined || body.withholdingPercent === null || body.withholdingPercent === ""
    ? null
    : Number(body.withholdingPercent);
  const responsibleProvided = body.responsibleId !== undefined && body.responsibleId !== null && body.responsibleId !== "";
  const responsibleId = responsibleProvided ? stringValue(body.responsibleId) : null;
  const status = body.status === undefined ? "needs_review" : stringValue(body.status);
  return {
    valid: fullName.ok && debtorTaxId.ok && debtorAddress.ok && employerName.ok && employerTaxId.ok
      && employerAddress.ok && proceedingNumber.ok && proceedingDocument.ok && proceedingAuthority.ok && proceedingCaseReference.ok
      && optionalDateValid(debtor.birthDate, debtorBirthDate)
      && optionalDateValid(proceeding?.date, proceedingDate)
      && Boolean((body.resolutionDate === undefined || body.resolutionDate === null || body.resolutionDate === "" || resolutionDate !== null))
      && Boolean((body.manualEffectiveDate === undefined || body.manualEffectiveDate === null || body.manualEffectiveDate === "" || manualEffectiveDate !== null))
      && (body.withholdingPercent === undefined || body.withholdingPercent === null || body.withholdingPercent === "" || (Number.isFinite(withholding) && withholding! >= 0 && withholding! <= 100))
      && (!responsibleProvided || (responsibleId !== null && validUuid(responsibleId)))
      && (status !== null && orderStatusValues.has(status)),
    fullName: fullName.value,
    debtorTaxId: debtorTaxId.value,
    debtorBirthDate,
    debtorAddress: debtorAddress.value,
    employerName: employerName.value,
    employerTaxId: employerTaxId.value,
    employerAddress: employerAddress.value,
    proceedingNumber: proceedingNumber.value,
    proceedingDate,
    proceedingDocument: proceedingDocument.value,
    proceedingAuthority: proceedingAuthority.value,
    proceedingCaseReference: proceedingCaseReference.value,
    resolutionNumber: resolutionNumber.value,
    resolutionDate,
    manualEffectiveDate,
    withholdingPercent: withholding,
    responsibleId,
    status,
  };
};

const validateResponsible = async (client: PoolClient, responsibleId: string | null) => {
  if (!responsibleId) return true;
  const result = await client.query("SELECT 1 FROM users WHERE id = $1 AND is_active = true", [responsibleId]);
  return result.rowCount === 1;
};

const writeOrderFieldReviews = async (
  client: PoolClient,
  orderId: string,
  input: ReturnType<typeof orderInput>,
  reviewedBy: string,
) => {
  const fields = [
    { key: "employer_name", extracted: input.employerName, manual: input.employerName },
    { key: "employer_tax_id", extracted: null, manual: input.employerTaxId },
    { key: "employer_address", extracted: input.employerAddress, manual: input.employerAddress },
  ];
  for (const field of fields) {
    const status = field.manual ? "verified" : "missing";
    await client.query(
      `
        INSERT INTO order_field_reviews
          (order_id, field_key, status, extracted_value, manual_value, reviewed_by)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
      `,
      [
        orderId,
        field.key,
        status,
        field.extracted === null ? null : JSON.stringify(field.extracted),
        field.manual === null ? null : JSON.stringify(field.manual),
        reviewedBy,
      ],
    );
  }
};

app.get("/api/order-assignees", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const result = await db.query<{ id: string; display_name: string; role: UserRole }>(
    "SELECT id, display_name, role FROM users WHERE is_active = true ORDER BY lower(display_name), lower(login)",
  );
  return { users: result.rows.map((row) => ({ id: row.id, displayName: row.display_name, role: row.role })) };
});

app.get("/api/orders", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const search = normalizeSearchText(query.q);
  const searchMode = normalizeSearchMode(query.mode);
  if (!searchMode) return reply.code(400).send({ error: "invalid_search_mode" });
  const status = typeof query.status === "string" ? query.status : "";
  if (status && status !== "all" && !orderStatusValues.has(status)) return reply.code(400).send({ error: "invalid_order_status" });
  const responsibleId = typeof query.responsibleId === "string" && query.responsibleId ? query.responsibleId : "";
  if (responsibleId && !validUuid(responsibleId)) return reply.code(400).send({ error: "invalid_responsible_id" });
  const incomplete = query.incomplete === true || query.incomplete === "true";
  const requestedPage = Number(query.page ?? 1);
  const requestedPageSize = Number(query.pageSize ?? 25);
  const pageSize = Number.isInteger(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 1), 100) : 25;
  const page = Number.isInteger(requestedPage) ? Math.max(requestedPage, 1) : 1;
  const sortKey = typeof query.sort === "string" && orderSortColumns[query.sort] ? query.sort : "updatedAt";
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const where: string[] = [];
  const values: unknown[] = [];
  if (!status) where.push("o.status <> 'archived'");
  if (status && status !== "all") {
    values.push(status);
    where.push(`o.status = $${values.length}`);
  }
  if (search) {
    values.push(searchMode === "fulltext" ? search : `%${search.toLowerCase()}%`);
    where.push(searchPredicate(
      ["o.public_code", "d.full_name", "d.external_ids->>'inn'", "e.name", "e.tax_id", "o.resolution_number", "p.proceeding_number"],
      searchMode,
      `$${values.length}`,
    ));
  }
  if (responsibleId) {
    values.push(responsibleId);
    where.push(`o.responsible_id = $${values.length}`);
  }
  if (incomplete) {
    where.push(`(
      o.employer_id IS NULL OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (field_key) field_key, status
          FROM order_field_reviews
          WHERE order_id = o.id
            AND field_key IN ('employer_name', 'employer_tax_id', 'employer_address')
          ORDER BY field_key, updated_at DESC, id DESC
        ) filter_review
        WHERE filter_review.status <> 'verified'
      )
    )`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countResult = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${orderSelectSql} ${whereSql}) registry`, values);
  const total = Number(countResult.rows[0]?.count ?? 0);
  const offset = (page - 1) * pageSize;
  const listValues = [...values, pageSize, offset];
  const result = await db.query<OrderListRow>(
    `${orderSelectSql} ${whereSql} ORDER BY ${orderSortColumns[sortKey]} ${direction}, o.id LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
    listValues,
  );
  return { page, pageSize, total, pages: Math.ceil(total / pageSize), orders: result.rows.map(orderResponse) };
});

app.get<{ Params: { id: string } }>("/api/orders/:id", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_order_id" });
  const result = await db.query<OrderListRow>(`${orderSelectSql} WHERE o.id = $1`, [request.params.id]);
  const row = result.rows[0];
  if (!row) return reply.code(404).send({ error: "order_not_found" });
  const history = await db.query(
    `SELECT id, actor_id, occurred_at, action, old_values, new_values, request_id
     FROM audit_log WHERE entity_type = 'order' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
    [request.params.id],
  );
  return { order: orderResponse(row), history: history.rows };
});

app.post("/api/orders", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const body = isRecord(request.body) ? request.body : {};
  const input = orderInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_order_payload" });
  if (input.status === "archived") return reply.code(400).send({ error: "invalid_initial_order_status" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!(await validateResponsible(client, input.responsibleId))) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "responsible_user_not_active" });
    }
    const debtor = await client.query<{ id: string }>(
      `INSERT INTO debtors (full_name, date_of_birth, address, external_ids)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [input.fullName, input.debtorBirthDate, input.debtorAddress, JSON.stringify(input.debtorTaxId ? { inn: input.debtorTaxId } : {})],
    );
    let proceedingId: string | null = null;
    if (input.proceedingNumber || input.proceedingDate || input.proceedingDocument || input.proceedingAuthority || input.proceedingCaseReference) {
      const proceeding = await client.query<{ id: string }>(
        `INSERT INTO enforcement_proceedings
           (proceeding_number, proceeding_date, enforcement_document, authority, case_reference, source_identifiers)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [input.proceedingNumber, input.proceedingDate, input.proceedingDocument, input.proceedingAuthority,
          input.proceedingCaseReference, JSON.stringify({ source: "manual_registry" })],
      );
      proceedingId = proceeding.rows[0].id;
    }
    let employerId: string | null = null;
    if (input.employerName) {
      const employer = await client.query<{ id: string }>(
        `INSERT INTO employers (name, tax_id, address, status) VALUES ($1, $2, $3, 'needs_review') RETURNING id`,
        [input.employerName, input.employerTaxId, input.employerAddress],
      );
      employerId = employer.rows[0].id;
    }
    const employerSnapshot = input.employerName
      ? JSON.stringify({ name: input.employerName, taxId: input.employerTaxId, address: input.employerAddress, source: "manual" })
      : null;
    const order = await client.query<{ id: string; public_code: string; version: string | number }>(
      `INSERT INTO orders
         (debtor_id, proceeding_id, employer_id, employer_snapshot, resolution_number, resolution_date,
          withholding_percent, manual_effective_date, status, responsible_id, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, public_code, version`,
      [debtor.rows[0].id, proceedingId, employerId, employerSnapshot, input.resolutionNumber, input.resolutionDate,
        input.withholdingPercent, input.manualEffectiveDate, input.status, input.responsibleId, request.authUser.id],
    );
    await writeOrderFieldReviews(client, order.rows[0].id, input, request.authUser.id);
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "order",
      entityId: order.rows[0].id,
      action: "created",
      newValues: { publicCode: order.rows[0].public_code, status: input.status, debtorName: input.fullName, employerName: input.employerName },
      requestId: request.id,
    });
    await client.query("COMMIT");
    return reply.code(201).send({ order: { id: order.rows[0].id, publicCode: order.rows[0].public_code, version: Number(order.rows[0].version) } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Order creation failed");
    return reply.code(500).send({ error: "order_creation_failed" });
  } finally {
    client.release();
  }
});

app.patch<{ Params: { id: string } }>("/api/orders/:id", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_order_id" });
  const body = isRecord(request.body) ? request.body : {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return reply.code(400).send({ error: "expected_version_required" });
  const input = orderInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_order_payload" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<{
      id: string;
      version: string | number;
      debtor_id: string;
      proceeding_id: string | null;
      employer_id: string | null;
      public_code: string;
      status: string;
    }>(
      `SELECT id, version, debtor_id, proceeding_id, employer_id, public_code, status
       FROM orders WHERE id = $1 FOR UPDATE`,
      [request.params.id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "order_not_found" });
    }
    if (Number(current.version) !== expectedVersion) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "order_version_conflict", currentVersion: Number(current.version) });
    }
    if (!(await validateResponsible(client, input.responsibleId))) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "responsible_user_not_active" });
    }

    await client.query(
      `UPDATE debtors
       SET full_name = $1, date_of_birth = $2, address = $3,
           external_ids = $4::jsonb, updated_at = now()
       WHERE id = $5`,
      [input.fullName, input.debtorBirthDate, input.debtorAddress, JSON.stringify(input.debtorTaxId ? { inn: input.debtorTaxId } : {}), current.debtor_id],
    );
    let proceedingId: string | null = null;
    if (input.proceedingNumber || input.proceedingDate || input.proceedingDocument || input.proceedingAuthority || input.proceedingCaseReference) {
      if (current.proceeding_id) {
        await client.query(
          `UPDATE enforcement_proceedings
           SET proceeding_number = $1, proceeding_date = $2, enforcement_document = $3,
               authority = $4, case_reference = $5, updated_at = now()
           WHERE id = $6`,
          [input.proceedingNumber, input.proceedingDate, input.proceedingDocument, input.proceedingAuthority,
            input.proceedingCaseReference, current.proceeding_id],
        );
        proceedingId = current.proceeding_id;
      } else {
        const proceeding = await client.query<{ id: string }>(
          `INSERT INTO enforcement_proceedings
             (proceeding_number, proceeding_date, enforcement_document, authority, case_reference, source_identifiers)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
          [input.proceedingNumber, input.proceedingDate, input.proceedingDocument, input.proceedingAuthority,
            input.proceedingCaseReference, JSON.stringify({ source: "manual_registry" })],
        );
        proceedingId = proceeding.rows[0].id;
      }
    }
    let employerId: string | null = null;
    if (input.employerName) {
      if (current.employer_id) {
        await client.query(
          `UPDATE employers SET name = $1, tax_id = $2, address = $3, status = 'needs_review', updated_at = now() WHERE id = $4`,
          [input.employerName, input.employerTaxId, input.employerAddress, current.employer_id],
        );
        employerId = current.employer_id;
      } else {
        const employer = await client.query<{ id: string }>(
          `INSERT INTO employers (name, tax_id, address, status) VALUES ($1, $2, $3, 'needs_review') RETURNING id`,
          [input.employerName, input.employerTaxId, input.employerAddress],
        );
        employerId = employer.rows[0].id;
      }
    }
    const employerSnapshot = input.employerName
      ? JSON.stringify({ name: input.employerName, taxId: input.employerTaxId, address: input.employerAddress, source: "manual" })
      : null;
    const updated = await client.query<{ id: string; public_code: string; version: string | number }>(
      `UPDATE orders
       SET proceeding_id = $1, employer_id = $2, employer_snapshot = $3::jsonb,
           resolution_number = $4, resolution_date = $5, withholding_percent = $6,
           manual_effective_date = $7, status = $8, responsible_id = $9,
           archived_at = CASE WHEN $8::order_status = 'archived'::order_status THEN coalesce(archived_at, now()) ELSE NULL END,
           archived_by = CASE WHEN $8::order_status = 'archived'::order_status THEN $10::uuid ELSE NULL END,
           version = version + 1, updated_at = now()
       WHERE id = $11 AND version = $12
       RETURNING id, public_code, version`,
      [proceedingId, employerId, employerSnapshot, input.resolutionNumber, input.resolutionDate, input.withholdingPercent,
        input.manualEffectiveDate, input.status, input.responsibleId, request.authUser.id, request.params.id, expectedVersion],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "order_version_conflict" });
    }
    await writeOrderFieldReviews(client, request.params.id, input, request.authUser.id);
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "order",
      entityId: request.params.id,
      action: input.status === "archived" && current.status !== "archived" ? "archived" : "updated",
      oldValues: { version: expectedVersion, status: current.status, publicCode: current.public_code },
      newValues: { version: Number(updated.rows[0].version), status: input.status, responsibleId: input.responsibleId },
      requestId: request.id,
    });
    await client.query("COMMIT");
    return { order: { id: updated.rows[0].id, publicCode: updated.rows[0].public_code, version: Number(updated.rows[0].version), status: input.status } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Order update failed");
    return reply.code(500).send({ error: "order_update_failed" });
  } finally {
    client.release();
  }
});

app.get<{ Params: { id: string } }>("/api/orders/:id/history", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_order_id" });
  const result = await db.query(
    `SELECT id, actor_id, occurred_at, action, old_values, new_values, request_id
     FROM audit_log WHERE entity_type = 'order' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
    [request.params.id],
  );
  return { entries: result.rows };
});

const shipmentOrderItems = (rows: ShipmentOrderRow[]): ShipmentItemApi[] => rows.map((row, index) => ({
  id: `order-${row.id}`,
  position: index + 1,
  orderId: row.id,
  publicCode: row.public_code,
  debtorName: row.debtor_name,
  employerName: row.employer_name,
  employerTaxId: row.employer_tax_id,
  employerAddress: row.employer_address,
  orderIncomplete: row.order_incomplete,
  employerVerified: row.employer_verified,
  resolutionNumber: row.resolution_number,
  proceedingNumber: row.proceeding_number,
}));

const deriveShipmentValues = (input: ReturnType<typeof shipmentInput>, orders: ShipmentOrderRow[]) => {
  const names = [...new Set(orders.map((row) => row.employer_name).filter((value): value is string => Boolean(value)))];
  const addresses = [...new Set(orders.map((row) => row.employer_address).filter((value): value is string => Boolean(value)))];
  return {
    recipientName: input.recipientName ?? (names.length === 1 ? names[0] : null),
    recipientAddress: input.recipientAddress ?? (addresses.length === 1 ? addresses[0] : null),
    composition: input.composition ?? (orders.length > 0 ? orders.map((row) => row.public_code).join(", ") : null),
  };
};

const shipmentRowFor = async (queryable: Pick<Pool, "query"> | PoolClient, id: string) => {
  const result = await queryable.query<ShipmentListRow>(`${shipmentSelectSql} WHERE s.id = $1`, [id]);
  return result.rows[0] ?? null;
};

app.get("/api/shipments", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
  const status = typeof query.status === "string" ? query.status : "";
  if (status && status !== "all" && !shipmentStatusValues.has(status)) return reply.code(400).send({ error: "invalid_shipment_status" });
  const responsibleId = typeof query.responsibleId === "string" && query.responsibleId ? query.responsibleId : "";
  if (responsibleId && !validUuid(responsibleId)) return reply.code(400).send({ error: "invalid_responsible_id" });
  const requestedPage = Number(query.page ?? 1);
  const requestedPageSize = Number(query.pageSize ?? 25);
  const pageSize = Number.isInteger(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 1), 100) : 25;
  const page = Number.isInteger(requestedPage) ? Math.max(requestedPage, 1) : 1;
  const sortKey = typeof query.sort === "string" && shipmentSortColumns[query.sort] ? query.sort : "updatedAt";
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const where: string[] = [];
  const values: unknown[] = [];
  if (!status) where.push("s.status <> 'archived'");
  if (status && status !== "all") {
    values.push(status);
    where.push(`s.status = $${values.length}`);
  }
  if (search) {
    values.push(`%${search.toLocaleLowerCase()}%`);
    where.push(`lower(concat_ws(' ', s.public_code, s.recipient_name, s.recipient_address, s.tracking_number, s.composition)) LIKE $${values.length}`);
  }
  if (responsibleId) {
    values.push(responsibleId);
    where.push(`s.responsible_id = $${values.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countResult = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${shipmentSelectSql} ${whereSql}) registry`, values);
  const total = Number(countResult.rows[0]?.count ?? 0);
  const listValues = [...values, pageSize, (page - 1) * pageSize];
  const result = await db.query<ShipmentListRow>(
    `${shipmentSelectSql} ${whereSql} ORDER BY ${shipmentSortColumns[sortKey]} ${direction}, s.id LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
    listValues,
  );
  return { page, pageSize, total, pages: Math.ceil(total / pageSize), shipments: result.rows.map(shipmentResponse) };
});

app.get<{ Params: { id: string } }>("/api/shipments/:id", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_shipment_id" });
  const row = await shipmentRowFor(db, request.params.id);
  if (!row) return reply.code(404).send({ error: "shipment_not_found" });
  const history = await db.query(
    `SELECT id, actor_id, occurred_at, action, old_values, new_values, request_id
     FROM audit_log WHERE entity_type = 'shipment' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
    [request.params.id],
  );
  return { shipment: shipmentResponse(row), history: history.rows };
});

app.post("/api/shipments", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const body = isRecord(request.body) ? request.body : {};
  const input = shipmentInput(body);
  if (!input.valid || input.status !== "draft") return reply.code(400).send({ error: "invalid_shipment_payload" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!(await validateResponsible(client, input.responsibleId))) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "responsible_user_not_active" });
    }
    const orders = await shipmentOrderQuery(client, input.orderIds);
    if (orders.length !== input.orderIds.length || orders.some((order) => order.status === "archived")) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "shipment_order_not_available" });
    }
    const derived = deriveShipmentValues(input, orders);
    const inserted = await client.query<{ id: string; public_code: string; version: string | number }>(
      `INSERT INTO shipments
         (recipient_name, recipient_address, composition, tracking_number, shipment_type, return_reason,
          status, responsible_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)
       RETURNING id, public_code, version`,
      [derived.recipientName, derived.recipientAddress, derived.composition, input.trackingNumber,
        input.shipmentType, input.returnReason, input.responsibleId, request.authUser.id],
    );
    for (const [index, order] of orders.entries()) {
      await client.query(
        `INSERT INTO shipment_items (shipment_id, order_id, item_position, order_snapshot)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [inserted.rows[0].id, order.id, index + 1, JSON.stringify(shipmentSnapshot(order))],
      );
    }
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "shipment",
      entityId: inserted.rows[0].id,
      action: "created",
      newValues: { publicCode: inserted.rows[0].public_code, orderIds: input.orderIds, status: "draft" },
      requestId: request.id,
    });
    await client.query("COMMIT");
    const row = await shipmentRowFor(db, inserted.rows[0].id);
    return reply.code(201).send({ shipment: row ? shipmentResponse(row) : { id: inserted.rows[0].id, publicCode: inserted.rows[0].public_code, version: Number(inserted.rows[0].version) } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Shipment creation failed");
    return reply.code(500).send({ error: "shipment_creation_failed" });
  } finally {
    client.release();
  }
});

app.patch<{ Params: { id: string } }>("/api/shipments/:id", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_shipment_id" });
  const body = isRecord(request.body) ? request.body : {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return reply.code(400).send({ error: "expected_version_required" });
  if (body.status === undefined || body.orderIds === undefined || body.recipientName === undefined
    || body.recipientAddress === undefined || body.composition === undefined) {
    return reply.code(400).send({ error: "shipment_payload_complete_required" });
  }
  const input = shipmentInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_shipment_payload" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<{
      id: string; version: string | number; status: string; sent_at: string | Date | null;
      delivered_at: string | Date | null; returned_at: string | Date | null;
      recipient_name: string | null; recipient_address: string | null; composition: string | null;
    }>(
      `SELECT id, version, status, sent_at, delivered_at, returned_at,
              recipient_name, recipient_address, composition
       FROM shipments WHERE id = $1 FOR UPDATE`,
      [request.params.id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "shipment_not_found" });
    }
    if (Number(current.version) !== expectedVersion) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "shipment_version_conflict", currentVersion: Number(current.version) });
    }
    if (!(await validateResponsible(client, input.responsibleId))) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "responsible_user_not_active" });
    }
    const allowedTransitions: Record<string, string[]> = {
      draft: ["draft", "sent", "archived"],
      sent: ["sent", "delivered", "returned", "archived"],
      delivered: ["delivered", "returned", "archived"],
      returned: ["returned", "archived"],
      archived: ["archived"],
    };
    if (!allowedTransitions[current.status]?.includes(input.status ?? "")) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "invalid_shipment_transition" });
    }
    if (input.status === "returned" && !input.returnReason) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "return_reason_required" });
    }
    const orders = await shipmentOrderQuery(client, input.orderIds);
    if (orders.length !== input.orderIds.length || orders.some((order) => order.status === "archived")) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "shipment_order_not_available" });
    }
    const existingItems = await client.query<{ order_id: string }>(
      "SELECT order_id FROM shipment_items WHERE shipment_id = $1 ORDER BY item_position",
      [request.params.id],
    );
    const existingOrderIds = existingItems.rows.map((row) => row.order_id);
    const itemsChanged = existingOrderIds.length !== input.orderIds.length || existingOrderIds.some((id, index) => id !== input.orderIds[index]);
    if (current.sent_at && (
      itemsChanged
      || (input.recipientName !== null && input.recipientName !== current.recipient_name)
      || (input.recipientAddress !== null && input.recipientAddress !== current.recipient_address)
      || (input.composition !== null && input.composition !== current.composition)
    )) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "sent_shipment_immutable" });
    }
    if (current.sent_at && input.status === "draft") {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "invalid_shipment_transition" });
    }
    if (current.status === "archived" && input.status !== "archived") {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "archived_shipment_immutable" });
    }
    const derived = deriveShipmentValues(input, orders);
    const effectiveItems = shipmentOrderItems(orders);
    const warnings = shipmentWarningsFor({ recipient_name: derived.recipientName, recipient_address: derived.recipientAddress }, effectiveItems);
    let sentAt = input.sentAt;
    let deliveredAt = input.deliveredAt;
    let returnedAt = input.returnedAt;
    if (input.status === "draft") {
      sentAt = null; deliveredAt = null; returnedAt = null;
    } else if (input.status === "sent") {
      sentAt = sentAt ?? (current.sent_at ? timestampValue(current.sent_at) : new Date().toISOString());
      deliveredAt = null; returnedAt = null;
      if (warnings.length > 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "shipment_validation_failed", warnings });
      }
    } else if (input.status === "delivered") {
      sentAt = sentAt ?? timestampValue(current.sent_at);
      deliveredAt = deliveredAt ?? new Date().toISOString();
      returnedAt = null;
      if (!sentAt || new Date(deliveredAt).getTime() < new Date(sentAt).getTime()) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "invalid_delivery_date" });
      }
    } else if (input.status === "returned") {
      sentAt = sentAt ?? timestampValue(current.sent_at);
      deliveredAt = deliveredAt ?? timestampValue(current.delivered_at);
      returnedAt = returnedAt ?? new Date().toISOString();
      if (!sentAt
        || new Date(returnedAt).getTime() < new Date(sentAt).getTime()
        || (deliveredAt !== null && new Date(returnedAt).getTime() < new Date(deliveredAt).getTime())) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "invalid_return_date" });
      }
    } else if (input.status === "archived") {
      sentAt = sentAt ?? timestampValue(current.sent_at);
      deliveredAt = deliveredAt ?? timestampValue(current.delivered_at);
      returnedAt = returnedAt ?? timestampValue(current.returned_at);
    }
    if (input.status === "sent" && !sentAt) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "sent_date_required" });
    }
    if (!current.sent_at && itemsChanged) {
      await client.query("DELETE FROM shipment_items WHERE shipment_id = $1", [request.params.id]);
      for (const [index, order] of orders.entries()) {
        await client.query(
          `INSERT INTO shipment_items (shipment_id, order_id, item_position, order_snapshot)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [request.params.id, order.id, index + 1, JSON.stringify(shipmentSnapshot(order))],
        );
      }
    }
    const updated = await client.query<{ id: string; public_code: string; version: string | number }>(
      `UPDATE shipments
       SET recipient_name = $1, recipient_address = $2, composition = $3,
           tracking_number = $4, shipment_type = $5, return_reason = $6,
           status = $7, sent_at = $8, delivered_at = $9, returned_at = $10,
           responsible_id = $11, version = version + 1, updated_at = now()
       WHERE id = $12 AND version = $13
       RETURNING id, public_code, version`,
      [derived.recipientName, derived.recipientAddress, derived.composition, input.trackingNumber,
        input.shipmentType, input.returnReason, input.status, sentAt, deliveredAt, returnedAt,
        input.responsibleId, request.params.id, expectedVersion],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "shipment_version_conflict" });
    }
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "shipment",
      entityId: request.params.id,
      action: input.status === "sent" && current.status !== "sent" ? "sent" : input.status === "delivered" ? "delivered" : input.status === "returned" ? "returned" : input.status === "archived" ? "archived" : "updated",
      oldValues: { version: expectedVersion, status: current.status, sentAt: timestampValue(current.sent_at) },
      newValues: { version: Number(updated.rows[0].version), status: input.status, sentAt, deliveredAt, returnedAt, orderIds: input.orderIds },
      requestId: request.id,
    });
    await client.query("COMMIT");
    const row = await shipmentRowFor(db, request.params.id);
    return { shipment: row ? shipmentResponse(row) : { id: updated.rows[0].id, publicCode: updated.rows[0].public_code, version: Number(updated.rows[0].version), status: input.status } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23000") return reply.code(409).send({ error: "sent_shipment_immutable" });
    request.log.error(error, "Shipment update failed");
    return reply.code(500).send({ error: "shipment_update_failed" });
  } finally {
    client.release();
  }
});

app.get<{ Params: { id: string } }>("/api/orders/:id/shipments", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_order_id" });
  const candidates = await db.query(
    `SELECT s.id, s.public_code, s.status, s.sent_at, s.delivered_at, s.returned_at,
            s.tracking_number, s.recipient_name, s.recipient_address,
            (p.shipment_id IS NOT NULL) AS selected
     FROM shipment_items si
     JOIN shipments s ON s.id = si.shipment_id
     LEFT JOIN order_shipment_preferences p ON p.order_id = si.order_id AND p.shipment_id = si.shipment_id
     WHERE si.order_id = $1
     ORDER BY s.sent_at DESC NULLS LAST, s.created_at DESC, s.id`,
    [request.params.id],
  );
  const current = await db.query(
    `SELECT $1::uuid AS order_id,
            COALESCE(pref.shipment_id, cs.shipment_id) AS shipment_id,
            COALESCE(preferred.public_code, cs.public_code) AS public_code,
            COALESCE(preferred.sent_at, cs.sent_at) AS sent_at,
            COALESCE(preferred.delivered_at, cs.delivered_at) AS delivered_at,
            COALESCE(preferred.returned_at, cs.returned_at) AS returned_at,
            CASE WHEN pref.shipment_id IS NOT NULL THEN 'manual'
                 WHEN cs.selection_status IS NOT NULL THEN cs.selection_status
                 ELSE 'none' END AS selection_status
     FROM (SELECT $1::uuid AS order_id) requested
     LEFT JOIN current_shipments cs ON cs.order_id = requested.order_id
     LEFT JOIN order_shipment_preferences pref ON pref.order_id = requested.order_id
     LEFT JOIN shipments preferred ON preferred.id = pref.shipment_id`,
    [request.params.id],
  );
  return { candidates: candidates.rows, current: current.rows[0]?.selection_status === "none" ? null : current.rows[0] };
});

app.post<{ Params: { id: string } }>("/api/orders/:id/shipment-preference", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_order_id" });
  const body = isRecord(request.body) ? request.body : {};
  const shipmentId = stringValue(body.shipmentId);
  const reason = body.reason === undefined || body.reason === null ? null : stringValue(body.reason);
  if (!shipmentId || !validUuid(shipmentId) || (body.reason !== undefined && body.reason !== null && !reason)) {
    return reply.code(400).send({ error: "invalid_shipment_preference" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const pair = await client.query(
      `SELECT 1 FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
       WHERE si.order_id = $1 AND si.shipment_id = $2 AND s.sent_at IS NOT NULL`,
      [request.params.id, shipmentId],
    );
    if (pair.rowCount !== 1) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "shipment_not_available_for_order" });
    }
    await client.query(
      `INSERT INTO order_shipment_preferences (order_id, shipment_id, reason, selected_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO UPDATE SET shipment_id = EXCLUDED.shipment_id,
         reason = EXCLUDED.reason, selected_by = EXCLUDED.selected_by, updated_at = now()`,
      [request.params.id, shipmentId, reason, request.authUser.id],
    );
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "order_shipment_preference",
      entityId: request.params.id,
      action: "selected",
      newValues: { orderId: request.params.id, shipmentId, reason },
      requestId: request.id,
    });
    await client.query("COMMIT");
    return { ok: true, orderId: request.params.id, shipmentId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Shipment preference update failed");
    return reply.code(500).send({ error: "shipment_preference_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/payment-transfers", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const requestedLimit = Number(query.limit ?? 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
  const values: unknown[] = [];
  const where = search ? `WHERE lower(coalesce(external_reference, '') || ' ' || coalesce(note, '')) LIKE $1` : "";
  if (search) values.push(`%${search.toLocaleLowerCase()}%`);
  values.push(limit);
  const result = await db.query<PaymentTransferRow>(
    `SELECT id, external_reference, transfer_date, note, version, created_at, updated_at
     FROM payment_transfers ${where}
     ORDER BY updated_at DESC, id LIMIT $${values.length}`,
    values,
  );
  return { transfers: result.rows.map((row) => ({
    id: row.id,
    externalReference: row.external_reference,
    transferDate: apiDateValue(row.transfer_date),
    note: row.note,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })) };
});

app.post("/api/payment-transfers", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const body = isRecord(request.body) ? request.body : {};
  const input = paymentTransferInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_payment_transfer_payload" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<PaymentTransferRow>(
      `INSERT INTO payment_transfers (external_reference, transfer_date, note, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, external_reference, transfer_date, note, version, created_at, updated_at`,
      [input.externalReference, input.transferDate, input.note, request.authUser.id],
    );
    const transfer = inserted.rows[0];
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "payment_transfer",
      entityId: transfer.id,
      action: "created",
      newValues: { externalReference: transfer.external_reference, transferDate: transfer.transfer_date, note: transfer.note },
      requestId: request.id,
    });
    await client.query("COMMIT");
    return reply.code(201).send({ transfer: {
      id: transfer.id,
      externalReference: transfer.external_reference,
      transferDate: apiDateValue(transfer.transfer_date),
      note: transfer.note,
      version: Number(transfer.version),
      createdAt: transfer.created_at,
      updatedAt: transfer.updated_at,
    } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "payment_transfer_reference_exists" });
    request.log.error(error, "Payment transfer creation failed");
    return reply.code(500).send({ error: "payment_transfer_creation_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/payments", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
  const stage = typeof query.stage === "string" ? query.stage : "";
  const confirmationStatus = typeof query.confirmationStatus === "string" ? query.confirmationStatus : "";
  if (stage && stage !== "all" && !paymentStageValues.has(stage)) return reply.code(400).send({ error: "invalid_payment_stage" });
  if (confirmationStatus && confirmationStatus !== "all" && !paymentConfirmationValues.has(confirmationStatus)) return reply.code(400).send({ error: "invalid_payment_confirmation_status" });
  const orderId = typeof query.orderId === "string" && query.orderId ? query.orderId : "";
  if (orderId && !validUuid(orderId)) return reply.code(400).send({ error: "invalid_order_id" });
  const dateFrom = query.dateFrom === undefined || query.dateFrom === "" ? null : normalizeDateValue(query.dateFrom);
  const dateTo = query.dateTo === undefined || query.dateTo === "" ? null : normalizeDateValue(query.dateTo);
  if ((query.dateFrom !== undefined && query.dateFrom !== "" && !dateFrom) || (query.dateTo !== undefined && query.dateTo !== "" && !dateTo)) return reply.code(400).send({ error: "invalid_payment_date" });
  if (dateFrom && dateTo && dateTo < dateFrom) return reply.code(400).send({ error: "invalid_payment_date_range" });
  const requestedPage = Number(query.page ?? 1);
  const requestedPageSize = Number(query.pageSize ?? 25);
  const pageSize = Number.isInteger(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 1), 100) : 25;
  const page = Number.isInteger(requestedPage) ? Math.max(requestedPage, 1) : 1;
  const sortKey = typeof query.sort === "string" && paymentSortColumns[query.sort] ? query.sort : "updatedAt";
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const where: string[] = [];
  const values: unknown[] = [];
  if (stage && stage !== "all") { values.push(stage); where.push(`pe.stage = $${values.length}`); }
  if (confirmationStatus && confirmationStatus !== "all") { values.push(confirmationStatus); where.push(`pe.confirmation_status = $${values.length}`); }
  if (orderId) { values.push(orderId); where.push(`pe.order_id = $${values.length}`); }
  if (dateFrom) { values.push(dateFrom); where.push(`pe.payment_date >= $${values.length}::date`); }
  if (dateTo) { values.push(dateTo); where.push(`pe.payment_date <= $${values.length}::date`); }
  if (search) {
    values.push(`%${search.toLocaleLowerCase()}%`);
    where.push(`lower(concat_ws(' ', pe.public_code, pe.source, pe.payment_document, pe.note, pe.unknown_external_id, o.public_code, d.full_name, e.name, p.proceeding_number, pt.external_reference)) LIKE $${values.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countResult = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${paymentSelectSql} ${whereSql}) registry`, values);
  const total = Number(countResult.rows[0]?.count ?? 0);
  const listValues = [...values, pageSize, (page - 1) * pageSize];
  const result = await db.query<PaymentEventRow>(
    `${paymentSelectSql} ${whereSql} ORDER BY ${paymentSortColumns[sortKey]} ${direction}, pe.id LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
    listValues,
  );
  return { page, pageSize, total, pages: Math.ceil(total / pageSize), payments: result.rows.map(paymentResponse) };
});

app.get<{ Params: { id: string } }>("/api/payments/:id", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_payment_id" });
  const row = await paymentRowFor(db, request.params.id);
  if (!row) return reply.code(404).send({ error: "payment_not_found" });
  const history = await db.query(
    `SELECT id, actor_id, occurred_at, action, old_values, new_values, request_id
     FROM audit_log WHERE entity_type = 'payment_event' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 200`,
    [request.params.id],
  );
  return { payment: paymentResponse(row), history: history.rows };
});

app.get("/api/payments/summary", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const month = typeof query.month === "string" && query.month ? query.month : null;
  let monthStart: string | null = null;
  let monthEnd: string | null = null;
  if (month) {
    const match = month.match(/^(\d{4})-(\d{2})$/);
    const year = match ? Number(match[1]) : 0;
    const monthNumber = match ? Number(match[2]) : 0;
    if (!match || monthNumber < 1 || monthNumber > 12) return reply.code(400).send({ error: "invalid_payment_month" });
    monthStart = `${year.toString().padStart(4, "0")}-${monthNumber.toString().padStart(2, "0")}-01`;
    const endDate = new Date(Date.UTC(year, monthNumber, 0));
    monthEnd = endDate.toISOString().slice(0, 10);
  }
  const result = await db.query<{ stage: string; event_count: string; total_amount: string }>(
    `WITH eligible AS (
       SELECT pe.*,
              row_number() OVER (
                  PARTITION BY pe.order_id, pe.stage, pe.source, pe.payment_date, pe.amount,
                               pe.period_start, pe.period_end
                ORDER BY pe.duplicate_override DESC, pe.updated_at ASC, pe.id
              ) AS duplicate_rank
       FROM payment_events pe
       JOIN orders o ON o.id = pe.order_id
       LEFT JOIN enforcement_proceedings p ON p.id = o.proceeding_id
       WHERE pe.confirmation_status = 'confirmed'
         AND pe.enforcement_reconciled = true
         AND pe.source = 'Этот работодатель'
         AND char_length(btrim(coalesce(p.proceeding_number, ''))) > 0
         AND ($1::date IS NULL OR pe.payment_date >= $1::date)
         AND ($2::date IS NULL OR pe.payment_date <= $2::date)
     )
     SELECT stage, count(*)::text AS event_count, sum(amount)::numeric(18,2)::text AS total_amount
     FROM eligible WHERE duplicate_rank = 1 GROUP BY stage`,
    [monthStart, monthEnd],
  );
  const excluded = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM payment_rejections pr
     WHERE ($1::date IS NULL OR pr.payment_date >= $1::date)
       AND ($2::date IS NULL OR pr.payment_date <= $2::date)`,
    [monthStart, monthEnd],
  );
  const totals = { fssp: { amount: "0.00", eventCount: 0 }, uk: { amount: "0.00", eventCount: 0 } };
  for (const row of result.rows) if (row.stage === "fssp" || row.stage === "uk") totals[row.stage] = { amount: row.total_amount, eventCount: Number(row.event_count) };
  return { month, totals, excludedCount: Number(excluded.rows[0]?.count ?? 0) };
});

app.post("/api/payments", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const body = isRecord(request.body) ? request.body : {};
  const input = paymentInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_payment_payload" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (input.orderId) {
      const order = await client.query<{ id: string }>("SELECT id FROM orders WHERE id = $1", [input.orderId]);
      if (order.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "payment_order_not_found" }); }
    }
    if (input.transferId) {
      const transfer = await client.query("SELECT 1 FROM payment_transfers WHERE id = $1", [input.transferId]);
      if (transfer.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "payment_transfer_not_found" }); }
    }
    const duplicateRows = await paymentDuplicateRows(client, input);
    if (input.confirmationStatus === "confirmed" && duplicateRows.length > 0 && !input.duplicateOverride) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "payment_duplicates_require_review", duplicates: duplicateRows });
    }
    const documents = input.documentIds.length === 0 ? { rowCount: 0 } : await client.query(
      "SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND status <> 'archived'", [input.documentIds],
    );
    if (documents.rowCount !== input.documentIds.length) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "payment_document_not_found" }); }
    const inserted = await client.query<{ id: string; public_code: string; version: string | number }>(
      `INSERT INTO payment_events
         (order_id, unknown_external_id, transfer_id, stage, source, payment_date, amount,
          confirmation_status, enforcement_reconciled, period_start, period_end,
          rejection_reason, payment_document, note, duplicate_override, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id, public_code, version`,
      [input.orderId, input.unknownExternalId, input.transferId, input.stage, input.source, input.paymentDate,
        input.amount, input.confirmationStatus, input.enforcementReconciled, input.periodStart, input.periodEnd,
        input.rejectionReason, input.paymentDocument, input.note, input.duplicateOverride, request.authUser.id],
    );
    for (const documentId of input.documentIds) await client.query(
      `INSERT INTO payment_documents (payment_event_id, document_id, document_type) VALUES ($1, $2, 'payment_confirmation')`,
      [inserted.rows[0].id, documentId],
    );
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "payment_event",
      entityId: inserted.rows[0].id,
      action: "created",
      newValues: { publicCode: inserted.rows[0].public_code, stage: input.stage, amount: input.amount, confirmationStatus: input.confirmationStatus, orderId: input.orderId, unknownExternalId: input.unknownExternalId },
      requestId: request.id,
    });
    await client.query("COMMIT");
    const row = await paymentRowFor(db, inserted.rows[0].id);
    return reply.code(201).send({ payment: row ? paymentResponse(row) : { id: inserted.rows[0].id, publicCode: inserted.rows[0].public_code, version: Number(inserted.rows[0].version) } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Payment creation failed");
    return reply.code(500).send({ error: "payment_creation_failed" });
  } finally {
    client.release();
  }
});

app.patch<{ Params: { id: string } }>("/api/payments/:id", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_payment_id" });
  const body = isRecord(request.body) ? request.body : {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return reply.code(400).send({ error: "expected_version_required" });
  const input = paymentInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_payment_payload" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<{ id: string; version: string | number; confirmation_status: string }>(
      "SELECT id, version, confirmation_status FROM payment_events WHERE id = $1 FOR UPDATE", [request.params.id],
    );
    const current = currentResult.rows[0];
    if (!current) { await client.query("ROLLBACK"); return reply.code(404).send({ error: "payment_not_found" }); }
    if (Number(current.version) !== expectedVersion) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "payment_version_conflict", currentVersion: Number(current.version) }); }
    if (input.orderId) {
      const order = await client.query("SELECT id FROM orders WHERE id = $1", [input.orderId]);
      if (order.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "payment_order_not_found" }); }
    }
    if (input.transferId) {
      const transfer = await client.query("SELECT 1 FROM payment_transfers WHERE id = $1", [input.transferId]);
      if (transfer.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "payment_transfer_not_found" }); }
    }
    const duplicateRows = await paymentDuplicateRows(client, input, request.params.id);
    if (input.confirmationStatus === "confirmed" && duplicateRows.length > 0 && !input.duplicateOverride) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "payment_duplicates_require_review", duplicates: duplicateRows });
    }
    const documents = input.documentIds.length === 0 ? { rowCount: 0 } : await client.query(
      "SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND status <> 'archived'", [input.documentIds],
    );
    if (documents.rowCount !== input.documentIds.length) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "payment_document_not_found" }); }
    const updated = await client.query<{ id: string; public_code: string; version: string | number }>(
      `UPDATE payment_events
       SET order_id = $1, unknown_external_id = $2, transfer_id = $3, stage = $4, source = $5,
           payment_date = $6, amount = $7::numeric, confirmation_status = $8,
           enforcement_reconciled = $9, period_start = $10, period_end = $11,
           rejection_reason = $12, payment_document = $13, note = $14,
           duplicate_override = $15, version = version + 1, updated_at = now()
       WHERE id = $16 AND version = $17
       RETURNING id, public_code, version`,
      [input.orderId, input.unknownExternalId, input.transferId, input.stage, input.source, input.paymentDate,
        input.amount, input.confirmationStatus, input.enforcementReconciled, input.periodStart, input.periodEnd,
        input.rejectionReason, input.paymentDocument, input.note, input.duplicateOverride, request.params.id, expectedVersion],
    );
    if (updated.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "payment_version_conflict" }); }
    await client.query("DELETE FROM payment_documents WHERE payment_event_id = $1", [request.params.id]);
    for (const documentId of input.documentIds) await client.query(
      `INSERT INTO payment_documents (payment_event_id, document_id, document_type) VALUES ($1, $2, 'payment_confirmation')`,
      [request.params.id, documentId],
    );
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "payment_event",
      entityId: request.params.id,
      action: input.confirmationStatus === "confirmed" && current.confirmation_status !== "confirmed" ? "confirmed" : input.confirmationStatus === "rejected" ? "rejected" : "updated",
      oldValues: { version: expectedVersion, confirmationStatus: current.confirmation_status },
      newValues: { version: Number(updated.rows[0].version), confirmationStatus: input.confirmationStatus, stage: input.stage, amount: input.amount },
      requestId: request.id,
    });
    await client.query("COMMIT");
    const row = await paymentRowFor(db, request.params.id);
    return { payment: row ? paymentResponse(row) : { id: updated.rows[0].id, publicCode: updated.rows[0].public_code, version: Number(updated.rows[0].version) } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Payment update failed");
    return reply.code(500).send({ error: "payment_update_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/control-settings", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const row = await controlSettingsFor(db);
  return { settings: controlSettingsResponse(row) };
});

app.patch("/api/control-settings", { preHandler: requireRole(pool, ["admin"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const body = isRecord(request.body) ? request.body : {};
  const expectedVersion = body.expectedVersion === undefined ? 0 : Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return reply.code(400).send({ error: "expected_version_required" });
  const input = controlSettingsInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_control_settings" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await controlSettingsFor(client);
    const currentVersion = current ? Number(current.version) : 0;
    if (currentVersion !== expectedVersion) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "control_settings_version_conflict", currentVersion });
    }
    const inserted = await client.query<ControlSettingsRow>(
      `INSERT INTO control_settings
         (timezone, after_sent_days, after_delivered_days, after_uk_check_days, reminder_before_days, created_by, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, timezone, after_sent_days, after_delivered_days, after_uk_check_days,
                 reminder_before_days, effective_from, version`,
      [input.timezone, input.afterSentDays, input.afterDeliveredDays, input.afterUkCheckDays, input.reminderBeforeDays,
        request.authUser.id, currentVersion + 1],
    );
    const settings = inserted.rows[0];
    await audit(client, {
      actorId: request.authUser.id,
      entityType: "control_settings",
      entityId: settings.id,
      action: "updated",
      oldValues: current ? controlSettingsResponse(current) : null,
      newValues: controlSettingsResponse(settings),
      requestId: request.id,
    });
    await client.query("COMMIT");
    return { settings: controlSettingsResponse(settings) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Control settings update failed");
    return reply.code(500).send({ error: "control_settings_update_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/control", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const settingsRow = await controlSettingsFor(db);
  const settings = controlSettingsResponse(settingsRow);
  const includeArchived = query.includeArchived === true || query.includeArchived === "true";
  const stateFilter = typeof query.state === "string" ? query.state : "";
  const allowedStates = new Set(["overdue", "today", "soon", "scheduled", "assign_action", "assign_responsible", "completed", "archived"]);
  if (stateFilter && !allowedStates.has(stateFilter)) return reply.code(400).send({ error: "invalid_control_state" });
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 200).toLocaleLowerCase() : "";
  const settingsParams = [settings.afterSentDays, settings.afterDeliveredDays, settings.afterUkCheckDays];
  const rows = await db.query<{
    order_id: string; order_public_code: string; debtor_name: string; order_status: string;
    sent_date: string | null; delivered_date: string | null; uk_payment_date: string | null;
    basis: string | null; automatic_base_date: string | null; due_date: string | null;
    action_id: string | null; action_title: string | null; action_description: string | null;
    action_status: "open" | "in_progress" | "done" | "cancelled" | null; action_result: string | null;
    action_due_date: string | Date | null; action_manual_due_date: string | Date | null;
    action_control_basis: string | null; action_assigned_to: string | null; action_assigned_name: string | null;
    action_completed_at: string | Date | null; action_version: string | number | null;
  }>(
    `WITH base AS (
       SELECT o.id AS order_id, o.public_code AS order_public_code, o.status AS order_status,
              d.full_name AS debtor_name,
              (SELECT max(s.sent_at::date)
                 FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
                WHERE si.order_id = o.id AND s.sent_at IS NOT NULL AND s.status <> 'archived') AS sent_date,
              (SELECT max(s.delivered_at::date)
                 FROM shipment_items si JOIN shipments s ON s.id = si.shipment_id
                WHERE si.order_id = o.id AND s.delivered_at IS NOT NULL AND s.status <> 'archived') AS delivered_date,
              (SELECT max(pe.payment_date)
                 FROM payment_events pe JOIN enforcement_proceedings ep ON ep.id = o.proceeding_id
                WHERE pe.order_id = o.id AND pe.stage = 'uk' AND pe.confirmation_status = 'confirmed'
                  AND pe.enforcement_reconciled = true AND pe.source = 'Этот работодатель'
                  AND char_length(btrim(coalesce(ep.proceeding_number, ''))) > 0) AS uk_payment_date
       FROM orders o JOIN debtors d ON d.id = o.debtor_id
       ${includeArchived ? "" : "WHERE o.status <> 'archived'"}
     ), selected AS (
       SELECT b.*,
              CASE WHEN b.uk_payment_date IS NOT NULL THEN 'uk_payment'
                   WHEN b.delivered_date IS NOT NULL THEN 'shipment_delivered'
                   WHEN b.sent_date IS NOT NULL THEN 'shipment_sent' END AS basis,
              CASE WHEN b.uk_payment_date IS NOT NULL THEN b.uk_payment_date
                   WHEN b.delivered_date IS NOT NULL THEN b.delivered_date
                   WHEN b.sent_date IS NOT NULL THEN b.sent_date END AS automatic_base_date,
              a.id AS action_id, a.title AS action_title, a.description AS action_description,
              a.status AS action_status, a.result AS action_result, a.due_date AS action_due_date,
              a.manual_due_date AS action_manual_due_date, a.control_basis AS action_control_basis,
              a.assigned_to AS action_assigned_to, u.display_name AS action_assigned_name,
              a.completed_at AS action_completed_at, a.version AS action_version
       FROM base b
       LEFT JOIN LATERAL (
         SELECT a.* FROM actions a
         WHERE a.order_id = b.order_id
         ORDER BY CASE WHEN a.status IN ('open', 'in_progress') THEN 0 ELSE 1 END,
                  a.updated_at DESC, a.id DESC
         LIMIT 1
       ) a ON true
       LEFT JOIN users u ON u.id = a.assigned_to
     )
     SELECT selected.*,
            CASE WHEN action_manual_due_date IS NOT NULL THEN action_manual_due_date
                 WHEN automatic_base_date IS NULL THEN NULL
                 WHEN basis = 'uk_payment' THEN automatic_base_date + $3::int
                 WHEN basis = 'shipment_delivered' THEN automatic_base_date + $2::int
                 WHEN basis = 'shipment_sent' THEN automatic_base_date + $1::int
            END AS due_date
     FROM selected`,
    settingsParams,
  );
  const dateText = (value: unknown) => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  };
  const addDays = (value: unknown, days: number) => {
    const normalized = dateText(value);
    if (!normalized) return null;
    const [year, month, day] = normalized.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  };
  const today = localDateInTimezone(settings.timezone);
  const soonLimit = addDays(today, settings.reminderBeforeDays) ?? today;
  const controls = rows.rows.map((row) => {
    const baseDate = dateText(row.automatic_base_date);
    const dueDate = dateText(row.due_date);
    const sentDate = dateText(row.sent_date);
    const deliveredDate = dateText(row.delivered_date);
    const ukPaymentDate = dateText(row.uk_payment_date);
    let state: string;
    if (row.order_status === "archived") state = "archived";
    else if (row.action_status === "done") state = "completed";
    else if (row.action_status === "cancelled" || !row.basis) state = "assign_action";
    else if (row.action_id && !row.action_assigned_to) state = "assign_responsible";
    else if (!row.action_id) state = "assign_action";
    else if (!dueDate) state = "assign_action";
    else if (dueDate < today) state = "overdue";
    else if (dueDate === today) state = "today";
    else if (dueDate <= soonLimit) state = "soon";
    else state = "scheduled";
    const action = row.action_id ? {
      id: row.action_id,
      title: row.action_title,
      description: row.action_description,
      status: row.action_status,
      result: row.action_result,
      dueDate: apiDateValue(row.action_due_date),
      manualDueDate: apiDateValue(row.action_manual_due_date),
      controlBasis: row.action_control_basis,
      completedAt: timestampValue(row.action_completed_at),
      assignedTo: row.action_assigned_to ? { id: row.action_assigned_to, displayName: row.action_assigned_name } : null,
      version: Number(row.action_version),
    } : null;
    return {
      order: { id: row.order_id, publicCode: row.order_public_code, debtorName: row.debtor_name, status: row.order_status },
      basis: row.basis,
      baseDate,
      dueDate,
      reminderDate: dueDate ? addDays(dueDate, -settings.reminderBeforeDays) : null,
      state,
      action,
      sourceDates: { sent: sentDate, delivered: deliveredDate, ukPayment: ukPaymentDate },
    };
  }).filter((control) => {
    if (stateFilter && control.state !== stateFilter) return false;
    if (search && !`${control.order.publicCode} ${control.order.debtorName} ${control.action?.title ?? ""}`.toLocaleLowerCase().includes(search)) return false;
    return true;
  });
  const sort = query.sort === "state" ? "state" : query.sort === "order" ? "order" : "dueDate";
  const direction = query.direction === "asc" ? 1 : -1;
  controls.sort((left, right) => {
    const leftValue = sort === "state" ? left.state : sort === "order" ? left.order.publicCode : (left.dueDate ?? "9999-12-31");
    const rightValue = sort === "state" ? right.state : sort === "order" ? right.order.publicCode : (right.dueDate ?? "9999-12-31");
    return String(leftValue).localeCompare(String(rightValue), "ru") * direction;
  });
  const requestedPage = Number(query.page ?? 1);
  const requestedPageSize = Number(query.pageSize ?? 25);
  const pageSize = Number.isInteger(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 1), 100) : 25;
  const page = Number.isInteger(requestedPage) ? Math.max(requestedPage, 1) : 1;
  return {
    today,
    settings,
    page,
    pageSize,
    total: controls.length,
    pages: Math.ceil(controls.length / pageSize),
    controls: controls.slice((page - 1) * pageSize, page * pageSize),
  };
});

app.get("/api/reports/overview", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const result = await reportRowsFor(db, query);
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return reportSummaryFor(db, result);
});

app.get("/api/reports/orders.xlsx", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const result = await reportRowsFor(db, query);
  if ("error" in result) return reply.code(400).send({ error: result.error });
  const requestedColumns = typeof query.columns === "string"
    ? query.columns.split(",").map((value) => value.trim()).filter((value) => Boolean(reportColumnDefinitions[value]))
    : [...reportDefaultColumns];
  const columns = [...new Set(requestedColumns)];
  if (columns.length === 0) return reply.code(400).send({ error: "report_columns_required" });
  const clarifications = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM payment_rejections");
  const filterDescription = reportFilterDescription(result);
  const contents = await buildOrderWorkbook(
    result.rows,
    result.settings,
    result.today,
    columns,
    filterDescription,
    Number(clarifications.rows[0]?.count ?? 0),
  );
  const fileDate = result.today;
  reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  reply.header("content-disposition", `attachment; filename="fssp-orders-${fileDate}.xlsx"`);
  reply.header("content-length", String(contents.length));
  return reply.send(contents);
});

app.get("/api/actions", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  const query = isRecord(request.query) ? request.query : {};
  const status = typeof query.status === "string" ? query.status : "";
  if (status && !controlStatusValues.has(status)) return reply.code(400).send({ error: "invalid_action_status" });
  const requestedPage = Number(query.page ?? 1);
  const requestedPageSize = Number(query.pageSize ?? 25);
  const pageSize = Number.isInteger(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 1), 100) : 25;
  const page = Number.isInteger(requestedPage) ? Math.max(requestedPage, 1) : 1;
  const values: unknown[] = [];
  const where = status ? `WHERE a.status = $1` : "";
  if (status) values.push(status);
  const count = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM (${actionSelectSql} ${where}) actions_registry`, values);
  const listValues = [...values, pageSize, (page - 1) * pageSize];
  const result = await db.query<ActionRow>(`${actionSelectSql} ${where} ORDER BY a.updated_at DESC, a.id LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues);
  return { page, pageSize, total: Number(count.rows[0]?.count ?? 0), pages: Math.ceil(Number(count.rows[0]?.count ?? 0) / pageSize), actions: result.rows.map(actionResponse) };
});

app.get<{ Params: { id: string } }>("/api/actions/:id", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_action_id" });
  const row = await actionRowFor(db, request.params.id);
  if (!row) return reply.code(404).send({ error: "action_not_found" });
  const history = await db.query(`SELECT id, actor_id, occurred_at, action, old_values, new_values, request_id FROM audit_log WHERE entity_type = 'action' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 200`, [request.params.id]);
  return { action: actionResponse(row), history: history.rows };
});

app.post("/api/actions", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const body = isRecord(request.body) ? request.body : {};
  const input = actionInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_action_payload" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1 FOR SHARE", [input.orderId]);
    if (order.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "action_order_not_found" }); }
    if (order.rows[0].status === "archived") { await client.query("ROLLBACK"); return reply.code(400).send({ error: "action_order_archived" }); }
    if (input.assignedTo) {
      const assignee = await client.query("SELECT 1 FROM users WHERE id = $1 AND is_active = true", [input.assignedTo]);
      if (assignee.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "action_assignee_not_active" }); }
    }
    const completedAt = input.status === "done" ? new Date().toISOString() : null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO actions
         (order_id, assigned_to, title, description, due_date, manual_due_date, control_basis,
          source_event_type, source_event_id, status, result, completed_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [input.orderId, input.assignedTo, input.title, input.description, input.dueDate, input.manualDueDate, input.controlBasis,
        input.sourceEventType, input.sourceEventId, input.status, input.result, completedAt, request.authUser.id],
    );
    await audit(client, { actorId: request.authUser.id, entityType: "action", entityId: inserted.rows[0].id, action: "created", newValues: { orderId: input.orderId, title: input.title, dueDate: input.dueDate, status: input.status }, requestId: request.id });
    await client.query("COMMIT");
    const row = await actionRowFor(db, inserted.rows[0].id);
    return reply.code(201).send({ action: row ? actionResponse(row) : { id: inserted.rows[0].id } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Action creation failed");
    return reply.code(500).send({ error: "action_creation_failed" });
  } finally {
    client.release();
  }
});

app.patch<{ Params: { id: string } }>("/api/actions/:id", { preHandler: requireRole(pool, ["admin", "editor"]) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_action_id" });
  const body = isRecord(request.body) ? request.body : {};
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return reply.code(400).send({ error: "expected_version_required" });
  const input = actionInput(body);
  if (!input.valid) return reply.code(400).send({ error: "invalid_action_payload" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ version: string | number; status: string }>("SELECT version, status FROM actions WHERE id = $1 FOR UPDATE", [request.params.id]);
    if (current.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(404).send({ error: "action_not_found" }); }
    if (Number(current.rows[0].version) !== expectedVersion) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "action_version_conflict", currentVersion: Number(current.rows[0].version) }); }
    const order = await client.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [input.orderId]);
    if (order.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "action_order_not_found" }); }
    if (order.rows[0].status === "archived") { await client.query("ROLLBACK"); return reply.code(400).send({ error: "action_order_archived" }); }
    if (input.assignedTo) {
      const assignee = await client.query("SELECT 1 FROM users WHERE id = $1 AND is_active = true", [input.assignedTo]);
      if (assignee.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(400).send({ error: "action_assignee_not_active" }); }
    }
    const completedAt = input.status === "done" ? new Date().toISOString() : null;
    const updated = await client.query<{ id: string }>(
      `UPDATE actions SET order_id = $1, assigned_to = $2, title = $3, description = $4,
          due_date = $5, manual_due_date = $6, control_basis = $7, source_event_type = $8,
          source_event_id = $9, status = $10, result = $11, completed_at = $12,
          version = version + 1, updated_at = now()
       WHERE id = $13 AND version = $14 RETURNING id`,
      [input.orderId, input.assignedTo, input.title, input.description, input.dueDate, input.manualDueDate, input.controlBasis,
        input.sourceEventType, input.sourceEventId, input.status, input.result, completedAt, request.params.id, expectedVersion],
    );
    if (updated.rowCount !== 1) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "action_version_conflict" }); }
    await audit(client, { actorId: request.authUser.id, entityType: "action", entityId: request.params.id, action: input.status === "done" ? "completed" : input.status === "cancelled" ? "cancelled" : "updated", oldValues: { version: expectedVersion, status: current.rows[0].status }, newValues: { status: input.status, dueDate: input.dueDate }, requestId: request.id });
    await client.query("COMMIT");
    const row = await actionRowFor(db, request.params.id);
    return { action: row ? actionResponse(row) : { id: updated.rows[0].id } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error, "Action update failed");
    return reply.code(500).send({ error: "action_update_failed" });
  } finally {
    client.release();
  }
});

app.post(
  "/api/imports/preview",
  { preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ error: "binary_pdf_body_required" });
    }
    if (request.body.length === 0 || request.body.length > maxUploadBytes) {
      return reply.code(413).send({ error: "pdf_size_not_allowed" });
    }
    const mimeType = (headerValue(request.headers["x-file-type"]) ?? request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (mimeType !== "application/pdf") {
      return reply.code(415).send({ error: "pdf_type_required" });
    }

    let preview;
    try {
      preview = await parsePdfPreview(request.body);
    } catch (error) {
      request.log.warn(error, "PDF preview parsing failed");
      return reply.code(422).send({
        error: "pdf_parse_failed",
        warning: {
          code: "pdf_extraction_failed",
          message: "Не удалось прочитать текстовый слой PDF; OCR не выполнялся.",
        },
      });
    }

    const originalFilename = sanitizeFilename(headerValue(request.headers["x-file-name"]) ?? "document.pdf");
    const documentId = randomUUID();
    const batchId = randomUUID();
    const batchFileId = randomUUID();
    const itemId = randomUUID();
    const storageKey = `${new Date().toISOString().slice(0, 10)}/${documentId}-${originalFilename}`;
    const digest = createHash("sha256").update(request.body).digest("hex");
    const manualFields = { employerName: null, employerTaxId: null, employerAddress: null };

    try {
      await documentStorage.put(storageKey, request.body);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "document_storage_failed" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO documents
            (id, storage_key, sha256, byte_size, mime_type, original_filename, uploaded_by)
          VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6)
        `,
        [documentId, storageKey, digest, request.body.length, originalFilename, request.authUser.id],
      );
      await client.query(
        `
          INSERT INTO import_batches (id, created_by, status, parser_version)
          VALUES ($1, $2, 'ready_for_review', $3)
        `,
        [batchId, request.authUser.id, PDF_PARSER_VERSION],
      );
      await client.query(
        `
          INSERT INTO import_batch_files
            (id, batch_id, source_document_id, checksum, page_count, status)
          VALUES ($1, $2, $3, $4, $5, 'ready')
        `,
        [batchFileId, batchId, documentId, digest, preview.pageCount],
      );
      await client.query(
        `
          INSERT INTO import_items
            (id, batch_file_id, page_start, page_end, raw_text, extracted_data, manual_data, warnings)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
        `,
        [
          itemId,
          batchFileId,
          preview.pageStart,
          preview.pageEnd,
          preview.rawText,
          JSON.stringify(preview.extracted),
          JSON.stringify(manualFields),
          JSON.stringify(preview.warnings),
        ],
      );
      await audit(client, {
        actorId: request.authUser.id,
        entityType: "import_batch",
        entityId: batchId,
        action: "preview_created",
        newValues: {
          filename: originalFilename,
          pageCount: preview.pageCount,
          parserVersion: PDF_PARSER_VERSION,
          itemCount: 1,
        },
        requestId: request.id,
      });
      await client.query("COMMIT");
      return reply.code(201).send({
        batch: { id: batchId, status: "ready_for_review", parserVersion: PDF_PARSER_VERSION },
        file: {
          id: batchFileId,
          sourceDocumentId: documentId,
          filename: originalFilename,
          pageCount: preview.pageCount,
          status: "ready",
        },
        items: [{
          id: itemId,
          pageStart: preview.pageStart,
          pageEnd: preview.pageEnd,
          extracted: preview.extracted,
          manualFields,
          warnings: preview.warnings,
          pages: preview.pages.map((page) => ({ pageNumber: page.pageNumber, hasText: page.hasText })),
        }],
        commitAvailable: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      await documentStorage.remove(storageKey).catch((cleanupError) => request.log.error(cleanupError));
      request.log.error(error);
      return reply.code(500).send({ error: "import_preview_registration_failed" });
    } finally {
      client.release();
    }
  },
);

app.post(
  "/api/imports/package-preview",
  { bodyLimit: maxUploadBytes * 20 + 1024 * 1024, preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!request.isMultipart()) return reply.code(400).send({ error: "multipart_pdf_package_required" });
    const prepared: PreparedPdf[] = [];
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        const contents = await part.toBuffer();
        if (part.mimetype !== "application/pdf") {
          return reply.code(415).send({ error: "pdf_type_required", filename: part.filename });
        }
        if (contents.length === 0 || contents.length > maxUploadBytes) {
          return reply.code(413).send({ error: "pdf_size_not_allowed", filename: part.filename });
        }
        prepared.push(await preparePdf(part.filename || "document.pdf", contents));
      }
    } catch (error) {
      request.log.warn(error, "PDF package multipart parsing failed");
      return reply.code(413).send({ error: "pdf_package_not_allowed" });
    }
    if (prepared.length === 0) return reply.code(400).send({ error: "pdf_package_empty" });
    const hashes = prepared.map((file) => createHash("sha256").update(file.contents).digest("hex"));
    const duplicateFiles = hashes
      .map((hash, index) => hashes.indexOf(hash) === index ? null : prepared[index].filename)
      .filter((filename): filename is string => Boolean(filename));
    if (duplicateFiles.length > 0) {
      return reply.code(409).send({ error: "duplicate_files_in_package", files: duplicateFiles });
    }

    try {
      const registered = await registerImportBatch(db, prepared, request.authUser.id, request.id, request.log);
      return reply.code(201).send({
        batch: { id: registered.batchId, status: "ready_for_review", parserVersion: PDF_PARSER_VERSION },
        files: registered.files,
        items: registered.items,
        composition: {
          totalFiles: registered.files.length,
          readyFiles: registered.files.filter((file) => file.status === "ready").length,
          failedFiles: registered.files.filter((file) => file.status === "failed").length,
          itemsToSave: registered.items.filter((item) => item.fileStatus === "ready").length,
          excludedItems: 0,
        },
        commitAvailable: false,
        requiresConfirmation: true,
      });
    } catch (error) {
      request.log.error(error, "PDF package registration failed");
      return reply.code(500).send({ error: "import_package_registration_failed" });
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/api/imports/:id/commit",
  { preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_import_id" });
    const body = isRecord(request.body) ? request.body : {};
    if (body.confirm !== true) return reply.code(400).send({ error: "explicit_confirmation_required" });
    const allowDuplicates = body.allowDuplicates === true;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const batchResult = await client.query<{ id: string; status: string; confirmed_at: string | null }>(
        "SELECT id, status, confirmed_at FROM import_batches WHERE id = $1 FOR UPDATE",
        [request.params.id],
      );
      const batch = batchResult.rows[0];
      if (!batch) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "import_not_found" });
      }
      if (batch.status !== "ready_for_review") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_not_committable", status: batch.status });
      }
      const rows = await client.query<CommitImportRow>(
        `
          SELECT i.id AS item_id, f.id AS batch_file_id, f.source_document_id,
                 f.status AS file_status, d.original_filename AS filename,
                 i.page_start, i.page_end, i.extracted_data, i.manual_data,
                 i.warnings, i.duplicate_state, i.decision
          FROM import_batch_files f
          JOIN documents d ON d.id = f.source_document_id
          JOIN import_items i ON i.batch_file_id = f.id
          WHERE f.batch_id = $1
          ORDER BY i.page_start, i.id
          FOR UPDATE
        `,
        [request.params.id],
      );
      if (rows.rowCount === 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_has_no_items" });
      }
      const excludedItems = rows.rows.filter((row) => row.decision === "excluded");
      const activeRows = rows.rows.filter((row) => row.decision === "pending");
      const unexpectedDecisions = rows.rows.filter((row) => row.decision !== "pending" && row.decision !== "excluded");
      if (unexpectedDecisions.length > 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_item_decision_conflict", items: unexpectedDecisions.map((row) => row.item_id) });
      }
      const failedFiles = rows.rows.filter((row) => row.file_status !== "ready" && row.decision !== "excluded");
      if (failedFiles.length > 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "import_has_failed_files",
          files: failedFiles.map((row) => ({ itemId: row.item_id, filename: row.filename, reason: "exclude_required" })),
        });
      }
      if (activeRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_has_no_items_to_commit", excludedItems: excludedItems.map((row) => row.item_id) });
      }
      const incomplete = activeRows
        .map((row) => ({ row, debtorName: extractedString(row.extracted_data, "debtorName") }))
        .filter(({ debtorName }) => !debtorName)
        .map(({ row }) => ({ itemId: row.item_id, filename: row.filename, field: "debtorName" }));
      if (incomplete.length > 0) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_has_incomplete_required_fields", items: incomplete });
      }

      const duplicateItems = activeRows.filter((row) => row.duplicate_state === "possible_duplicate");
      const resolutions = activeRows
        .map((row) => extractedString(row.extracted_data, "resolutionNumber"))
        .filter((value): value is string => Boolean(value));
      const repeatedResolution = new Set<string>();
      const seenResolutions = new Set<string>();
      for (const resolution of resolutions) {
        const normalized = resolution.toLowerCase();
        if (seenResolutions.has(normalized)) repeatedResolution.add(normalized);
        seenResolutions.add(normalized);
      }
      const existing = resolutions.length === 0
        ? { rows: [] as Array<{ id: string; resolution_number: string }> }
        : await client.query<{ id: string; resolution_number: string }>(
          "SELECT id, resolution_number FROM orders WHERE resolution_number = ANY($1::text[]) AND status <> 'archived' FOR UPDATE",
          [resolutions],
        );
      const conflicts = [
        ...duplicateItems.map((row) => ({ itemId: row.item_id, filename: row.filename, reason: "possible_duplicate" })),
        ...Array.from(repeatedResolution).map((resolution) => ({ resolution, reason: "repeated_in_batch" })),
        ...existing.rows.map((row) => ({ resolution: row.resolution_number, orderId: row.id, reason: "existing_order" })),
      ];
      if (conflicts.length > 0 && !allowDuplicates) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_conflicts_require_review", conflicts });
      }

      const debtorCache = new Map<string, string>();
      const proceedingCache = new Map<string, string>();
      const createdOrders: Array<{ id: string; itemId: string; filename: string }> = [];
      for (const row of activeRows) {
        const extracted = jsonObject(row.extracted_data);
        const manual = jsonObject(row.manual_data);
        const debtorName = extractedString(extracted, "debtorName")!;
        const debtorTaxId = extractedString(extracted, "debtorTaxId");
        const debtorBirthDate = databaseDate(extractedString(extracted, "debtorBirthDate"));
        const debtorKey = `${debtorTaxId ?? ""}:${debtorName.toLowerCase()}`;
        let debtorId = debtorCache.get(debtorKey);
        if (!debtorId) {
          const debtor = await client.query<{ id: string }>(
            `
              INSERT INTO debtors (full_name, date_of_birth, external_ids)
              VALUES ($1, $2, $3::jsonb)
              RETURNING id
            `,
            [debtorName, debtorBirthDate, JSON.stringify(debtorTaxId ? { inn: debtorTaxId } : {})],
          );
          debtorId = debtor.rows[0].id;
          debtorCache.set(debtorKey, debtorId);
        }

        const proceedingNumber = extractedString(extracted, "proceedingNumber");
        const proceedingDate = databaseDate(extractedString(extracted, "proceedingDate"));
        let proceedingId: string | null = null;
        if (proceedingNumber) {
          proceedingId = proceedingCache.get(proceedingNumber.toLowerCase()) ?? null;
          if (!proceedingId) {
            const proceeding = await client.query<{ id: string }>(
              `
                INSERT INTO enforcement_proceedings (proceeding_number, proceeding_date, source_identifiers)
                VALUES ($1, $2, $3::jsonb)
                RETURNING id
              `,
              [proceedingNumber, proceedingDate, JSON.stringify({ source: "pdf_import" })],
            );
            proceedingId = proceeding.rows[0].id;
            proceedingCache.set(proceedingNumber.toLowerCase(), proceedingId);
          }
        }

        const employerName = extractedString(manual, "employerName") ?? extractedString(extracted, "employerName");
        const employerTaxId = extractedString(manual, "employerTaxId");
        const employerAddress = extractedString(manual, "employerAddress") ?? extractedString(extracted, "employerAddress");
        let employerId: string | null = null;
        if (employerName) {
          const employer = await client.query<{ id: string }>(
            `
              INSERT INTO employers (name, tax_id, address, status)
              VALUES ($1, $2, $3, 'needs_review')
              RETURNING id
            `,
            [employerName, employerTaxId, employerAddress],
          );
          employerId = employer.rows[0].id;
        }

        const resolutionNumber = extractedString(extracted, "resolutionNumber");
        const resolutionDate = databaseDate(extractedString(extracted, "resolutionDate"));
        const withholdingPercent = typeof extracted.withholdingPercent === "number"
          && Number.isFinite(extracted.withholdingPercent)
          ? extracted.withholdingPercent
          : null;
        const employerSnapshot = employerName
          ? { name: employerName, taxId: employerTaxId, address: employerAddress, source: "pdf_import" }
          : null;
        const order = await client.query<{ id: string; public_code: string }>(
          `
            INSERT INTO orders
              (debtor_id, proceeding_id, employer_id, employer_snapshot, resolution_number,
               resolution_date, withholding_percent, status, created_by)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'needs_review', $8)
            RETURNING id, public_code
          `,
          [
            debtorId,
            proceedingId,
            employerId,
            employerSnapshot ? JSON.stringify(employerSnapshot) : null,
            resolutionNumber,
            resolutionDate,
            withholdingPercent,
            request.authUser.id,
          ],
        );
        const orderId = order.rows[0].id;
        await client.query(
          `
            INSERT INTO order_documents (order_id, document_id, document_type, attached_by)
            VALUES ($1, $2, 'fssp_resolution', $3)
          `,
          [orderId, row.source_document_id, request.authUser.id],
        );
        const warningCodes = new Set(jsonArray(row.warnings).flatMap((warning) => (
          isRecord(warning) && typeof warning.code === "string" ? [warning.code] : []
        )));
        const reviewFields = [
          {
            key: "employer_name",
            extracted: extractedString(extracted, "employerName"),
            manual: extractedString(manual, "employerName"),
            status: extractedString(manual, "employerName") ? "verified" : employerName ? "needs_review" : "missing",
          },
          {
            key: "employer_tax_id",
            extracted: null,
            manual: employerTaxId,
            status: employerTaxId ? "verified" : "missing",
          },
          {
            key: "employer_address",
            extracted: extractedString(extracted, "employerAddress"),
            manual: extractedString(manual, "employerAddress"),
            status: extractedString(manual, "employerAddress") ? "verified" : employerAddress ? "needs_review" : "missing",
          },
        ];
        for (const field of reviewFields) {
          await client.query(
            `
              INSERT INTO order_field_reviews
                (order_id, field_key, status, extracted_value, manual_value, source_page_start, source_page_end)
              VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
            `,
            [
              orderId,
              field.key,
              field.status,
              field.extracted === null ? null : JSON.stringify(field.extracted),
              field.manual === null ? null : JSON.stringify(field.manual),
              row.page_start,
              row.page_end,
            ],
          );
        }
        if (warningCodes.has("employer_name_requires_manual_verification") && employerId) {
          await client.query(
            "UPDATE order_field_reviews SET status = 'needs_review' WHERE order_id = $1 AND field_key = 'employer_name'",
            [orderId],
          );
        }
        await client.query("UPDATE import_items SET decision = 'confirmed', updated_at = now() WHERE id = $1", [row.item_id]);
        createdOrders.push({ id: orderId, itemId: row.item_id, filename: row.filename });
      }
      await client.query(
        "UPDATE import_batches SET status = 'committed', confirmed_at = now(), updated_at = now() WHERE id = $1",
        [request.params.id],
      );
      await audit(client, {
        actorId: request.authUser.id,
        entityType: "import_batch",
        entityId: request.params.id,
        action: "committed",
        newValues: { orderCount: createdOrders.length, allowDuplicates },
        requestId: request.id,
      });
      await client.query("COMMIT");
      return {
        batch: { id: request.params.id, status: "committed" },
        orders: createdOrders,
        excludedItems: excludedItems.map((row) => ({ itemId: row.item_id, filename: row.filename })),
        commitAvailable: false,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error(error, "PDF import commit failed");
      return reply.code(500).send({ error: "import_commit_failed" });
    } finally {
      client.release();
    }
  },
);

app.get<{ Params: { id: string } }>(
  "/api/imports/:id",
  { preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db) return;
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_import_id" });
    const result = await db.query<ImportItemRow>(
      `
        SELECT i.id, b.id AS batch_id, b.status AS batch_status, b.parser_version,
               b.created_at AS batch_created_at, f.id AS batch_file_id,
               f.status AS file_status, f.source_document_id, d.original_filename, f.page_count,
               i.page_start, i.page_end, i.raw_text, i.extracted_data, i.manual_data,
               i.warnings, i.duplicate_state, i.decision
        FROM import_batches b
        JOIN import_batch_files f ON f.batch_id = b.id
        JOIN documents d ON d.id = f.source_document_id
        JOIN import_items i ON i.batch_file_id = f.id
        WHERE b.id = $1
        ORDER BY i.page_start, i.id
      `,
      [request.params.id],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "import_not_found" });
    const first = result.rows[0];
    const files = Array.from(new Map(result.rows.map((row) => [row.batch_file_id, {
      id: row.batch_file_id,
      sourceDocumentId: row.source_document_id,
      filename: row.original_filename,
      pageCount: row.page_count,
      status: row.file_status,
    }])).values());
    return {
      batch: {
        id: first.batch_id,
        status: first.batch_status,
        parserVersion: first.parser_version,
        createdAt: first.batch_created_at,
      },
      file: files[0],
      files,
      items: result.rows.map(importItemResponse),
      composition: {
        totalFiles: files.length,
        readyFiles: files.filter((file) => file.status === "ready").length,
        failedFiles: files.filter((file) => file.status === "failed").length,
        itemsToSave: result.rows.filter((row) => row.decision === "pending").length,
        excludedItems: result.rows.filter((row) => row.decision === "excluded").length,
      },
      commitAvailable: false,
    };
  },
);

app.patch<{ Params: { id: string } }>(
  "/api/imports/items/:id",
  { preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_import_item_id" });
    const body = isRecord(request.body) ? request.body : {};
    const fields = body.manualFields;
    if (!isRecord(fields)) return reply.code(400).send({ error: "manual_fields_required" });
    const allowed = new Set(["employerName", "employerTaxId", "employerAddress"]);
    const limits: Record<string, number> = { employerName: 500, employerTaxId: 20, employerAddress: 1000 };
    const nextFields: JsonObject = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.has(key) || (value !== null && typeof value !== "string")) {
        return reply.code(400).send({ error: "invalid_manual_fields" });
      }
      const normalized = value === null ? null : value.trim();
      if (normalized && normalized.length > limits[key]) {
        return reply.code(400).send({ error: "manual_field_too_long", field: key });
      }
      nextFields[key] = normalized || null;
    }
    if (Object.keys(nextFields).length === 0) return reply.code(400).send({ error: "manual_fields_required" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<ImportItemRow>(
        `
          SELECT i.id, b.id AS batch_id, b.status AS batch_status, b.parser_version,
                 b.created_at AS batch_created_at, f.id AS batch_file_id,
                 f.status AS file_status, f.source_document_id, d.original_filename, f.page_count,
                 i.page_start, i.page_end, i.raw_text, i.extracted_data, i.manual_data,
                 i.warnings, i.duplicate_state, i.decision
          FROM import_items i
          JOIN import_batch_files f ON f.id = i.batch_file_id
          JOIN import_batches b ON b.id = f.batch_id
          JOIN documents d ON d.id = f.source_document_id
          WHERE i.id = $1
          FOR UPDATE
        `,
        [request.params.id],
      );
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "import_item_not_found" });
      }
      if (current.batch_status !== "ready_for_review") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_item_not_editable" });
      }
      const merged = { ...jsonObject(current.manual_data), ...nextFields };
      const updated = await client.query<ImportItemRow>(
        `
          UPDATE import_items
          SET manual_data = $1::jsonb, updated_at = now()
          WHERE id = $2
          RETURNING id, page_start, page_end, raw_text, extracted_data, manual_data,
                    warnings, duplicate_state, decision
        `,
        [JSON.stringify(merged), request.params.id],
      );
      await audit(client, {
        actorId: request.authUser.id,
        entityType: "import_item",
        entityId: request.params.id,
        action: "manual_fields_updated",
        oldValues: jsonObject(current.manual_data),
        newValues: merged,
        requestId: request.id,
      });
      await client.query("COMMIT");
      return {
        item: {
          id: updated.rows[0].id,
          pageStart: updated.rows[0].page_start,
          pageEnd: updated.rows[0].page_end,
          extracted: jsonObject(updated.rows[0].extracted_data),
          manualFields: jsonObject(updated.rows[0].manual_data),
          warnings: jsonArray(updated.rows[0].warnings),
        },
        commitAvailable: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error);
      return reply.code(500).send({ error: "import_item_update_failed" });
    } finally {
      client.release();
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/api/imports/items/:id/exclude",
  { preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_import_item_id" });
    const body = isRecord(request.body) ? request.body : {};
    const reason = stringValue(body.reason)?.trim() ?? "";
    if (!reason || reason.length > 500) return reply.code(400).send({ error: "exclusion_reason_required" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<ImportItemRow>(
        `
          SELECT i.id, b.id AS batch_id, b.status AS batch_status, b.parser_version,
                 b.created_at AS batch_created_at, f.id AS batch_file_id,
                 f.status AS file_status, f.source_document_id, d.original_filename, f.page_count,
                 i.page_start, i.page_end, i.raw_text, i.extracted_data, i.manual_data,
                 i.warnings, i.duplicate_state, i.decision
          FROM import_items i
          JOIN import_batch_files f ON f.id = i.batch_file_id
          JOIN import_batches b ON b.id = f.batch_id
          JOIN documents d ON d.id = f.source_document_id
          WHERE i.id = $1
          FOR UPDATE
        `,
        [request.params.id],
      );
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "import_item_not_found" });
      }
      if (current.batch_status !== "ready_for_review") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_item_not_editable" });
      }
      if (current.file_status !== "failed") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "only_failed_file_can_be_excluded" });
      }
      if (current.decision === "excluded") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "import_item_already_excluded" });
      }
      const warnings = jsonArray(current.warnings);
      warnings.push({ code: "excluded_by_user", message: `Файл исключён пользователем: ${reason}`, reason });
      const manualData = { ...jsonObject(current.manual_data), exclusionReason: reason };
      const updated = await client.query<ImportItemRow>(
        `
          UPDATE import_items
          SET decision = 'excluded', manual_data = $1::jsonb, warnings = $2::jsonb, updated_at = now()
          WHERE id = $3
          RETURNING id, page_start, page_end, raw_text, extracted_data, manual_data,
                    warnings, duplicate_state, decision
        `,
        [JSON.stringify(manualData), JSON.stringify(warnings), request.params.id],
      );
      await audit(client, {
        actorId: request.authUser.id,
        entityType: "import_item",
        entityId: request.params.id,
        action: "excluded",
        oldValues: { decision: current.decision, warnings: current.warnings },
        newValues: { decision: "excluded", reason },
        requestId: request.id,
      });
      await client.query("COMMIT");
      return {
        item: {
          id: updated.rows[0].id,
          pageStart: updated.rows[0].page_start,
          pageEnd: updated.rows[0].page_end,
          fileStatus: current.file_status,
          decision: updated.rows[0].decision,
          extracted: jsonObject(updated.rows[0].extracted_data),
          manualFields: {
            employerName: extractedString(updated.rows[0].manual_data, "employerName"),
            employerTaxId: extractedString(updated.rows[0].manual_data, "employerTaxId"),
            employerAddress: extractedString(updated.rows[0].manual_data, "employerAddress"),
          },
          exclusionReason: reason,
          warnings: jsonArray(updated.rows[0].warnings),
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error(error, "PDF item exclusion failed");
      return reply.code(500).send({ error: "import_item_exclusion_failed" });
    } finally {
      client.release();
    }
  },
);

app.post(
  "/api/documents",
  { preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ error: "binary_document_body_required" });
    }
    if (request.body.length === 0 || request.body.length > maxUploadBytes) {
      return reply.code(413).send({ error: "document_size_not_allowed" });
    }
    const mimeType = (headerValue(request.headers["x-file-type"]) ?? request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!allowedMimeTypes.has(mimeType)) {
      return reply.code(415).send({ error: "document_type_not_allowed" });
    }
    const originalFilename = sanitizeFilename(headerValue(request.headers["x-file-name"]) ?? "document.bin");
    const documentId = randomUUID();
    const storageKey = `${new Date().toISOString().slice(0, 10)}/${documentId}-${originalFilename}`;
    const digest = createHash("sha256").update(request.body).digest("hex");

    try {
      await documentStorage.put(storageKey, request.body);
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "document_storage_failed" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<DocumentRow>(
        `
          INSERT INTO documents
            (id, storage_key, sha256, byte_size, mime_type, original_filename, uploaded_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, storage_key, sha256, byte_size, mime_type, original_filename,
                    status, uploaded_by, created_at, updated_at
        `,
        [documentId, storageKey, digest, request.body.length, mimeType, originalFilename, request.authUser.id],
      );
      const document = inserted.rows[0];
      await audit(client, {
        actorId: request.authUser.id,
        entityType: "document",
        entityId: document.id,
        action: "uploaded",
        newValues: {
          sha256: document.sha256,
          byteSize: document.byte_size,
          mimeType: document.mime_type,
          originalFilename: document.original_filename,
        },
        requestId: request.id,
      });
      await client.query("COMMIT");
      return reply.code(201).send({ document });
    } catch (error) {
      await client.query("ROLLBACK");
      await documentStorage.remove(storageKey).catch((cleanupError) => request.log.error(cleanupError));
      request.log.error(error);
      return reply.code(500).send({ error: "document_registration_failed" });
    } finally {
      client.release();
    }
  },
);

app.get("/api/documents", { preHandler: requireAuth(pool) }, async (request, reply) => {
  const db = dbOrReply(reply);
  if (!db || !request.authUser) return;
  const query = isRecord(request.query) ? request.query : {};
  const requestedLimit = Number(query.limit ?? 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const result = await db.query<DocumentRow>(
    `
      SELECT id, storage_key, sha256, byte_size, mime_type, original_filename,
             status, uploaded_by, created_at, updated_at
      FROM documents
      WHERE ($1 IN ('admin', 'editor') OR status = 'active')
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [request.authUser.role, limit],
  );
  return { documents: result.rows };
});

app.get<{ Params: { id: string } }>(
  "/api/documents/:id",
  { preHandler: requireAuth(pool) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_document_id" });
    const result = await db.query<DocumentRow>(
      `
        SELECT id, storage_key, sha256, byte_size, mime_type, original_filename,
               status, uploaded_by, created_at, updated_at
        FROM documents WHERE id = $1
      `,
      [request.params.id],
    );
    const document = result.rows[0];
    if (!document) return reply.code(404).send({ error: "document_not_found" });
    if (document.status !== "active" && request.authUser.role === "viewer") {
      return reply.code(403).send({ error: "document_not_available" });
    }
    let contents: Buffer;
    try {
      contents = await documentStorage.read(document.storage_key);
    } catch (error) {
      request.log.error(error);
      return reply.code(404).send({ error: "document_file_not_found" });
    }
    const filename = encodeURIComponent(document.original_filename);
    reply.header("Content-Type", document.mime_type);
    reply.header("Content-Length", contents.length);
    reply.header("Content-Disposition", `attachment; filename="document"; filename*=UTF-8''${filename}`);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(contents);
  },
);

app.patch<{ Params: { id: string } }>(
  "/api/documents/:id",
  { preHandler: requireRole(pool, ["admin", "editor"]) },
  async (request, reply) => {
    const db = dbOrReply(reply);
    if (!db || !request.authUser) return;
    if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid_document_id" });
    const body = isRecord(request.body) ? request.body : {};
    if (!validDocumentStatus(body.status)) return reply.code(400).send({ error: "invalid_document_status" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<DocumentRow>(
        `
          SELECT id, storage_key, sha256, byte_size, mime_type, original_filename,
                 status, uploaded_by, created_at, updated_at
          FROM documents WHERE id = $1 FOR UPDATE
        `,
        [request.params.id],
      );
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "document_not_found" });
      }
      const updated = await client.query<DocumentRow>(
        `
          UPDATE documents SET status = $1, updated_at = now()
          WHERE id = $2
          RETURNING id, storage_key, sha256, byte_size, mime_type, original_filename,
                    status, uploaded_by, created_at, updated_at
        `,
        [body.status, request.params.id],
      );
      await audit(client, {
        actorId: request.authUser.id,
        entityType: "document",
        entityId: request.params.id,
        action: "status_changed",
        oldValues: { status: current.status },
        newValues: { status: updated.rows[0].status },
        requestId: request.id,
      });
      await client.query("COMMIT");
      return { document: updated.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error);
      return reply.code(500).send({ error: "document_update_failed" });
    } finally {
      client.release();
    }
  },
);

if (process.env.NODE_ENV === "production") {
  await app.register(fastifyStatic, {
    root: publicRoot,
    wildcard: false,
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
}

const close = async () => {
  await app.close();
  await pool?.end();
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

await app.listen({ port, host });
