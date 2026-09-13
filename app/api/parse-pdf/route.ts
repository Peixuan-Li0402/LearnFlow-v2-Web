import { NextResponse } from "next/server";
import { parsePdfWithModel } from "@/lib/model-provider";

const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf")) {
      return NextResponse.json({ error: "请选择 PDF 文件。" }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: "当前网页版本支持不超过 20MB 的 PDF。" }, { status: 413 });
    }
    const parsed = await parsePdfWithModel(new Uint8Array(await file.arrayBuffer()), file.name, request.signal);
    return NextResponse.json(parsed);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "PDF 识别失败，请稍后重试。" },
      { status: 503 },
    );
  }
}
