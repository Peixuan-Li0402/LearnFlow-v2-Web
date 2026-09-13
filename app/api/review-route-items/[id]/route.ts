import { NextResponse } from "next/server";
import { updateReviewRouteItem } from "@/db/course-store";
import type { ReviewRouteItem } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };
const statuses = new Set<ReviewRouteItem["status"]>(["PENDING", "DONE", "REVIEW"]);

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json()) as { status?: ReviewRouteItem["status"] };
  if (!body.status || !statuses.has(body.status)) return NextResponse.json({ error: "复习状态无效。" }, { status: 400 });
  await updateReviewRouteItem(id, body.status);
  return NextResponse.json({ ok: true });
}

