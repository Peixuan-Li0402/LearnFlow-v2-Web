import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResponse, ProjectState } from "../lib/agent-types";
import { normalizeAgentResponse, normalizeProjectState, repairModelText } from "../lib/normalize-agent";

test("null arrays returned by the model cannot crash rendering", () => {
  const response = normalizeAgentResponse({
    provider: "model",
    progress: 0.2,
    problems: [{
      id: "p1",
      index: 1,
      title: "测试题",
      rawText: "题目",
      status: "NOT_STARTED",
      missingInformation: null,
      sourceMaterialIds: null,
    }],
    answerBlocks: [{
      id: "b1",
      problemId: "p1",
      order: 1,
      title: "步骤",
      plainText: "内容",
      latex: "x",
      status: "GENERATED",
      version: 1,
      checkpointId: null,
      dependencies: null,
    }],
  } as unknown as AgentResponse);

  assert.deepEqual(response.problems?.[0].missingInformation, []);
  assert.deepEqual(response.problems?.[0].sourceMaterialIds, []);
  assert.deepEqual(response.answerBlocks?.[0].dependencies, []);
  assert.equal(response.progress, 20);
});

test("persisted projects with null collections are repaired on load", () => {
  const project = normalizeProjectState({
    id: "p",
    runtimeVersion: "model-v1",
    name: "测试",
    status: "ACTIVE",
    currentProblemId: null,
    teachingStage: "READING_PROBLEM",
    selectedMethod: "",
    progress: 0,
    problems: null,
    materials: null,
    answerBlocks: null,
    teachingMessages: null,
    sideMessages: null,
    knowledgeCheckpoints: null,
    memories: null,
    checkpoints: null,
    rollbackPreview: null,
    answerVersion: 1,
    updatedAt: new Date().toISOString(),
  } as unknown as ProjectState);

  assert.deepEqual(project.problems, []);
  assert.deepEqual(project.teachingMessages, []);
  assert.deepEqual(project.checkpoints, []);
  assert.equal(project.conversationVersion, "per-problem-v1");
});

test("legacy shared conversations reset without losing parsed problems", () => {
  const project = normalizeProjectState({
    id: "legacy",
    runtimeVersion: "model-v1",
    name: "旧项目",
    status: "ACTIVE",
    currentProblemId: "p1",
    teachingStage: "DERIVING",
    selectedMethod: "旧方法",
    progress: 60,
    problems: [{ id: "p1", index: 1, title: "第一题", rawText: "题目", status: "TEACHING", missingInformation: [], sourceMaterialIds: [] }],
    materials: [],
    answerBlocks: [],
    teachingMessages: [{ id: "m1", role: "assistant", content: "旧的跨题消息", createdAt: new Date().toISOString() }],
    sideMessages: [],
    knowledgeCheckpoints: [],
    memories: [],
    checkpoints: [],
    rollbackPreview: null,
    answerVersion: 1,
    updatedAt: new Date().toISOString(),
  });

  assert.equal(project.status, "AWAITING_CONFIRMATION");
  assert.equal(project.problems.length, 1);
  assert.equal(project.problems[0].status, "NOT_STARTED");
  assert.deepEqual(project.problemTeachingMessages, {});
});

test("per-problem conversations remain isolated", () => {
  const now = new Date().toISOString();
  const project = normalizeProjectState({
    id: "isolated",
    runtimeVersion: "model-v1",
    conversationVersion: "per-problem-v1",
    name: "分题会话",
    status: "ACTIVE",
    currentProblemId: "p1",
    teachingStage: "DERIVING",
    selectedMethod: "方法一",
    progress: 40,
    problems: [
      { id: "p1", index: 1, title: "第一题", rawText: "题目一", status: "TEACHING", missingInformation: [], sourceMaterialIds: [] },
      { id: "p2", index: 2, title: "第二题", rawText: "题目二", status: "TEACHING", missingInformation: [], sourceMaterialIds: [] },
    ],
    materials: [], answerBlocks: [], teachingMessages: [], sideMessages: [], knowledgeCheckpoints: [],
    problemTeachingMessages: {
      p1: [{ id: "m1", role: "assistant", content: "第一题讲解", createdAt: now }],
      p2: [{ id: "m2", role: "assistant", content: "第二题讲解", createdAt: now }],
    },
    problemSideMessages: {
      p1: [{ id: "s1", role: "assistant", content: "第一题基础知识", createdAt: now }],
      p2: [{ id: "s2", role: "assistant", content: "第二题基础知识", createdAt: now }],
    },
    problemKnowledgeCheckpoints: {}, problemTeachingStages: {}, problemSelectedMethods: {}, problemProgress: {},
    memories: [], checkpoints: [], rollbackPreview: null, answerVersion: 1, updatedAt: now,
  });

  assert.equal(project.problemTeachingMessages?.p1[0].content, "第一题讲解");
  assert.equal(project.problemTeachingMessages?.p2[0].content, "第二题讲解");
  assert.equal(project.problemSideMessages?.p1[0].content, "第一题基础知识");
  assert.equal(project.problemSideMessages?.p2[0].content, "第二题基础知识");
});

