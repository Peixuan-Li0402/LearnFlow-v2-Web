import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type ProgressCallback = (completed: number, total: number, phase?: "render" | "recognize") => void;

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("PDF 页面转换为图片失败。")),
      "image/jpeg",
      0.86,
    );
  });
}

export async function renderPdfPagesForVision(file: File, signal?: AbortSignal, onProgress?: ProgressCallback) {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  signal?.addEventListener("abort", () => loadingTask.destroy(), { once: true });
  const document = await loadingTask.promise;
  if (document.numPages > 80) {
    throw new Error(`这份 PDF 有 ${document.numPages} 页。单次最多处理 80 页，请按章节拆分后上传。`);
  }
  const pages: File[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (signal?.aborted) throw signal.reason || new DOMException("请求已取消", "AbortError");
      const page = await document.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(1.2, Math.min(2.2, 1500 / Math.max(1, base.width)));
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("浏览器无法创建 PDF 页面画布。");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      const blob = await canvasBlob(canvas);
      pages.push(new File([blob], `page-${String(pageNumber).padStart(4, "0")}.jpg`, { type: "image/jpeg" }));
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
      onProgress?.(pageNumber, document.numPages, "render");
    }
  } finally {
    await document.destroy();
  }
  return pages;
}

export async function extractVisualDocumentText(file: File, signal?: AbortSignal, onProgress?: ProgressCallback) {
  const pages = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    ? await renderPdfPagesForVision(file, signal, onProgress)
    : file.type.startsWith("image/")
      ? [file]
      : [];
  if (!pages.length) throw new Error("这类资料暂时不能在浏览器中转换成视觉页面。");
  const batches = Array.from(
    { length: Math.ceil(pages.length / 6) },
    (_, index) => pages.slice(index * 6, index * 6 + 6),
  );
  const results = new Array<string>(batches.length);
  let cursor = 0;
  let recognizedPages = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      if (signal?.aborted) throw signal.reason || new DOMException("请求已取消", "AbortError");
      const batchIndex = cursor;
      cursor += 1;
      const batch = batches[batchIndex];
      const form = new FormData();
      form.append("documentName", file.name);
      form.append("startPage", String(batchIndex * 6 + 1));
      batch.forEach((page) => form.append("pages", page, page.name));
      const response = await fetch("/api/vision-pages", { method: "POST", body: form, signal });
      const payload = await response.json() as { text?: string; error?: string };
      if (!response.ok || !payload.text?.trim()) {
        throw new Error(payload.error || `第 ${batchIndex * 6 + 1}-${batchIndex * 6 + batch.length} 页没有识别出可用内容。`);
      }
      results[batchIndex] = payload.text;
      recognizedPages += batch.length;
      onProgress?.(recognizedPages, pages.length, "recognize");
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, () => worker()));
  return results.join("\n\n").trim();
}
