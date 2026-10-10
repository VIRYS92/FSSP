export type SearchMode = "substring" | "fulltext";

export const normalizeSearchMode = (value: unknown): SearchMode | null => {
  if (value === undefined || value === null || value === "" || value === "substring") return "substring";
  if (value === "fulltext") return "fulltext";
  return null;
};

export const normalizeSearchText = (value: unknown, maxLength = 200) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

export const searchPredicate = (fields: string[], mode: SearchMode, parameter: string) => {
  const expression = `concat_ws(' ', ${fields.join(", ")})`;
  return mode === "fulltext"
    ? `to_tsvector('simple', ${expression}) @@ websearch_to_tsquery('simple', ${parameter})`
    : `lower(${expression}) LIKE lower(${parameter})`;
};
