const base = process.env.LEARNFLOW_URL || "http://127.0.0.1:3011";
const requestedProjectId = process.env.LEARNFLOW_PROJECT_ID || "project_mrmtezl5_z27rv9";
const requestedIndexes = new Set(
  String(process.env.LEARNFLOW_PROBLEM_INDEXES || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0),
);

async function jsonFetch(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} (${response.status}): ${payload.error || JSON.stringify(payload).slice(0, 300)}`);
  return payload;
}

const projectPayload = await jsonFetch(`/api/projects/${requestedProjectId}`);
const project = projectPayload.project || projectPayload;
const results = [];
const leakPattern = /我先试试|我发现了|不对[，。]|修正思路|重新来过|换个角度再试|maybe|perhaps/i;

for (const problem of (project.problems || []).filter((item) => !requestedIndexes.size || requestedIndexes.has(item.index))) {
  const isolated = {
    ...project,
    currentProblemId: problem.id,
    problemSolutionBlueprints: {},
    answerBlocks: [],
    teachingMessages: [],
    sideMessages: [],
  };
  const startedAt = performance.now();
  const started = await jsonFetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start_problem", problem, project: isolated, responseMode: "deep" }),
  });
  const blueprintMs = Math.round(performance.now() - startedAt);
  isolated.problemSolutionBlueprints = { [problem.id]: started.solutionBlueprint };
  const answerAt = performance.now();
  const direct = await jsonFetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "chat",
      problem,
      project: isolated,
      responseMode: "deep",
      message: "直接查看完整答案",
      interaction: { kind: "DIRECT_ANSWER" },
    }),
  });
  const directMs = Math.round(performance.now() - answerAt);
  const appliedModes = (started.solutionBlueprint?.materialUsage || [])
    .filter((item) => item.applied)
    .map((item) => item.sourceMode);
  const visible = `${started.assistantMessage || ""}\n${direct.assistantMessage || ""}\n${(direct.answerBlocks || []).map((item) => item.plainText).join("\n")}`;
  const result = {
    index: problem.index,
    title: problem.title,
    sections: started.solutionBlueprint?.sections?.length || 0,
    answerBlocks: direct.answerBlocks?.length || 0,
    finalConclusion: Boolean(started.solutionBlueprint?.finalConclusion?.trim()),
    appliedModes,
    reasoningLeak: leakPattern.test(visible),
    blueprintMs,
    directMs,
  };
  if (!result.sections || result.answerBlocks !== 5 || !result.finalConclusion || result.reasoningLeak) {
    throw new Error(`Problem ${problem.index} failed: ${JSON.stringify(result)}`);
  }
  results.push(result);
  console.log(JSON.stringify(result));
}

console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