test("JSON control characters inside LaTeX commands are repaired", () => {
  assert.equal(repairModelText("a\times b，\frac{1}{2}，x\right]"), "a\\times b，\\frac{1}{2}，x\\right]");
  const backspace = String.fromCharCode(8);
  assert.equal(
    repairModelText(`特征函数定义为 ${backspace}oldsymbol{E[e^{itX}]}，且 ${backspace}ar X=0。`),
    "特征函数定义为 \\boldsymbol{E[e^{itX}]}，且 \\bar X=0。",
  );
});

test("literal JSON unicode escapes from a model become valid LaTeX symbols", () => {
  assert.equal(
    repairModelText(String.raw`$\u03c6_X(t) \u2264 1$`),
    String.raw`$\phi_X(t) \leq 1$`,
  );
});

test("model text repairs doubled commands and OCR-spoken math names before persistence", () => {
  assert.equal(
    repairModelText(String.raw`参数 lambda，a neq 0，A, B in mathcalF，x in mathbbR`),
    String.raw`参数 \lambda，a \neq 0，A, B \in \mathcal{F}，x \in \mathbb{R}`,
  );
  assert.equal(
    repairModelText(String.raw`f(x)=\\begin{cases}\\frac{1}{2}\\end{cases}`),
    String.raw`f(x)=\begin{cases}\frac{1}{2}\end{cases}`,
  );
});

test("answer blocks use one canonical structure for every problem", () => {
  const response = normalizeAgentResponse({
    provider: "model",
    answerBlocks: [
      { id: "a", problemId: "p1", type: "RESULT", title: "答案", plainText: "42", latex: "$$42$$", status: "GENERATED", order: 1, version: 1, dependencies: [] },
      { id: "b", problemId: "p1", type: "METHOD", title: "随意标题", plainText: "方法", latex: "x", status: "GENERATED", order: 9, version: 1, dependencies: [] },
      { id: "c", problemId: "p1", type: "RESULT", title: "重复答案", plainText: "最终为 $42$", latex: "42", status: "VERIFIED", order: 7, version: 1, dependencies: [] },
    ],
  });
  assert.deepEqual(response.answerBlocks?.map((block) => [block.type, block.title, block.order]), [
    ["METHOD", "方法与依据", 2],
    ["RESULT", "最终答案", 4],
  ]);
  assert.equal(response.answerBlocks?.[1].id, "a");
});

test("batch checkpoints and hidden solution blueprints are normalized", () => {
  const response = normalizeAgentResponse({
    provider: "model",
    knowledgeCheckpoints: [{ id: "k1", name: "量词", question: "是否理解 forall？", status: "PENDING" }],
    solutionBlueprint: {
      difficulty: "ADVANCED",
      difficultyReason: "需要多步证明",
      selectedMethod: "反证法",
      finalConclusion: "$\\forall n$ 命题成立",
      prerequisites: [{ id: "p1", name: "量词", question: "是否理解 $\\forall$？" }],
      sections: [{ id: "s1", title: "建立反设", goal: "构造矛盾", keyCalculations: null, commonPitfalls: null }],
      verification: "代回检查",
    },
  } as unknown as AgentResponse);

  assert.equal(response.knowledgeCheckpoints?.length, 1);
  assert.equal(response.solutionBlueprint?.difficulty, "ADVANCED");
  assert.deepEqual(response.solutionBlueprint?.sections[0].keyCalculations, []);
});
