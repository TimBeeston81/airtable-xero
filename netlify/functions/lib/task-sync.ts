// The task side of the Supabase version: tell Tim about a new client ticket, and write a
// task's status back to the ticket it came from. Same behaviour as notify-new-task.mts and
// sync-task-status.mts, against a store and injected senders so it is testable.

import { PRODUCTION_SUPABASE_REF } from "./environment";

export interface StoredTask {
  id: string;
  code: string | null;
  title: string;
  status: string;
  critical: boolean;
  origin_base_id: string | null;
  origin_table_id: string | null;
  origin_record_id: string | null;
  origin_status_field_id: string | null;
  origin_status_map: unknown;
  project_code: string | null;
  project_name: string | null;
}

export interface TaskStore {
  getTask(taskId: string): Promise<StoredTask | null>;
  log(taskId: string, outcome: "success" | "failure", message: string, automation: string): Promise<void>;
}

export interface TaskDeps {
  store: TaskStore;
  env: (name: string) => string | undefined;
  sendPushover(o: { title: string; html: string; url?: string; urlTitle?: string; emergency?: boolean }): Promise<string>;
  updateOrigin(baseId: string, tableId: string, recordId: string, fieldsById: Record<string, unknown>): Promise<void>;
  escapeHtml(text: string): string;
}

export type TaskResult =
  | { ok: true; skipped?: boolean; reason?: string; requestId?: string; critical?: boolean; targetStatus?: string }
  | { ok: false; error: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isProduction = (deps: TaskDeps) => (deps.env("SUPABASE_URL") ?? "").includes(PRODUCTION_SUPABASE_REF);

export async function notifyNewTask(deps: TaskDeps, taskId: string): Promise<TaskResult> {
  const SOURCE = "notify-new-task";
  try {
    const task = await deps.store.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const client = [task.project_code, task.project_name].filter(Boolean).join(" · ") || "a client";
    const production = isProduction(deps);
    // Staging must never raise an alarm that repeats until acknowledged, whatever the task says.
    const emergency = task.critical && production;
    const prefix = production ? "" : "[staging] ";
    const base = (deps.env("WAREHOUSE_URL") || "https://warehouse.timbeeston.uk").replace(/\/+$/, "");
    const requestId = await deps.sendPushover({
      title: `${prefix}${task.critical ? "🔴 Critical ticket" : "New ticket"} · ${client}`,
      html: deps.escapeHtml(task.title || "(untitled task)"),
      url: `${base}/tasks/${task.id}`,
      urlTitle: "Open in WareHouse",
      emergency,
    });
    return { ok: true, requestId, critical: task.critical };
  } catch (err) {
    await deps.store.log(taskId, "failure", `Alert not sent: ${message(err)}`, SOURCE).catch(() => undefined);
    return { ok: false, error: message(err) };
  }
}

export async function syncTaskStatus(deps: TaskDeps, taskId: string): Promise<TaskResult> {
  const SOURCE = "sync-task-status";
  try {
    const task = await deps.store.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const { origin_base_id: baseId, origin_table_id: tableId, origin_record_id: recordId, origin_status_field_id: fieldId } = task;
    if (!baseId || !tableId || !recordId || !fieldId || !task.origin_status_map) {
      return { ok: true, skipped: true, reason: "not from a client's base" };
    }
    // A copy of the data must never edit a real client's ticket.
    if (!isProduction(deps)) return { ok: true, skipped: true, reason: "staging never writes to a client's base" };

    const map = task.origin_status_map as Record<string, unknown>;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("The status map isn't valid.");
    const target = map[task.status];
    if (typeof target !== "string" || !target) return { ok: true, skipped: true, reason: `no mapping for status "${task.status}"` };

    await deps.updateOrigin(baseId, tableId, recordId, { [fieldId]: target });
    await deps.store.log(taskId, "success", `Synced Status → ${target} (record ${recordId} in base ${baseId})`, SOURCE);
    return { ok: true, targetStatus: target };
  } catch (err) {
    await deps.store.log(taskId, "failure", message(err), SOURCE).catch(() => undefined);
    return { ok: false, error: message(err) };
  }
}
