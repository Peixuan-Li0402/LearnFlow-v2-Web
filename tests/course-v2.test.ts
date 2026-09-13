import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { CourseGraph } from "../lib/course-types";
import { graphToMarkdown, parseImportedGraph } from "../lib/graph-serialization";

const root = new URL("../", import.meta.url);

const graph: CourseGraph = {
  id: "graph_1",
  courseId: "course_1",
  title: "概率论知识图谱",
  version: 1,
  status: "READY",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  nodes: [
    { id: "n0", graphId: "graph_1", courseId: "course_1", type: "COURSE", title: "概率论", shortSummary: "课程", importance: "CORE", difficulty: "FOUNDATION", examWeight: 1, confidence: 1, sourceRefs: [], learningStatus: "UNSEEN", generatedFrom: "COURSE_MATERIAL", order: 0 },
    { id: "n1", graphId: "graph_1", courseId: "course_1", type: "CONCEPT", title: "条件期望", shortSummary: "给定信息后的平均值", importance: "CORE", difficulty: "INTERMEDIATE", examWeight: 0.9, confidence: 0.95, sourceRefs: [], learningStatus: "LEARNING", generatedFrom: "COURSE_MATERIAL", order: 1 },
  ],
  edges: [
    { id: "e1", graphId: "graph_1", courseId: "course_1", sourceNodeId: "n0", targetNodeId: "n1", type: "CONTAINS", label: "包含", confidence: 1, inferred: false, sourceRefs: [] },
  ],
};

test("knowledge graph JSON and Markdown exports are both re-importable", () => {
  const fromJson = parseImportedGraph(JSON.stringify(graph), "json");
  assert.equal(fromJson.nodes[1].title, "条件期望");
  assert.equal(fromJson.edges[0].type, "CONTAINS");

  const markdown = graphToMarkdown(graph);
  assert.match(markdown, /概率论知识图谱/);
  assert.match(markdown, /条件期望/);
  const fromMarkdown = parseImportedGraph(markdown, "markdown");
  assert.deepEqual(fromMarkdown.nodes.map((node) => node.title), ["概率论", "条件期望"]);
});

test("v2 keeps course projects separate from standalone assignments", async () => {
  const [schema, workspace, model, homework, tools, agentRoute, courseContext, courseProjectsRoute] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/learn/course-workspace.tsx", root), "utf8"),
    readFile(new URL("lib/course-model.ts", root), "utf8"),
    readFile(new URL("app/homework-agent-app.tsx", root), "utf8"),
    readFile(new URL("tools-service/app.py", root), "utf8"),
    readFile(new URL("app/api/agent/route.ts", root), "utf8"),
    readFile(new URL("lib/course-agent-context.ts", root), "utf8"),
    readFile(new URL("app/api/courses/[id]/projects/route.ts", root), "utf8"),
  ]);
  for (const table of ["courses", "course_materials", "knowledge_nodes", "knowledge_edges", "review_routes", "problem_knowledge_links"]) {
    assert.match(schema, new RegExp(table));
  }
  assert.match(workspace, /MarkmapTree/);
  assert.match(workspace, /G6KnowledgeGraph/);
  assert.match(workspace, /生成完整讲解/);
  assert.match(workspace, /期末冲刺路线/);
  assert.match(workspace, /新建课程项目/);
  assert.match(workspace, /课程项目 · \{course\.name\}/);
  assert.match(workspace, /assignment-card-kind">作业/);
  assert.match(workspace, />新建项目内作业</);
  assert.doesNotMatch(workspace, /加入当前课程|assignment-attach-row/);
  assert.match(model, /generateCourseOutline/);
  assert.match(model, /normalizeCourseOutlineResult/);
  assert.match(model, /buildFallbackCourseOutline/);
  assert.match(model, /OUTLINE_SOURCE_/);
  assert.match(model, /Math\.min\(2, groups\.length\)/);
  assert.match(model, /candidateOutlines/);
  assert.match(model, /generateCourseGraph/);
  assert.match(model, /generateNodeExplanation/);
  assert.match(homework, /本题知识路径/);
  assert.match(homework, /assignment-only-list/);
  assert.match(homework, /entity-kind assignment-kind">作业/);
  assert.match(homework, /sidebarOpen && "新建作业"/);
  assert.match(homework, /sidebarOpen && "新建课程项目"/);
  assert.match(homework, /独立作业/);
  assert.match(homework, /课程项目作业/);
  assert.doesNotMatch(homework, /空白作业|直接导入作业|quick-import-button|newProjectMode|project-mode-switch/);
  assert.match(homework, /请选择作业 PDF/);
  assert.match(agentRoute, /buildCourseAgentContext/);
  assert.match(agentRoute, /loadVisualReferences\(body, courseContext\)/);
  assert.match(agentRoute, /callModel\(\{ \.\.\.body, courseContext, visualReferences \}, signal\)/);
  assert.match(courseContext, /if \(!courseId\) return undefined/);
  assert.match(courseContext, /rankCourseChunks/);
  assert.match(courseContext, /getCourseGraph/);
  assert.match(courseContext, /COURSE_MATERIAL/);
  assert.match(courseProjectsRoute, /独立作业不能加入课程项目/);
  assert.doesNotMatch(courseProjectsRoute, /attachProjectToCourse/);
  assert.match(tools, /Judge0/);
  assert.doesNotMatch(tools, /subprocess|os\.system|shell=True/);
});

