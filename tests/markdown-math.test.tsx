import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMath } from "../app/markdown-math";

test("bare matrix environments and capital Greek symbols render", () => {
  const html = renderToStaticMarkup(<MarkdownMath content={String.raw`样本空间为 \Omega。矩阵 A=\begin{pmatrix}1&2\\3&4\end{pmatrix}。`} />);
  assert.match(html, /Ω/);
  assert.match(html, /mtable/);
  assert.doesNotMatch(html, /class="katex-error"/);
  assert.doesNotMatch(html.replace(/<annotation[\s\S]*?<\/annotation>/g, ""), /\\begin/);
});

test("control bytes from JSON cannot break visible math", () => {
  const html = renderToStaticMarkup(<MarkdownMath content={"$F_x=-1,\u0002F_y=-1$"} />);
  assert.doesNotMatch(html, /katex-error|\u0002/);
  assert.match(html, /class="katex"/);
});

test("repair does not alter English explanations or code", () => {
  const html = renderToStaticMarkup(<MarkdownMath content={'The gamma function is useful.\n\n`lambda x: x + 1`'} />);
  assert.match(html, /The gamma function is useful/);
  assert.match(html, /<code>lambda x: x \+ 1<\/code>/);
});

test("Markdown and LaTeX render instead of leaking source markers", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"### 公式\n\n**平均值**为 $$\\bar f=\\frac{1}{b-a}\\int_a^b f(x)\\,dx$$"} />,
  );
  assert.match(html, /<h3>/);
  assert.match(html, /<strong>/);
  assert.match(html, /class="katex/);
  assert.doesNotMatch(html, /\$\$/);
  assert.match(html, /<mfrac>/);
});

test("knowledge-checkpoint style inline formulas render with KaTeX", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"请尝试对 $1 + 2x + y^2 + 2xy^2$ 进行因式分解。"} />,
  );
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /\$1 \+ 2x/);
});

test("bare model equations are repaired before Markdown rendering", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"对应的齐次方程为 y'' - 2y' + y = 0。特征方程为 r^2 - 2r + 1 = 0。"} />,
  );
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /<msup><mi>r<\/mi><mn>2<\/mn><\/msup>/);
});

test("unmatched dollars and bare LaTeX commands are repaired", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"已知 \\ln(1+t) \\sim t$$，并且 \\frac{1}{x^2} \\to 0。"} />,
  );
  assert.ok((html.match(/class="katex"/g) || []).length >= 2);
  assert.doesNotMatch(html, /class="katex-error"/);
});

test("spoken epsilon and quantifier names become mathematical symbols", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"forall n > N，exists N，使得 epsilon > 0，并且 x \\in A。"} />,
  );
  assert.match(html, /class="katex"/);
  assert.match(html, /∀/);
  assert.match(html, /∃/);
  assert.match(html, /ε/);
  assert.match(html, /∈/);
  assert.doesNotMatch(html, />forall</);
  assert.doesNotMatch(html, />epsilon</);
});

test("bare superscripts and subscripts are rendered as math", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"定义 P_i 为从第 i 个罐子中取出白球的概率。由此得到 P_1 = m/(m+n)，并比较 x^2。"} />,
  );
  assert.ok((html.match(/class="katex"/g) || []).length >= 3);
  assert.match(html, /<msub><mi>P<\/mi><mi>i<\/mi><\/msub>/);
  assert.match(html, /<msub><mi>P<\/mi><mn>1<\/mn><\/msub>/);
  assert.match(html, /<msup><mi>x<\/mi><mn>2<\/mn><\/msup>/);
});

test("malformed escaped display delimiters and cases environments are repaired", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"$f_X(x)$ = \\$$\\begin{cases} \\frac{1}{2}, & -1<x<1 \\\\ 0, & \\text{其他} \\end{cases}"} />,
  );
  assert.match(html, /class="katex/);
  assert.match(html, /mtable/);
  assert.doesNotMatch(html, /class="katex-error"/);
});

test("bare boldsymbol expressions do not leak as red LaTeX source", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"特征函数定义为 \\boldsymbol{E[e^{itX}]}。"} />,
  );
  assert.match(html, /class="katex/);
  assert.doesNotMatch(html, /class="katex-error"/);
});

test("OCR spoken parameter and function names render as mathematical symbols", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={"设参数为 lambda，且 a neq 0，密度正比于 exp left(ax^2+bx+c right)。"} />,
  );
  assert.match(html, /class="katex/);
  assert.match(html, /λ/);
  assert.match(html, /≠/);
  assert.match(html, /exp/);
  assert.doesNotMatch(html, />lambda</);
  assert.doesNotMatch(html, />neq</);
  assert.doesNotMatch(html, /class="katex-error"/);
});

test("double-escaped cases and common set notation are repaired", () => {
  const html = renderToStaticMarkup(
    <MarkdownMath content={String.raw`f_X(x)=\\begin{cases}\\frac{1}{2},&-1<x<1\\0,&\text{其他}\\end{cases}，且 A, B in mathcalF，x in mathbbR。`} />,
  );
  assert.match(html, /mtable/);
  assert.match(html, /𝓕|mathcal/);
  assert.match(html, /ℝ|mathbb/);
  assert.doesNotMatch(html, /class="katex-error"/);
  assert.doesNotMatch(html, /\\\\begin/);
});
