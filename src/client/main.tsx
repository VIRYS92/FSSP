import { FormEvent, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type User = {
  id: string;
  login: string;
  email: string | null;
  displayName: string;
  role: "admin" | "editor" | "viewer";
  isActive: boolean;
};

type DocumentItem = {
  id: string;
  original_filename: string;
  mime_type: string;
  byte_size: string | number;
  status: "active" | "quarantined" | "archived";
  created_at: string;
};

type PdfManualFields = {
  employerName: string | null;
  employerTaxId: string | null;
  employerAddress: string | null;
};

type PdfWarning = { code: string; field?: string; message: string };

type PdfPreviewItem = {
  id: string;
  batchFileId?: string;
  filename?: string;
  pageStart: number;
  pageEnd: number;
  fileStatus?: "ready" | "failed";
  error?: string | null;
  duplicateState?: string;
  decision?: string;
  extracted: {
    resolutionNumber?: string | null;
    resolutionDate?: string | null;
    proceedingNumber?: string | null;
    proceedingDate?: string | null;
    debtorName?: string | null;
    debtorTaxId?: string | null;
    employerName?: string | null;
    employerAddress?: string | null;
    withholdingPercent?: number | null;
  };
  manualFields: PdfManualFields;
  exclusionReason?: string | null;
  warnings: PdfWarning[];
};

type PdfPreviewResponse = {
  batch: { id: string; status: string; parserVersion: string };
  file?: { filename: string; pageCount: number };
  files?: Array<{ id: string; filename: string; pageCount: number | null; status: string; error: string | null }>;
  items: PdfPreviewItem[];
  composition?: { totalFiles: number; readyFiles: number; failedFiles: number; itemsToSave: number; excludedItems: number };
  commitAvailable: boolean;
  requiresConfirmation?: boolean;
};

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error ?? "request_failed");
  return payload;
};

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login, password }),
      });
      onLogin(result.user);
    } catch {
      setError("Не удалось войти. Проверьте логин и пароль.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Управляющая компания</p>
        <h1>Контроль постановлений ФССП</h1>
        <p className="muted">Войдите, чтобы открыть защищённые документы и рабочую область.</p>
        <form onSubmit={submit} className="form-stack">
          <label>Логин<input value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" required /></label>
          <label>Пароль<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {error && <p className="error-message">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "Входим…" : "Войти"}</button>
        </form>
      </section>
    </main>
  );
}

