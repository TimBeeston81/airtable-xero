import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import { syncTaskStatus } from "./lib/task-sync";
import { realTaskDeps } from "./lib/task-deps";

// Called by WareHouse with { taskId: <uuid> }. Business failures are 200 with ok:false, so the caller can show why.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  let taskId = "";
  try {
    taskId = String((await req.json()).taskId ?? "");
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!UUID.test(taskId)) return new Response("Missing or invalid taskId", { status: 400 });

  const result = await syncTaskStatus(realTaskDeps(), taskId);
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config: Config = {
  path: "/supabase/sync-task-status",
};
