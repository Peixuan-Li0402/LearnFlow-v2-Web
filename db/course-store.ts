import { bindings, ensureSchema } from "./store";
import type {
  CourseAssignmentSummary,
  CourseGraph,
  CourseMaterial,
  CourseOutline,
  CourseSpace,
  CourseWorkspacePayload,
  ExplanationArtifact,
  GraphBuildJob,
  KnowledgeEdge,
  KnowledgeNode,
  LearningStatus,
  MaterialChunk,
  ProblemKnowledgeLink,
  ReviewRoute,
  ReviewRouteInput,
  ReviewRouteItem,
  SourceRef,
} from "@/lib/course-types";

const nowIso = (value = Date.now()) => new Date(value).toISOString();
const stableIdHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

function normalizeGraphIds(graph: CourseGraph): CourseGraph {
  const idMap = new Map<string, string>();
  const semanticMap = new Map<string, string>();
  const normalizedNodes: KnowledgeNode[] = [];
  for (const node of graph.nodes) {
    const semanticKey = `${node.type}:${node.title.trim().toLowerCase()}`;
    const existing = idMap.get(node.id) || semanticMap.get(semanticKey);
    if (existing) {
      idMap.set(node.id, existing);
      continue;
    }
    const id = `kn_${stableIdHash(`${graph.courseId}|${node.id}|${semanticKey}`)}`;
    idMap.set(node.id, id);
    semanticMap.set(semanticKey, id);
    normalizedNodes.push({ ...node, id, graphId: graph.id, courseId: graph.courseId });
  }
  const nodes = normalizedNodes.map((node) => ({
    ...node,
    chapterId: node.chapterId ? idMap.get(node.chapterId) : undefined,
  }));
  const edgeKeys = new Set<string>();
  const edges: KnowledgeEdge[] = [];
  for (const edge of graph.edges) {
    const sourceNodeId = idMap.get(edge.sourceNodeId);
    const targetNodeId = idMap.get(edge.targetNodeId);
    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) continue;
    const key = `${sourceNodeId}|${targetNodeId}|${edge.type}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      ...edge,
      id: `ke_${stableIdHash(`${graph.courseId}|${key}`)}`,
      graphId: graph.id,
      courseId: graph.courseId,
      sourceNodeId,
      targetNodeId,
    });
  }
  return { ...graph, nodes, edges };
}
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export async function ensureCourseSchema() {
  await ensureSchema();
  const { DB } = bindings();
  const projectColumns = await DB.prepare("PRAGMA table_info(projects)").all<{ name: string }>();
  const names = new Set(projectColumns.results.map((column: { name: string }) => String(column.name)));
  if (!names.has("course_id")) await DB.prepare("ALTER TABLE projects ADD COLUMN course_id TEXT").run();
  if (!names.has("project_type")) {
    await DB.prepare("ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'ASSIGNMENT'").run();
  }

  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      outline_json TEXT,
      outline_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS course_materials (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      status TEXT NOT NULL,
      parse_progress INTEGER NOT NULL DEFAULT 0,
      extracted_text TEXT,
      page_count INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS course_materials_course_idx ON course_materials(course_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS material_chunks (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      heading TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      page INTEGER,
      slide INTEGER,
      source_ref_json TEXT NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS material_chunks_course_idx ON material_chunks(course_id)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS material_chunks_material_idx ON material_chunks(material_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS knowledge_graphs (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      title TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS knowledge_graphs_course_idx ON knowledge_graphs(course_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      short_summary TEXT NOT NULL,
      importance TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      exam_weight REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1,
      source_refs_json TEXT NOT NULL,
      explanation_artifact_id TEXT,
      learning_status TEXT NOT NULL DEFAULT 'UNSEEN',
      generated_from TEXT NOT NULL,
      chapter_id TEXT,
      formula TEXT,
      conditions_json TEXT NOT NULL DEFAULT '[]',
      aliases_json TEXT NOT NULL DEFAULT '[]',
      order_index INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS knowledge_nodes_course_idx ON knowledge_nodes(course_id)"),
    DB.prepare("CREATE INDEX IF NOT EXISTS knowledge_nodes_graph_idx ON knowledge_nodes(graph_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS knowledge_edges (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1,
      inferred INTEGER NOT NULL DEFAULT 0,
      source_refs_json TEXT NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS knowledge_edges_course_idx ON knowledge_edges(course_id)"),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS knowledge_edges_unique_idx ON knowledge_edges(graph_id, source_node_id, target_node_id, type)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS graph_jobs (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      trace_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS graph_jobs_course_idx ON graph_jobs(course_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS explanation_artifacts (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      title TEXT NOT NULL,
      sections_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS explanation_artifacts_node_idx ON explanation_artifacts(node_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS learning_sessions (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      node_id TEXT,
      kind TEXT NOT NULL,
      messages_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS learning_sessions_course_idx ON learning_sessions(course_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS node_learning_states (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS node_learning_states_unique_idx ON node_learning_states(course_id, node_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS review_routes (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      exam_date TEXT NOT NULL,
      daily_minutes INTEGER NOT NULL,
      scope TEXT NOT NULL,
      target_score INTEGER,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS review_routes_course_idx ON review_routes(course_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS review_route_items (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      day_index INTEGER NOT NULL,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      node_ids_json TEXT NOT NULL,
      estimated_minutes INTEGER NOT NULL,
      rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING'
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS review_route_items_route_idx ON review_route_items(route_id)"),
    DB.prepare(`CREATE TABLE IF NOT EXISTS problem_knowledge_links (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      relevance REAL NOT NULL,
      evidence TEXT NOT NULL
    )`),
    DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS problem_knowledge_links_unique_idx ON problem_knowledge_links(project_id, problem_id, node_id)"),
  ]);
}

async function undoUnusedLegacyCourseMigrations() {
  await ensureCourseSchema();
  const { DB } = bindings();
  const rows = await DB.prepare(`SELECT
      c.id AS course_id,
      p.id AS project_id,
      (SELECT COUNT(*) FROM projects p2 WHERE p2.course_id = c.id) AS project_count,
      (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.id) AS material_count,
      (SELECT COUNT(*) FROM knowledge_graphs g WHERE g.course_id = c.id) AS graph_count,
      (SELECT COUNT(*) FROM graph_jobs j WHERE j.course_id = c.id) AS job_count,
      (SELECT COUNT(*) FROM review_routes r WHERE r.course_id = c.id) AS route_count
    FROM courses c
    JOIN projects p ON p.course_id = c.id
    WHERE c.description = '由旧版作业项目自动迁移'
      AND c.id = ('course_' || p.id)`)
    .all<{
      course_id: string;
      project_id: string;
      project_count: number;
      material_count: number;
      graph_count: number;
      job_count: number;
      route_count: number;
    }>();
  for (const row of rows.results) {
    if (Number(row.project_count) !== 1
      || Number(row.material_count) > 0
      || Number(row.graph_count) > 0
      || Number(row.job_count) > 0
      || Number(row.route_count) > 0) continue;
    await DB.batch([
      DB.prepare("UPDATE projects SET course_id = NULL, project_type = 'ASSIGNMENT', updated_at = ? WHERE id = ?")
        .bind(Date.now(), row.project_id),
      DB.prepare("DELETE FROM courses WHERE id = ?").bind(row.course_id),
    ]);
  }
}

function mapCourse(row: Record<string, unknown>): CourseSpace {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description || ""),
    status: String(row.status) as CourseSpace["status"],
    outline: parseJson<CourseOutline | null>(row.outline_json, null),
    outlineConfirmed: Boolean(row.outline_confirmed),
    createdAt: nowIso(Number(row.created_at)),
    updatedAt: nowIso(Number(row.updated_at)),
  };
}

function mapMaterial(row: Record<string, unknown>): CourseMaterial {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    name: String(row.name),
    category: String(row.category) as CourseMaterial["category"],
    mimeType: String(row.mime_type),
    size: Number(row.size),
    objectKey: String(row.object_key),
    status: String(row.status) as CourseMaterial["status"],
    parseProgress: Number(row.parse_progress || 0),
    extractedText: row.extracted_text ? String(row.extracted_text) : undefined,
    pageCount: row.page_count == null ? undefined : Number(row.page_count),
    error: row.error ? String(row.error) : undefined,
    createdAt: nowIso(Number(row.created_at)),
    updatedAt: nowIso(Number(row.updated_at)),
  };
}

function mapNode(row: Record<string, unknown>): KnowledgeNode {
  return {
    id: String(row.id),
    graphId: String(row.graph_id),
    courseId: String(row.course_id),
    type: String(row.type) as KnowledgeNode["type"],
    title: String(row.title),
    shortSummary: String(row.short_summary || ""),
    importance: String(row.importance) as KnowledgeNode["importance"],
    difficulty: String(row.difficulty) as KnowledgeNode["difficulty"],
    examWeight: Number(row.exam_weight || 0),
    confidence: Number(row.confidence || 0),
    sourceRefs: parseJson<SourceRef[]>(row.source_refs_json, []),
    explanationArtifactId: row.explanation_artifact_id ? String(row.explanation_artifact_id) : undefined,
    learningStatus: String(row.learning_status || "UNSEEN") as LearningStatus,
    generatedFrom: String(row.generated_from) as KnowledgeNode["generatedFrom"],
    chapterId: row.chapter_id ? String(row.chapter_id) : undefined,
    formula: row.formula ? String(row.formula) : undefined,
    conditions: parseJson<string[]>(row.conditions_json, []),
    aliases: parseJson<string[]>(row.aliases_json, []),
    order: Number(row.order_index || 0),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function mapEdge(row: Record<string, unknown>): KnowledgeEdge {
  return {
    id: String(row.id),
    graphId: String(row.graph_id),
    courseId: String(row.course_id),
    sourceNodeId: String(row.source_node_id),
    targetNodeId: String(row.target_node_id),
    type: String(row.type) as KnowledgeEdge["type"],
    label: String(row.label || ""),
    confidence: Number(row.confidence || 0),
    inferred: Boolean(row.inferred),
    sourceRefs: parseJson<SourceRef[]>(row.source_refs_json, []),
  };
}

function mapJob(row: Record<string, unknown>): GraphBuildJob {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    status: String(row.status) as GraphBuildJob["status"],
    stage: String(row.stage),
    progress: Number(row.progress || 0),
    error: row.error ? String(row.error) : undefined,
    trace: parseJson<GraphBuildJob["trace"]>(row.trace_json, []),
    createdAt: nowIso(Number(row.created_at)),
    updatedAt: nowIso(Number(row.updated_at)),
  };
}

export async function listCourses() {
  await undoUnusedLegacyCourseMigrations();
  const result = await bindings().DB.prepare("SELECT * FROM courses ORDER BY updated_at DESC").all();
  return result.results.map((row: Record<string, unknown>) => mapCourse(row));
}

export async function getCourse(id: string) {
  await ensureCourseSchema();
  const row = await bindings().DB.prepare("SELECT * FROM courses WHERE id = ?").bind(id).first();
  return row ? mapCourse(row as Record<string, unknown>) : null;
}

export async function createCourse(course: CourseSpace) {
  await ensureCourseSchema();
  const createdAt = Date.parse(course.createdAt) || Date.now();
  const updatedAt = Date.parse(course.updatedAt) || createdAt;
  await bindings().DB.prepare(`INSERT INTO courses
    (id, name, description, status, outline_json, outline_confirmed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      course.id,
      course.name,
      course.description,
      course.status,
      course.outline ? JSON.stringify(course.outline) : null,
      course.outlineConfirmed ? 1 : 0,
      createdAt,
      updatedAt,
    )
    .run();
  return getCourse(course.id);
}

