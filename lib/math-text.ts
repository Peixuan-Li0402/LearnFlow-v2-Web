const duplicateCommandEscape = /\\{2,}(?=(?:alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|pi|rho|sigma|phi|omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Omega|begin|end|frac|sqrt|text|operatorname|mathrm|mathbf|boldsymbol|mathbb|mathcal|left|right|exp|ln|log|lim|int|sum|prod|sin|cos|tan|arcsin|arccos|arctan|times|cdot|to|mapsto|sim|approx|equiv|infty|leq|geq|neq|neg|pm|mp|forall|exists|in|notin|subset|subseteq|supset|supseteq|partial|nabla|Rightarrow|Leftarrow|Leftrightarrow|leftrightarrow|overline|underline)\b)/g;

const spokenCommands: Array<[RegExp, string]> = [
  [/(?<![A-Za-z\\])mathbb\s*\{?\s*([RNPZQCE])\s*\}?/g, "\\mathbb{$1}"],
  [/(?<![A-Za-z\\])mathcal\s*\{?\s*([A-Z])\s*\}?/g, "\\mathcal{$1}"],
  [/(?<![A-Za-z\\])boldsymbol\s*(?=\{)/g, "\\boldsymbol"],
  [/(?<![A-Za-z\\])operatorname\s*(?=\{)/g, "\\operatorname"],
  [/(?<![A-Za-z\\])varepsilon\b/gi, "\\varepsilon"],
  [/(?<![A-Za-z\\])epsilon\b/gi, "\\varepsilon"],
  [/(?<![A-Za-z\\])lambda\b/gi, "\\lambda"],
  [/(?<![A-Za-z\\])theta\b/gi, "\\theta"],
  [/(?<![A-Za-z\\])omega\b/gi, "\\omega"],
  [/(?<![A-Za-z\\])alpha\b/gi, "\\alpha"],
  [/(?<![A-Za-z\\])beta\b/gi, "\\beta"],
  [/(?<![A-Za-z\\])gamma\b/gi, "\\gamma"],
  [/(?<![A-Za-z\\])delta\b/gi, "\\delta"],
  [/(?<![A-Za-z\\])sigma\b/gi, "\\sigma"],
  [/(?<![A-Za-z\\])rho\b/gi, "\\rho"],
  [/(?<![A-Za-z\\])phi\b/gi, "\\phi"],
  [/(?<![A-Za-z\\])mu\b/gi, "\\mu"],
  [/(?<![A-Za-z\\])pi\b/gi, "\\pi"],
  [/(?<![A-Za-z\\])forall\s*([A-Za-z])/gi, "\\forall $1"],
  [/(?<![A-Za-z\\])exists\s*([A-Za-z])/gi, "\\exists $1"],
  [/(?<![A-Za-z\\])forall\b/gi, "\\forall"],
  [/(?<![A-Za-z\\])exists\b/gi, "\\exists"],
  [/(?<![A-Za-z\\])notin\b/gi, "\\notin"],
  [/(?<![A-Za-z\\])infty\b/gi, "\\infty"],
  [/(?<![A-Za-z\\])neq\b/gi, "\\neq"],
  [/(?<![A-Za-z\\])geq\b/gi, "\\geq"],
  [/(?<![A-Za-z\\])leq\b/gi, "\\leq"],
  [/(?<![A-Za-z\\])neg\b/gi, "\\neg"],
  [/(?<![A-Za-z\\])quad\b/gi, "\\quad"],
  [/(?<![A-Za-z\\])exp(?=\s*(?:left\s*)?[\(\{\\])/gi, "\\exp"],
  [/(?<![A-Za-z\\])ln(?=\s*(?:left\s*)?[\(\{\\])/gi, "\\ln"],
  [/(?<![A-Za-z\\])log(?=\s*(?:left\s*)?[\(\{\\])/gi, "\\log"],
  [/(?<![A-Za-z\\])sin(?=\s*(?:left\s*)?[\(\{\\])/gi, "\\sin"],
  [/(?<![A-Za-z\\])cos(?=\s*(?:left\s*)?[\(\{\\])/gi, "\\cos"],
  [/(?<![A-Za-z\\])tan(?=\s*(?:left\s*)?[\(\{\\])/gi, "\\tan"],
  [/(?<![A-Za-z\\])left(?=\s*[\(\[\{])/gi, "\\left"],
  [/(?<![A-Za-z\\])right(?=\s*[\)\]\}])/gi, "\\right"],
  [/(?<![A-Za-z\\])frac(?=\s*\{)/gi, "\\frac"],
  [/(?<![A-Za-z\\])sqrt(?=\s*(?:\[|\{))/gi, "\\sqrt"],
  [/(?<![A-Za-z\\])lex(?=\s*[\),，。；;])/gi, "\\le x"],
];

/**
 * Repairs recurring OCR/model math corruption without inventing new content.
 * The transformation is idempotent, so it is safe at persistence and render.
 */
export function repairMathText(value: string) {
  // Keep code and ordinary English prose literal; a parameter called lambda
  // is mathematical, but Python code and "gamma function is ..." are not TeX.
  const protectedParts: string[] = [];
  value = value.replace(/```[\s\S]*?```|`[^`\n]*`|\b[A-Za-z]{2,}(?:[ \t]+[A-Za-z]{2,}){2,}[.!?]?/g, (part) => {
    if (!part.startsWith("`") && !/\b(?:the|is|are|function|means|using|this)\b/i.test(part)) return part;
    const index = protectedParts.push(part) - 1;
    return `\uE000${index}\uE001`;
  });
  let repaired = (value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(duplicateCommandEscape, "\\");

  for (const [pattern, replacement] of spokenCommands) repaired = repaired.replace(pattern, replacement);

  // Older course graphs contain an escaped placeholder such as "\\-代数"
  // where OCR dropped the sigma command. Recover the conventional term while
  // keeping the rest of the sentence untouched.
  repaired = repaired
    .replace(/\$\\+\$[-–—]\s*(?:代数|域)/gu, "σ-代数")
    .replace(/\$\\+\$[-–—]\s*algebra/giu, "σ-algebra")
    .replace(/\\+[-–—]\s*(?:代数|域)/gu, "\\sigma-代数")
    .replace(/\\+[-–—]\s*algebra/giu, "\\sigma-algebra")
    .replace(/\\([∩∪])/gu, (_, symbol: string) => symbol === "∩" ? "\\cap" : "\\cup")
    .replace(/\\bigigcup/giu, "\\bigcup")
    .replace(/\\bigigcap/giu, "\\bigcap")
    .replace(/\\?\s*ext\s*\{\s*lin\s*sup\s*\}/giu, "\\limsup")
    .replace(/\\?\s*ext\s*\{\s*lin\s*inf\s*\}/giu, "\\liminf")
    .replace(/\\?\s*ext\s*\{\s*P\s*\}/gu, "\\mathbb{P}")
    .replace(/\\?\s*ext\s*\{\s*([A-Za-z]+)\s*\}/gu, "\\text{$1}")
    .replace(/(?:\\b){2,}(?=ig(?:cup|cap))/giu, "\\b")
    .replace(/(?:\\f){2,}(?=orall)/giu, "\\f")
    .replace(/(?<![A-Za-z\\])\\?\s*igcup(?=$|[\s_{}()[\],.;:，。；：])/giu, "\\bigcup")
    .replace(/(?<![A-Za-z\\])\\?\s*igcap(?=$|[\s_{}()[\],.;:，。；：])/giu, "\\bigcap")
    .replace(/(?<![A-Za-z\\])\\?\s*orall(?=$|[\s_{}()[\],.;:，。；：])/giu, "\\forall")
    .replace(/(?<![A-Za-z\\])lim\s*sup\b/giu, "\\limsup")
    .replace(/(?<![A-Za-z\\])lim\s*inf\b/giu, "\\liminf")
    .replace(/(?<![A-Za-z\\])lin\s*sup\b/giu, "\\limsup")
    .replace(/(?<![A-Za-z\\])lin\s*inf\b/giu, "\\liminf")
    .replace(/\\lim\s*_\s*n\s*inf\s*_\s*\{?\s*k\s*[≥>]\s*n\}?/giu, "\\liminf_{n\\to\\infty}")
    .replace(/(?<![A-Za-z\\])lim\s*_\s*n\s*inf\s*_\s*\{?\s*k\s*[≥>]\s*n\}?/giu, "\\liminf_{n\\to\\infty}")
    .replace(/(?<![A-Za-z\\])union(?=\s*[_\{])/giu, "\\bigcup")
    .replace(/(?<![A-Za-z\\])intersection(?=\s*[_\{])/giu, "\\bigcap")
    .replace(/(?:ℙ|\\mathbb\{P\})\s*\(\s*B\s*[|｜]\s*A\s*\)\s*=\s*(?:\\?frac|frac)\s*(?:ℙ|\\mathbb\{P\})\s*\(\s*A\s*\\?cap\s*B\s*\)\s*(?:ℙ|\\mathbb\{P\})\s*\(\s*A\s*\)/gu,
      "\\mathbb{P}(B\\mid A)=\\frac{\\mathbb{P}(A\\cap B)}{\\mathbb{P}(A)}");

  return repaired
    .replace(
      /([A-Za-z0-9}\]])\s+\bin\b\s+(?=\\(?:mathbb|mathcal)\{|[\[(]|[A-Z](?:\b|_))/g,
      "$1 \\\\in ",
    )
    .replace(duplicateCommandEscape, "\\")
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) => protectedParts[Number(index)]);
}

export function normalizeLatexFormula(value: string) {
  return repairMathText(value)
    .trim()
    .replace(/^\$\$?\s*/, "")
    .replace(/\s*\$\$?$/, "")
    .trim();
}

const plainSymbols: Array<[RegExp, string]> = [
  [/\\mathbb\{R\}/g, "ℝ"], [/\\mathbb\{N\}/g, "ℕ"], [/\\mathbb\{P\}/g, "ℙ"],
  [/\\mathbb\{Z\}/g, "ℤ"], [/\\mathbb\{Q\}/g, "ℚ"], [/\\mathbb\{C\}/g, "ℂ"],
  [/\\mathcal\{F\}/g, "𝓕"], [/\\Omega/g, "Ω"], [/\\omega/g, "ω"],
  [/\\Lambda/g, "Λ"], [/\\lambda/g, "λ"], [/\\varepsilon|\\epsilon/g, "ε"],
  [/\\alpha/g, "α"], [/\\beta/g, "β"], [/\\gamma/g, "γ"], [/\\delta/g, "δ"],
  [/\\theta/g, "θ"], [/\\mu/g, "μ"], [/\\pi/g, "π"], [/\\rho/g, "ρ"], [/\\sigma/g, "σ"],
  [/\\phi/g, "φ"], [/\\forall/g, "∀"], [/\\exists/g, "∃"],
  [/\\notin/g, "∉"], [/\\infty/g, "∞"], [/\\in\b/g, "∈"], [/\\mid/g, "|"], [/\\neq/g, "≠"],
  [/\\leq?/g, "≤"], [/\\geq?/g, "≥"], [/\\neg/g, "¬"], [/\\Rightarrow/g, "⇒"],
  [/\\Leftrightarrow/g, "⇔"], [/\\times/g, "×"], [/\\cdot/g, "·"],
  [/\\bigcup/g, "⋃"], [/\\bigcap/g, "⋂"], [/\\cup\b/g, "∪"], [/\\cap\b/g, "∩"],
  [/\\subseteq/g, "⊆"], [/\\subset\b/g, "⊂"], [/\\prod\b/g, "∏"], [/\\sum\b/g, "∑"],
  [/\\(?:ldots|cdots|dots)\b/g, "…"], [/\\to\b/g, "→"],
];

/** Converts graph labels to compact Unicode so SVG/canvas never leaks TeX. */
export function mathTextToPlainLabel(value: string) {
  let label = repairMathText(value)
    .replace(/\\\{/g, "\uE010").replace(/\\\}/g, "\uE011")
    .replace(/\$\$?/g, "")
    .replace(/\\mathcal\s*\{?([A-Z])\}?/g, (_, letter: string) => ({ A: "𝒜", B: "ℬ", F: "𝓕", G: "𝒢", P: "𝒫" }[letter] || letter))
    .replace(/\\mathbb\s*([RNZQCP])\b/g, "\\mathbb{$1}")
    .replace(/\\(?:text|operatorname|mathrm|mathbf|boldsymbol)\{([^{}]*)\}/g, "$1");
  for (const [pattern, replacement] of plainSymbols) label = label.replace(pattern, replacement);
  return label
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\quad/g, " ")
    .replace(/\\([≥≤≠∈∪∩⋃⋂])/g, "$1")
    .replace(/\bt(limsup|liminf)\b/gi, "$1")
    .replace(/\b(limsup|liminf)\s+t\b/gi, "$1")
    .replace(/\\([A-Za-z]+)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\uE010/g, "{").replace(/\uE011/g, "}")
    .replace(/\s+/g, " ")
    .trim();
}
