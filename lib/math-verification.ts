import type { SolutionBlueprint } from "./agent-types";

function numericMatrix(source: string) {
  const body = source.match(/\\begin\{[pb]matrix\}([\s\S]*?)\\end\{[pb]matrix\}/)?.[1];
  if (!body) return null;
  const rows = body.trim().split(/\\\\/).map(row => row.split("&").map(cell => {
    const value = cell.trim().replace(/\\(?:d|t)?frac\{(-?\d+)\}\{(-?\d+)\}/g, "$1/$2").replace(/\s/g, "");
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/[+-]?(?:\d+(?:\.\d+)?|\.\d+))?$/.test(value)) return NaN;
    const [numerator, denominator = "1"] = value.split("/");
    return Number(numerator) / Number(denominator);
  }));
  if (!rows.length || rows.some(row => row.length !== rows[0].length || row.some(value => !Number.isFinite(value)))) return null;
  return rows;
}

export function verifyNumericInverseProduct(problem: string, conclusion: string): string | null {
  if (!/A\^\{-1\}B|A\^-1B/.test(problem.replace(/\s/g, ""))) return null;
  const first = numericMatrix(problem.split(/A\s*=/)[1] || "");
  const second = numericMatrix(problem.split(/B\s*=/)[1] || "");
  const candidate = numericMatrix(conclusion);
  if (!first || !second || !candidate || first.length !== first[0].length || first[0].length !== candidate.length || second.length !== first.length || second[0].length !== candidate[0].length) return null;
  for (let row = 0; row < second.length; row++) {
    for (let column = 0; column < second[0].length; column++) {
      const actual = first[row].reduce((sum, value, index) => sum + value * candidate[index][column], 0);
      if (Math.abs(actual - second[row][column]) > 1e-7 * Math.max(1, Math.abs(second[row][column])))
        return `矩阵代回校验失败：A乘候选答案的第${row + 1}行第${column + 1}列为${actual}，但B对应元素为${second[row][column]}。请重新计算所有矩阵乘法元素。`;
    }
  }
  return null;
}

export function completeBlueprint(blueprint: SolutionBlueprint | undefined): blueprint is SolutionBlueprint {
  if (!blueprint?.sections?.length || !blueprint.prerequisites?.length || !blueprint.finalConclusion?.trim() || !blueprint.verification?.trim()) return false;
  return blueprint.sections.every(section => section.title?.trim() && section.keyCalculations?.length && section.keyCalculations.every(calculation => {
    if (!calculation.trim() || /\\\s*$/.test(calculation)) return false;
    const opens = [...calculation.matchAll(/\\begin\{([^}]+)\}/g)].map(match => match[1]);
    return opens.every(environment => calculation.includes(`\\end{${environment}}`));
  }));
}
