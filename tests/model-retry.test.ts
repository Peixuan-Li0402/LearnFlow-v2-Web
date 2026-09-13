import assert from "node:assert/strict";
import test from "node:test";
import { runModelCandidates } from "../lib/model-retry";

function modelError(status: number, detail: string) {
  return Object.assign(new Error(detail), { status, detail });
}

test("transient model failures are retried before changing model", async () => {
  const calls: string[] = [];
  const result = await runModelCandidates(["qwen-max", "qwen-plus"], async (model, attempt) => {
    calls.push(`${model}:${attempt}`);
    if (model === "qwen-max" && attempt === 0) throw modelError(503, "temporary unavailable");
    return `${model}:ok`;
  });
  assert.equal(result, "qwen-max:ok");
  assert.deepEqual(calls, ["qwen-max:0", "qwen-max:1"]);
});

test("model-specific permission failures fall back inside Token Plan", async () => {
  const calls: string[] = [];
  const result = await runModelCandidates(["qwen-max", "qwen-plus"], async (model) => {
    calls.push(model);
    if (model === "qwen-max") throw modelError(403, "model access permission denied");
    return "verified";
  });
  assert.equal(result, "verified");
  assert.deepEqual(calls, ["qwen-max", "qwen-plus"]);
});

test("invalid credentials fail without wasting calls on other models", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runModelCandidates(["qwen-max", "qwen-plus"], async (model) => {
      calls.push(model);
      throw modelError(401, "invalid api key");
    }),
    /invalid api key/,
  );
  assert.deepEqual(calls, ["qwen-max"]);
});
