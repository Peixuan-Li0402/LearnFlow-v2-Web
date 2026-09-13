import assert from "node:assert/strict";
import test from "node:test";
import { buildReferenceDigest, chunkReferenceText, selectRelevantReferenceText } from "../lib/reference-context";

const teacherText = `
# 第十三讲 特征函数

定义：随机变量 X 的特征函数为 $\\phi_X(t)=E[e^{itX}]$。
特征函数可以由概率密度积分得到。

## 正态分布

若 $X\\sim N(0,1)$，利用密度函数的导数关系 $f'(x)=-xf(x)$，
对 $\\phi_X'(t)$ 作分部积分可得微分方程 $\\phi_X'(t)=-t\\phi_X(t)$。
结合 $\\phi_X(0)=1$，得到 $\\phi_X(t)=e^{-t^2/2}$。

## 大数定律

本节讨论依概率收敛及其条件。
`;

test("reference text is chunked and keeps a compact learning digest", () => {
  assert.ok(chunkReferenceText(teacherText).length >= 1);
  const digest = buildReferenceDigest(teacherText);
  assert.match(digest, /特征函数/);
  assert.match(digest, /f'\(x\)=-xf\(x\)/);
});

test("problem-aware retrieval prefers the relevant teacher formula", () => {
  const selected = selectRelevantReferenceText(teacherText, "标准正态分布特征函数的严格推导");
  assert.match(selected, /phi_X'\(t\).*?-t/);
  assert.match(selected, /N\(0,1\)/);
});
