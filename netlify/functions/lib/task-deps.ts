import { createSupabaseTaskStore } from "./task-store";
import { escapeHtml, sendPushover } from "./pushover";
import { updateRecordInBase } from "./cross-base-airtable";
import type { TaskDeps } from "./task-sync";

export function realTaskDeps(): TaskDeps {
  const url = Netlify.env.get("SUPABASE_URL") || "";
  const key = Netlify.env.get("SUPABASE_SECRET_KEY") || "";
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.");
  return { store: createSupabaseTaskStore(url, key), env: (n) => Netlify.env.get(n), sendPushover, updateOrigin: updateRecordInBase, escapeHtml };
}
