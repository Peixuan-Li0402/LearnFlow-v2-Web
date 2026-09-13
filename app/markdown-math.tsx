import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { repairMathText } from "@/lib/math-text";

function removeLastOccurrence(value: string, token: string) {
  const index = value.lastIndexOf(token);
  return index < 0 ? value : value.slice(0, index) + value.slice(index + token.length);
}

function balanceDollarDelimiters(value: string) {
  let balanced = value;
  const doubleCount = balanced.match(/\$\$/g)?.length || 0;
  if (doubleCount % 2) balanced = removeLastOccurrence(balanced, "$$");

  const singleIndexes: number[] = [];
  for (let index = 0; index < balanced.length; index += 1) {
    if (balanced[index] !== "$" || balanced[index - 1] === "\\") continue;
    if (balanced[index - 1] === "$" || balanced[index + 1] === "$") continue;
    singleIndexes.push(index);
  }
  if (singleIndexes.length % 2) {
    const index = singleIndexes[singleIndexes.length - 1];
    balanced = balanced.slice(0, index) + balanced.slice(index + 1);
  }
  return balanced;
}

function repairMalformedMathSource(value: string) {
  return value
    // Models occasionally escape a display delimiter as \$$. Remove the
    // accidental escape and let the environment repair below add one clean pair.
    .replace(/\\\$\$/g, "")
    .replace(/\$\$?\s*(\\begin\{cases\}[\s\S]*?\\end\{cases\})\s*\$\$?/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/(?<!\$)(\\begin\{cases\}[\s\S]*?\\end\{cases\})(?!\$)/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(
      /([A-Za-z](?:_\{?[A-Za-z0-9]+\}?)?\s*\([^)\n]+\)\s*=\s*)\n\$\$\n(\\begin\{cases\}[\s\S]*?\\end\{cases\})\n\$\$/g,
      (_, lhs: string, cases: string) => `\n$$\n${lhs}${cases}\n$$\n`,
    )
    .replace(/\\text\{\\!\\boldsymbol\{([^{}]*)\}\}/g, "\\boldsymbol{$1}");
}

function wrapBareLatex(value: string) {
  value = value.replace(/\\(?:Omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Psi)\b/g, (math) => `$${math}$`);
  return value.replace(
    /((?:[A-Za-z0-9_{}()[\]+\-*/^=<>.,'′≥≤≠∈∪∩]+\s*)?\\(?:liminf|limsup|frac|sqrt|exp|ln|log|lim|int|sum|prod|bigcup|bigcap|sin|cos|tan|arcsin|arccos|arctan|left|right|operatorname|mathrm|mathbf|boldsymbol|mathbb|mathcal|text|times|cdot|to|mapsto|sim|approx|equiv|infty|leq|geq|neq|neg|pm|mp|alpha|beta|gamma|epsilon|varepsilon|delta|theta|lambda|mu|pi|rho|sigma|phi|omega|forall|exists|in|notin|subset|subseteq|supset|supseteq|partial|nabla|Rightarrow|Leftarrow|Leftrightarrow|leftrightarrow|overline|underline)[A-Za-z0-9\\_{}()[\]+\-*/^=<>.,'′≥≤≠∈∪∩\s]*)/g,
    (_, math: string) => ` $${math.trim()}$ `,
  );
}

function wrapBareScripts(value: string) {
  return value.replace(
    /(?<![A-Za-z0-9\\$])([A-Za-z](?:(?:_\{[^}\n]+\}|_[A-Za-z0-9]+|\^\{[^}\n]+\}|\^[A-Za-z0-9]+)){1,2})(?![A-Za-z0-9])/g,
    (_, math: string) => `$${math}$`,
  );
}

function repairSpokenMathSymbols(value: string) {
  return repairMathText(value)
    .replace(/(?<!\\)\bsum(?=\s*_)/g, "\\sum")
    .replace(/(?<!\\)\bprod(?=\s*_)/g, "\\prod")
    .replace(/(?<!\\)\bliminf\b/g, "\\liminf")
    .replace(/(?<!\\)\blimsup\b/g, "\\limsup")
    .replace(/(?<!\\)\blim(?=\s*_)/g, "\\lim");
}

function normalizeMathSegment(content: string) {
  content = content.split(/(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g).map((part) => part.startsWith("$") ? part :
    part.replace(/((?:[A-Za-z](?:_\{?\w+\}?)?\s*=\s*)?\\begin\{(pmatrix|bmatrix|matrix|vmatrix|Vmatrix|aligned|align\*?)\}[\s\S]*?\\end\{\2\})/g,
      (_, math: string) => `\n$$\n${math}\n$$\n`)).join("");
  const normalized = balanceDollarDelimiters(repairMalformedMathSource(repairMathText(content))
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/\\\((.*?)\\\)/g, (_, math: string) => `$${math.trim()}$`));

  return normalized
    .split(/(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g)
    .map((part) => {
      if (part.startsWith("$")) return repairSpokenMathSymbols(part);
      return wrapBareLatex(repairSpokenMathSymbols(part)).split(/(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$)/g).map((nested) => {
        if (nested.startsWith("$")) return repairSpokenMathSymbols(nested);
        return wrapBareScripts(nested).replace(
        /(^|[\s，。；：:（(])([A-Za-z\\][A-Za-z0-9\\_{}()[\]'′+\-*/^.,\s]*?(?:=|≤|≥|<|>)[A-Za-z0-9\\_{}()[\]'′+\-*/^.,\s]+)(?=$|[\u3000-\u9fff，。；：:）)\]])/gm,
        (_, prefix: string, math: string) => `${prefix}$${math.trim()}$`,
        );
      }).join("");
    })
    .join("");
}

export function normalizeMathDelimiters(content: string) {
  return content.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part) => part.startsWith("`") ? part : normalizeMathSegment(part)).join("");
}

export function MarkdownMath({ content, className = "" }: { content: string; className?: string }) {
  return (
    <div className={`rich-text ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}>
        {normalizeMathDelimiters(content || "")}
      </ReactMarkdown>
    </div>
  );
}
