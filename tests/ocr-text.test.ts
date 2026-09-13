import assert from "node:assert/strict";
import test from "node:test";
import { extractOcrText } from "../lib/ocr-text";

test("structured Qwen OCR layouts are flattened in reading order", () => {
  const payload = {
    output: [{
      content: [{
        ocr_result: {
          layouts: [
            { blocks: [{ text: "2020 级微积分 A1 期末考试" }] },
            { blocks: [{ text: "1. 常微分方程 $y''-2y'+2y=0$ 的通解为____。" }] },
            { blocks: [{ text: "2. 计算 $\\int_{-1}^1(x^3+\\sqrt{1-x^2})dx$。" }] },
          ],
        },
      }],
    }],
  };

  const text = extractOcrText(payload);
  assert.match(text || "", /2020 级微积分/);
  assert.match(text || "", /常微分方程/);
  assert.match(text || "", /\\int_\{-1\}\^1/);
});

test("plain string OCR results remain supported", () => {
  assert.equal(extractOcrText({ ocr_result: "第一题\n第二题" }), "第一题\n第二题");
});
