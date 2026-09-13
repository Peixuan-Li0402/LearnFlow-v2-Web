export type ProjectStatus =
  | "CREATED"
  | "INGESTING"
  | "PARSING"
  | "AWAITING_CONFIRMATION"
  | "READY"
  | "ACTIVE"
  | "COMPLETED"
  | "ERROR";

export type ProblemStatus =
  | "UNPARSED"
  | "MISSING_INFO"
  | "NOT_STARTED"
  | "PREPARING"
  | "TEACHING"
  | "SKIPPED"
  | "COMPLETED"
  | "NEEDS_REVIEW";

export type TeachingStage =
  | "READING_PROBLEM"
  | "IDENTIFYING_GOAL"
  | "CHECKING_PREREQUISITES"
  | "SELECTING_METHOD"
  | "EXPLAINING_METHOD"
  | "DERIVING"
  | "VERIFYING"
  | "SUMMARIZING"
  | "DONE";

export type AnswerBlockStatus =
  | "PENDING"
  | "TEACHING"
  | "GENERATED"
  | "VERIFIED"
  | "COMMITTED"
  | "SKIPPED_TEACHING"
  | "INVALIDATED"
  | "ROLLED_BACK";

export interface Material {
  id: string;
  name: string;
  category: "ASSIGNMENT" | "COURSE_RULE" | "COURSE_EXAMPLE" | "REFERENCE";
  mimeType: string;
  size: number;
  status: "UPLOADING" | "PARSING" | "READY" | "NEEDS_OCR" | "ERROR";
  extractedText?: string;
  learningDigest?: string;
  understandingMode?: "VISUAL_DOCUMENT" | "TEXT_INDEX";
  visualReady?: boolean;
  parseProgress?: number;
  parseError?: string;
  objectKey?: string;
}

export interface MissingInformation {
  type: "HARD" | "SOFT";
  description: string;
  suggestion: string;
}

export interface Problem {
  id: string;
  index: number;
  title: string;
  rawText: string;
  status: ProblemStatus;
  missingInformation: MissingInformation[];
  sourceMaterialIds: string[];
}

export interface AnswerBlock {
  id: string;
  problemId: string;
  type: "READING" | "METHOD" | "DERIVATION" | "RESULT" | "CHECK";
  title: string;
  plainText: string;
  latex: string;
  status: AnswerBlockStatus;
  order: number;
  version: number;
  checkpointId?: string;
  dependencies?: string[];
}

export interface ChatMessage {
  id: string;
  role: "assistant" | "user" | "system";
  content: string;
  createdAt: string;
  stage?: TeachingStage;
  archivedVersion?: number;
}

export interface KnowledgeCheckpoint {
  id: string;
  name: string;
  question: string;
  status: "PENDING" | "ANSWERED";
  answer?: "KNOWN" | "UNCERTAIN" | "UNKNOWN" | "OTHER" | "SKIPPED";
}

export interface SolutionBlueprint {
  qualityVersion?: "verified-v2";
  difficulty: "BASIC" | "INTERMEDIATE" | "ADVANCED";
  difficultyReason: string;
  selectedMethod: string;
  problemSummary?: string;
  givens?: string[];
  methodReason?: string;
  finalConclusion: string;
  materialUsage?: Array<{
    name: string;
    applied: boolean;
    details: string[];
    evidence: string[];
    sourceMode?: "VISUAL_ORIGINAL" | "VISUAL_INDEX" | "TEXT_INDEX" | "COURSE_GRAPH";
  }>;
  prerequisites: Array<{
    id: string;
    name: string;
    question: string;
  }>;
  sections: Array<{
    id: string;
    title: string;
    goal: string;
    explanation?: string;
    intuition?: string;
    keyCalculations: string[];
    commonPitfalls: string[];
  }>;
  verification: string;
}

export interface MemoryItem {
  id: string;
  type: "KNOWLEDGE_STATE" | "COURSE_RULE" | "PREFERENCE" | "CONTROL_SIGNAL";
  title: string;
  value: string;
  confidence: number;
  evidence: string[];
  updatedAt: string;
}

