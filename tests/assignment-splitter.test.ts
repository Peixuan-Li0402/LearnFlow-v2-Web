import assert from "node:assert/strict";
import test from "node:test";
import { splitRecognizedAssignment } from "../lib/assignment-splitter";

test("recognized homework falls back to deterministic top-level splitting", () => {
  const problems = splitRecognizedAssignment(`
# 原资料（第 1 页）
1. 设 X 服从参数为 lambda 的泊松分布，求 P(X=2)。
（1）先写出概率质量函数；
（2）再代入计算。

2、设 a neq 0，求函数 exp left(ax) 的导数。

参考答案：
1. 略
`);
  assert.equal(problems.length, 2);
  assert.match(problems[0].rawText, /\\lambda/);
  assert.match(problems[1].rawText, /\\neq/);
  assert.match(problems[1].rawText, /\\exp\s*\\left/);
  assert.doesNotMatch(problems[0].rawText, /参考答案/);
});

test("an unnumbered single-question handout remains usable", () => {
  const problems = splitRecognizedAssignment("设随机变量 $X\\sim U(0,1)$，求其分布函数。");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].id, "problem_1");
});
