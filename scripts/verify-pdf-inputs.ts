import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const paths = process.argv.slice(2);
if (!paths.length) {
  console.error("usage: npm run test:pdf -- file1.pdf [file2.pdf ...]");
  process.exit(2);
}

for (const path of paths) {
  const bytes = await readFile(path);
  const form = new FormData();
  form.append("file", new File([bytes], basename(path), { type: "application/pdf" }));
  const response = await fetch(`${baseUrl}/api/parse-pdf`, { method: "POST", body: form });
  const result = await response.json() as {
    text?: string;
    problems?: Array<{ index?: number; title?: string; rawText?: string }>;
    error?: string;
  };
  if (!response.ok) throw new Error(result.error || `PDF model request failed: ${response.status}`);
  console.log(JSON.stringify({
    file: basename(path),
    modelRecognizedCharacters: result.text?.length || 0,
    problems: result.problems?.length || 0,
    problemSummaries: (result.problems || []).map((problem) => ({
      index: problem.index,
      title: problem.title,
      characters: problem.rawText?.length || 0,
    })),
    provider: "qwen",
  }));
}