test("course materials use resumable upload plus bounded browser vision with visible progress", async () => {
  const [workspace, initRoute, partRoute, completeRoute, uploadConfig, provider, visualClient, visualRoute] = await Promise.all([
    readFile(new URL("app/learn/course-workspace.tsx", root), "utf8"),
    readFile(new URL("app/api/courses/[id]/materials/uploads/route.ts", root), "utf8"),
    readFile(new URL("app/api/course-materials/[id]/uploads/[uploadId]/parts/[partNumber]/route.ts", root), "utf8"),
    readFile(new URL("app/api/course-materials/[id]/uploads/[uploadId]/complete/route.ts", root), "utf8"),
    readFile(new URL("lib/course-material-upload.ts", root), "utf8"),
    readFile(new URL("lib/model-provider.ts", root), "utf8"),
    readFile(new URL("lib/client-pdf-vision.ts", root), "utf8"),
    readFile(new URL("app/api/vision-pages/route.ts", root), "utf8"),
  ]);
  assert.match(initRoute, /createMultipartUpload/);
  assert.match(partRoute, /uploadPart/);
  assert.match(completeRoute, /multipart\.complete/);
  assert.match(uploadConfig, /5 \* 1024 \* 1024/);
  assert.match(workspace, /attempt < attempts/);
  assert.match(workspace, /Math\.min\(2, queue\.length\)/);
  assert.match(workspace, /uploadControllersRef/);
  assert.match(workspace, /uploadFingerprintsRef/);
  assert.match(workspace, /upload-task-progress/);
  assert.match(workspace, /正在提取标题、公式与正文/);
  assert.match(workspace, /千问正在阅读页面/);
  assert.match(visualClient, /pages\.slice\(index \* 6, index \* 6 \+ 6\)/);
  assert.match(visualClient, /Math\.min\(2, batches\.length\)/);
  assert.match(visualRoute, /const MAX_PAGES = 6/);
  assert.match(provider, /extractVisualPageImagesWithModel/);
  assert.match(provider, /fastTeachingInteractions/);
  const courseModel = await readFile(new URL("lib/course-model.ts", root), "utf8");
  assert.match(courseModel, /TOKEN_PLAN_API_KEY/);
  assert.match(courseModel, /tokenPlanFastModel/);
  assert.doesNotMatch(courseModel, /LLM_API_KEY|standardFastModel/);
});

test("assignment switching cancels stale model work and direct import never blocks project creation", async () => {
  const [homework, agentRoute, parseRoute, provider, courseStore] = await Promise.all([
    readFile(new URL("app/homework-agent-app.tsx", root), "utf8"),
    readFile(new URL("app/api/agent/route.ts", root), "utf8"),
    readFile(new URL("app/api/parse-pdf/route.ts", root), "utf8"),
    readFile(new URL("lib/model-provider.ts", root), "utf8"),
    readFile(new URL("db/course-store.ts", root), "utf8"),
  ]);
  assert.match(homework, /problemSelectionTimerRef/);
  assert.doesNotMatch(homework, /prefetchAllProblemBlueprints|all-problems|blueprintPrefetchJobsRef/);
  assert.match(homework, /controller\.abort\(\)/);
  assert.match(homework, /mainRequestRef\.current\?\.id !== requestId/);
  assert.match(homework, /setTimeout\(\(\) => \{[\s\S]*startProblem\(problem\)[\s\S]*\}, 260\)/);
  assert.match(homework, /立即创建，后台整理/);
  assert.match(homework, /assignment-upload-state/);
  assert.match(agentRoute, /buildCourseAgentContext\(body\)/);
  assert.match(agentRoute, /loadVisualReferences\(body, courseContext\)/);
  assert.match(agentRoute, /callModel\(\{ \.\.\.body, courseContext, visualReferences \}, signal\)/);
  assert.match(parseRoute, /parsePdfWithModel\([\s\S]*request\.signal/);
  assert.match(provider, /signal\?: AbortSignal/);
  assert.doesNotMatch(courseStore, /async function migrateLegacyProjects/);
  assert.match(courseStore, /undoUnusedLegacyCourseMigrations/);
  assert.match(courseStore, /normalizeGraphIds/);
  assert.match(courseStore, /ON CONFLICT\(id\) DO UPDATE/);
  assert.match(courseStore, /Removing the final source means there is no evidence left/);
  assert.match(courseStore, /DELETE FROM graph_jobs WHERE course_id = \?/);
  assert.match(courseStore, /DELETE FROM knowledge_graphs WHERE course_id = \?/);
});

test("knowledge graph selection preserves the current viewport", async () => {
  const [dependencyGraph, chapterTree] = await Promise.all([
    readFile(new URL("app/learn/g6-knowledge-graph.tsx", root), "utf8"),
    readFile(new URL("app/learn/markmap-tree.tsx", root), "utf8"),
  ]);
  assert.match(dependencyGraph, /instanceRef/);
  assert.match(dependencyGraph, /setElementState/);
  assert.match(dependencyGraph, /viewportRef/);
  assert.match(dependencyGraph, /getZoom\(\)/);
  assert.match(dependencyGraph, /translateTo\(savedViewport\.position/);
  assert.doesNotMatch(dependencyGraph, /\}, \[focusNodeId, graph, onSelect, visibleTypes\]\)/);
  assert.doesNotMatch(dependencyGraph, /focusElement\(focusNodeId\)/);
  assert.match(chapterTree, /initialFitComplete/);
  assert.match(chapterTree, /userInteracted/);
  assert.match(chapterTree, /event\.stopPropagation\(\)/);
});
