import assert from "node:assert/strict";
import test from "node:test";
import { verifyNumericInverseProduct, completeBlueprint } from "../lib/math-verification";

test("numeric matrix verification rejects one wrong element", () => {
  const problem = String.raw`求 A^{-1}B, A=\begin{pmatrix}1&1&0\\2&0&1\\1&-1&0\end{pmatrix}, B=\begin{pmatrix}0&2&3\\-1&0&4\\5&-1&0\end{pmatrix}`;
  assert.equal(verifyNumericInverseProduct(problem, String.raw`\begin{pmatrix}2.5&.5&1.5\\-2.5&1.5&1.5\\-6&-1&1\end{pmatrix}`), null);
  assert.match(verifyNumericInverseProduct(problem, String.raw`\begin{pmatrix}2.5&0.5&1.5\\-2.5&1.5&1.5\\-6&-1&-1\end{pmatrix}`) || "", /代回校验失败/);
});
test("missing verification is never publishable", () => {
  assert.equal(completeBlueprint(undefined), false);
});
