import type { CourseMaterialCategory } from "./course-types";

export const COURSE_MATERIAL_PART_SIZE = 5 * 1024 * 1024;
export const COURSE_MATERIAL_MAX_SIZE = 200 * 1024 * 1024;

export const allowedCourseMaterialCategories = new Set<CourseMaterialCategory>([
  "COURSEWARE",
  "TEXTBOOK",
  "PAST_EXAM",
  "REFERENCE_ANSWER",
  "NOTES",
  "OTHER",
]);

export function isAcceptedCourseMaterial(name: string) {
  return /\.(pdf|ppt|pptx|doc|docx|png|jpe?g|webp|bmp|md|markdown|txt)$/i.test(name.toLowerCase());
}

export function safeCourseMaterialName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}
