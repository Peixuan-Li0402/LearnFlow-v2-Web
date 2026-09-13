import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  courseId: text("course_id"),
  projectType: text("project_type").notNull().default("ASSIGNMENT"),
  dataJson: text("data_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const materials = sqliteTable(
  "materials",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("materials_project_idx").on(table.projectId)],
);

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull(),
  outlineJson: text("outline_json"),
  outlineConfirmed: integer("outline_confirmed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const courseMaterials = sqliteTable(
  "course_materials",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    objectKey: text("object_key").notNull(),
    status: text("status").notNull(),
    parseProgress: integer("parse_progress").notNull().default(0),
    extractedText: text("extracted_text"),
    pageCount: integer("page_count"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("course_materials_course_idx").on(table.courseId)],
);

export const materialChunks = sqliteTable(
  "material_chunks",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    materialId: text("material_id").notNull(),
    sequence: integer("sequence").notNull(),
    heading: text("heading").notNull().default(""),
    text: text("text").notNull(),
    page: integer("page"),
    slide: integer("slide"),
    sourceRefJson: text("source_ref_json").notNull(),
  },
  (table) => [
    index("material_chunks_course_idx").on(table.courseId),
    index("material_chunks_material_idx").on(table.materialId),
  ],
);

export const knowledgeGraphs = sqliteTable(
  "knowledge_graphs",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    title: text("title").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("knowledge_graphs_course_idx").on(table.courseId)],
);

export const knowledgeNodes = sqliteTable(
  "knowledge_nodes",
  {
    id: text("id").primaryKey(),
    graphId: text("graph_id").notNull(),
    courseId: text("course_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    shortSummary: text("short_summary").notNull(),
    importance: text("importance").notNull(),
    difficulty: text("difficulty").notNull(),
    examWeight: real("exam_weight").notNull().default(0),
    confidence: real("confidence").notNull().default(1),
    sourceRefsJson: text("source_refs_json").notNull(),
    explanationArtifactId: text("explanation_artifact_id"),
    learningStatus: text("learning_status").notNull().default("UNSEEN"),
    generatedFrom: text("generated_from").notNull(),
    chapterId: text("chapter_id"),
    formula: text("formula"),
    conditionsJson: text("conditions_json").notNull().default("[]"),
    aliasesJson: text("aliases_json").notNull().default("[]"),
    orderIndex: integer("order_index").notNull().default(0),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (table) => [
    index("knowledge_nodes_course_idx").on(table.courseId),
    index("knowledge_nodes_graph_idx").on(table.graphId),
    index("knowledge_nodes_title_idx").on(table.title),
  ],
);

export const knowledgeEdges = sqliteTable(
  "knowledge_edges",
  {
    id: text("id").primaryKey(),
    graphId: text("graph_id").notNull(),
    courseId: text("course_id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    type: text("type").notNull(),
    label: text("label").notNull().default(""),
    confidence: real("confidence").notNull().default(1),
    inferred: integer("inferred", { mode: "boolean" }).notNull().default(false),
    sourceRefsJson: text("source_refs_json").notNull(),
  },
  (table) => [
    index("knowledge_edges_course_idx").on(table.courseId),
    index("knowledge_edges_graph_idx").on(table.graphId),
    uniqueIndex("knowledge_edges_unique_idx").on(table.graphId, table.sourceNodeId, table.targetNodeId, table.type),
  ],
);

export const graphJobs = sqliteTable(
  "graph_jobs",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    status: text("status").notNull(),
    stage: text("stage").notNull(),
    progress: integer("progress").notNull().default(0),
    error: text("error"),
    traceJson: text("trace_json").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("graph_jobs_course_idx").on(table.courseId)],
);

export const explanationArtifacts = sqliteTable(
  "explanation_artifacts",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    nodeId: text("node_id").notNull(),
    title: text("title").notNull(),
    sectionsJson: text("sections_json").notNull(),
    sourceRefsJson: text("source_refs_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("explanation_artifacts_node_idx").on(table.nodeId)],
);

export const learningSessions = sqliteTable(
  "learning_sessions",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    nodeId: text("node_id"),
    kind: text("kind").notNull(),
    messagesJson: text("messages_json").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("learning_sessions_course_idx").on(table.courseId)],
);

export const nodeLearningStates = sqliteTable(
  "node_learning_states",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    nodeId: text("node_id").notNull(),
    status: text("status").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("node_learning_states_unique_idx").on(table.courseId, table.nodeId)],
);

export const reviewRoutes = sqliteTable(
  "review_routes",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    examDate: text("exam_date").notNull(),
    dailyMinutes: integer("daily_minutes").notNull(),
    scope: text("scope").notNull(),
    targetScore: integer("target_score"),
    summary: text("summary").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("review_routes_course_idx").on(table.courseId)],
);

export const reviewRouteItems = sqliteTable(
  "review_route_items",
  {
    id: text("id").primaryKey(),
    routeId: text("route_id").notNull(),
    dayIndex: integer("day_index").notNull(),
    date: text("date").notNull(),
    title: text("title").notNull(),
    nodeIdsJson: text("node_ids_json").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    rationale: text("rationale").notNull(),
    status: text("status").notNull().default("PENDING"),
  },
  (table) => [index("review_route_items_route_idx").on(table.routeId)],
);

export const problemKnowledgeLinks = sqliteTable(
  "problem_knowledge_links",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id").notNull(),
    projectId: text("project_id").notNull(),
    problemId: text("problem_id").notNull(),
    nodeId: text("node_id").notNull(),
    relevance: real("relevance").notNull(),
    evidence: text("evidence").notNull(),
  },
  (table) => [
    index("problem_knowledge_links_problem_idx").on(table.projectId, table.problemId),
    uniqueIndex("problem_knowledge_links_unique_idx").on(table.projectId, table.problemId, table.nodeId),
  ],
);

