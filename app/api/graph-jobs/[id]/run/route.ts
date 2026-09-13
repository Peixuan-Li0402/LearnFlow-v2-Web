import { getGraphJob } from "@/db/course-store";
import { runGraphBuildJob } from "@/lib/graph-job-runner";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getGraphJob(id))) return new Response("任务不存在。", { status: 404 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        send("connected", { jobId: id });
        await runGraphBuildJob(id, async (event) => send(event.type, event));
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : "图谱任务执行失败。" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

