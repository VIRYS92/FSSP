import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const PDF_PARSER_VERSION = "pdf-local-v1";

export type PdfWarning = {
  code: string;
  field?: string;
  message: string;
};

export type ExtractedPdfFields = {
  resolutionNumber: string | null;
  resolutionDate: string | null;
  proceedingNumber: string | null;
  proceedingDate: string | null;
  debtorName: string | null;
  debtorTaxId: string | null;
  debtorBirthDate: string | null;
  employerName: string | null;
  employerTaxId: string | null;
  employerAddress: string | null;
  withholdingPercent: number | null;
  sources: Record<string, { page: number; excerpt: string }>;
};

export type PdfPreview = {
  pageCount: number;
  pageStart: number;
  pageEnd: number;
  pages: Array<{ pageNumber: number; text: string; hasText: boolean }>;
  rawText: string;
  extracted: ExtractedPdfFields;
  warnings: PdfWarning[];
};

const compact = (value: string) => value
  .replace(/\u00a0/g, " ")
  .replace(/\s+/g, " ")
  .replace(/\s+([,.;:])/g, "$1")
  .replace(/\s*-\s*/g, "-")
  .replace(/([«"'])\s+/g, "$1")
  .replace(/\s+([»"'])/g, "$1")
  .replace(/(ООО|ОАО|ПАО|ЗАО|МУП|АО|ИП)"/gi, '$1 "')
  .trim();

const cleanCandidate = (value: string | undefined) => {
  if (!value) return null;
  const result = compact(value).replace(/^[,;:\s]+|[,;:\s]+$/g, "").trim();
  return result || null;
};

const matchValue = (text: string, expression: RegExp) => cleanCandidate(text.match(expression)?.[1]);

const pageNumberFor = (pages: PdfPreview["pages"], value: string | null) => {
  if (!value) return 1;
  const index = pages.findIndex((page) => page.text.toLowerCase().includes(value.toLowerCase()));
  return index >= 0 ? pages[index].pageNumber : 1;
};

const sourceFor = (pages: PdfPreview["pages"], value: string | null) => {
  const page = pageNumberFor(pages, value);
  const pageText = pages[page - 1]?.text ?? "";
  const position = value ? pageText.toLowerCase().indexOf(value.toLowerCase()) : -1;
  const excerpt = position >= 0
    ? pageText.slice(Math.max(0, position - 100), Math.min(pageText.length, position + (value?.length ?? 0) + 100))
    : pageText.slice(0, 200);
  return { page, excerpt };
};

const looksLikePersonName = (value: string | null) => {
  if (!value || /(ООО|ОАО|ПАО|ЗАО|МУП|ИП|АО)/i.test(value)) return false;
  const normalized = value.replace(/[«»"']/g, "").trim();
  return /^(?:[А-ЯЁ][А-ЯЁ-]+|[А-ЯЁ][а-яё-]+)(?:\s+(?:[А-ЯЁ][А-ЯЁ-]+|[А-ЯЁ][а-яё-]+)){1,3}$/.test(normalized);
};

const createWarnings = (fields: ExtractedPdfFields, pages: PdfPreview["pages"], allText: string) => {
  const warnings: PdfWarning[] = [];
  const add = (code: string, message: string, field?: string) => warnings.push({ code, message, field });

  if (!fields.employerName) add("employer_name_missing", "Наименование работодателя не извлечено; заполните вручную.", "employerName");
  if (!fields.employerAddress) add("employer_address_missing", "Адрес работодателя не извлечён; заполните вручную.", "employerAddress");
  add("employer_inn_manual_required", "ИНН работодателя не заполняется автоматически; проверьте и внесите вручную.", "employerTaxId");
  if (looksLikePersonName(fields.employerName)) {
    add("employer_name_requires_manual_verification", "Работодатель похож на ФИО; юридический статус и ИНН не определяются автоматически.", "employerName");
  }
  if (/взыскать\s+солидарно/i.test(allText)) {
    add("solidarity_context_manual_debtor", "В документе перечислены солидарные должники; выбран только должник из контекстного блока.", "debtorName");
  }
  if (!fields.debtorName) add("debtor_missing", "Конкретный должник не извлечён; требуется ручная проверка.", "debtorName");
  if (!fields.proceedingNumber) add("proceeding_number_missing", "Номер исполнительного производства не извлечён.", "proceedingNumber");
  if (!fields.resolutionNumber) add("resolution_number_missing", "Номер постановления не извлечён.", "resolutionNumber");
  for (const page of pages) {
    if (!page.hasText) add("page_text_missing", `На странице ${page.pageNumber} не найден текстовый слой; OCR не выполнялся.`, `page:${page.pageNumber}`);
  }
  return warnings;
};

const textItems = (items: unknown[]) => items
  .map((item) => (item && typeof item === "object" && "str" in item ? String((item as { str?: unknown }).str ?? "") : ""))
  .join(" ");

export const parsePdfPreview = async (contents: Buffer): Promise<PdfPreview> => {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(contents),
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages: PdfPreview["pages"] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = compact(textItems(content.items));
    pages.push({ pageNumber, text, hasText: text.length > 0 });
  }

  const rawText = pages.map((page) => `--- PAGE ${page.pageNumber} ---\n${page.text}`).join("\n\n");
  const allText = compact(pages.map((page) => page.text).join(" "));
  const resolutionMatch = allText.match(/от\s+(\d{2}\.\d{2}\.\d{4})\s+№\s*([0-9][0-9/.-]*)/i);
  const proceedingMatch = allText.match(/исполнительного\s+производства\s+от\s+(\d{2}\.\d{2}\.\d{4})\s+№\s*([0-9][0-9/.-]*ИП)/i);
  const debtorMatch = allText.match(/в\s+отношении\s+должника\s*\([^)]*\)\s*:\s*(.+?)(?=,\s*ИНН|,\s*д\.?\s*р\.?|,\s*адрес\s+должника:)/i);
  const employerMatch = allText.match(/место\s+работы\s+должника:\s*(.*?),\s*адрес:\s*(.*?)(?=\)\s*\.|\)\s+В\s+связи|\s+В\s+связи)/i);
  const employerName = cleanCandidate(employerMatch?.[1]);
  const employerAddress = cleanCandidate(employerMatch?.[2]);
  const fields: ExtractedPdfFields = {
    resolutionNumber: cleanCandidate(resolutionMatch?.[2]),
    resolutionDate: cleanCandidate(resolutionMatch?.[1]),
    proceedingNumber: cleanCandidate(proceedingMatch?.[2]),
    proceedingDate: cleanCandidate(proceedingMatch?.[1]),
    debtorName: cleanCandidate(debtorMatch?.[1]),
    debtorTaxId: matchValue(allText, /в\s+отношении\s+должника[\s\S]{0,500}?ИНН\s+(\d{10,12})/i),
    debtorBirthDate: matchValue(allText, /в\s+отношении\s+должника[\s\S]{0,600}?д\.?\s*р\.?\s*(\d{2}\.\d{2}\.\d{4})/i),
    employerName,
    employerTaxId: null,
    employerAddress,
    withholdingPercent: Number(allText.match(/удержание\s+производить[\s\S]{0,180}?(\d{1,3})\s*%/i)?.[1] ?? "") || null,
    sources: {
      resolutionNumber: sourceFor(pages, cleanCandidate(resolutionMatch?.[2])),
      resolutionDate: sourceFor(pages, cleanCandidate(resolutionMatch?.[1])),
      proceedingNumber: sourceFor(pages, cleanCandidate(proceedingMatch?.[2])),
      proceedingDate: sourceFor(pages, cleanCandidate(proceedingMatch?.[1])),
      debtorName: sourceFor(pages, cleanCandidate(debtorMatch?.[1])),
      employerName: sourceFor(pages, employerName),
      employerAddress: sourceFor(pages, employerAddress),
    },
  };
  const firstPageHasTitle = pages[0]?.text.includes("Постановление об обращении взыскания") ?? false;
  const warnings = createWarnings(fields, pages, allText);
  if (!firstPageHasTitle) {
    warnings.push({ code: "document_boundary_uncertain", message: "Граница постановления не подтверждена заголовком; проверьте диапазон страниц." });
  }
  return {
    pageCount: pdf.numPages,
    pageStart: 1,
    pageEnd: pdf.numPages,
    pages,
    rawText,
    extracted: fields,
    warnings,
  };
};