export async function updateCourse(id: string, patch: Partial<CourseSpace>) {
  await ensureCourseSchema();
  const current = await getCourse(id);
  if (!current) return null;
  const next: CourseSpace = { ...current, ...patch, id, updatedAt: nowIso() };
  await bindings().DB.prepare(`UPDATE courses SET
    name = ?, description = ?, status = ?, outline_json = ?, outline_confirmed = ?, updated_at = ?
    WHERE id = ?`)
    .bind(
      next.name,
      next.description,
      next.status,
      next.outline ? JSON.stringify(next.outline) : null,
      next.outlineConfirmed ? 1 : 0,
      Date.parse(next.updatedAt),
      id,
    )
    .run();
  return getCourse(id);
}

export async function deleteCourse(id: string) {
  await ensureCourseSchema();
  const { DB, UPLOADS } = bindings();
  const files = await DB.prepare("SELECT object_key FROM course_materials WHERE course_id = ?")
    .bind(id)
    .all<{ object_key: string }>();
  const keys = files.results.map((row: { object_key: string }) => row.object_key).filter(Boolean);
  if (keys.length) await UPLOADS.delete(keys);
  await DB.batch([
    DB.prepare("DELETE FROM problem_knowledge_links WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM review_route_items WHERE route_id IN (SELECT id FROM review_routes WHERE course_id = ?)").bind(id),
    DB.prepare("DELETE FROM review_routes WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM node_learning_states WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM learning_sessions WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM explanation_artifacts WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM graph_jobs WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM knowledge_edges WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM knowledge_nodes WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM knowledge_graphs WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM material_chunks WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM course_materials WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM projects WHERE course_id = ?").bind(id),
    DB.prepare("DELETE FROM courses WHERE id = ?").bind(id),
  ]);
}

