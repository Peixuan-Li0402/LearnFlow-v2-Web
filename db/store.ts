import { env } from "cloudflare:workers";
import type { ProjectState } from "@/lib/agent-types";
import { normalizeProjectState } from "@/lib/normalize-agent";

type Bindings = { DB: D1Database; UPLOADS: R2Bucket };

export function bindings() {
  return env as unknown as Bindings;
}

export async function ensureSchema() {
  const { DB } = bindings();
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    DB.prepare("CREATE INDEX IF NOT EXISTS materials_project_idx ON materials(project_id)"),
  ]);
}

export async function listProjects() {
  await ensureSchema();
  const columns = await bindings().DB.prepare("PRAGMA table_info(projects)").all<{ name: string }>();
  const hasCourseId = columns.results.some((column) => column.name === "course_id");
  const result = await bindings().DB.prepare(
    `SELECT id, name, status, data_json, created_at, updated_at${hasCourseId ? ", course_id" : ""}
     FROM projects
     WHERE id NOT LIKE 'demo_%' AND id NOT LIKE 'pdf_e2e_%'
     ORDER BY updated_at DESC`,
  ).all();
  return result.results
    .map((row) => ({
      ...normalizeProjectState(JSON.parse(String(row.data_json)) as ProjectState),
      courseId: hasCourseId && row.course_id ? String(row.course_id) : null,
    }))
    .filter((project) => project.runtimeVersion === "model-v1");
}

export async function getProject(id: string) {
  await ensureSchema();
  const columns = await bindings().DB.prepare("PRAGMA table_info(projects)").all<{ name: string }>();
  const hasCourseId = columns.results.some((column) => column.name === "course_id");
  const row = await bindings().DB.prepare(`SELECT data_json${hasCourseId ? ", course_id" : ""} FROM projects WHERE id = ?`)
    .bind(id)
    .first<{ data_json: string; course_id?: string | null }>();
  return row ? {
    ...normalizeProjectState(JSON.parse(row.data_json) as ProjectState),
    courseId: hasCourseId && row.course_id ? row.course_id : null,
  } : null;
}

export async function saveProject(project: ProjectState) {
  await ensureSchema();
  project = normalizeProjectState(project);
  const timestamp = Date.now();
  await bindings().DB.prepare(
    `INSERT INTO projects (id, name, status, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       status=excluded.status,
       data_json=excluded.data_json,
       updated_at=excluded.updated_at`,
  )
    .bind(project.id, project.name, project.status, JSON.stringify(project), timestamp, timestamp)
    .run();
  return project;
}

export async function deleteProject(id: string) {
  await ensureSchema();
  const { DB, UPLOADS } = bindings();
  const materialRows = await DB.prepare("SELECT object_key FROM materials WHERE project_id = ?")
    .bind(id)
    .all<{ object_key: string }>();
  const objectKeys = materialRows.results.map((row) => row.object_key).filter(Boolean);
  if (objectKeys.length) await UPLOADS.delete(objectKeys);
  await DB.batch([
    DB.prepare("DELETE FROM materials WHERE project_id = ?").bind(id),
    DB.prepare("DELETE FROM projects WHERE id = ?").bind(id),
  ]);
}
