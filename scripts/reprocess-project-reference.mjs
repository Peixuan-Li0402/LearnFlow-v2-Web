import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const base = process.env.LEARNFLOW_URL || "http://127.0.0.1:3011";
const projectId = process.env.LEARNFLOW_PROJECT_ID;
const referencePath = process.env.LEARNFLOW_REFERENCE_PDF;
const resetProblemId = process.env.LEARNFLOW_RESET_PROBLEM_ID || "";
if (!projectId || !referencePath) throw new Error("LEARNFLOW_PROJECT_ID and LEARNFLOW_REFERENCE_PDF are required");

async function jsonFetch(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `${path} returned ${response.status}`);
  return json;
}

async function timed(name, task, timings) {
  const started = performance.now();
  const value = await task();
  timings[name] = Math.round(performance.now() - started);
  return value;
}

const projectPayload = await jsonFetch(`/api/projects/${projectId}`);
let project = projectPayload.project;
const bytes = await readFile(referencePath);
const material = project.materials.find((item) => item.name === basename(referencePath) && item.category !== "ASSIGNMENT");
if (!material) throw new Error(`Reference material ${basename(referencePath)} is not registered in the project`);
const timings = {};

const initialized = await jsonFetch("/api/materials/uploads", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    projectId, materialId: material.id, name: material.name, size: bytes.length,
    mimeType: material.mimeType || "application/pdf", category: material.category,
  }),
});
const parts = [];
for (let index = 0; index < Math.ceil(bytes.length / initialized.partSize); index += 1) {
  const body = bytes.subarray(index * initialized.partSize, Math.min(bytes.length, (index + 1) * initialized.partSize));
  parts.push(await jsonFetch(`/api/materials/${material.id}/uploads/${encodeURIComponent(initialized.uploadId)}/parts/${index + 1}`, {
    method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body,
  }));
}
await jsonFetch(`/api/materials/${material.id}/uploads/${encodeURIComponent(initialized.uploadId)}/complete`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts }),
});

const parsed = await timed("referenceParseMs", () => jsonFetch("/api/materials/parse", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, materialId: material.id }),
}), timings);

project = {
  ...project,
  materials: project.materials.map((item) => item.id === material.id ? {
    ...item, objectKey: initialized.objectKey, status: "READY", parseProgress: 100,
    extractedText: parsed.extractedText, learningDigest: parsed.learningDigest,
    understandingMode: parsed.understandingMode, visualReady: parsed.visualReady, parseError: undefined,
  } : item),
  problemSolutionBlueprints: {},
  updatedAt: new Date().toISOString(),
};

if (resetProblemId) {
  project.answerBlocks = (project.answerBlocks || []).filter((item) => item.problemId !== resetProblemId);
  project.checkpoints = (project.checkpoints || []).filter((item) => item.problemId && item.problemId !== resetProblemId);
  project.problemTeachingMessages = { ...project.problemTeachingMessages, [resetProblemId]: [] };
  project.problemSideMessages = { ...project.problemSideMessages, [resetProblemId]: [] };
  project.problemKnowledgeCheckpoints = { ...project.problemKnowledgeCheckpoints, [resetProblemId]: [] };
  project.problemTeachingStages = { ...project.problemTeachingStages, [resetProblemId]: "READING_PROBLEM" };
  project.problemSelectedMethods = { ...project.problemSelectedMethods, [resetProblemId]: "" };
  project.problemProgress = { ...project.problemProgress, [resetProblemId]: 0 };
  project.problems = project.problems.map((item) => item.id === resetProblemId ? { ...item, status: "NOT_STARTED" } : item);
}

await jsonFetch(`/api/projects/${projectId}`, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project),
});

if (resetProblemId) {
  const problem = project.problems.find((item) => item.id === resetProblemId);
  if (!problem) throw new Error(`Problem ${resetProblemId} was not found`);
  const prepared = await timed("blueprintMs", () => jsonFetch("/api/agent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start_problem", problem, project, responseMode: project.responseMode || "deep" }),
  }), timings);
  project.problemSolutionBlueprints[problem.id] = prepared.solutionBlueprint;
  project.problemKnowledgeCheckpoints[problem.id] = prepared.knowledgeCheckpoints || [];
  project.problemTeachingStages[problem.id] = prepared.stage;
  project.problemSelectedMethods[problem.id] = prepared.selectedMethod || "";
  project.problemProgress[problem.id] = prepared.progress || 0;
  project.problemTeachingMessages[problem.id] = prepared.assistantMessage ? [{
    id: `message_${Date.now().toString(36)}`, role: "assistant", content: prepared.assistantMessage,
    createdAt: new Date().toISOString(), stage: prepared.stage,
  }] : [];
  project.problems = project.problems.map((item) => item.id === problem.id ? { ...item, status: "TEACHING" } : item);
  project.teachingStage = prepared.stage;
  project.selectedMethod = prepared.selectedMethod || "";
  project.progress = prepared.progress || 0;
  project.updatedAt = new Date().toISOString();
  await jsonFetch(`/api/projects/${projectId}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project),
  });
  if (!prepared.solutionBlueprint?.materialUsage?.some((item) => item.applied)) {
    throw new Error("The rebuilt blueprint did not record the teacher material as applied");
  }
  if (!prepared.solutionBlueprint?.materialUsage?.some((item) => item.applied && ["VISUAL_ORIGINAL", "VISUAL_INDEX"].includes(item.sourceMode))) {
    throw new Error("The rebuilt blueprint did not use the visually parsed teacher PDF");
  }
}

console.log(JSON.stringify({
  ok: true, projectId, material: material.name, extractedCharacters: parsed.extractedText.length,
  resetProblemId: resetProblemId || null, timings,
}, null, 2));
