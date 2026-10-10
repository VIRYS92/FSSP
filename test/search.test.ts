import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchMode, normalizeSearchText, searchPredicate } from "../src/search.js";

test("search mode defaults to safe substring search", () => {
  assert.equal(normalizeSearchMode(undefined), "substring");
  assert.equal(normalizeSearchMode("substring"), "substring");
  assert.equal(normalizeSearchMode("fulltext"), "fulltext");
  assert.equal(normalizeSearchMode("sql"), null);
});

test("search text is trimmed and capped", () => {
  assert.equal(normalizeSearchText("  должник  "), "должник");
  assert.equal(normalizeSearchText("x".repeat(300)).length, 200);
  assert.equal(normalizeSearchText(null), "");
});

test("search predicates stay parameterized", () => {
  const fields = ["o.public_code", "d.full_name"];
  assert.match(searchPredicate(fields, "substring", "$1"), /^lower\(concat_ws/);
  assert.match(searchPredicate(fields, "fulltext", "$2"), /websearch_to_tsquery\('simple', \$2\)/);
  assert.doesNotMatch(searchPredicate(fields, "fulltext", "$2"), /OR 1=1/);
});
