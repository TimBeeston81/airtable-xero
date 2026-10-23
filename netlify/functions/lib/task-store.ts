import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { StoredTask, TaskStore } from "./task-sync";

export function createSupabaseTaskStore(url: string, key: string, db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } })): TaskStore {
  return {
    async getTask(taskId) {
      const { data, error } = await db
        .from("tasks")
        .select("id, code, title, status, critical, origin_base_id, origin_table_id, origin_record_id, origin_status_field_id, origin_status_map, projects(code, name)")
        .eq("id", taskId)
        .maybeSingle();
      if (error) throw new Error(`Supabase task lookup failed: ${error.message}`);
      if (!data) return null;
      const { projects, ...task } = data as any;
      return { ...task, project_code: projects?.code ?? null, project_name: projects?.name ?? null } as StoredTask;
    },
    async log(taskId, outcome, text, automation) {
      try {
        const { error } = await db.from("events").insert({ entity_type: "tasks", entity_id: taskId, kind: "automation", automation, outcome, message: text, actor: automation });
        if (error) throw error;
      } catch (err) {
        console.error(`Could not write the log line for task ${taskId}:`, err);
      }
    },
  };
}
