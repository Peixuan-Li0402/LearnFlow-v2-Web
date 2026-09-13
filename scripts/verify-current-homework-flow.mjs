import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const base = process.env.LEARNFLOW_URL || "http://127.0.0.1:3011";
const assignmentPath = process.env.LEARNFLOW_ASSIGNMENT_PDF || "C:/Users/lenovo/Desktop/作品/概率论/prob_hw13 (1).pdf";
const teacherPath = process.env.LEARNFLOW_TEACHER_PDF || "C:/Users/lenovo/Desktop/作品/概率论/Lec13_2026_0527 (1).pdf";
const projectId = `pdf_e2e_${Date.now().toString(36)}`;
const assignmentId = `material_assignment_${Date.now().toString(36)}`;
const teacherId = `material_teacher_${Date.now().toString(36)}`;

const timings = {};
async function timed(name, task) {
  const started = performance.now();
  const result = await task();
  timings[name] = Math.round(performance.now() - started);
  return result;
}

async function jsonFetch(url, init) {
  const response = await fetch(`${base}${url}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} (${response.status}): ${payload.error || JSON.stringify(payload).slice(0, 300)}`);
  return payload;
}

async function upload(path, materialId, category) {
  const bytes = await readFile(path);
  if (bytes.length > 2_500_000) {
    const initialized = await jsonFetch("/api/materials/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, materialId, name: basename(path), size: bytes.length, mimeType: "application/pdf", category }),
    });
    const parts = [];
    for (let index = 0; index < Math.ceil(bytes.length / initialized.partSize); index += 1) {
      const body = bytes.subarray(index * initialized.partSize, Math.min(bytes.length, (index + 1) * initialized.partSize));
      parts.push(await jsonFetch(`/api/materials/${materialId}/uploads/${encodeURIComponent(initialized.uploadId)}/parts/${index + 1}`, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body,
      }));
    }
    return jsonFetch(`/api/materials/${materialId}/uploads/${encodeURIComponent(initialized.uploadId)}/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts }),
    });
  }
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), basename(path));
  form.append("projectId", projectId);
  form.append("materialId", materialId);
  form.append("category", category);
  return jsonFetch("/api/materials", { method: "POST", body: form });
}

const assignmentBytes = await readFile(assignmentPath);
const parseForm = new FormData();
parseForm.append("file", new Blob([assignmentBytes], { type: "application/pdf" }), basename(assignmentPath));

let created = false;
try {
  const parsed = await timed("assignmentParseMs", () => jsonFetch("/api/parse-pdf", { method: "POST", body: parseForm }));
  if (!parsed.problems?.length) throw new Error("Assignment parser returned no problems");
  let project = {
    runtimeVersion: "model-v1",
    conversationVersion: "per-problem-v1",
    id: projectId,
    courseId: null,
    name: "prob_hw13 latency verification",
    status: "AWAITING_CONFIRMATION",
    currentProblemId: parsed.problems[0].id,
    teachingStage: "READING_PROBLEM",
    selectedMethod: "",
    progress: 0,
    responseMode: "deep",
    problems: parsed.problems,
    materials: [
      { id: assignmentId, name: basename(assignmentPath), category: "ASSIGNMENT", mimeType: "application/pdf", size: assignmentBytes.length, status: "READY", extractedText: parsed.text || "" },
      { id: teacherId, name: basename(teacherPath), category: "COURSE_RULE", mimeType: "application/pdf", size: (await readFile(teacherPath)).length, status: "UPLOADING" },
    ],
    answerBlocks: [], teachingMessages: [], sideMessages: [], knowledgeCheckpoints: [],
    problemTeachingMessages: {}, problemSideMessages: {}, problemKnowledgeCheckpoints: {},
    problemTeachingStages: {}, problemSelectedMethods: {}, problemProgress: {}, problemSolutionBlueprints: {},
    memories: [], checkpoints: [], rollbackPreview: null, answerVersion: 1, updatedAt: new Date().toISOString(),
  };
  await jsonFetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) });
  created = true;
  const assignmentUpload = await timed("assignmentPersistMs", () => upload(assignmentPath, assignmentId, "ASSIGNMENT"));
  const teacherUpload = await timed("teacherPersistMs", () => upload(teacherPath, teacherId, "COURSE_RULE"));
  project.materials[0].objectKey = assignmentUpload.objectKey;
  project.materials[1] = { ...project.materials[1], objectKey: teacherUpload.objectKey, status: "PARSING", parseProgress: 35 };
  const teacherParsed = await timed("teacherParseMs", () => jsonFetch("/api/materials/parse", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, materialId: teacherId }),
  }));
  project.materials[1] = {
    ...project.materials[1], status: "READY", parseProgress: 100,
    extractedText: teacherParsed.extractedText, learningDigest: teacherParsed.learningDigest,
    understandingMode: teacherParsed.understandingMode,
    visualReady: teacherParsed.visualReady,
  };
  await jsonFetch(`/api/projects/${projectId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) });

  const problem = parsed.problems[0];
  const started = await timed("initialBlueprintMs", () => jsonFetch("/api/agent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start_problem", problem, project, responseMode: "deep" }),
  }));
  project.problemSolutionBlueprints[problem.id] = started.solutionBlueprint;
  project.problemKnowledgeCheckpoints[problem.id] = (started.knowledgeCheckpoints || []).map((item) => ({ ...item, status: "ANSWERED", answer: "KNOWN" }));
  project.problemTeachingStages[problem.id] = started.stage;
  project.problemProgress[problem.id] = started.progress;
  const answers = project.problemKnowledgeCheckpoints[problem.id].map((item) => ({ checkpointId: item.id, answer: "KNOWN" }));
  const firstLesson = await timed("firstLessonMs", () => jsonFetch("/api/agent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat", problem, project, responseMode: "deep", message: "都了解，开始讲解", interaction: { kind: "KNOWLEDGE_SURVEY", answers } }),
  }));
  project.checkpoints.push(firstLesson.checkpoint);
  project.problemTeachingStages[problem.id] = firstLesson.stage;
  project.problemProgress[problem.id] = firstLesson.progress;
  const secondLesson = await timed("continueLessonMs", () => jsonFetch("/api/agent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat", problem, project, responseMode: "deep", message: "继续", interaction: { kind: "CONTINUE" } }),
  }));
  const direct = await timed("directAnswerMs", () => jsonFetch("/api/agent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat", problem, project, responseMode: "deep", message: "直接查看完整答案", interaction: { kind: "DIRECT_ANSWER" } }),
  }));

  const visible = [firstLesson.assistantMessage, secondLesson.assistantMessage, direct.assistantMessage].join("\n");
  if (/我先试试|我发现了|不对[，。]|修正思路|重新来过|换个角度再试/u.test(visible)) {
    throw new Error("Visible lesson leaked exploratory self-correction");
  }
  if (direct.answerBlocks?.length !== 5) throw new Error(`Direct answer has ${direct.answerBlocks?.length || 0} blocks instead of 5`);
  if (!started.solutionBlueprint?.materialUsage?.some((item) => item.applied)) throw new Error("Teacher material was not recorded as applied");
  const visualSourceMode = started.solutionBlueprint?.materialUsage?.find((item) => item.applied && ["VISUAL_ORIGINAL", "VISUAL_INDEX"].includes(item.sourceMode))?.sourceMode;
  if (!visualSourceMode) {
    throw new Error("Teacher material was not used through the visual document pipeline");
  }
  if (timings.firstLessonMs > 2000 || timings.continueLessonMs > 2000 || timings.directAnswerMs > 2000) {
    throw new Error(`Cached delivery is too slow: ${JSON.stringify(timings)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    problems: parsed.problems.length,
    teacherCharacters: teacherParsed.characterCount,
    blueprintSections: started.solutionBlueprint.sections.length,
    appliedMaterials: started.solutionBlueprint.materialUsage.filter((item) => item.applied).map((item) => item.name),
    visualSourceMode,
    answerBlocks: direct.answerBlocks.length,
    visibleReasoningLeak: false,
    timings,
  }, null, 2));
} finally {
  if (created) await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
}