function Documents({ user }: { user: User }) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const result = await api<{ documents: DocumentItem[] }>("/api/documents");
      setDocuments(result.documents);
    } catch {
      setError("Не удалось загрузить документы.");
    }
  };

  useEffect(() => { void load(); }, []);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("document") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/documents", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-type": file.type || "application/octet-stream",
          "x-file-name": file.name,
        },
        body: file,
      });
      form.reset();
      await load();
    } catch {
      setError("Не удалось загрузить файл. Разрешены PDF, PNG, JPEG, TXT и бинарные документы.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Защищённое хранилище</p><h2>Документы</h2></div>
        <span className="role-badge">{user.role}</span>
      </div>
      {(user.role === "admin" || user.role === "editor") && (
        <form onSubmit={upload} className="upload-row">
          <input name="document" type="file" accept="application/pdf,image/jpeg,image/png,text/plain,application/octet-stream" required />
          <button type="submit" disabled={busy}>{busy ? "Загрузка…" : "Загрузить"}</button>
        </form>
      )}
      {error && <p className="error-message">{error}</p>}
      {documents.length === 0 ? <p className="muted">Документов пока нет.</p> : (
        <ul className="document-list">
          {documents.map((document) => (
            <li key={document.id}>
              <div><strong>{document.original_filename}</strong><span>{document.mime_type} · {document.status}</span></div>
              <a href={`/api/documents/${document.id}`} download>Скачать</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PdfImportPreview() {
  const [preview, setPreview] = useState<PdfPreviewResponse | null>(null);
  const [manual, setManual] = useState<Record<string, PdfManualFields>>({});
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("pdf") as HTMLInputElement | null;
    const files = input?.files ? Array.from(input.files) : [];
    if (files.length === 0) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("pdfs", file, file.name));
      const result = await api<PdfPreviewResponse>("/api/imports/package-preview", {
        method: "POST",
        body: formData,
      });
      setPreview(result);
      setManual(Object.fromEntries(result.items.map((item) => [item.id, {
        employerName: item.manualFields?.employerName ?? "",
        employerTaxId: item.manualFields?.employerTaxId ?? "",
        employerAddress: item.manualFields?.employerAddress ?? "",
      }])));
      setAllowDuplicates(false);
      setMessage(`Предпросмотр пакета из ${result.items.length} файл(ов) создан. Рабочие записи пока не созданы.`);
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось обработать PDF.");
    } finally {
      setBusy(false);
    }
  };

  const saveManual = async (item: PdfPreviewItem) => {
    if (!item) return;
    const fields = manual[item.id] ?? { employerName: "", employerTaxId: "", employerAddress: "" };
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ item: PdfPreviewItem }>(`/api/imports/items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manualFields: {
          employerName: fields.employerName || null,
          employerTaxId: fields.employerTaxId || null,
          employerAddress: fields.employerAddress || null,
        } }),
      });
      setPreview((current) => current ? { ...current, items: current.items.map((currentItem) => currentItem.id === item.id ? { ...currentItem, ...result.item } : currentItem) } : current);
      setMessage("Ручные реквизиты сохранены в черновике предпросмотра.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить реквизиты.");
    } finally {
      setBusy(false);
    }
  };

  const excludeItem = async (item: PdfPreviewItem) => {
    const reason = window.prompt("Почему файл нужно исключить из пакета?", item.error ?? "Повреждённый PDF");
    if (!reason?.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ item: PdfPreviewItem }>(`/api/imports/items/${item.id}/exclude`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setPreview((current) => current ? {
        ...current,
        items: current.items.map((currentItem) => currentItem.id === item.id ? { ...currentItem, ...result.item } : currentItem),
        composition: current.composition ? {
          ...current.composition,
          itemsToSave: Math.max(0, current.composition.itemsToSave - 1),
          excludedItems: current.composition.excludedItems + 1,
        } : current.composition,
      } : current);
      setMessage("Ошибочный файл исключён явно. Он останется в составе пакета с причиной исключения.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось исключить файл.");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ batch: { status: string }; orders: Array<{ id: string; public_code?: string }> }>(`/api/imports/${preview.batch.id}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, allowDuplicates }),
      });
      setPreview((current) => current ? {
        ...current,
        batch: { ...current.batch, status: result.batch.status },
        items: current.items.map((item) => item.decision === "pending" ? { ...item, decision: "confirmed" } : item),
        composition: current.composition ? { ...current.composition, itemsToSave: 0 } : current.composition,
        commitAvailable: false,
      } : current);
      setMessage(`Пакет подтверждён: создано рабочих записей — ${result.orders.length}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подтвердить пакет.");
    } finally {
      setBusy(false);
    }
  };

  const hasDuplicates = preview?.items.some((item) => item.duplicateState === "possible_duplicate") ?? false;
  return (
    <section className="panel" id="pdf-import">
      <div className="panel-heading"><div><p className="eyebrow">Подэтап 6.2</p><h2>Пакетный импорт PDF</h2></div><span className="role-badge">без OCR</span></div>
      <p className="muted">Выберите один или несколько PDF с текстовым слоем. OCR и векторный поиск не выполняются. До отдельного подтверждения рабочие записи не создаются.</p>
      <form onSubmit={upload} className="upload-row">
        <input name="pdf" type="file" accept="application/pdf" multiple required />
        <button type="submit" disabled={busy}>{busy ? "Обработка…" : "Показать пакет"}</button>
      </form>
      {error && <p className="error-message">{error}</p>}
      {message && <p className="success-message">{message}</p>}
      {preview && <p className="package-summary">Состав пакета: файлов — {preview.composition?.totalFiles ?? preview.files?.length ?? preview.items.length}; к сохранению — {preview.composition?.itemsToSave ?? preview.items.filter((item) => item.decision === "pending").length}; исключено — {preview.composition?.excludedItems ?? preview.items.filter((item) => item.decision === "excluded").length}; ошибок — {preview.composition?.failedFiles ?? preview.items.filter((item) => item.fileStatus === "failed").length}.</p>}
      {preview && preview.items.map((item) => {
        const fields = manual[item.id] ?? { employerName: "", employerTaxId: "", employerAddress: "" };
        return <div className="preview-card" key={item.id}>
          <p><strong>{item.filename ?? preview.files?.find((file) => file.id === item.id)?.filename ?? "PDF"}</strong> · страницы {item.pageStart}–{item.pageEnd}</p>
          {item.fileStatus === "failed" && <div className="warning-box"><strong>Файл не прочитан</strong><p>{item.error ?? "Причина не указана."}</p>{item.decision !== "excluded" ? <button type="button" onClick={() => void excludeItem(item)} disabled={busy}>Исключить ошибочный файл из пакета</button> : <p>Исключён явно: {item.exclusionReason}</p>}</div>}
          <p className="muted">Должник: {item.extracted.debtorName ?? "не извлечён"} · ИП: {item.extracted.proceedingNumber ?? "не извлечён"}</p>
          <div className="form-grid">
            <label>Наименование работодателя<input value={fields.employerName ?? ""} placeholder={item.extracted.employerName ?? "Заполните вручную"} onChange={(event) => setManual((current) => ({ ...current, [item.id]: { ...fields, employerName: event.target.value } }))} /></label>
            <label>ИНН работодателя<input value={fields.employerTaxId ?? ""} placeholder="Заполните вручную" onChange={(event) => setManual((current) => ({ ...current, [item.id]: { ...fields, employerTaxId: event.target.value } }))} /></label>
            <label>Адрес работодателя<textarea value={fields.employerAddress ?? ""} placeholder={item.extracted.employerAddress ?? "Заполните вручную"} onChange={(event) => setManual((current) => ({ ...current, [item.id]: { ...fields, employerAddress: event.target.value } }))} /></label>
          </div>
          <button type="button" onClick={() => void saveManual(item)} disabled={busy}>Сохранить исправления предпросмотра</button>
          {item.duplicateState === "possible_duplicate" && <p className="warning-message">Возможный дубль требует проверки.</p>}
          {item.warnings.length > 0 && <div className="warning-box"><strong>Предупреждения</strong><ul>{item.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul></div>}
        </div>;
      })}
      {preview && preview.batch.status === "ready_for_review" && (
        <div className="confirmation-box">
          {hasDuplicates && <label className="checkbox-label"><input type="checkbox" checked={allowDuplicates} onChange={(event) => setAllowDuplicates(event.target.checked)} /> Я проверил возможные дубли и разрешаю создание записей.</label>}
          <button type="button" onClick={() => void commit()} disabled={busy || (hasDuplicates && !allowDuplicates) || preview.items.some((item) => item.fileStatus === "failed" && item.decision !== "excluded")}>Подтвердить и создать рабочие записи</button>
          <p className="muted">Подтверждение транзакционное. Неполные реквизиты сохраняются с предупреждениями.</p>
        </div>
      )}
    </section>
  );
}

type RegistryStatus = "draft" | "needs_review" | "active" | "completed" | "archived";

type RegistryOrder = {
  id: string;
  publicCode: string;
  status: RegistryStatus;
  version: number;
  resolutionNumber: string | null;
  resolutionDate: string | null;
  withholdingPercent: number | null;
  manualEffectiveDate: string | null;
  updatedAt: string;
  debtor: { id: string; fullName: string; taxId: string | null; birthDate: string | null; address: string | null };
  proceeding: { id: string; number: string | null; date: string | null; enforcementDocument: string | null; authority: string | null; caseReference: string | null } | null;
  employer: { id: string; name: string | null; taxId: string | null; address: string | null; status: string | null } | null;
  responsible: { id: string; displayName: string | null } | null;
  incomplete: boolean;
  fieldReviews: Array<{ fieldKey: string; status: string; updatedAt: string }>;
};

type RegistryForm = {
  debtor: { fullName: string; taxId: string; birthDate: string; address: string };
  proceeding: { number: string; date: string; enforcementDocument: string; authority: string; caseReference: string };
  resolutionNumber: string;
  resolutionDate: string;
  withholdingPercent: string;
  manualEffectiveDate: string;
  employer: { name: string; taxId: string; address: string };
  responsibleId: string;
  status: RegistryStatus;
};

type RegistryHistory = {
  id: string;
  actor_id: string | null;
  occurred_at: string;
  action: string;
  old_values: unknown;
  new_values: unknown;
};

const blankRegistryForm = (): RegistryForm => ({
  debtor: { fullName: "", taxId: "", birthDate: "", address: "" },
  proceeding: { number: "", date: "", enforcementDocument: "", authority: "", caseReference: "" },
  resolutionNumber: "",
  resolutionDate: "",
  withholdingPercent: "",
  manualEffectiveDate: "",
  employer: { name: "", taxId: "", address: "" },
  responsibleId: "",
  status: "needs_review",
});

const registryFormFromOrder = (order: RegistryOrder): RegistryForm => ({
  debtor: {
    fullName: order.debtor.fullName ?? "",
    taxId: order.debtor.taxId ?? "",
    birthDate: order.debtor.birthDate ?? "",
    address: order.debtor.address ?? "",
  },
  proceeding: {
    number: order.proceeding?.number ?? "",
    date: order.proceeding?.date ?? "",
    enforcementDocument: order.proceeding?.enforcementDocument ?? "",
    authority: order.proceeding?.authority ?? "",
    caseReference: order.proceeding?.caseReference ?? "",
  },
  resolutionNumber: order.resolutionNumber ?? "",
  resolutionDate: order.resolutionDate ?? "",
  withholdingPercent: order.withholdingPercent === null ? "" : String(order.withholdingPercent),
  manualEffectiveDate: order.manualEffectiveDate ?? "",
  employer: {
    name: order.employer?.name ?? "",
    taxId: order.employer?.taxId ?? "",
    address: order.employer?.address ?? "",
  },
  responsibleId: order.responsible?.id ?? "",
  status: order.status,
});

const registryPayload = (form: RegistryForm) => ({
  debtor: {
    fullName: form.debtor.fullName,
    taxId: form.debtor.taxId || null,
    birthDate: form.debtor.birthDate || null,
    address: form.debtor.address || null,
  },
  proceeding: {
    number: form.proceeding.number || null,
    date: form.proceeding.date || null,
    enforcementDocument: form.proceeding.enforcementDocument || null,
    authority: form.proceeding.authority || null,
    caseReference: form.proceeding.caseReference || null,
  },
  resolutionNumber: form.resolutionNumber || null,
  resolutionDate: form.resolutionDate || null,
  withholdingPercent: form.withholdingPercent === "" ? null : Number(form.withholdingPercent),
  manualEffectiveDate: form.manualEffectiveDate || null,
  employer: {
    name: form.employer.name || null,
    taxId: form.employer.taxId || null,
    address: form.employer.address || null,
  },
  responsibleId: form.responsibleId || null,
  status: form.status,
});

const registryStatusLabels: Record<RegistryStatus, string> = {
  draft: "Черновик",
  needs_review: "Нужно проверить",
  active: "Активно",
  completed: "Завершено",
  archived: "Архив",
};

const formatDateTime = (value: string) => new Date(value).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });

type ReportOverview = {
  generatedAt: string;
  today: string;
  timezone: string;
  filters: string;
  total: number;
  statusCounts: Record<string, number>;
  incomplete: number;
  deliveredWithoutUkPayment: number;
  paymentsToClarify: number;
  controlCounts: Record<string, number>;
  payments: { fssp: string; uk: string };
};

function ReportsOverview() {
  const [overview, setOverview] = useState<ReportOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<ReportOverview>("/api/reports/overview")
      .then(setOverview)
      .catch(() => setError("Не удалось загрузить обзор отчётов."));
  }, []);
  if (error) return <section className="panel overview-panel" id="reports"><p className="error-message">{error}</p></section>;
  if (!overview) return <section className="panel overview-panel" id="reports"><p className="muted">Загрузка обзора…</p></section>;
  const controlCount = (key: string) => overview.controlCounts[key] ?? 0;
  return (
    <section className="panel overview-panel" id="reports">
      <div className="panel-heading"><div><p className="eyebrow">Этап 8</p><h2>Обзор и отчёты</h2><p className="muted">Актуально на {overview.today} ({overview.timezone}). Excel-импорт не выполняется.</p></div><a className="button-secondary light" href="/api/reports/orders.xlsx">Скачать XLSX по активной выборке</a></div>
      <div className="report-summary-grid">
        <article><span>Постановлений</span><strong>{overview.total}</strong><small>в текущей выборке</small></article>
        <article><span>Просроченный контроль</span><strong>{controlCount("overdue")}</strong><small>требуют действия</small></article>
        <article><span>Сегодня / скоро</span><strong>{controlCount("today") + controlCount("soon")}</strong><small>{controlCount("today")} сегодня, {controlCount("soon")} скоро</small></article>
        <article><span>Неполные реквизиты</span><strong>{overview.incomplete}</strong><small>нужно проверить</small></article>
        <article><span>Вручено без платежа УК</span><strong>{overview.deliveredWithoutUkPayment}</strong><small>для уточнения</small></article>
        <article><span>Платежи к уточнению</span><strong>{overview.paymentsToClarify}</strong><small>с предупреждениями</small></article>
        <article><span>Подтверждено ФССП</span><strong>{overview.payments.fssp}</strong><small>денежный итог</small></article>
        <article><span>Подтверждено УК</span><strong>{overview.payments.uk}</strong><small>денежный итог</small></article>
      </div>
    </section>
  );
}

function OrdersRegistry({ user }: { user: User }) {
  const canEdit = user.role === "admin" || user.role === "editor";
  const [orders, setOrders] = useState<RegistryOrder[]>([]);
  const [assignees, setAssignees] = useState<Array<{ id: string; displayName: string; role: string }>>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"substring" | "fulltext">("substring");
  const [status, setStatus] = useState("");
  const [responsibleId, setResponsibleId] = useState("");
  const [incomplete, setIncomplete] = useState(false);
  const [sort, setSort] = useState("updatedAt");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ order: RegistryOrder; history: RegistryHistory[] } | null>(null);
  const [form, setForm] = useState<RegistryForm>(blankRegistryForm);
  const [editing, setEditing] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const columnDefinitions = [
    ["publicCode", "Код"], ["debtor", "Должник"], ["employer", "Работодатель"],
    ["proceeding", "ИП"], ["status", "Статус"], ["responsible", "Ответственный"], ["warning", "Реквизиты"], ["updatedAt", "Изменено"],
  ] as const;
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    try {
      const saved = window.localStorage.getItem("fssp.registry.columns");
      return saved ? JSON.parse(saved) as string[] : columnDefinitions.map(([key]) => key);
    } catch { return columnDefinitions.map(([key]) => key); }
  });

  const loadOrders = async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort, direction });
    if (query.trim()) params.set("q", query.trim());
    if (searchMode !== "substring") params.set("mode", searchMode);
    if (status) params.set("status", status);
    if (responsibleId) params.set("responsibleId", responsibleId);
    if (incomplete) params.set("incomplete", "true");
    const result = await api<{ orders: RegistryOrder[]; total: number; pages: number }>(`/api/orders?${params.toString()}`);
    setOrders(result.orders);
    setTotal(result.total);
    setPages(result.pages);
    if (selectedId && !result.orders.some((order) => order.id === selectedId) && !detail) setSelectedId(null);
  };

  useEffect(() => { void loadOrders().catch(() => setError("Не удалось загрузить реестр постановлений.")); }, [page, pageSize, query, searchMode, status, responsibleId, incomplete, sort, direction]);
  useEffect(() => {
    api<{ users: Array<{ id: string; displayName: string; role: string }> }>("/api/order-assignees")
      .then((result) => setAssignees(result.users)).catch(() => setError("Не удалось загрузить список ответственных."));
  }, []);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setBusy(true);
    api<{ order: RegistryOrder; history: RegistryHistory[] }>(`/api/orders/${selectedId}`)
      .then((result) => { setDetail(result); setForm(registryFormFromOrder(result.order)); setEditing(false); })
      .catch(() => setError("Не удалось открыть карточку постановления."))
      .finally(() => setBusy(false));
  }, [selectedId]);

  const updateForm = (section: "debtor" | "proceeding" | "employer", key: string, value: string) => {
    setForm((current) => ({ ...current, [section]: { ...current[section], [key]: value } }));
  };
  const toggleColumn = (key: string) => {
    setVisibleColumns((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      window.localStorage.setItem("fssp.registry.columns", JSON.stringify(next));
      return next;
    });
  };
  const changeSort = (key: string) => {
    if (sort === key) setDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSort(key); setDirection("asc"); }
    setPage(1);
  };
  const startCreate = () => {
    setSelectedId(null); setDetail(null); setEditing(true); setForm(blankRegistryForm()); setError(""); setMessage("");
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const payload = registryPayload(form) as Record<string, unknown>;
      if (detail) {
        const savedId = detail.order.id;
        await api(`/api/orders/${savedId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, expectedVersion: detail.order.version }) });
        setMessage("Постановление сохранено.");
        const refreshed = await api<{ order: RegistryOrder; history: RegistryHistory[] }>(`/api/orders/${savedId}`);
        setDetail(refreshed); setForm(registryFormFromOrder(refreshed.order)); setSelectedId(savedId);
      } else {
        const result = await api<{ order: { id: string } }>("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        setMessage("Постановление создано.");
        setSelectedId(result.order.id);
      }
      setEditing(false);
      await loadOrders();
    } catch (cause) {
      if (cause instanceof Error && cause.message === "order_version_conflict") {
        setError("Запись уже изменил другой пользователь. Изменения не перезаписаны; откройте карточку заново.");
        if (detail) {
          const refreshed = await api<{ order: RegistryOrder; history: RegistryHistory[] }>(`/api/orders/${detail.order.id}`);
          setDetail(refreshed); setForm(registryFormFromOrder(refreshed.order)); setEditing(false);
        }
      } else setError(cause instanceof Error ? cause.message : "Не удалось сохранить постановление.");
    } finally { setBusy(false); }
  };
  const archive = async () => {
    if (!detail || !window.confirm("Переместить постановление в архив?")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const payload = registryPayload({ ...form, status: "archived" });
      await api(`/api/orders/${detail.order.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, expectedVersion: detail.order.version }) });
      setMessage("Постановление архивировано."); setEditing(false); setSelectedId(null); setDetail(null); await loadOrders();
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "order_version_conflict" ? "Запись уже изменена другим пользователем; архивирование не выполнено." : "Не удалось архивировать постановление.");
    } finally { setBusy(false); }
  };
  const columnVisible = (key: string) => visibleColumns.includes(key);
  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const exportXlsx = (selectedOnly = false) => {
    if (selectedOnly && selectedIds.length === 0) return;
    const params = new URLSearchParams({ sort, direction, columns: visibleColumns.join(",") });
    if (query.trim()) params.set("q", query.trim());
    if (searchMode !== "substring") params.set("mode", searchMode);
    if (status) params.set("status", status);
    if (responsibleId) params.set("responsibleId", responsibleId);
    if (incomplete) params.set("incomplete", "true");
    if (selectedOnly) params.set("ids", selectedIds.join(","));
    window.open(`/api/reports/orders.xlsx?${params.toString()}`, "_blank", "noopener");
  };
  return (
    <section className="panel registry-panel" id="orders">
      <div className="panel-heading">
        <div><p className="eyebrow">Подэтап 7.1</p><h2>Рабочий реестр постановлений</h2><p className="muted">Записи создаются вручную или после подтверждённого PDF-импорта. Реквизиты работодателя можно заполнить вручную.</p></div>
        {canEdit && <button type="button" onClick={startCreate}>Новое постановление</button>}
      </div>
      <div className="registry-toolbar">
        <label>Поиск<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Код, ФИО, ИНН, номер ИП…" /></label>
        <label>Тип поиска<select value={searchMode} onChange={(event) => { setSearchMode(event.target.value as "substring" | "fulltext"); setPage(1); }}><option value="substring">По фрагменту</option><option value="fulltext">Полнотекстовый</option></select></label>
        <label>Статус<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">Все активные</option><option value="draft">Черновик</option><option value="needs_review">Нужно проверить</option><option value="active">Активно</option><option value="completed">Завершено</option><option value="archived">Архив</option><option value="all">Все</option></select></label>
        <label>Ответственный<select value={responsibleId} onChange={(event) => { setResponsibleId(event.target.value); setPage(1); }}><option value="">Все</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
        <label className="checkbox-label registry-filter"><input type="checkbox" checked={incomplete} onChange={(event) => { setIncomplete(event.target.checked); setPage(1); }} /> Неполные или непроверенные</label>
        <div className="column-menu"><button type="button" className="button-secondary light" onClick={() => setShowColumns((value) => !value)}>Столбцы</button>{showColumns && <div className="column-menu-popover">{columnDefinitions.map(([key, label]) => <label key={key} className="checkbox-label"><input type="checkbox" checked={columnVisible(key)} onChange={() => toggleColumn(key)} /> {label}</label>)}</div>}</div>
        <button type="button" className="button-secondary light" onClick={() => exportXlsx(false)}>Скачать XLSX</button>
        <button type="button" className="button-secondary light" disabled={selectedIds.length === 0} onClick={() => exportXlsx(true)}>Выбранные в XLSX ({selectedIds.length})</button>
      </div>
      {error && <p className="error-message">{error}</p>}
      {message && <p className="success-message">{message}</p>}
      <p className="registry-count">Найдено: {total}</p>
      <div className="registry-table-wrap">
        <table className="registry-table"><thead><tr><th className="selection-column">Выбор</th>{columnDefinitions.filter(([key]) => columnVisible(key)).map(([key, label]) => <th key={key}><button type="button" className="sort-button" onClick={() => changeSort(key)}>{label}{sort === key ? (direction === "asc" ? " ↑" : " ↓") : ""}</button></th>)}</tr></thead>
          <tbody>{orders.map((order) => <tr key={order.id} className={selectedId === order.id ? "selected-row" : ""} onClick={() => setSelectedId(order.id)}>
            <td className="selection-column"><input type="checkbox" checked={selectedIds.includes(order.id)} onChange={() => toggleSelected(order.id)} onClick={(event) => event.stopPropagation()} aria-label={`Выбрать ${order.publicCode}`} /></td>
            {columnVisible("publicCode") && <td><strong>{order.publicCode}</strong></td>}
            {columnVisible("debtor") && <td>{order.debtor.fullName}<small>{order.debtor.taxId || "ИНН не указан"}</small></td>}
            {columnVisible("employer") && <td>{order.employer?.name || "Не указан"}<small>{order.employer?.taxId || "ИНН не указан"}</small></td>}
            {columnVisible("proceeding") && <td>{order.proceeding?.number || "Не указан"}</td>}
            {columnVisible("status") && <td><span className={`status-pill status-${order.status}`}>{registryStatusLabels[order.status]}</span></td>}
            {columnVisible("responsible") && <td>{order.responsible?.displayName || "Не назначен"}</td>}
            {columnVisible("warning") && <td>{order.incomplete ? <span className="warning-message">Проверить реквизиты</span> : <span className="ok-message">Проверено</span>}</td>}
            {columnVisible("updatedAt") && <td>{formatDateTime(order.updatedAt)}</td>}
          </tr>)}</tbody>
        </table>
        {orders.length === 0 && <p className="muted empty-state">По заданным условиям постановлений нет.</p>}
      </div>
      <div className="pagination"><label>На странице<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label><span>Страница {pages === 0 ? 0 : page} из {pages}</span><button type="button" className="button-secondary light" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Назад</button><button type="button" className="button-secondary light" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Вперёд</button></div>
      {(editing || detail) && <div className="registry-card">
        <div className="panel-heading"><div><p className="eyebrow">{detail ? `Карточка ${detail.order.publicCode}` : "Новая запись"}</p><h3>{detail ? "Постановление" : "Создание постановления"}</h3>{detail && <p className="muted">Версия {detail.order.version}. Одновременное изменение проверяется сервером.</p>}</div>{detail && <button type="button" className="button-secondary light" onClick={() => { setEditing(false); setSelectedId(null); }}>Закрыть</button>}</div>
        {(!editing && detail) ? <div className="card-summary"><p><strong>{detail.order.debtor.fullName}</strong> · {registryStatusLabels[detail.order.status]}</p><p>Работодатель: {detail.order.employer?.name || "не указан"} · ИНН: {detail.order.employer?.taxId || "не указан"} · адрес: {detail.order.employer?.address || "не указан"}</p><p>Ответственный: {detail.order.responsible?.displayName || "не назначен"}</p>{detail.order.incomplete && <div className="warning-box"><strong>Реквизиты требуют проверки</strong><p>Заполните или проверьте наименование, ИНН и адрес работодателя. Эта запись доступна через фильтр неполных реквизитов.</p></div>}<div className="card-actions">{canEdit && <button type="button" onClick={() => setEditing(true)}>Редактировать</button>}{canEdit && detail.order.status !== "archived" && <button type="button" className="button-danger" onClick={() => void archive()}>Архивировать</button>}</div><div className="history"><h4>История изменений</h4>{detail.history.length === 0 ? <p className="muted">История пока пуста.</p> : <ul className="history-list">{detail.history.map((entry) => <li key={entry.id}><strong>{entry.action}</strong><span>{formatDateTime(entry.occurred_at)}</span></li>)}</ul>}</div></div> : <form onSubmit={(event) => void save(event)} className="registry-form">
          <div className="form-grid"><label>ФИО должника<input required value={form.debtor.fullName} onChange={(event) => updateForm("debtor", "fullName", event.target.value)} /></label><label>ИНН должника<input value={form.debtor.taxId} onChange={(event) => updateForm("debtor", "taxId", event.target.value)} /></label><label>Дата рождения<input type="date" value={form.debtor.birthDate} onChange={(event) => updateForm("debtor", "birthDate", event.target.value)} /></label><label>Адрес должника<input value={form.debtor.address} onChange={(event) => updateForm("debtor", "address", event.target.value)} /></label><label>Номер ИП<input value={form.proceeding.number} onChange={(event) => updateForm("proceeding", "number", event.target.value)} /></label><label>Дата ИП<input type="date" value={form.proceeding.date} onChange={(event) => updateForm("proceeding", "date", event.target.value)} /></label><label>Исполнительный документ<input value={form.proceeding.enforcementDocument} onChange={(event) => updateForm("proceeding", "enforcementDocument", event.target.value)} /></label><label>Выдавший орган<input value={form.proceeding.authority} onChange={(event) => updateForm("proceeding", "authority", event.target.value)} /></label><label>Номер дела<input value={form.proceeding.caseReference} onChange={(event) => updateForm("proceeding", "caseReference", event.target.value)} /></label><label>Номер постановления<input value={form.resolutionNumber} onChange={(event) => setForm((current) => ({ ...current, resolutionNumber: event.target.value }))} /></label><label>Дата постановления<input type="date" value={form.resolutionDate} onChange={(event) => setForm((current) => ({ ...current, resolutionDate: event.target.value }))} /></label><label>Удержание, %<input type="number" min="0" max="100" step="0.01" value={form.withholdingPercent} onChange={(event) => setForm((current) => ({ ...current, withholdingPercent: event.target.value }))} /></label><label>Дата вступления в силу<input type="date" value={form.manualEffectiveDate} onChange={(event) => setForm((current) => ({ ...current, manualEffectiveDate: event.target.value }))} /></label></div>
          <div className="form-grid"><label>Наименование работодателя<input value={form.employer.name} onChange={(event) => updateForm("employer", "name", event.target.value)} /></label><label>ИНН работодателя<input value={form.employer.taxId} onChange={(event) => updateForm("employer", "taxId", event.target.value)} /></label><label>Адрес работодателя<textarea value={form.employer.address} onChange={(event) => updateForm("employer", "address", event.target.value)} /></label></div>
          <div className="form-grid"><label>Ответственный<select value={form.responsibleId} onChange={(event) => setForm((current) => ({ ...current, responsibleId: event.target.value }))}><option value="">Не назначен</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><label>Статус<select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as RegistryStatus }))}>{Object.entries(registryStatusLabels).filter(([key]) => key !== "archived").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
          <div className="card-actions"><button type="submit" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button>{detail && <button type="button" className="button-secondary light" onClick={() => setEditing(false)}>Отмена</button>}</div>
        </form>}
      </div>}
    </section>
  );
}

type ShipmentStatus = "draft" | "sent" | "delivered" | "returned" | "archived";
type ShipmentItem = {
  id: string;
  position: number;
  orderId: string;
  publicCode: string;
  debtorName: string;
  employerName: string | null;
  employerAddress: string | null;
  orderIncomplete: boolean;
  employerVerified: boolean;
};
type Shipment = {
  id: string;
  publicCode: string;
  recipientName: string | null;
  recipientAddress: string | null;
  composition: string | null;
  trackingNumber: string | null;
  shipmentType: string | null;
  returnReason: string | null;
  status: ShipmentStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  responsible: { id: string; displayName: string | null } | null;
  version: number;
  updatedAt: string;
  items: ShipmentItem[];
  warnings: Array<{ code: string; message: string }>;
};
type ShipmentHistory = { id: string; occurred_at: string; action: string; old_values: unknown; new_values: unknown };
type ShipmentForm = {
  orderIds: string[];
  recipientName: string;
  recipientAddress: string;
  composition: string;
  trackingNumber: string;
  shipmentType: string;
  returnReason: string;
  responsibleId: string;
  status: ShipmentStatus;
  sentAt: string;
  deliveredAt: string;
  returnedAt: string;
};
type ShipmentSelection = {
  current: { shipment_id: string | null; public_code: string | null; selection_status: string } | null;
  candidates: Array<{ id: string; public_code: string; status: ShipmentStatus; selected: boolean }>;
};

type PaymentStage = "fssp" | "uk";
type PaymentConfirmationStatus = "unconfirmed" | "confirmed" | "rejected";
type PaymentDocument = { id: string; filename: string; documentType: string };
type Payment = {
  id: string;
  publicCode: string;
  target: { orderId: string; publicCode: string | null; debtorName: string | null; employerName: string | null; proceedingNumber: string | null } | null;
  unknownExternalId: string | null;
  stage: PaymentStage;
  source: string;
  paymentDate: string | null;
  amount: string;
  confirmationStatus: PaymentConfirmationStatus;
  enforcementReconciled: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  paymentDocument: string | null;
  note: string | null;
  rejectionReason: string | null;
  duplicateOverride: boolean;
  transfer: { id: string; externalReference: string | null; transferDate: string | null; note: string | null } | null;
  documents: PaymentDocument[];
  duplicateCandidates: Array<{ id: string; publicCode: string; confirmationStatus: PaymentConfirmationStatus; amount: string; paymentDate: string; transferId: string | null }>;
  warnings: Array<{ code: string; message: string }>;
  eligibleForTotals: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};
type PaymentHistory = { id: string; occurred_at: string; action: string; old_values: unknown; new_values: unknown };
type PaymentTransfer = { id: string; externalReference: string | null; transferDate: string | null; note: string | null; version: number };
type PaymentForm = {
  targetKind: "order" | "unknown";
  orderId: string;
  unknownExternalId: string;
  stage: PaymentStage;
  source: string;
  paymentDate: string;
  amount: string;
  confirmationStatus: PaymentConfirmationStatus;
  enforcementReconciled: boolean;
  periodStart: string;
  periodEnd: string;
  paymentDocument: string;
  note: string;
  rejectionReason: string;
  transferId: string;
  transferExternalReference: string;
  transferDate: string;
  transferNote: string;
  documentIds: string[];
  duplicateOverride: boolean;
};

type ControlState = "overdue" | "today" | "soon" | "scheduled" | "assign_action" | "assign_responsible" | "completed" | "archived";
type ControlSettings = { id: string | null; timezone: string; afterSentDays: number; afterDeliveredDays: number; afterUkCheckDays: number; reminderBeforeDays: number; effectiveFrom: string | null; version: number };
type ControlAction = { id: string; title: string; description: string | null; status: "open" | "in_progress" | "done" | "cancelled"; result: string | null; dueDate: string | null; manualDueDate: string | null; controlBasis: string; completedAt: string | null; assignedTo: { id: string; displayName: string | null } | null; version: number };
type ControlRow = { order: { id: string; publicCode: string; debtorName: string; status: string }; basis: string | null; baseDate: string | null; dueDate: string | null; reminderDate: string | null; state: ControlState; action: ControlAction | null; sourceDates: { sent: string | null; delivered: string | null; ukPayment: string | null } };
type ControlHistory = { id: string; occurred_at: string; action: string; old_values: unknown; new_values: unknown };
type ControlForm = { orderId: string; title: string; description: string; dueDate: string; manualDueDate: string; assignedTo: string; status: "open" | "in_progress" | "done" | "cancelled"; result: string; controlBasis: string };

const controlStateLabels: Record<ControlState, string> = {
  overdue: "Просрочено", today: "Сегодня", soon: "Скоро", scheduled: "Запланировано",
  assign_action: "Назначить действие", assign_responsible: "Назначить ответственного", completed: "Завершена", archived: "Архив",
};
const actionStatusLabels: Record<ControlForm["status"], string> = { open: "Открыта", in_progress: "В работе", done: "Завершена", cancelled: "Отменена" };
const blankControlForm = (): ControlForm => ({ orderId: "", title: "", description: "", dueDate: "", manualDueDate: "", assignedTo: "", status: "open", result: "", controlBasis: "manual" });

const paymentStageLabels: Record<PaymentStage, string> = { fssp: "Депозит ФССП", uk: "Счёт УК" };
const paymentConfirmationLabels: Record<PaymentConfirmationStatus, string> = { unconfirmed: "Не подтверждено", confirmed: "Подтверждено", rejected: "Отклонено" };
const blankPaymentForm = (): PaymentForm => ({
  targetKind: "order", orderId: "", unknownExternalId: "", stage: "fssp", source: "Этот работодатель", paymentDate: "", amount: "",
  confirmationStatus: "unconfirmed", enforcementReconciled: false, periodStart: "", periodEnd: "", paymentDocument: "", note: "", rejectionReason: "",
  transferId: "", transferExternalReference: "", transferDate: "", transferNote: "", documentIds: [], duplicateOverride: false,
});

const paymentFormFrom = (payment: Payment): PaymentForm => ({
  targetKind: payment.target ? "order" : "unknown",
  orderId: payment.target?.orderId ?? "",
  unknownExternalId: payment.unknownExternalId ?? "",
  stage: payment.stage,
  source: payment.source,
  paymentDate: payment.paymentDate ?? "",
  amount: payment.amount,
  confirmationStatus: payment.confirmationStatus,
  enforcementReconciled: payment.enforcementReconciled,
  periodStart: payment.periodStart ?? "",
  periodEnd: payment.periodEnd ?? "",
  paymentDocument: payment.paymentDocument ?? "",
  note: payment.note ?? "",
  rejectionReason: payment.rejectionReason ?? "",
  transferId: payment.transfer?.id ?? "",
  transferExternalReference: payment.transfer?.externalReference ?? "",
  transferDate: payment.transfer?.transferDate ?? "",
  transferNote: payment.transfer?.note ?? "",
  documentIds: payment.documents.map((document) => document.id),
  duplicateOverride: payment.duplicateOverride,
});

const paymentPayload = (form: PaymentForm, transferId = form.transferId) => ({
  orderId: form.targetKind === "order" ? form.orderId || null : null,
  unknownExternalId: form.targetKind === "unknown" ? form.unknownExternalId || null : null,
  stage: form.stage,
  source: form.source,
  paymentDate: form.paymentDate,
  amount: form.amount,
  confirmationStatus: form.confirmationStatus,
  enforcementReconciled: form.enforcementReconciled,
  periodStart: form.periodStart || null,
  periodEnd: form.periodEnd || null,
  paymentDocument: form.paymentDocument || null,
  note: form.note || null,
  rejectionReason: form.rejectionReason || null,
  transferId: transferId || null,
  documentIds: form.documentIds,
  duplicateOverride: form.duplicateOverride,
});

const shipmentStatusLabels: Record<ShipmentStatus, string> = {
  draft: "Черновик",
  sent: "Отправлено",
  delivered: "Вручено",
  returned: "Возвращено",
  archived: "Архив",
};

const blankShipmentForm = (): ShipmentForm => ({
  orderIds: [], recipientName: "", recipientAddress: "", composition: "", trackingNumber: "",
  shipmentType: "", returnReason: "", responsibleId: "", status: "draft", sentAt: "", deliveredAt: "", returnedAt: "",
});

const localDateTime = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

const shipmentFormFrom = (shipment: Shipment): ShipmentForm => ({
  orderIds: shipment.items.map((item) => item.orderId),
  recipientName: shipment.recipientName ?? "",
  recipientAddress: shipment.recipientAddress ?? "",
  composition: shipment.composition ?? "",
  trackingNumber: shipment.trackingNumber ?? "",
  shipmentType: shipment.shipmentType ?? "",
  returnReason: shipment.returnReason ?? "",
  responsibleId: shipment.responsible?.id ?? "",
  status: shipment.status,
  sentAt: localDateTime(shipment.sentAt),
  deliveredAt: localDateTime(shipment.deliveredAt),
  returnedAt: localDateTime(shipment.returnedAt),
});

const shipmentPayload = (form: ShipmentForm, status = form.status) => ({
  orderIds: form.orderIds,
  recipientName: form.recipientName || null,
  recipientAddress: form.recipientAddress || null,
  composition: form.composition || null,
  trackingNumber: form.trackingNumber || null,
  shipmentType: form.shipmentType || null,
  returnReason: form.returnReason || null,
  responsibleId: form.responsibleId || null,
  status,
  sentAt: form.sentAt ? new Date(form.sentAt).toISOString() : null,
  deliveredAt: form.deliveredAt ? new Date(form.deliveredAt).toISOString() : null,
  returnedAt: form.returnedAt ? new Date(form.returnedAt).toISOString() : null,
});

function ShipmentsRegistry({ user }: { user: User }) {
  const canEdit = user.role === "admin" || user.role === "editor";
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [orders, setOrders] = useState<RegistryOrder[]>([]);
  const [assignees, setAssignees] = useState<Array<{ id: string; displayName: string }>>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ shipment: Shipment; history: ShipmentHistory[] } | null>(null);
  const [form, setForm] = useState<ShipmentForm>(blankShipmentForm);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selections, setSelections] = useState<Record<string, ShipmentSelection>>({});

  const loadShipments = async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: "updatedAt", direction: "desc" });
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    const result = await api<{ shipments: Shipment[]; total: number; pages: number }>(`/api/shipments?${params.toString()}`);
    setShipments(result.shipments); setTotal(result.total); setPages(result.pages);
  };
  const loadOrders = async () => {
    const result = await api<{ orders: RegistryOrder[] }>("/api/orders?status=all&page=1&pageSize=100&sort=publicCode&direction=asc");
    setOrders(result.orders.filter((order) => order.status !== "archived"));
  };
  useEffect(() => { void loadShipments().catch(() => setError("Не удалось загрузить отправления.")); }, [page, pageSize, query, status]);
  useEffect(() => {
    void loadOrders().catch(() => setError("Не удалось загрузить постановления для состава."));
    api<{ users: Array<{ id: string; displayName: string }> }>("/api/order-assignees")
      .then((result) => setAssignees(result.users)).catch(() => setError("Не удалось загрузить список ответственных."));
  }, []);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setBusy(true);
    api<{ shipment: Shipment; history: ShipmentHistory[] }>(`/api/shipments/${selectedId}`)
      .then(async (result) => {
        setDetail(result); setForm(shipmentFormFrom(result.shipment)); setEditing(false);
        const selectionEntries = await Promise.all(result.shipment.items.map(async (item) => [item.orderId, await api<ShipmentSelection>(`/api/orders/${item.orderId}/shipments`)] as const));
        setSelections(Object.fromEntries(selectionEntries));
      })
      .catch(() => setError("Не удалось открыть карточку отправления."))
      .finally(() => setBusy(false));
  }, [selectedId]);

  const update = (key: keyof ShipmentForm, value: string | string[]) => setForm((current) => ({ ...current, [key]: value }));
  const toggleOrder = (orderId: string) => setForm((current) => ({ ...current, orderIds: current.orderIds.includes(orderId) ? current.orderIds.filter((id) => id !== orderId) : [...current.orderIds, orderId] }));
  const startCreate = () => { setSelectedId(null); setDetail(null); setEditing(true); setForm(blankShipmentForm()); setError(""); setMessage(""); };
  const persist = async (nextStatus = form.status, overrides: Partial<ShipmentForm> = {}) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const effectiveForm = { ...form, ...overrides };
      if (detail) {
        const savedId = detail.shipment.id;
        await api(`/api/shipments/${savedId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...shipmentPayload(effectiveForm, nextStatus), expectedVersion: detail.shipment.version }) });
        setMessage(nextStatus === "sent" ? "Отправка зафиксирована." : nextStatus === "delivered" ? "Вручение зафиксировано." : nextStatus === "returned" ? "Возврат зафиксирован." : nextStatus === "archived" ? "Отправление архивировано." : "Черновик сохранён.");
        const refreshed = await api<{ shipment: Shipment; history: ShipmentHistory[] }>(`/api/shipments/${savedId}`);
        setDetail(refreshed); setForm(shipmentFormFrom(refreshed.shipment)); setSelectedId(savedId);
      } else {
        const result = await api<{ shipment: { id: string } }>("/api/shipments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(shipmentPayload(effectiveForm, "draft")) });
        setMessage("Черновик отправления создан."); setSelectedId(result.shipment.id);
      }
      setEditing(false); await loadShipments();
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "Не удалось сохранить отправление.";
      setError(text === "shipment_version_conflict" ? "Отправление уже изменил другой пользователь. Изменения не перезаписаны." : text === "shipment_validation_failed" ? "Нельзя зафиксировать отправку: проверьте предупреждения в составе." : text);
      if (detail && text === "shipment_version_conflict") {
        const refreshed = await api<{ shipment: Shipment; history: ShipmentHistory[] }>(`/api/shipments/${detail.shipment.id}`);
        setDetail(refreshed); setForm(shipmentFormFrom(refreshed.shipment)); setEditing(false);
      }
    } finally { setBusy(false); }
  };
  const archive = () => { if (detail && window.confirm("Переместить отправление в архив?")) void persist("archived"); };
  const selectPreferred = async (orderId: string) => {
    if (!detail) return;
    setBusy(true); setError("");
    try {
      await api(`/api/orders/${orderId}/shipment-preference`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shipmentId: detail.shipment.id, reason: "Выбрано сотрудником в реестре отправлений" }) });
      const selection = await api<ShipmentSelection>(`/api/orders/${orderId}/shipments`);
      setSelections((current) => ({ ...current, [orderId]: selection })); setMessage("Актуальный конверт выбран вручную.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выбрать конверт."); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel shipment-panel" id="shipments">
      <div className="panel-heading"><div><p className="eyebrow">Подэтап 7.2</p><h2>Почтовые отправления</h2><p className="muted">Черновик фиксирует состав постановлений. После отправки получатель, адрес и состав защищены от изменения.</p></div>{canEdit && <button type="button" onClick={startCreate}>Новый конверт</button>}</div>
      <div className="registry-toolbar"><label>Поиск<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Код, получатель, трек-номер…" /></label><label>Статус<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">Все активные</option><option value="draft">Черновик</option><option value="sent">Отправлено</option><option value="delivered">Вручено</option><option value="returned">Возвращено</option><option value="archived">Архив</option><option value="all">Все</option></select></label></div>
      {error && <p className="error-message">{error}</p>}{message && <p className="success-message">{message}</p>}<p className="registry-count">Найдено: {total}</p>
      <div className="registry-table-wrap"><table className="registry-table shipment-table"><thead><tr><th>Код</th><th>Получатель</th><th>Состав</th><th>Статус</th><th>Трек-номер</th><th>Отправлено</th><th>Проверки</th></tr></thead><tbody>{shipments.map((shipment) => <tr key={shipment.id} className={selectedId === shipment.id ? "selected-row" : ""} onClick={() => setSelectedId(shipment.id)}><td><strong>{shipment.publicCode}</strong></td><td>{shipment.recipientName || "Не указан"}<small>{shipment.recipientAddress || "Адрес не указан"}</small></td><td>{shipment.items.length}<small>{shipment.items.map((item) => item.publicCode).join(", ") || "Постановления не выбраны"}</small></td><td><span className={`status-pill status-${shipment.status}`}>{shipmentStatusLabels[shipment.status]}</span></td><td>{shipment.trackingNumber || "—"}</td><td>{shipment.sentAt ? formatDateTime(shipment.sentAt) : "—"}</td><td>{shipment.warnings.length > 0 ? <span className="warning-message">{shipment.warnings.length} предупрежд.</span> : <span className="ok-message">Готово</span>}</td></tr>)}</tbody></table>{shipments.length === 0 && <p className="muted empty-state">Отправлений пока нет.</p>}</div>
      <div className="pagination"><label>На странице<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label><span>Страница {pages === 0 ? 0 : page} из {pages}</span><button type="button" className="button-secondary light" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Назад</button><button type="button" className="button-secondary light" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Вперёд</button></div>
      {(editing || detail) && <div className="registry-card shipment-card"><div className="panel-heading"><div><p className="eyebrow">{detail ? `Конверт ${detail.shipment.publicCode}` : "Новое отправление"}</p><h3>{detail ? "Карточка отправления" : "Создание черновика"}</h3>{detail && <p className="muted">Версия {detail.shipment.version}. Состав после отправки неизменяем.</p>}</div>{detail && <button type="button" className="button-secondary light" onClick={() => { setSelectedId(null); setDetail(null); setEditing(false); }}>Закрыть</button>}</div>
        {!editing && detail ? <div className="card-summary"><p><strong>{detail.shipment.recipientName || "Получатель не указан"}</strong> · {shipmentStatusLabels[detail.shipment.status]}</p><p>Адрес: {detail.shipment.recipientAddress || "не указан"} · трек-номер: {detail.shipment.trackingNumber || "не указан"}</p>{detail.shipment.warnings.length > 0 && <div className="warning-box"><strong>Проверки отправления</strong><ul>{detail.shipment.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul></div>}<h4>Состав</h4><ul className="shipment-items">{detail.shipment.items.map((item) => <li key={item.id}><div><strong>{item.publicCode}</strong> · {item.debtorName}<small>{item.employerName || "Работодатель не указан"} · {item.employerAddress || "адрес не указан"}</small></div><div>{selections[item.orderId]?.current?.selection_status === "ambiguous" && <span className="warning-message">Актуальный конверт неоднозначен</span>}{canEdit && detail.shipment.sentAt && <button type="button" className="button-secondary light" onClick={() => void selectPreferred(item.orderId)} disabled={busy}>Выбрать актуальным</button>}</div></li>)}</ul><div className="card-actions">{canEdit && detail.shipment.status === "draft" && <button type="button" onClick={() => setEditing(true)}>Редактировать</button>}{canEdit && detail.shipment.status === "draft" && <button type="button" onClick={() => void persist("sent")} disabled={busy}>Зафиксировать отправку</button>}{canEdit && detail.shipment.status === "sent" && <button type="button" onClick={() => void persist("delivered")} disabled={busy}>Отметить вручение</button>}{canEdit && (detail.shipment.status === "sent" || detail.shipment.status === "delivered") && <button type="button" className="button-danger" onClick={() => { const reason = window.prompt("Причина возврата", form.returnReason); if (reason !== null) { update("returnReason", reason); void persist("returned", { returnReason: reason }); } }} disabled={busy}>Отметить возврат</button>}{canEdit && detail.shipment.status !== "archived" && <button type="button" className="button-danger" onClick={archive} disabled={busy}>Архивировать</button>}</div><div className="history"><h4>История изменений</h4>{detail.history.length === 0 ? <p className="muted">История пока пуста.</p> : <ul className="history-list">{detail.history.map((entry) => <li key={entry.id}><strong>{entry.action}</strong><span>{formatDateTime(entry.occurred_at)}</span></li>)}</ul>}</div></div> : <form onSubmit={(event) => { event.preventDefault(); void persist("draft"); }} className="registry-form"><div className="form-grid"><label>Тип отправления<input value={form.shipmentType} onChange={(event) => update("shipmentType", event.target.value)} placeholder="Почта России, курьер…" /></label><label>Трек-номер<input value={form.trackingNumber} onChange={(event) => update("trackingNumber", event.target.value)} /></label><label>Получатель<input value={form.recipientName} onChange={(event) => update("recipientName", event.target.value)} placeholder="Подставится при одном проверенном работодателе" /></label><label>Адрес получателя<textarea value={form.recipientAddress} onChange={(event) => update("recipientAddress", event.target.value)} /></label><label>Состав конверта<textarea value={form.composition} onChange={(event) => update("composition", event.target.value)} placeholder="Подставится из выбранных постановлений" /></label><label>Ответственный<select value={form.responsibleId} onChange={(event) => update("responsibleId", event.target.value)}><option value="">Не назначен</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label></div><div className="shipment-order-picker"><strong>Постановления в составе</strong>{orders.map((order) => <label key={order.id} className="checkbox-label"><input type="checkbox" checked={form.orderIds.includes(order.id)} onChange={() => toggleOrder(order.id)} /> {order.publicCode} · {order.debtor.fullName} · {order.employer?.name || "работодатель не указан"}</label>)}{orders.length === 0 && <p className="muted">Нет доступных постановлений.</p>}</div><div className="card-actions"><button type="submit" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить черновик"}</button>{detail && <button type="button" className="button-secondary light" onClick={() => setEditing(false)}>Отмена</button>}</div></form>}
      </div>}
    </section>
  );
}