export async function listCourseMaterials(courseId: string) {
  await ensureCourseSchema();
  const result = await bindings().DB.prepare("SELECT * FROM course_materials WHERE course_id = ? ORDER BY created_at DESC")
    .bind(courseId)
    .all();
  return result.results.map((row: Record<string, unknown>) => mapMaterial(row));
}

export async function getCourseMaterial(id: string) {
  await ensureCourseSchema();
  const row = await bindings().DB.prepare("SELECT * FROM course_materials WHERE id = ?").bind(id).first();
  return row ? mapMaterial(row as Record<string, unknown>) : null;
}

export async function saveCourseMaterial(material: CourseMaterial, bytes?: ArrayBuffer) {
  await ensureCourseSchema();
  const { DB, UPLOADS } = bindings();
  if (bytes) await UPLOADS.put(material.objectKey, bytes, { httpMetadata: { contentType: material.mimeType } });
  await DB.prepare(`INSERT INTO course_materials
    (id, course_id, name, category, mime_type, size, object_key, status, parse_progress,
     extracted_text, page_count, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category=excluded.category, status=excluded.status, parse_progress=excluded.parse_progress,
      extracted_text=excluded.extracted_text, page_count=excluded.page_count,
      error=excluded.error, updated_at=excluded.updated_at`)
    .bind(
      material.id,
      material.courseId,
      material.name,
      material.category,
      material.mimeType,
      material.size,
      material.objectKey,
      material.status,
      material.parseProgress,
      material.extractedText || null,
      material.pageCount ?? null,
      material.error || null,
      Date.parse(material.createdAt) || Date.now(),
      Date.parse(material.updatedAt) || Date.now(),
    )
    .run();
  return getCourseMaterial(material.id);
}