export interface Checkpoint {
  id: string;
  title: string;
  teachingStage: TeachingStage;
  answerBlockIds: string[];
  method: string;
  createdAt: string;
  problemId?: string;
  sectionId?: string;
  sectionIndex?: number;
}

export interface RollbackPreview {
  targetCheckpointId: string;
  title: string;
  reason: string;
  preservedBlockIds: string[];
  invalidatedBlockIds: string[];
  newMethod: string;
  resumeStage: TeachingStage;
}

export interface ProjectState {
  runtimeVersion?: "model-v1";
  conversationVersion?: "per-problem-v1";
  id: string;
  courseId?: string | null;
  name: string;
  status: ProjectStatus;
  currentProblemId: string | null;
  teachingStage: TeachingStage;
  selectedMethod: string;
  progress: number;
  responseMode?: "fast" | "deep";
  problems: Problem[];
  materials: Material[];
  answerBlocks: AnswerBlock[];
  teachingMessages: ChatMessage[];
  sideMessages: ChatMessage[];
  knowledgeCheckpoints: KnowledgeCheckpoint[];
  problemTeachingMessages?: Record<string, ChatMessage[]>;
  problemSideMessages?: Record<string, ChatMessage[]>;
  problemKnowledgeCheckpoints?: Record<string, KnowledgeCheckpoint[]>;
  problemTeachingStages?: Record<string, TeachingStage>;
  problemSelectedMethods?: Record<string, string>;
  problemProgress?: Record<string, number>;
  problemSolutionBlueprints?: Record<string, SolutionBlueprint>;
  memories: MemoryItem[];
  checkpoints: Checkpoint[];
  rollbackPreview: RollbackPreview | null;
  answerVersion: number;
  updatedAt: string;
}

export interface AgentRequest {
  action: "parse_assignment" | "start_problem" | "chat" | "side_chat" | "analyze_rollback";
  problem?: Problem;
  assignmentText?: string;
  message?: string;
  project?: ProjectState;
  courseContext?: {
    courseId: string;
    courseName: string;
    courseDescription: string;
    references: Array<{
      name: string;
      category: "COURSE_MATERIAL";
      text: string;
      materialId?: string;
      page?: number;
      slide?: number;
    }>;
    knowledgeNodes: Array<{
      id: string;
      title: string;
      type: string;
      shortSummary: string;
      conditions?: string[];
    }>;
  };
  /** Server-only visual evidence loaded from R2. Never persisted in ProjectState. */
  visualReferences?: Array<{
    materialId: string;
    name: string;
    mimeType: string;
    dataUrl: string;
    scope: "ASSIGNMENT_ONLY" | "COURSE_PROJECT";
  }>;
  responseMode?: "fast" | "deep";
  interaction?: {
    kind: "FREEFORM" | "KNOWLEDGE_RESPONSE" | "KNOWLEDGE_SURVEY" | "SKIP_CHECKPOINT" | "SKIP_SECTION" | "CONTINUE" | "DIRECT_ANSWER";
    checkpointId?: string;
    answer?: "KNOWN" | "UNCERTAIN" | "UNKNOWN" | "OTHER" | "SKIPPED";
    answers?: Array<{
      checkpointId: string;
      answer: "KNOWN" | "UNCERTAIN" | "UNKNOWN" | "OTHER" | "SKIPPED";
      note?: string;
    }>;
  };
}

export interface AgentResponse {
  problems?: Problem[];
  assistantMessage?: string;
  sideAnswer?: string;
  stage?: TeachingStage;
  progress?: number;
  selectedMethod?: string;
  answerBlocks?: AnswerBlock[];
  knowledgeCheckpoint?: KnowledgeCheckpoint | null;
  knowledgeCheckpoints?: KnowledgeCheckpoint[];
  solutionBlueprint?: SolutionBlueprint;
  memory?: MemoryItem | null;
  checkpoint?: Checkpoint | null;
  rollbackPreview?: RollbackPreview;
  provider: "model";
}

export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
