export type CourseStatus =
  | "CREATED"
  | "INGESTING"
  | "OUTLINE_READY"
  | "OUTLINE_CONFIRMED"
  | "GRAPH_BUILDING"
  | "READY"
  | "ERROR";

export type CourseMaterialCategory =
  | "COURSEWARE"
  | "TEXTBOOK"
  | "PAST_EXAM"
  | "REFERENCE_ANSWER"
  | "NOTES"
  | "OTHER";

export type CourseMaterialStatus = "UPLOADING" | "UPLOADED" | "PARSING" | "READY" | "ERROR";

export type KnowledgeNodeType =
  | "COURSE"
  | "CHAPTER"
  | "CONCEPT"
  | "DEFINITION"
  | "THEOREM"
  | "FORMULA"
  | "METHOD"
  | "QUESTION_TYPE"
  | "EXAMPLE"
  | "WARNING";

export type KnowledgeEdgeType =
  | "CONTAINS"
  | "PREREQUISITE_OF"
  | "DERIVES"
  | "USES"
  | "EQUIVALENT_TO"
  | "SIMILAR_TO"
  | "CONFUSED_WITH"
  | "APPLIES_TO"
  | "EVIDENCED_BY"
  | "RELATED_PROBLEM";

export type LearningStatus = "UNSEEN" | "LEARNING" | "UNDERSTOOD" | "REVIEW";
export type GraphJobStatus = "QUEUED" | "RUNNING" | "AWAITING_OUTLINE_CONFIRMATION" | "COMPLETED" | "ERROR";

export interface SourceRef {
  id?: string;
  materialId: string;
  materialName: string;
  page?: number;
  slide?: number;
  section?: string;
  excerpt: string;
  locator?: string;
}

export interface CourseSpace {
  id: string;
  name: string;
  description: string;
  status: CourseStatus;
  outline: CourseOutline | null;
  outlineConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CourseMaterial {
  id: string;
  courseId: string;
  name: string;
  category: CourseMaterialCategory;
  mimeType: string;
  size: number;
  objectKey: string;
  status: CourseMaterialStatus;
  parseProgress: number;
  error?: string;
  extractedText?: string;
  pageCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialChunk {
  id: string;
  courseId: string;
  materialId: string;
  sequence: number;
  heading: string;
  text: string;
  page?: number;
  slide?: number;
  sourceRef: SourceRef;
}

export interface CourseOutlineSection {
  id: string;
  title: string;
  summary: string;
  order: number;
  children: CourseOutlineSection[];
  sourceRefs: SourceRef[];
}

export interface CourseOutline {
  title: string;
  summary: string;
  examScopeNotes: string[];
  conflicts: string[];
  sections: CourseOutlineSection[];
}

export interface ExplanationSection {
  key:
    | "summary"
    | "problem"
    | "example"
    | "prerequisites"
    | "intuition"
    | "definition"
    | "symbols"
    | "formula"
    | "derivation"
    | "visual"
    | "connections"
    | "confusions"
    | "course_examples"
    | "exam"
    | "answer"
    | "sources";
  title: string;
  content: string;
}

export interface ExplanationArtifact {
  id: string;
  courseId: string;
  nodeId: string;
  title: string;
  sections: ExplanationSection[];
  sourceRefs: SourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeNode {
  id: string;
  graphId: string;
  courseId: string;
  type: KnowledgeNodeType;
  title: string;
  shortSummary: string;
  importance: "CORE" | "IMPORTANT" | "SUPPORTING" | "OPTIONAL";
  difficulty: "FOUNDATION" | "INTERMEDIATE" | "ADVANCED";
  examWeight: number;
  confidence: number;
  sourceRefs: SourceRef[];
  explanationArtifactId?: string;
  learningStatus: LearningStatus;
  generatedFrom: "COURSE_MATERIAL" | "AI_SUPPLEMENT";
  chapterId?: string;
  formula?: string;
  conditions?: string[];
  aliases?: string[];
  order: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeEdge {
  id: string;
  graphId: string;
  courseId: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: KnowledgeEdgeType;
  label: string;
  confidence: number;
  inferred: boolean;
  sourceRefs: SourceRef[];
}

export interface CourseGraph {
  id: string;
  courseId: string;
  title: string;
  version: number;
  status: "BUILDING" | "READY" | "ERROR";
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphTraceItem {
  id: string;
  stage: string;
  label: string;
  detail: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "ERROR";
  startedAt?: string;
  completedAt?: string;
}

export interface GraphBuildJob {
  id: string;
  courseId: string;
  status: GraphJobStatus;
  stage: string;
  progress: number;
  error?: string;
  trace: GraphTraceItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRouteInput {
  examDate: string;
  dailyMinutes: number;
  scope: string;
  targetScore?: number;
  reviewedNodeIds: string[];
  teacherEmphasis?: string;
}

export interface ReviewRouteItem {
  id: string;
  routeId: string;
  dayIndex: number;
  date: string;
  title: string;
  nodeIds: string[];
  estimatedMinutes: number;
  rationale: string;
  status: "PENDING" | "DONE" | "REVIEW";
}

export interface ReviewRoute {
  id: string;
  courseId: string;
  examDate: string;
  dailyMinutes: number;
  scope: string;
  targetScore?: number;
  summary: string;
  items: ReviewRouteItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ProblemKnowledgeLink {
  id: string;
  courseId: string;
  projectId: string;
  problemId: string;
  nodeId: string;
  relevance: number;
  evidence: string;
}

export interface CourseAssignmentSummary {
  id: string;
  courseId: string | null;
  name: string;
  projectType: string;
  problemCount: number;
  completedCount: number;
  updatedAt: string;
}

export interface CourseWorkspacePayload {
  course: CourseSpace;
  materials: CourseMaterial[];
  projects: CourseAssignmentSummary[];
  graph: CourseGraph | null;
  latestJob: GraphBuildJob | null;
  reviewRoute: ReviewRoute | null;
}

export const courseUid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