export async function deleteCourseMaterial(id: string) {
  await ensureCourseSchema();
  const { DB, UPLOADS } = bindings();
  const material = await getCourseMaterial(id);
  if (!material) return null;
  await UPLOADS.delete(material.objectKey);
  await DB.batch([
    DB.prepare("DELETE FROM material_chunks WHERE material_id = ?").bind(id),
    DB.prepare("DELETE FROM course_materials WHERE id = ?").bind(id),
  ]);
  const remaining = await DB.prepare("SELECT COUNT(*) AS count FROM course_materials WHERE course_id = ?")
    .bind(material.courseId)
    .first<{ count: number }>();
  if (!Number(remaining?.count || 0)) {
    // Removing the final source means there is no evidence left for the
    // outline/graph. Clear every derived artifact instead of retaining a
    // misleading AI-only graph or a stale failed job in the UI.
    await DB.batch([
      DB.prepare("DELETE FROM problem_knowledge_links WHERE course_id = ?").bind(material.courseId),
      DB.prepare("DELETE FROM review_route_items WHERE route_id IN (SELECT id FROM review_routes WHERE course_id = ?)").bind(material.courseId),
      DB.prepare("DELETE FROM review_routes WHERE course_id = ?").bind(material.courseId),
      DB.prepare("DELETE FROM node_learning_states WHERE course_id = ?").bind(material.courseId),
      DB.prepare("DELETE FROM explanation_artifacts WHERE course_id = ?").bind(material.courseId),
      DB.prepare("DELETE FROM graph_jobs WHERE course_id = ?").bind(material.courseId),
      DB.prepare("DELETE FROM knowledge_edges WHERE course_id = ?").bind(material.courseId),
      DB.prepare("DELETE FROM knowledge_nodes WHERE course_id = ?").bind(material.courseId),
      DB.prepare("DELETE FROM knowledge_graphs WHERE course_id = ?").bind(material.courseId),
    ]);
    await updateCourse(material.courseId, {
      status: "CREATED",
      outline: undefined,
      outlineConfirmed: false,
    });
    return material;
  }
  const graph = await getCourseGraph(material.courseId);
  if (graph) {
    const timestamp = new Date().toISOString();
    graph.updatedAt = timestamp;
    graph.version += 1;
    graph.nodes = graph.nodes.map((node) => {
      const sourceRefs = node.sourceRefs.filter((ref) => ref.materialId !== id);
      if (sourceRefs.length === node.sourceRefs.length) return node;
      return {
        ...node,
        sourceRefs,
        confidence: sourceRefs.length ? Math.min(node.confidence, 0.8) : Math.min(node.confidence, 0.55),
        generatedFrom: sourceRefs.length ? node.generatedFrom : "AI_SUPPLEMENT",
        metadata: { ...(node.metadata || {}), needsRevalidation: true, removedMaterialId: id },
      };
    });
    graph.edges = graph.edges.map((edge) => {
      const sourceRefs = edge.sourceRefs.filter((ref) => ref.materialId !== id);
      if (sourceRefs.length === edge.sourceRefs.length) return edge;
      return {
        ...edge,
        sourceRefs,
        inferred: sourceRefs.length === 0 || edge.inferred,
        confidence: sourceRefs.length ? Math.min(edge.confidence, 0.8) : Math.min(edge.confidence, 0.55),
      };
    });
    await saveGraph(graph).catch(() => undefined);
  }
  return material;
}