function PaymentsRegistry({ user }: { user: User }) {
  const canEdit = user.role === "admin" || user.role === "editor";
  const [payments, setPayments] = useState<Payment[]>([]);
  const [orders, setOrders] = useState<RegistryOrder[]>([]);
  const [transfers, setTransfers] = useState<PaymentTransfer[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("");
  const [confirmationStatus, setConfirmationStatus] = useState("");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [summary, setSummary] = useState<{ totals: { fssp: { amount: string; eventCount: number }; uk: { amount: string; eventCount: number } }; excludedCount: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ payment: Payment; history: PaymentHistory[] } | null>(null);
  const [form, setForm] = useState<PaymentForm>(blankPaymentForm);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadPayments = async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: "updatedAt", direction: "desc" });
    if (query.trim()) params.set("q", query.trim());
    if (stage) params.set("stage", stage);
    if (confirmationStatus) params.set("confirmationStatus", confirmationStatus);
    const result = await api<{ payments: Payment[]; total: number; pages: number }>(`/api/payments?${params.toString()}`);
    setPayments(result.payments); setTotal(result.total); setPages(result.pages);
  };
  const loadSupportingData = async () => {
    const [orderResult, transferResult, documentResult] = await Promise.all([
      api<{ orders: RegistryOrder[] }>("/api/orders?status=all&page=1&pageSize=100&sort=publicCode&direction=asc"),
      api<{ transfers: PaymentTransfer[] }>("/api/payment-transfers?limit=200"),
      api<{ documents: DocumentItem[] }>("/api/documents?limit=200"),
    ]);
    setOrders(orderResult.orders.filter((order) => order.status !== "archived"));
    setTransfers(transferResult.transfers);
    setDocuments(documentResult.documents.filter((document) => document.status !== "archived"));
  };
  const loadSummary = async () => {
    const result = await api<{ totals: { fssp: { amount: string; eventCount: number }; uk: { amount: string; eventCount: number } }; excludedCount: number }>(`/api/payments/summary?month=${encodeURIComponent(month)}`);
    setSummary(result);
  };
  useEffect(() => { void loadPayments().catch(() => setError("Не удалось загрузить поступления.")); }, [page, pageSize, query, stage, confirmationStatus]);
  useEffect(() => { void loadSupportingData().catch(() => setError("Не удалось загрузить справочники платежей.")); }, []);
  useEffect(() => { void loadSummary().catch(() => setError("Не удалось загрузить итоги платежей.")); }, [month]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setBusy(true);
    api<{ payment: Payment; history: PaymentHistory[] }>(`/api/payments/${selectedId}`)
      .then((result) => { setDetail(result); setForm(paymentFormFrom(result.payment)); setEditing(false); })
      .catch(() => setError("Не удалось открыть поступление."))
      .finally(() => setBusy(false));
  }, [selectedId]);

  const update = <K extends keyof PaymentForm>(key: K, value: PaymentForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const startCreate = () => { setSelectedId(null); setDetail(null); setForm(blankPaymentForm()); setEditing(true); setError(""); setMessage(""); };
  const persist = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const effective = { ...form };
      let transferId = effective.transferId;
      if (!transferId && (effective.transferExternalReference.trim() || effective.transferDate || effective.transferNote.trim())) {
        const transfer = await api<{ transfer: PaymentTransfer }>("/api/payment-transfers", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ externalReference: effective.transferExternalReference || null, transferDate: effective.transferDate || null, note: effective.transferNote || null }),
        });
        transferId = transfer.transfer.id;
        setTransfers((current) => [transfer.transfer, ...current]);
      }
      const payload = paymentPayload(effective, transferId);
      if (detail) {
        const savedId = detail.payment.id;
        await api(`/api/payments/${savedId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, expectedVersion: detail.payment.version }) });
        setMessage("Поступление сохранено.");
        const refreshed = await api<{ payment: Payment; history: PaymentHistory[] }>(`/api/payments/${savedId}`);
        setDetail(refreshed); setForm(paymentFormFrom(refreshed.payment)); setSelectedId(savedId);
      } else {
        const result = await api<{ payment: Payment }>("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        setMessage("Поступление создано."); setSelectedId(result.payment.id);
      }
      setEditing(false); await loadPayments(); await loadSummary();
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "Не удалось сохранить поступление.";
      setError(text === "payment_duplicates_require_review" ? "Найдены возможные дубли. Проверьте их и включите явное подтверждение отдельного платежа." : text === "payment_version_conflict" ? "Поступление уже изменил другой пользователь. Изменения не перезаписаны." : text);
      if (detail && text === "payment_version_conflict") {
        const refreshed = await api<{ payment: Payment; history: PaymentHistory[] }>(`/api/payments/${detail.payment.id}`);
        setDetail(refreshed); setForm(paymentFormFrom(refreshed.payment)); setEditing(false);
      }
    } finally { setBusy(false); }
  };

  const statusLabel = (value: PaymentConfirmationStatus) => paymentConfirmationLabels[value];
  return (
    <section className="panel payment-panel" id="payments">
      <div className="panel-heading"><div><p className="eyebrow">Подэтап 7.3</p><h2>Поступления</h2><p className="muted">Депозит ФССП и счёт УК учитываются раздельно. В итог попадают только проверенные записи этого работодателя.</p></div>{canEdit && <button type="button" onClick={startCreate}>Новое поступление</button>}</div>
      {summary && <div className="payment-summary"><article><span>ФССП за {month}</span><strong>{summary.totals.fssp.amount}</strong><small>{summary.totals.fssp.eventCount} событий</small></article><article><span>УК за {month}</span><strong>{summary.totals.uk.amount}</strong><small>{summary.totals.uk.eventCount} событий</small></article><article><span>Исключено из итогов</span><strong>{summary.excludedCount}</strong><small>требуют уточнения</small></article></div>}
      <div className="registry-toolbar"><label>Поиск<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Код, постановление, ИП, ID…" /></label><label>Этап<select value={stage} onChange={(event) => { setStage(event.target.value); setPage(1); }}><option value="">Все этапы</option><option value="fssp">Депозит ФССП</option><option value="uk">Счёт УК</option></select></label><label>Подтверждение<select value={confirmationStatus} onChange={(event) => { setConfirmationStatus(event.target.value); setPage(1); }}><option value="">Все состояния</option><option value="unconfirmed">Не подтверждено</option><option value="confirmed">Подтверждено</option><option value="rejected">Отклонено</option></select></label><label>Месяц итогов<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></div>
      {error && <p className="error-message">{error}</p>}{message && <p className="success-message">{message}</p>}<p className="registry-count">Найдено: {total}</p>
      <div className="registry-table-wrap"><table className="registry-table payment-table"><thead><tr><th>Код</th><th>Дата</th><th>Получатель</th><th>Этап</th><th>Сумма</th><th>Состояние</th><th>Проверки</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id} className={selectedId === payment.id ? "selected-row" : ""} onClick={() => setSelectedId(payment.id)}><td><strong>{payment.publicCode}</strong><small>{payment.transfer?.externalReference || "Без перевода"}</small></td><td>{payment.paymentDate || "—"}</td><td>{payment.target ? `${payment.target.publicCode || "Постановление"} · ${payment.target.debtorName || ""}` : `Внешний ID: ${payment.unknownExternalId}`}</td><td>{paymentStageLabels[payment.stage]}</td><td><strong>{payment.amount}</strong></td><td><span className={`status-pill status-${payment.confirmationStatus}`}>{statusLabel(payment.confirmationStatus)}</span></td><td>{payment.warnings.length > 0 ? <span className="warning-message">{payment.warnings.length} предупрежд.</span> : payment.eligibleForTotals ? <span className="ok-message">Входит в итог</span> : <span className="warning-message">Проверить</span>}</td></tr>)}</tbody></table>{payments.length === 0 && <p className="muted empty-state">Поступлений пока нет.</p>}</div>
      <div className="pagination"><label>На странице<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label><span>Страница {pages === 0 ? 0 : page} из {pages}</span><button type="button" className="button-secondary light" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Назад</button><button type="button" className="button-secondary light" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Вперёд</button></div>
      {(editing || detail) && <div className="registry-card payment-card"><div className="panel-heading"><div><p className="eyebrow">{detail ? `Поступление ${detail.payment.publicCode}` : "Новое поступление"}</p><h3>{detail ? "Карточка поступления" : "Создание поступления"}</h3>{detail && <p className="muted">Версия {detail.payment.version}. Возможный дубль требует отдельного решения.</p>}</div>{detail && <button type="button" className="button-secondary light" onClick={() => { setSelectedId(null); setDetail(null); setEditing(false); }}>Закрыть</button>}</div>
        {!editing && detail ? <div className="card-summary"><p><strong>{detail.payment.publicCode}</strong> · {paymentStageLabels[detail.payment.stage]} · {detail.payment.amount}</p><p>Получатель: {detail.payment.target ? `${detail.payment.target.publicCode || "постановление"} · ${detail.payment.target.debtorName || ""}` : `неизвестный ID ${detail.payment.unknownExternalId}`}</p><p>Дата: {detail.payment.paymentDate || "не указана"} · источник: {detail.payment.source}</p>{detail.payment.transfer && <p>Перевод: {detail.payment.transfer.externalReference || detail.payment.transfer.id} · {detail.payment.transfer.transferDate || "дата не указана"}</p>}{detail.payment.warnings.length > 0 && <div className="warning-box"><strong>Проверки поступления</strong><ul>{detail.payment.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul></div>}{detail.payment.documents.length > 0 && <p>Документы: {detail.payment.documents.map((document) => document.filename).join(", ")}</p>}<div className="card-actions">{canEdit && <button type="button" onClick={() => setEditing(true)}>Редактировать</button>}</div><div className="history"><h4>История изменений</h4>{detail.history.length === 0 ? <p className="muted">История пока пуста.</p> : <ul className="history-list">{detail.history.map((entry) => <li key={entry.id}><strong>{entry.action}</strong><span>{formatDateTime(entry.occurred_at)}</span></li>)}</ul>}</div></div> : <form onSubmit={(event) => void persist(event)} className="registry-form"><div className="form-grid"><label>Тип получателя<select value={form.targetKind} onChange={(event) => { const value = event.target.value as PaymentForm["targetKind"]; setForm((current) => ({ ...current, targetKind: value, orderId: value === "order" ? current.orderId : "", unknownExternalId: value === "unknown" ? current.unknownExternalId : "" })); }}><option value="order">Постановление</option><option value="unknown">Неизвестный внешний ID</option></select></label>{form.targetKind === "order" ? <label>Постановление<select required value={form.orderId} onChange={(event) => update("orderId", event.target.value)}><option value="">Выберите постановление</option>{orders.map((order) => <option key={order.id} value={order.id}>{order.publicCode} · {order.debtor.fullName}</option>)}</select></label> : <label>Внешний ID<input required value={form.unknownExternalId} onChange={(event) => update("unknownExternalId", event.target.value)} /></label>}<label>Этап<select value={form.stage} onChange={(event) => update("stage", event.target.value as PaymentStage)}><option value="fssp">Депозит ФССП</option><option value="uk">Счёт УК</option></select></label><label>Источник<input required value={form.source} onChange={(event) => update("source", event.target.value)} /></label><label>Дата платежа<input required type="date" value={form.paymentDate} onChange={(event) => update("paymentDate", event.target.value)} /></label><label>Сумма<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={form.amount} onChange={(event) => update("amount", event.target.value)} placeholder="0.00" /></label><label>Начало периода<input type="date" value={form.periodStart} onChange={(event) => update("periodStart", event.target.value)} /></label><label>Конец периода<input type="date" value={form.periodEnd} onChange={(event) => update("periodEnd", event.target.value)} /></label><label>Платёжный документ<input value={form.paymentDocument} onChange={(event) => update("paymentDocument", event.target.value)} /></label><label>Состояние<select value={form.confirmationStatus} onChange={(event) => update("confirmationStatus", event.target.value as PaymentConfirmationStatus)}><option value="unconfirmed">Не подтверждено</option><option value="confirmed">Подтверждено</option><option value="rejected">Отклонено</option></select></label></div><div className="form-grid"><label>Связанный перевод<select value={form.transferId} onChange={(event) => update("transferId", event.target.value)}><option value="">Без связи / создать ниже</option>{transfers.map((transfer) => <option key={transfer.id} value={transfer.id}>{transfer.externalReference || transfer.id} · {transfer.transferDate || "без даты"}</option>)}</select></label><label>Новый перевод: внешний номер<input value={form.transferExternalReference} onChange={(event) => update("transferExternalReference", event.target.value)} /></label><label>Дата перевода<input type="date" value={form.transferDate} onChange={(event) => update("transferDate", event.target.value)} /></label><label>Примечание перевода<input value={form.transferNote} onChange={(event) => update("transferNote", event.target.value)} /></label></div><label className="registry-filter"><input type="checkbox" checked={form.enforcementReconciled} onChange={(event) => update("enforcementReconciled", event.target.checked)} /> Номер ИП сверён</label>{form.confirmationStatus === "rejected" && <label>Причина отклонения<textarea required value={form.rejectionReason} onChange={(event) => update("rejectionReason", event.target.value)} /></label>}<label>Примечание платежа<textarea value={form.note} onChange={(event) => update("note", event.target.value)} /></label><label>Подтверждающие документы<select multiple value={form.documentIds} onChange={(event) => update("documentIds", Array.from(event.target.selectedOptions).map((option) => option.value))}>{documents.map((document) => <option key={document.id} value={document.id}>{document.original_filename}</option>)}</select></label>{form.confirmationStatus === "confirmed" && <label className="registry-filter"><input type="checkbox" checked={form.duplicateOverride} onChange={(event) => update("duplicateOverride", event.target.checked)} /> Я проверил возможный дубль и разрешаю отдельное событие</label>}<div className="card-actions"><button type="submit" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button>{detail && <button type="button" className="button-secondary light" onClick={() => setEditing(false)}>Отмена</button>}</div></form>}
      </div>}
    </section>
  );
}

function ControlRegistry({ user }: { user: User }) {
  const canEdit = user.role === "admin" || user.role === "editor";
  const [controls, setControls] = useState<ControlRow[]>([]);
  const [orders, setOrders] = useState<RegistryOrder[]>([]);
  const [assignees, setAssignees] = useState<Array<{ id: string; displayName: string; role: string }>>([]);
  const [settings, setSettings] = useState<ControlSettings | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<ControlRow | null>(null);
  const [history, setHistory] = useState<ControlHistory[]>([]);
  const [form, setForm] = useState<ControlForm>(blankControlForm);
  const [editing, setEditing] = useState(false);
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stateCounts = controls.reduce<Record<string, number>>((counts, control) => { counts[control.state] = (counts[control.state] ?? 0) + 1; return counts; }, {});

  const loadControls = async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q: query, state, includeArchived: String(includeArchived) });
    const result = await api<{ controls: ControlRow[]; total: number; pages: number; settings: ControlSettings }>(`/api/control?${params.toString()}`);
    setControls(result.controls); setTotal(result.total); setPages(result.pages); setSettings(result.settings);
  };
  const loadSupport = async () => {
    const [orderResult, assigneeResult] = await Promise.all([
      api<{ orders: RegistryOrder[] }>("/api/orders?status=all&page=1&pageSize=100&sort=publicCode&direction=asc"),
      api<{ users: Array<{ id: string; displayName: string; role: string }> }>("/api/order-assignees"),
    ]);
    setOrders(orderResult.orders.filter((order) => order.status !== "archived")); setAssignees(assigneeResult.users);
  };
  useEffect(() => { void loadControls().catch(() => setError("Не удалось загрузить контрольную ленту.")); }, [page, pageSize, query, state, includeArchived]);
  useEffect(() => { void loadSupport().catch(() => setError("Не удалось загрузить постановления и ответственных.")); api<{ settings: ControlSettings }>("/api/control-settings").then((result) => setSettings(result.settings)).catch(() => setError("Не удалось загрузить настройки контроля.")); }, []);

  const openControl = async (control: ControlRow) => {
    setSelected(control); setEditing(false); setMessage(""); setError("");
    if (control.action) {
      try {
        const result = await api<{ action: ControlAction; history: ControlHistory[] }>(`/api/actions/${control.action.id}`);
        setHistory(result.history);
        setForm({ orderId: control.order.id, title: result.action.title, description: result.action.description ?? "", dueDate: result.action.dueDate ?? "", manualDueDate: result.action.manualDueDate ?? "", assignedTo: result.action.assignedTo?.id ?? "", status: result.action.status, result: result.action.result ?? "", controlBasis: result.action.controlBasis });
      } catch { setError("Не удалось загрузить историю действия."); }
    } else {
      setHistory([]); setForm({ ...blankControlForm(), orderId: control.order.id });
    }
  };
  const update = <K extends keyof ControlForm>(key: K, value: ControlForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const startCreate = (control?: ControlRow) => { setSelected(control ?? null); setHistory([]); setForm({ ...blankControlForm(), orderId: control?.order.id ?? "" }); setEditing(true); setSettingsEditing(false); setError(""); setMessage(""); };
  const saveAction = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const payload = { orderId: form.orderId, title: form.title, description: form.description || null, dueDate: form.dueDate || null, manualDueDate: form.manualDueDate || null, assignedTo: form.assignedTo || null, status: form.status, result: form.result || null, controlBasis: form.controlBasis };
      if (selected?.action) {
        await api(`/api/actions/${selected.action.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, expectedVersion: selected.action.version }) });
        setMessage("Действие сохранено.");
      } else {
        await api("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        setMessage("Действие назначено.");
      }
      setEditing(false); await loadControls();
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "Не удалось сохранить действие.";
      setError(text === "action_version_conflict" ? "Действие уже изменил другой пользователь. Изменения не перезаписаны." : text);
      if (text === "action_version_conflict" && selected) await loadControls();
    } finally { setBusy(false); }
  };
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ settings: ControlSettings }>("/api/control-settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...settings, expectedVersion: settings.version }) });
      setSettings(result.settings); setSettingsEditing(false); setMessage("Настройки контроля сохранены."); await loadControls();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки контроля."); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel control-panel" id="control">
      <div className="panel-heading"><div><p className="eyebrow">Подэтап 7.4</p><h2>Контроль</h2><p className="muted">Сроки считаются в часовом поясе {settings?.timezone ?? "Asia/Yekaterinburg"}: 7 дней после отправки, 30 после вручения и 30 после подтверждённого платежа УК.</p></div>{canEdit && <button type="button" onClick={() => startCreate()}>Новое действие</button>}</div>
      <div className="control-summary"><span>Просрочено: <strong>{stateCounts.overdue ?? 0}</strong></span><span>Сегодня: <strong>{stateCounts.today ?? 0}</strong></span><span>Скоро: <strong>{stateCounts.soon ?? 0}</strong></span><span>Назначить: <strong>{(stateCounts.assign_action ?? 0) + (stateCounts.assign_responsible ?? 0)}</strong></span></div>
      <div className="registry-toolbar"><label>Поиск<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Код, ФИО, действие…" /></label><label>Состояние<select value={state} onChange={(event) => { setState(event.target.value); setPage(1); }}><option value="">Все</option>{Object.entries(controlStateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="registry-filter"><input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); setPage(1); }} /> Показывать архив</label>{settings && user.role === "admin" && <button type="button" className="button-secondary light" onClick={() => setSettingsEditing((value) => !value)}>Настройки сроков</button>}</div>
      {error && <p className="error-message">{error}</p>}{message && <p className="success-message">{message}</p>}<p className="registry-count">Найдено: {total}</p>
      {settingsEditing && settings && user.role === "admin" && <form className="control-settings" onSubmit={(event) => void saveSettings(event)}><label>Часовой пояс<input value={settings.timezone} onChange={(event) => setSettings((current) => current ? { ...current, timezone: event.target.value } : current)} /></label><label>После отправки, дней<input type="number" min="1" value={settings.afterSentDays} onChange={(event) => setSettings((current) => current ? { ...current, afterSentDays: Number(event.target.value) } : current)} /></label><label>После вручения, дней<input type="number" min="1" value={settings.afterDeliveredDays} onChange={(event) => setSettings((current) => current ? { ...current, afterDeliveredDays: Number(event.target.value) } : current)} /></label><label>После платежа УК, дней<input type="number" min="1" value={settings.afterUkCheckDays} onChange={(event) => setSettings((current) => current ? { ...current, afterUkCheckDays: Number(event.target.value) } : current)} /></label><label>Напоминать за, дней<input type="number" min="0" value={settings.reminderBeforeDays} onChange={(event) => setSettings((current) => current ? { ...current, reminderBeforeDays: Number(event.target.value) } : current)} /></label><button type="submit" disabled={busy}>Сохранить настройки</button></form>}
      <div className="registry-table-wrap"><table className="registry-table control-table"><thead><tr><th>Постановление</th><th>Основание</th><th>Срок</th><th>Действие</th><th>Ответственный</th><th>Состояние</th></tr></thead><tbody>{controls.map((control) => <tr key={control.order.id} className={selected?.order.id === control.order.id ? "selected-row" : ""} onClick={() => void openControl(control)}><td><strong>{control.order.publicCode}</strong><small>{control.order.debtorName}</small></td><td>{control.basis === "shipment_sent" ? "Отправка" : control.basis === "shipment_delivered" ? "Вручение" : control.basis === "uk_payment" ? "Платёж УК" : control.basis ? "Ручная дата" : "Нет события"}</td><td>{control.dueDate || "—"}<small>{control.reminderDate ? `Напомнить ${control.reminderDate}` : ""}</small></td><td>{control.action?.title || "Действие не назначено"}</td><td>{control.action?.assignedTo?.displayName || "Не назначен"}</td><td><span className={`status-pill control-${control.state}`}>{controlStateLabels[control.state]}</span></td></tr>)}</tbody></table>{controls.length === 0 && <p className="muted empty-state">Записей контроля нет.</p>}</div>
      <div className="pagination"><label>На странице<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label><span>Страница {pages === 0 ? 0 : page} из {pages}</span><button type="button" className="button-secondary light" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Назад</button><button type="button" className="button-secondary light" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Вперёд</button></div>
      {(editing || selected) && <div className="registry-card control-card"><div className="panel-heading"><div><p className="eyebrow">{selected ? selected.order.publicCode : "Новое действие"}</p><h3>{editing ? "Действие контроля" : "Карточка контроля"}</h3>{selected && <p className="muted">Основание: {selected.baseDate || "не задано"}; срок: {selected.dueDate || "не задан"}.</p>}</div>{selected && <button type="button" className="button-secondary light" onClick={() => { setSelected(null); setEditing(false); }}>Закрыть</button>}</div>{!editing && selected ? <div className="card-summary"><p><strong>{selected.order.publicCode}</strong> · {selected.order.debtorName} · {controlStateLabels[selected.state]}</p><p>Источники: отправка {selected.sourceDates.sent || "—"}, вручение {selected.sourceDates.delivered || "—"}, платёж УК {selected.sourceDates.ukPayment || "—"}</p>{selected.action ? <><p>Действие: {selected.action.title} · {actionStatusLabels[selected.action.status]}</p><p>Срок: {selected.action.dueDate || "не задан"} · ответственный: {selected.action.assignedTo?.displayName || "не назначен"}</p>{selected.action.result && <p>Результат: {selected.action.result}</p>}</> : <p>Действие ещё не назначено.</p>}{canEdit && <div className="card-actions"><button type="button" onClick={() => setEditing(true)}>{selected.action ? "Редактировать действие" : "Назначить действие"}</button></div>}{history.length > 0 && <div className="history"><h4>История</h4><ul className="history-list">{history.map((entry) => <li key={entry.id}><strong>{entry.action}</strong><span>{formatDateTime(entry.occurred_at)}</span></li>)}</ul></div>}</div> : <form className="registry-form" onSubmit={(event) => void saveAction(event)}><div className="form-grid"><label>Постановление<select required value={form.orderId} onChange={(event) => update("orderId", event.target.value)}><option value="">Выберите постановление</option>{orders.map((order) => <option key={order.id} value={order.id}>{order.publicCode} · {order.debtor.fullName}</option>)}</select></label><label>Название действия<input required value={form.title} onChange={(event) => update("title", event.target.value)} placeholder="Проверить исполнение…" /></label><label>Срок<input type="date" value={form.dueDate} onChange={(event) => update("dueDate", event.target.value)} /></label><label>Ручная дата (приоритет)<input type="date" value={form.manualDueDate} onChange={(event) => update("manualDueDate", event.target.value)} /></label><label>Ответственный<select value={form.assignedTo} onChange={(event) => update("assignedTo", event.target.value)}><option value="">Не назначен</option>{assignees.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><label>Состояние<select value={form.status} onChange={(event) => update("status", event.target.value as ControlForm["status"])}>{Object.entries(actionStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div><label>Описание<textarea value={form.description} onChange={(event) => update("description", event.target.value)} /></label><label>Результат<textarea value={form.result} onChange={(event) => update("result", event.target.value)} /></label><div className="card-actions"><button type="submit" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить действие"}</button>{selected && <button type="button" className="button-secondary light" onClick={() => setEditing(false)}>Отмена</button>}</div></form>}</div>}
    </section>
  );
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <div className="shell">
      <header className="topbar">
        <div><p className="eyebrow">Управляющая компания</p><h1>Контроль постановлений ФССП</h1></div>
        <div className="account"><span>{user.displayName}</span><button className="button-secondary" onClick={onLogout}>Выйти</button></div>
      </header>
      <nav className="navigation" aria-label="Основная навигация">
        <a className="active" href="#overview">Обзор</a>
        <a href="#reports">Отчёты</a>
        <a href="#documents">Документы</a>
        <a href="#orders">Постановления</a>
        <a href="#shipments">Отправления</a>
        <a href="#payments">Поступления</a>
        <a href="#control">Контроль</a>
      </nav>
      <main className="content" id="overview">
        <section className="hero-card">
          <div><p className="eyebrow">Авторизация и роли подключены</p><h2>Рабочая область постановлений</h2><p className="muted">Здесь доступны защищённые документы, пакетный PDF-предпросмотр и рабочий реестр. Строки из исходной книги не переносились.</p></div>
          <div className="hero-mark" aria-hidden="true">П</div>
        </section>
        <ReportsOverview />
        <div id="documents"><Documents user={user} /></div>
        {(user.role === "admin" || user.role === "editor") && <PdfImportPreview />}
        <OrdersRegistry user={user} />
        <ShipmentsRegistry user={user} />
        <PaymentsRegistry user={user} />
        <ControlRegistry user={user} />
      </main>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me").then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
  };

  if (loading) return <main className="auth-page"><p className="muted">Загрузка…</p></main>;
  return user ? <Workspace user={user} onLogout={() => void logout()} /> : <Login onLogin={setUser} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
