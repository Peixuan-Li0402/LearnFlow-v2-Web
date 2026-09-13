import { NextResponse } from "next/server";
import { extractVisualPageImagesWithModel } from "@/lib/model-provider";

// Keep each browser -> Worker request comfortably below hosting body limits.
// A complete PDF is split into batches by the client, so this is deliberately
// much smaller than the document-level 80-page limit.
const MAX_PAGES = 6;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const documentName = String(form.get("documentName") || "课程资料");
    const startPage = Math.max(1, Number.parseInt(String(form.get("startPage") || "1"), 10) || 1);
    const files = form.getAll("pages").filter((item): item is File => item instanceof File);
    if (!files.length) return NextResponse.json({ error: "没有收到 PDF 页面图片。" }, { status: 400 });
    if (files.length > MAX_PAGES) {
      return NextResponse.json({ error: `单次最多处理 ${MAX_PAGES} 页。` }, { status: 413 });
    }
    const pages = await Promise.all(files.map(async (file, index) => {
      if (!file.type.startsWith("image/") || file.size > MAX_PAGE_BYTES) {
        throw new Error(`第 ${index + 1} 页不是有效图片，或单页超过 5MB。`);
      }
      return {
        page: startPage + index,
        name: file.name || `page-${index + 1}.jpg`,
        mimeType: file.type || "image/jpeg",
        bytes: new Uint8Array(await file.arrayBuffer()),
      };
    }));
    const text = await extractVisualPageImagesWithModel(pages, documentName, request.signal);
    return NextResponse.json({ text, pageCount: pages.length });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "视觉页面解析失败。" },
      { status: 503 },
    );
  }
}
