import { jsonrepair } from "jsonrepair";

function stripCodeFence(text: string) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function escapeInvalidJsonBackslashes(text: string) {
  // LLMs frequently emit LaTeX such as "\mathbb" with a single backslash
  // inside JSON strings. JSON only permits a small set of escapes, so preserve
  // LaTeX commands by escaping every unsupported JSON backslash.
  return text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

function candidatesFor(text: string) {
  const stripped = stripCodeFence(text);
  const firstObject = stripped.indexOf("{");
  if (firstObject < 0) throw new Error("模型没有返回可解析的 JSON 对象。");
  const fromObject = stripped.slice(firstObject).trim();
  const lastObject = fromObject.lastIndexOf("}");
  const bounded = lastObject > 0 ? fromObject.slice(0, lastObject + 1) : fromObject;
  return [...new Set([bounded, fromObject])];
}

export function parseModelJson<T>(text: string): T {
  let lastError: unknown;
  for (const candidate of candidatesFor(text)) {
    const escapedCandidate = escapeInvalidJsonBackslashes(candidate);
    for (const source of [candidate, escapedCandidate]) {
      try {
        return JSON.parse(source) as T;
      } catch (error) {
        lastError = error;
      }
    }
    // Repair the escape-preserving variant first. jsonrepair intentionally
    // removes unsupported JSON escapes, which would otherwise turn \mathbb
    // into mathbb and reintroduce visible formula corruption.
    for (const source of [escapedCandidate, candidate]) {
      try {
        return JSON.parse(jsonrepair(source)) as T;
      } catch (error) {
        lastError = error;
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "未知结构错误";
  throw new Error(`模型返回的结构化内容无法修复：${detail}`);
}
