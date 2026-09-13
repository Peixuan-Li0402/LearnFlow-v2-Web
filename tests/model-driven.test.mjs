import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("runtime has no fixed-answer fallback", async () => {
  const route = await readFile(new URL("app/api/agent/route.ts", root), "utf8");
  const visualContext = await readFile(new URL("lib/visual-reference-context.ts", root), "utf8");
  await assert.rejects(access(new URL("lib/demo-engine.ts", root)));
  assert.match(route, /buildCourseAgentContext\(body\)/);
  assert.match(route, /loadVisualReferences\(body, courseContext\)/);
  assert.match(route, /await callModel\(\{ \.\.\.body, courseContext, visualReferences \}, signal\)/);
  assert.match(route, /AbortSignal\.timeout\(150_000\)/);
  assert.match(visualContext, /UPLOADS\.get\(item\.objectKey\)/);
  assert.match(visualContext, /data:\$\{item\.mimeType\};base64/);
  assert.match(visualContext, /problemSolutionBlueprints/);
  assert.doesNotMatch(route, /fallback|runDemoAgent/);
});

test("PDF pages are rendered in the browser and sent to Qwen vision in bounded batches", async () => {
  const provider = await readFile(new URL("lib/model-provider.ts", root), "utf8");
  const route = await readFile(new URL("app/api/vision-pages/route.ts", root), "utf8");
  const client = await readFile(new URL("lib/client-pdf-vision.ts", root), "utf8");
  const app = await readFile(new URL("app/homework-agent-app.tsx", root), "utf8");
  assert.match(provider, /TOKEN_PLAN_DOCUMENT_MODEL/);
  assert.match(provider, /extractVisualPageImagesWithModel/);
  assert.match(provider, /pages\.length \/ 6/);
  assert.match(provider, /type: "image_url"/);
  assert.match(provider, /data:\$\{mimeType\};base64/);
  assert.match(client, /pdfjs-dist\/build\/pdf\.mjs/);
  assert.match(client, /pages\.slice\(index \* 6, index \* 6 \+ 6\)/);
  assert.match(client, /Math\.min\(2, batches\.length\)/);
  assert.match(client, /form\.append\("startPage"/);
  assert.match(route, /const MAX_PAGES = 6/);
  assert.match(route, /request\.formData\(\)/);
  assert.match(route, /startPage \+ index/);
  assert.match(app, /extractVisualDocumentText/);
  assert.doesNotMatch(app, /\/api\/parse-pdf/);
});

test("teacher references use their original visual pages during the hidden solve", async () => {
  const [provider, agentRoute, materialsRoute, app] = await Promise.all([
    readFile(new URL("lib/model-provider.ts", root), "utf8"),
    readFile(new URL("app/api/agent/route.ts", root), "utf8"),
    readFile(new URL("app/api/materials/parse/route.ts", root), "utf8"),
    readFile(new URL("app/homework-agent-app.tsx", root), "utf8"),
  ]);
  assert.match(agentRoute, /loadVisualReferences/);
  assert.match(provider, /visualResponsesCompletion/);
  assert.match(provider, /x-dashscope-session-cache/);
  assert.match(provider, /type: "input_file"/);
  assert.match(provider, /VISUAL_ORIGINAL/);
  assert.match(provider, /VISUAL_INDEX/);
  assert.match(provider, /isQuotaOrModelAccessError/);
  assert.match(provider, /config\.fastModel/);
  assert.match(provider, /visualUnavailableUntil/);
  assert.match(provider, /hasReusableVisualIndex/);
  assert.match(provider, /TOKEN_PLAN_API_KEY/);
  assert.match(provider, /token-plan\.cn-beijing\.maas\.aliyuncs\.com/);
  assert.match(provider, /endpoint\.label/);
  assert.doesNotMatch(provider, /config\.standard\.baseUrl/);
  assert.match(provider, /config\.tokenPlan\.baseUrl/);
  assert.match(provider, /原始视觉页面/);
  assert.match(materialsRoute, /VISUAL_DOCUMENT/);
  assert.match(materialsRoute, /visualReady/);
  assert.match(app, /已完成视觉学习/);
  assert.doesNotMatch(app, /prefetchAllProblemBlueprints/);
  assert.doesNotMatch(app, /已学习老师资料：.*字/);
});

test("teaching uses a hidden solution blueprint and one batch knowledge survey", async () => {
  const provider = await readFile(new URL("lib/model-provider.ts", root), "utf8");
  const app = await readFile(new URL("app/homework-agent-app.tsx", root), "utf8");
  assert.match(provider, /callSideModel/);
  assert.match(provider, /sideMessages/);
  assert.match(provider, /progress 为 0-100 的整数/);
  assert.doesNotMatch(app, /quick-questions|这个公式的适用条件是什么/);
  assert.match(app, /rollback-toggle/);
  assert.match(app, /assistant-avatar\.jpg/);
  assert.doesNotMatch(app, /from "next\/image"/);
  assert.match(app, /problemTeachingMessages/);
  assert.match(app, /problemSideMessages/);
  assert.match(app, /currentTeachingMessages/);
  assert.match(app, /MarkdownMath/);
  assert.match(app, /mainThinking/);
  assert.match(app, /sideThinking/);
  assert.match(app, /knowledge-question/);
  assert.match(app, /makeMessage\("user", message/);
  assert.match(provider, /SOLUTION_BLUEPRINT_PROMPT/);
  assert.match(provider, /buildSolutionBlueprint/);
  assert.match(provider, /unwrapAgentPayload/);
  assert.match(provider, /generateDirectAnswer/);
  assert.match(provider, /独立解题器/);
  assert.match(provider, /独立数学复核员/);
  assert.match(provider, /一次性摸底/);
  assert.match(provider, /KNOWLEDGE_SURVEY/);
  assert.match(provider, /ADVANCED 每步约 600-1200 字/);
  assert.match(provider, /不输出私有思维链、草稿或内部蓝图/);
  assert.match(provider, /FINAL_ANSWER_PROMPT/);
  assert.match(provider, /qwen3\.6-flash/);
  assert.match(provider, /material\.category !== "ASSIGNMENT"/);
  assert.match(provider, /基础知识助手/);
  assert.match(app, /repeatsLastAssistant/);
  assert.doesNotMatch(app, /avoidRepeat: true/);
  assert.match(app, /skipCurrentSection/);
  assert.match(app, /submitKnowledgeSurvey/);
  assert.match(app, /pendingKnowledgeCheckpoints/);
  assert.match(app, /按这个情况开始讲解/);
  assert.match(app, /response-mode/);
  assert.match(app, /pdf-progress/);
  assert.match(app, /estimatePdfSeconds/);
  assert.match(app, /referenceFileInput/);
  assert.match(app, /currentReferenceInput/);
  assert.match(app, /为当前作业添加参考资料/);
  assert.match(app, /A temporary R2\/network failure must not discard a reference/);
  assert.match(app, /visualParsed \|\| await parseStoredReference/);
  assert.match(app, /老师课件或参考资料/);
  assert.match(app, /ResizeObserver loop completed/);
  assert.doesNotMatch(app, /function Formula/);
  const materialsRoute = await readFile(new URL("app/api/materials/route.ts", root), "utf8");
  const materialsParseRoute = await readFile(new URL("app/api/materials/parse/route.ts", root), "utf8");
  assert.match(materialsRoute, /Always persist first/);
  assert.doesNotMatch(materialsRoute, /extractReferenceMaterialWithModel/);
  assert.match(materialsParseRoute, /extractReferenceMaterialWithModel/);
  assert.match(materialsParseRoute, /learningDigest/);
  assert.match(provider, /deliverVerifiedSection/);
  assert.match(provider, /buildCanonicalAnswerBlocks/);
  assert.match(provider, /thinking_budget/);
  assert.match(provider, /blueprintRequests/);
  assert.match(provider, /const solverModel = config\.solverModel/);
  assert.match(provider, /config\.reviewModel/);
  assert.match(provider, /signal,\s*true,\s*false,\s*60_000/);
  assert.match(provider, /attemptsPerModel: 1/);
  assert.match(provider, /const totalTimeoutMs = timeoutOverrideMs \|\| config\.modelTimeoutMs/);
  assert.match(provider, /selectRelevantReferenceText\(material\.extractedText!, query, 3_600\)/);
  assert.match(provider, /reviewSolutionBlueprint/);
  assert.match(provider, /BLUEPRINT_REVIEW_PROMPT/);
  assert.doesNotMatch(provider, /LLM_API_KEY/);
});

test("empty first launch contains no demonstration project", async () => {
  const empty = await readFile(new URL("lib/empty-project.ts", root), "utf8");
  assert.match(empty, /problems: \[\]/);
  assert.match(empty, /teachingMessages: \[\]/);
  assert.match(empty, /responseMode: "deep"/);
  assert.doesNotMatch(empty, /概率论|均匀分布|demo_/);
});