export async function saveMaterialChunks(materialId: string, courseId: string, chunks: MaterialChunk[]) {
  await ensureCourseSchema();
  const { DB } = bindings();
  const statements = [DB.prepare("DELETE FROM material_chunks WHERE material_id = ?").bind(materialId)];
  for (const chunk of chunks) {
    statements.push(DB.prepare(`INSERT INTO material_chunks
      (id, course_id, material_id, sequence, heading, text, page, slide, source_ref_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        chunk.id,
        courseId,
        materialId,
        chunk.sequence,
        chunk.heading,
        chunk.text,
        chunk.page ?? null,
        chunk.slide ?? null,
        JSON.stringify(chunk.sourceRef),
      ));
  }
  await DB.batch(statements);
}

export async function listMaterialChunks(courseId: string) {
  await ensureCourseSchema();
  const result = await bindings().DB.prepare(
    "SELECT * FROM material_chunks WHERE course_id = ? ORDER BY material_id, sequence",
  ).bind(courseId).all();
  return result.results.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    courseId: String(row.course_id),
    materialId: String(row.material_id),
    sequence: Number(row.sequence),
    heading: String(row.heading || ""),
    text: String(row.text),
    page: row.page == null ? undefined : Number(row.page),
    slide: row.slide == null ? undefined : Number(row.slide),
    sourceRef: parseJson<SourceRef>(row.source_ref_json, {
      materialId: String(row.material_id),
      materialName: "课程资料",
      excerpt: String(row.text).slice(0, 180),
    }),
  } satisfies MaterialChunk));
}

export async function saveGraph(graph: CourseGraph) {
  await ensureCourseSchema();
  const { DB } = bindings();
  graph = normalizeGraphIds(graph);
  const timestamp = Date.parse(graph.updatedAt) || Date.now();
  await DB.batch([
    DB.prepare("DELETE FROM knowledge_edges WHERE course_id = ?").bind(graph.courseId),
    DB.prepare("DELETE FROM knowledge_nodes WHERE course_id = ?").bind(graph.courseId),
    // A course has one current graph. Leaving old graph headers with the same
    // version makes a later GET nondeterministically select an empty graph.
    DB.prepare("DELETE FROM knowledge_graphs WHERE course_id = ? AND id <> ?").bind(graph.courseId, graph.id),
    DB.prepare(`INSERT INTO knowledge_graphs (id, course_id, title, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, version=excluded.version,
      status=excluded.status, updated_at=excluded.updated_at`)
      .bind(graph.id, graph.courseId, graph.title, graph.version, graph.status, Date.parse(graph.createdAt) || timestamp, timestamp),
  ]);
  const nodeStatements = graph.nodes.map((node) => DB.prepare(`INSERT INTO knowledge_nodes
    (id, graph_id, course_id, type, title, short_summary, importance, difficulty, exam_weight,
     confidence, source_refs_json, explanation_artifact_id, learning_status, generated_from,
     chapter_id, formula, conditions_json, aliases_json, order_index, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      graph_id=excluded.graph_id, course_id=excluded.course_id, type=excluded.type,
      title=excluded.title, short_summary=excluded.short_summary, importance=excluded.importance,
      difficulty=excluded.difficulty, exam_weight=excluded.exam_weight, confidence=excluded.confidence,
      source_refs_json=excluded.source_refs_json, explanation_artifact_id=excluded.explanation_artifact_id,
      learning_status=excluded.learning_status, generated_from=excluded.generated_from,
      chapter_id=excluded.chapter_id, formula=excluded.formula, conditions_json=excluded.conditions_json,
      aliases_json=excluded.aliases_json, order_index=excluded.order_index, metadata_json=excluded.metadata_json`)
    .bind(
      node.id,
      graph.id,
      graph.courseId,
      node.type,
      node.title,
      node.shortSummary,
      node.importance,
      node.difficulty,
      node.examWeight,
      node.confidence,
      JSON.stringify(node.sourceRefs),
      node.explanationArtifactId || null,
      node.learningStatus,
      node.generatedFrom,
      node.chapterId || null,
      node.formula || null,
      JSON.stringify(node.conditions || []),
      JSON.stringify(node.aliases || []),
      node.order,
      JSON.stringify(node.metadata || {}),
    ));
  const edgeStatements = graph.edges.map((edge) => DB.prepare(`INSERT INTO knowledge_edges
    (id, graph_id, course_id, source_node_id, target_node_id, type, label, confidence, inferred, source_refs_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      graph_id=excluded.graph_id, course_id=excluded.course_id,
      source_node_id=excluded.source_node_id, target_node_id=excluded.target_node_id,
      type=excluded.type, label=excluded.label, confidence=excluded.confidence,
      inferred=excluded.inferred, source_refs_json=excluded.source_refs_json`)
    .bind(
      edge.id,
      graph.id,
      graph.courseId,
      edge.sourceNodeId,
      edge.targetNodeId,
      edge.type,
      edge.label,
      edge.confidence,
      edge.inferred ? 1 : 0,
      JSON.stringify(edge.sourceRefs),
    ));
  const batches = [...nodeStatements, ...edgeStatements];
  for (let index = 0; index < batches.length; index += 75) {
    await DB.batch(batches.slice(index, index + 75));
  }
  return getCourseGraph(graph.courseId);
}

export async function getCourseGraph(courseId: string): Promise<CourseGraph | null> {
  await ensureCourseSchema();
  const { DB } = bindings();
  const graphRow = await DB.prepare("SELECT * FROM knowledge_graphs WHERE course_id = ? ORDER BY version DESC LIMIT 1")
    .bind(courseId)
    .first();
  if (!graphRow) return null;
  const nodes = await DB.prepare("SELECT * FROM knowledge_nodes WHERE graph_id = ? ORDER BY order_index, title")
    .bind(String(graphRow.id))
    .all();
  const edges = await DB.prepare("SELECT * FROM knowledge_edges WHERE graph_id = ?")
    .bind(String(graphRow.id))
    .all();
  return {
    id: String(graphRow.id),
    courseId,
    title: String(graphRow.title),
    version: Number(graphRow.version),
    status: String(graphRow.status) as CourseGraph["status"],
    nodes: nodes.results.map((row: Record<string, unknown>) => mapNode(row)),
    edges: edges.results.map((row: Record<string, unknown>) => mapEdge(row)),
    createdAt: nowIso(Number(graphRow.created_at)),
    updatedAt: nowIso(Number(graphRow.updated_at)),
  };
}

export async function getKnowledgeNode(id: string) {
  await ensureCourseSchema();
  const row = await bindings().DB.prepare("SELECT * FROM knowledge_nodes WHERE id = ?").bind(id).first();
  return row ? mapNode(row as Record<string, unknown>) : null;
}

export async function updateNodeLearningStatus(id: string, status: LearningStatus, evidence: string[] = []) {
  await ensureCourseSchema();
  const node = await getKnowledgeNode(id);
  if (!node) return null;
  const stateId = `state_${node.courseId}_${id}`;
  await bindings().DB.batch([
    bindings().DB.prepare("UPDATE knowledge_nodes SET learning_status = ? WHERE id = ?").bind(status, id),
    bindings().DB.prepare(`INSERT INTO node_learning_states
      (id, course_id, node_id, status, confidence, evidence_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(course_id, node_id) DO UPDATE SET status=excluded.status,
      confidence=excluded.confidence, evidence_json=excluded.evidence_json, updated_at=excluded.updated_at`)
      .bind(stateId, node.courseId, id, status, evidence.length ? 0.85 : 0.7, JSON.stringify(evidence), Date.now()),
  ]);
  return getKnowledgeNode(id);
}

export async function saveExplanationArtifact(artifact: ExplanationArtifact) {
  await ensureCourseSchema();
  const timestamp = Date.parse(artifact.updatedAt) || Date.now();
  await bindings().DB.batch([
    bindings().DB.prepare(`INSERT INTO explanation_artifacts
      (id, course_id, node_id, title, sections_json, source_refs_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET id=excluded.id, title=excluded.title,
      sections_json=excluded.sections_json, source_refs_json=excluded.source_refs_json,
      updated_at=excluded.updated_at`)
      .bind(
        artifact.id,
        artifact.courseId,
        artifact.nodeId,
        artifact.title,
        JSON.stringify(artifact.sections),
        JSON.stringify(artifact.sourceRefs),
        Date.parse(artifact.createdAt) || timestamp,
        timestamp,
      ),
    bindings().DB.prepare("UPDATE knowledge_nodes SET explanation_artifact_id = ? WHERE id = ?")
      .bind(artifact.id, artifact.nodeId),
  ]);
  return artifact;
}

export async function getExplanationArtifact(nodeId: string) {
  await ensureCourseSchema();
  const row = await bindings().DB.prepare("SELECT * FROM explanation_artifacts WHERE node_id = ?")
    .bind(nodeId)
    .first();
  if (!row) return null;
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    nodeId: String(row.node_id),
    title: String(row.title),
    sections: parseJson<ExplanationArtifact["sections"]>(row.sections_json, []),
    sourceRefs: parseJson<SourceRef[]>(row.source_refs_json, []),
    createdAt: nowIso(Number(row.created_at)),
    updatedAt: nowIso(Number(row.updated_at)),
  } satisfies ExplanationArtifact;
}

export async function createGraphJob(job: GraphBuildJob) {
  await ensureCourseSchema();
  await bindings().DB.prepare(`INSERT INTO graph_jobs
    (id, course_id, status, stage, progress, error, trace_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      job.id,
      job.courseId,
      job.status,
      job.stage,
      job.progress,
      job.error || null,
      JSON.stringify(job.trace),
      Date.parse(job.createdAt) || Date.now(),
      Date.parse(job.updatedAt) || Date.now(),
    )
    .run();
  return getGraphJob(job.id);
}

export async function updateGraphJob(id: string, patch: Partial<GraphBuildJob>) {
  await ensureCourseSchema();
  const current = await getGraphJob(id);
  if (!current) return null;
  const next = { ...current, ...patch, id, updatedAt: nowIso() };
  await bindings().DB.prepare(`UPDATE graph_jobs SET
    status=?, stage=?, progress=?, error=?, trace_json=?, updated_at=? WHERE id=?`)
    .bind(
      next.status,
      next.stage,
      next.progress,
      next.error || null,
      JSON.stringify(next.trace),
      Date.parse(next.updatedAt),
      id,
    )
    .run();
  return getGraphJob(id);
}

export async function getGraphJob(id: string) {
  await ensureCourseSchema();
  const row = await bindings().DB.prepare("SELECT * FROM graph_jobs WHERE id = ?").bind(id).first();
  return row ? mapJob(row as Record<string, unknown>) : null;
}

export async function getLatestGraphJob(courseId: string) {
  await ensureCourseSchema();
  const row = await bindings().DB.prepare("SELECT * FROM graph_jobs WHERE course_id = ? ORDER BY updated_at DESC LIMIT 1")
    .bind(courseId)
    .first();
  return row ? mapJob(row as Record<string, unknown>) : null;
}

export async function saveReviewRoute(route: ReviewRoute) {
  await ensureCourseSchema();
  const { DB } = bindings();
  const timestamp = Date.parse(route.updatedAt) || Date.now();
  const previous = await DB.prepare("SELECT id FROM review_routes WHERE course_id = ?").bind(route.courseId).all<{ id: string }>();
  const statements = previous.results.map((row: { id: string }) => DB.prepare("DELETE FROM review_route_items WHERE route_id = ?").bind(row.id));
  statements.push(DB.prepare("DELETE FROM review_routes WHERE course_id = ?").bind(route.courseId));
  statements.push(DB.prepare(`INSERT INTO review_routes
    (id, course_id, exam_date, daily_minutes, scope, target_score, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      route.id,
      route.courseId,
      route.examDate,
      route.dailyMinutes,
      route.scope,
      route.targetScore ?? null,
      route.summary,
      Date.parse(route.createdAt) || timestamp,
      timestamp,
    ));
  for (const item of route.items) {
    statements.push(DB.prepare(`INSERT INTO review_route_items
      (id, route_id, day_index, date, title, node_ids_json, estimated_minutes, rationale, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        item.id,
        route.id,
        item.dayIndex,
        item.date,
        item.title,
        JSON.stringify(item.nodeIds),
        item.estimatedMinutes,
        item.rationale,
        item.status,
      ));
  }
  await DB.batch(statements);
  return getReviewRoute(route.courseId);
}

export async function getReviewRoute(courseId: string): Promise<ReviewRoute | null> {
  await ensureCourseSchema();
  const { DB } = bindings();
  const route = await DB.prepare("SELECT * FROM review_routes WHERE course_id = ? ORDER BY updated_at DESC LIMIT 1")
    .bind(courseId)
    .first();
  if (!route) return null;
  const itemRows = await DB.prepare("SELECT * FROM review_route_items WHERE route_id = ? ORDER BY day_index")
    .bind(String(route.id))
    .all();
  const items: ReviewRouteItem[] = itemRows.results.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    routeId: String(row.route_id),
    dayIndex: Number(row.day_index),
    date: String(row.date),
    title: String(row.title),
    nodeIds: parseJson<string[]>(row.node_ids_json, []),
    estimatedMinutes: Number(row.estimated_minutes),
    rationale: String(row.rationale),
    status: String(row.status) as ReviewRouteItem["status"],
  }));
  return {
    id: String(route.id),
    courseId,
    examDate: String(route.exam_date),
    dailyMinutes: Number(route.daily_minutes),
    scope: String(route.scope),
    targetScore: route.target_score == null ? undefined : Number(route.target_score),
    summary: String(route.summary),
    items,
    createdAt: nowIso(Number(route.created_at)),
    updatedAt: nowIso(Number(route.updated_at)),
  };
}

export async function updateReviewRouteItem(id: string, status: ReviewRouteItem["status"]) {
  await ensureCourseSchema();
  await bindings().DB.prepare("UPDATE review_route_items SET status = ? WHERE id = ?").bind(status, id).run();
}

export async function saveProblemKnowledgeLinks(
  courseId: string,
  projectId: string,
  problemId: string,
  links: ProblemKnowledgeLink[],
) {
  await ensureCourseSchema();
  const { DB } = bindings();
  const statements = [
    DB.prepare("DELETE FROM problem_knowledge_links WHERE project_id = ? AND problem_id = ?").bind(projectId, problemId),
    ...links.map((link) => DB.prepare(`INSERT INTO problem_knowledge_links
      (id, course_id, project_id, problem_id, node_id, relevance, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(link.id, courseId, projectId, problemId, link.nodeId, link.relevance, link.evidence)),
  ];
  await DB.batch(statements);
  return links;
}

export async function listProblemKnowledgeLinks(projectId: string, problemId: string) {
  await ensureCourseSchema();
  const rows = await bindings().DB.prepare(
    "SELECT * FROM problem_knowledge_links WHERE project_id = ? AND problem_id = ? ORDER BY relevance DESC",
  ).bind(projectId, problemId).all();
  return rows.results.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    courseId: String(row.course_id),
    projectId: String(row.project_id),
    problemId: String(row.problem_id),
    nodeId: String(row.node_id),
    relevance: Number(row.relevance),
    evidence: String(row.evidence),
  } satisfies ProblemKnowledgeLink));
}

export async function listRelatedProblems(nodeId: string) {
  await ensureCourseSchema();
  const rows = await bindings().DB.prepare(`SELECT
      l.id AS link_id, l.course_id, l.project_id, l.problem_id, l.relevance, l.evidence,
      p.name AS project_name, p.data_json
    FROM problem_knowledge_links l
    JOIN projects p ON p.id = l.project_id
    WHERE l.node_id = ?
    ORDER BY l.relevance DESC`)
    .bind(nodeId)
    .all();
  return rows.results.map((row: Record<string, unknown>) => {
    const data = parseJson<{ problems?: Array<{ id: string; index: number; title: string; rawText: string }> }>(row.data_json, {});
    const problem = data.problems?.find((item) => item.id === String(row.problem_id));
    return {
      linkId: String(row.link_id),
      courseId: String(row.course_id),
      projectId: String(row.project_id),
      projectName: String(row.project_name),
      problemId: String(row.problem_id),
      problem,
      relevance: Number(row.relevance),
      evidence: String(row.evidence),
    };
  });
}

export async function listCourseAssignments(courseId: string): Promise<CourseAssignmentSummary[]> {
  await ensureCourseSchema();
  const rows = await bindings().DB.prepare(
    "SELECT id, course_id, name, project_type, data_json, updated_at FROM projects WHERE course_id = ? ORDER BY updated_at DESC",
  ).bind(courseId).all();
  return rows.results.map((row: Record<string, unknown>) => {
    const data = parseJson<{ problems?: Array<{ status?: string }> }>(row.data_json, {});
    const problems = data.problems || [];
    return {
      id: String(row.id),
      courseId: row.course_id ? String(row.course_id) : null,
      name: String(row.name),
      projectType: String(row.project_type || "ASSIGNMENT"),
      problemCount: problems.length,
      completedCount: problems.filter((problem) => problem.status === "COMPLETED").length,
      updatedAt: nowIso(Number(row.updated_at)),
    };
  });
}

export async function listAssignmentCandidates(): Promise<CourseAssignmentSummary[]> {
  await ensureCourseSchema();
  const rows = await bindings().DB.prepare(
    "SELECT id, course_id, name, project_type, data_json, updated_at FROM projects ORDER BY updated_at DESC",
  ).all();
  return rows.results.map((row: Record<string, unknown>) => {
    const data = parseJson<{ problems?: Array<{ status?: string }> }>(row.data_json, {});
    const problems = data.problems || [];
    return {
      id: String(row.id),
      courseId: row.course_id ? String(row.course_id) : null,
      name: String(row.name),
      projectType: String(row.project_type || "ASSIGNMENT"),
      problemCount: problems.length,
      completedCount: problems.filter((problem) => problem.status === "COMPLETED").length,
      updatedAt: nowIso(Number(row.updated_at)),
    };
  });
}

export async function attachProjectToCourse(projectId: string, courseId: string) {
  await ensureCourseSchema();
  const [course, project] = await Promise.all([
    getCourse(courseId),
    bindings().DB.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first<{ id: string }>(),
  ]);
  if (!course || !project) return false;
  await bindings().DB.prepare(
    "UPDATE projects SET course_id = ?, project_type = 'ASSIGNMENT', updated_at = ? WHERE id = ?",
  ).bind(courseId, Date.now(), projectId).run();
  return true;
}

export async function getCourseWorkspace(courseId: string): Promise<CourseWorkspacePayload | null> {
  const course = await getCourse(courseId);
  if (!course) return null;
  const [materials, projects, graph, latestJob, reviewRoute] = await Promise.all([
    listCourseMaterials(courseId),
    listCourseAssignments(courseId),
    getCourseGraph(courseId),
    getLatestGraphJob(courseId),
    getReviewRoute(courseId),
  ]);
  return { course, materials, projects, graph, latestJob, reviewRoute };
}

export async function getProjectCourseId(projectId: string) {
  await ensureCourseSchema();
  const row = await bindings().DB.prepare("SELECT course_id FROM projects WHERE id = ?").bind(projectId).first<{ course_id: string }>();
  return row?.course_id || null;
}

export async function getReviewInputs(courseId: string): Promise<{
  graph: CourseGraph | null;
  input?: ReviewRouteInput;
}> {
  return { graph: await getCourseGraph(courseId) };
}
