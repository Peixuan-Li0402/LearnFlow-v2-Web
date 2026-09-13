import type { Problem } from "./agent-types";
import { mathTextToPlainLabel, repairMathText } from "./math-text";

const arabicHeading = /^\s*(?:#{1,5}\s*)?(?:第\s*)?(\d{1,2})\s*(?:题|[.．、:：])(?:\s+|(?=[^\d]))/u;
const chineseHeading = /^\s*(?:#{1,5}\s*)?([一二三四五六七八九十百]+)\s*[、.．:：](?:\s+|(?=\S))/u;
const answerBoundary = /^\s*(?:#{1,5}\s*)?(?:参考)?(?:答案|解答|解析|题解)(?:\s|$|[:：])/u;
const sourcePageHeading = /^\s*#{1,5}\s*原资料/u;

function cleanTitle(rawText: string, index: number) {
  const firstMeaningfulLine = rawText
    .split(/\r?\n/u)
    .map((line) => line
      .replace(/^\s*#{1,5}\s*/u, "")
      .replace(/^\s*(?:第\s*)?\d{1,2}\s*(?:题|[.．、:：])\s*/u, "")
      .replace(/^\s*[一二三四五六七八九十百]+\s*[、.．:：]\s*/u, "")
      .trim())
    .find((line) => line && !sourcePageHeading.test(line));
  const plain = mathTextToPlainLabel(firstMeaningfulLine || "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return `第 ${index} 题`;
  return plain.length > 30 ? `${plain.slice(0, 30)}…` : plain;
}

function makeProblem(rawText: string, index: number): Problem {
  const repaired = repairMathText(rawText).trim();
  return {
    id: `problem_${index}`,
    index,
    title: cleanTitle(repaired, index),
    rawText: repaired,
    status: "NOT_STARTED",
    missingInformation: [],
    sourceMaterialIds: [],
  };
}

/**
 * Deterministic safety net for the rare case where the model recognizes every
 * page but returns an empty or malformed structured problem list.
 *
 * It intentionally only treats top-level numbered lines as problem starts.
 * Parenthesized subquestions such as (1) and (2) stay inside their parent.
 */
export function splitRecognizedAssignment(text: string): Problem[] {
  const repaired = repairMathText(text).replace(/\r\n/g, "\n").trim();
  if (!repaired) return [];

  const lines = repaired.split("\n");
  const starts: number[] = [];
  let answerStart = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (answerBoundary.test(line)) {
      answerStart = index;
      break;
    }
    if (arabicHeading.test(line) || chineseHeading.test(line)) starts.push(index);
  }

  const usableStarts = starts.filter((start) => start < answerStart);
  if (usableStarts.length) {
    return usableStarts
      .map((start, position) => {
        const end = usableStarts[position + 1] ?? answerStart;
        return lines.slice(start, end)
          .filter((line, lineIndex) => lineIndex === 0 || !sourcePageHeading.test(line))
          .join("\n")
          .trim();
      })
      .filter((problemText) => problemText.length >= 8)
      .map((problemText, position) => makeProblem(problemText, position + 1));
  }

  // A one-question handout often has no number at all. Returning it as one
  // reviewable problem is safer than discarding successfully recognized text.
  const body = lines
    .slice(0, answerStart)
    .filter((line) => !sourcePageHeading.test(line))
    .join("\n")
    .trim();
  return body.length >= 8 ? [makeProblem(body, 1)] : [];
}
