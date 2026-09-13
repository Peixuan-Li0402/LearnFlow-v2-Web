import assert from "node:assert/strict";
import test from "node:test";
import { agentErrorMessage } from "../lib/agent-error";

test("provider payloads never reach the student", () => {
  assert.match(agentErrorMessage({status:403, message:'{"key":"secret"}'}), /权限或额度/);
  assert.doesNotMatch(agentErrorMessage({status:403, message:'{"key":"secret"}'}), /secret/);
  assert.match(agentErrorMessage(new Error("model timeout")), /已停止请求/);
  assert.match(agentErrorMessage(new Error("JSON unexpected EOF")), /没有发布/);
  assert.match(agentErrorMessage({status:429}), /繁忙/);
});
