const base = process.env.LEARNFLOW_URL || "http://127.0.0.1:3011";

const problems = Array.from({ length: 5 }, (_, index) => ({
  id: `stress_problem_${index + 1}`,
  index: index + 1,
  title: `并发切题测试 ${index + 1}`,
  rawText: `已知 $x=${index + 1}$，求 $x+1$。`,
  status: "NOT_STARTED",
  missingInformation: [],
  sourceMaterialIds: [],
}));

const blueprintFor = (problem) => ({
  qualityVersion: "verified-v2",
  difficulty: "BASIC",
  difficultyReason: "单步运算，用于交互并发回归测试。",
  problemSummary: problem.rawText,
  givens: [`$x=${problem.index}$`],
  selectedMethod: "直接代入",
  methodReason: "题目给出了变量值。",
  finalConclusion: `$x+1=${problem.index + 1}$。`,
  materialUsage: [],
  prerequisites: [{ id: `${problem.id}_knowledge`, name: "加法", question: "你是否了解加法？" }],
  sections: [{
    id: `${problem.id}_section`, title: "代入计算", goal: "代入并计算。",
    intuition: "把已知数值放进表达式。", explanation: `代入 $x=${problem.index}$，得到 $x+1=${problem.index + 1}$。`,
    keyCalculations: [`${problem.index}+1=${problem.index + 1}`], commonPitfalls: ["不要漏加 $1$。"],
  }],
  verification: `用整数加法复核，结果为 ${problem.index + 1}。`,
});

const project = {
  id: "stress_project", name: "cached interaction stress", status: "ACTIVE",
  currentProblemId: problems[0].id, teachingStage: "CHECKING_PREREQUISITES",
  selectedMethod: "", progress: 0, responseMode: "deep", problems, materials: [],
  answerBlocks: [], teachingMessages: [], sideMessages: [], knowledgeCheckpoints: [], checkpoints: [],
  problemTeachingMessages: {}, problemSideMessages: {}, problemKnowledgeCheckpoints: {},
  problemTeachingStages: {}, problemSelectedMethods: {}, problemProgress: {},
  problemSolutionBlueprints: Object.fromEntries(problems.map((problem) => [problem.id, blueprintFor(problem)])),
  memories: [], answerVersion: 1, updatedAt: new Date().toISOString(),
};

async function call(payload) {
  const response = await fetch(`${base}/api/agent`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

const started = performance.now();
const starts = await Promise.all(Array.from({ length: 40 }, (_, index) => {
  const problem = problems[index % problems.length];
  return call({ action: "start_problem", problem, project, responseMode: "deep" });
}));
const startMs = Math.round(performance.now() - started);

const directStarted = performance.now();
const answers = await Promise.all(Array.from({ length: 40 }, (_, index) => {
  const problem = problems[index % problems.length];
  return call({
    action: "chat", problem, project, responseMode: "deep", message: "直接查看完整答案",
    interaction: { kind: "DIRECT_ANSWER" },
  });
}));
const directMs = Math.round(performance.now() - directStarted);

if (starts.some((item) => item.knowledgeCheckpoints?.length !== 1)) throw new Error("Rapid switching returned inconsistent surveys");
if (answers.some((item) => item.answerBlocks?.length !== 5)) throw new Error("Concurrent direct answers were incomplete");

console.log(JSON.stringify({ ok: true, requests: 80, startMs, directMs, maxBatchMs: Math.max(startMs, directMs) }, null, 2));
