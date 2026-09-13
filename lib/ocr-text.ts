const TEXT_KEYS = ["text", "markdown", "latex", "formula", "formula_text", "content", "value"] as const;

function appendFragment(target: string[], value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized || target[target.length - 1] === normalized) return;
  target.push(normalized);
}

function collectStructuredText(value: unknown, target: string[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredText(item, target));
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const directText = TEXT_KEYS
    .map((key) => record[key])
    .find((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (directText) {
    appendFragment(target, directText);
    return;
  }

  Object.values(record).forEach((item) => {
    if (Array.isArray(item) || (item && typeof item === "object")) {
      collectStructuredText(item, target);
    }
  });
}

function collectOcrResults(value: unknown, target: string[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectOcrResults(item, target));
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "ocr_result")) {
    const ocrResult = record.ocr_result;
    if (typeof ocrResult === "string") appendFragment(target, ocrResult);
    else collectStructuredText(ocrResult, target);
  }

  Object.entries(record).forEach(([key, item]) => {
    if (key === "ocr_result") return;
    if (Array.isArray(item) || (item && typeof item === "object")) {
      collectOcrResults(item, target);
    }
  });
}

export function extractOcrText(payload: unknown) {
  const fragments: string[] = [];
  collectOcrResults(payload, fragments);
  return fragments.join("\n").trim() || null;
}
