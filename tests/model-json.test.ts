import assert from "node:assert/strict";
import test from "node:test";
import { parseModelJson } from "../lib/model-json";

test("repairs a missing comma between array entries", () => {
  const value = parseModelJson<{ sections: Array<{ id: string }> }>(`{
    "sections": [
      {"id":"one"}
      {"id":"two"}
    ]
  }`);
  assert.deepEqual(value.sections.map((item) => item.id), ["one", "two"]);
});

test("repairs truncated JSON while preserving LaTeX commands", () => {
  const value = parseModelJson<{ finalConclusion: string; values: string[] }>(`{
    "finalConclusion":"使用 \\mathbb{P}(A) 计算",
    "values":["\\\\lambda", "done"`);
  assert.equal(value.finalConclusion, "使用 \\mathbb{P}(A) 计算");
  assert.deepEqual(value.values, ["\\lambda", "done"]);
});
