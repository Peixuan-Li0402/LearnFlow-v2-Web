import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const base = process.env.LEARNFLOW_URL || "http://127.0.0.1:3011";
const pagePaths = process.argv.slice(2);
if (!pagePaths.length) {
  console.error("usage: node scripts/verify-visual-page-parse.mjs page-1.png [page-2.png ...]");
  process.exit(2);
}

const form = new FormData();
form.append("documentName", process.env.LEARNFLOW_DOCUMENT_NAME || "visual-qa.pdf");
form.append("startPage", "1");
for (const path of pagePaths) {
  const bytes = await readFile(path);
  form.append("pages", new File([bytes], basename(path), { type: "image/png" }));
}

const visionResponse = await fetch(`${base}/api/vision-pages`, { method: "POST", body: form });
const vision = await visionResponse.json();
if (!visionResponse.ok || !vision.text) throw new Error(vision.error || `vision HTTP ${visionResponse.status}`);

const parseResponse = await fetch(`${base}/api/agent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "parse_assignment", assignmentText: vision.text }),
});
const parsed = await parseResponse.json();
if (!parseResponse.ok) throw new Error(parsed.error || `parse HTTP ${parseResponse.status}`);

const problems = parsed.problems || [];
const combined = problems.map((problem) => problem.rawText || "").join("\n");
const rawMathLeak = /(?<!\\)\b(?:lambda|epsilon|forall|exists|mathbbR|mathcalF|neq|geq|leq|exp\s+left)\b/i.test(combined);
const doubleEscaped = /\\\\(?:begin|frac|lambda|forall|exists|mathbb|mathcal|exp|left|right)\b/.test(combined);
const leakContexts = combined
  .split(/\r?\n/)
  .filter((line) => /(?<!\\)\b(?:lambda|epsilon|forall|exists|mathbbR|mathcalF|neq|geq|leq|exp\s+left)\b/i.test(line))
  .slice(0, 8);
if (!problems.length) throw new Error("visual pages produced no problems");
if (rawMathLeak) throw new Error(`visual parse still contains spoken English math commands: ${JSON.stringify(leakContexts)}`);
if (doubleEscaped) throw new Error("visual parse still contains double-escaped LaTeX");

console.log(JSON.stringify({
  ok: true,
  recognizedCharacters: vision.text.length,
  problems: problems.length,
  rawMathLeak,
  doubleEscaped,
    summaries: problems.map((problem) => ({
      index: problem.index,
      title: problem.title,
      characters: problem.rawText?.length || 0,
      ...(process.env.LEARNFLOW_DUMP_PROBLEMS === "1" ? { rawText: problem.rawText } : {}),
    })),
}, null, 2));

if (process.env.LEARNFLOW_SOLVE === "1") {
  const requestedPositions = (process.env.LEARNFLOW_SOLVE_POSITIONS || "")
    .split(",")
    .map((value) => Number(value.trim()) - 1)
    .filter((value) => Number.isInteger(value) && value >= 0 && value < problems.length);
  const selectedPositions = requestedPositions.length
    ? [...new Set(requestedPositions)]
    : [...new Set([0, Math.floor(problems.length / 2), problems.length - 1])];
  const solved = [];
  for (const position of selectedPositions) {
    const problem = problems[position];
    const project = {
      id: `visual_qa_${Date.now()}_${position}`,
      name: "submission visual QA",
      status: "ACTIVE",
      currentProblemId: problem.id,
      teachingStage: "READING_PROBLEM",
      selectedMethod: "",
      progress: 0,
      responseMode: "deep",
      problems,
      materials: [],
      answerBlocks: [],
      teachingMessages: [],
      sideMessages: [],
      knowledgeCheckpoints: [],
      problemTeachingMessages: {},
      problemSideMessages: {},
      problemKnowledgeCheckpoints: {},
      problemTeachingStages: {},
      problemSelectedMethods: {},
      problemProgress: {},
      problemSolutionBlueprints: {},
      memories: [],
      checkpoints: [],
      rollbackPreview: null,
      answerVersion: 1,
      updatedAt: new Date().toISOString(),
    };
    const startedAt = performance.now();
    const startResponse = await fetch(`${base}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start_problem", problem, project, responseMode: "deep" }),
    });
    const started = await startResponse.json();
    if (!startResponse.ok) throw new Error(`problem ${problem.index} solve failed: ${started.error || startResponse.status}`);
    if (started.solutionBlueprint?.qualityVersion !== "verified-v2") throw new Error(`problem ${problem.index} was not independently verified`);
    if (!started.solutionBlueprint?.finalConclusion?.trim()) throw new Error(`problem ${problem.index} has no final conclusion`);
    if (!started.solutionBlueprint?.verification?.trim()) throw new Error(`problem ${problem.index} has no verification`);
    if ((started.solutionBlueprint?.sections?.length || 0) < 2) throw new Error(`problem ${problem.index} has an incomplete teaching plan`);

    project.problemSolutionBlueprints[problem.id] = started.solutionBlueprint;
    const directResponse = await fetch(`${base}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "chat",
        problem,
        project,
        responseMode: "deep",
        message: "直接查看完整答案",
        interaction: { kind: "DIRECT_ANSWER" },
      }),
    });
    const direct = await directResponse.json();
    if (!directResponse.ok) throw new Error(`problem ${problem.index} direct answer failed: ${direct.error || directResponse.status}`);
    if (direct.answerBlocks?.length !== 5) throw new Error(`problem ${problem.index} returned ${direct.answerBlocks?.length || 0} answer blocks`);
    const visible = [direct.assistantMessage, ...(direct.answerBlocks || []).map((block) => block.plainText)].join("\n");
    if (/我先试试|我发现了|不对[，。]|修正思路|重新来过|原思考过程|自我修正/u.test(visible)) {
      throw new Error(`problem ${problem.index} leaked exploratory reasoning`);
    }
    if (/(?<!\\)\b(?:lambda|epsilon|forall|exists|mathbbR|mathcalF|neq|geq|leq|exp\s+left)\b/i.test(visible)) {
      throw new Error(`problem ${problem.index} answer contains spoken English math commands`);
    }
    solved.push({
      index: problem.index,
      title: problem.title,
      solveMs: Math.round(performance.now() - startedAt),
      difficulty: started.solutionBlueprint.difficulty,
      sections: started.solutionBlueprint.sections.length,
      conclusion: started.solutionBlueprint.finalConclusion,
      verification: started.solutionBlueprint.verification,
      answerBlocks: direct.answerBlocks.length,
    });
  }
  console.log(JSON.stringify({ solved: true, cases: solved }, null, 2));
}
