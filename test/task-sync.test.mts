import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyNewTask, syncTaskStatus, type StoredTask, type TaskDeps, type TaskStore } from "../netlify/functions/lib/task-sync";
import { PRODUCTION_URL, STAGING_URL } from "./fakes.mts";

const baseTask = (over: Partial<StoredTask> = {}): StoredTask => ({
  id: "t1", code: "TSK-1", title: "Site is down <b>", status: "Done", critical: false,
  origin_base_id: "appHLaxm6scb5xGmA", origin_table_id: "tbl7UMsMlVDFDuZI0", origin_record_id: "recYMNUxf5XNukfeE", origin_status_field_id: "fldYT98e3u84ys3R8",
  origin_status_map: { Done: "Resolved", Dropped: "Resolved", Snagging: "In Progress", "In Progress": "In Progress" },
  project_code: "P-HYH-1-0001", project_name: "Healing Young Hearts", ...over,
});

function setup(task: StoredTask | null, url = PRODUCTION_URL) {
  const logs: { outcome: string; message: string; automation: string }[] = [];
  const pushes: any[] = [];
  const writes: any[] = [];
  const store: TaskStore = { getTask: async () => task, log: async (_id, outcome, message, automation) => void logs.push({ outcome, message, automation }) };
  const state = { pushFails: false, writeFails: false };
  const deps: TaskDeps = {
    store,
    env: (n) => ({ SUPABASE_URL: url, WAREHOUSE_URL: "https://warehouse.example.test/" } as Record<string, string>)[n],
    sendPushover: async (o) => { if (state.pushFails) throw new Error("Pushover API error (400): bad token"); pushes.push(o); return "req-1"; },
    updateOrigin: async (b, t, r, f) => { if (state.writeFails) throw new Error("Cross-base update failed (403)"); writes.push({ b, t, r, f }); },
    escapeHtml: (s) => s.replace(/</g, "&lt;"),
  };
  return { deps, logs, pushes, writes, state };
}

test("a Done task writes Resolved to the ticket's status field, once, and logs it", async () => {
  const s = setup(baseTask());
  const r = await syncTaskStatus(s.deps, "t1");
  assert.deepEqual(r, { ok: true, targetStatus: "Resolved" });
  assert.deepEqual(s.writes, [{ b: "appHLaxm6scb5xGmA", t: "tbl7UMsMlVDFDuZI0", r: "recYMNUxf5XNukfeE", f: { fldYT98e3u84ys3R8: "Resolved" } }]);
  assert.equal(s.logs.at(-1)?.outcome, "success");
});

test("a status with no mapping, or a task from nowhere, is skipped quietly with nothing written", async () => {
  const reopened = setup(baseTask({ status: "Not Done" }));
  const r1 = await syncTaskStatus(reopened.deps, "t1");
  assert.ok(r1.ok && r1.skipped && /no mapping/.test(r1.reason!));
  const local = setup(baseTask({ origin_base_id: null, origin_status_map: null }));
  const r2 = await syncTaskStatus(local.deps, "t1");
  assert.ok(r2.ok && r2.skipped && /not from a client/.test(r2.reason!));
  assert.equal(reopened.writes.length + local.writes.length, 0);
  assert.equal(reopened.logs.length + local.logs.length, 0, "silent: no log churn");
});

test("staging never writes to a client's base", async () => {
  const s = setup(baseTask(), STAGING_URL);
  const r = await syncTaskStatus(s.deps, "t1");
  assert.ok(r.ok && r.skipped && /staging never writes/.test(r.reason!));
  assert.equal(s.writes.length, 0);
});

test("a failed write-back is reported and logged, never silent", async () => {
  const s = setup(baseTask());
  s.state.writeFails = true;
  const r = await syncTaskStatus(s.deps, "t1");
  assert.ok(!r.ok && /403/.test(r.error));
  assert.deepEqual([s.logs.at(-1)?.outcome, s.logs.at(-1)?.automation], ["failure", "sync-task-status"]);
  const bad = setup(baseTask({ origin_status_map: "not json" }));
  assert.ok(!(await syncTaskStatus(bad.deps, "t1")).ok);
  const missing = setup(null);
  const m = await syncTaskStatus(missing.deps, "t1");
  assert.ok(!m.ok && /not found/.test(m.error));
});

test("a normal ticket sends an ordinary alert with the project, escaped text and a link", async () => {
  const s = setup(baseTask());
  const r = await notifyNewTask(s.deps, "t1");
  assert.ok(r.ok && r.requestId === "req-1");
  const p = s.pushes[0];
  assert.deepEqual([p.title, p.emergency, p.url, p.html], ["New ticket · P-HYH-1-0001 · Healing Young Hearts", false, "https://warehouse.example.test/tasks/t1", "Site is down &lt;b>"]);
});

test("a critical ticket is an emergency alert in production, but never on staging", async () => {
  const prod = setup(baseTask({ critical: true }));
  await notifyNewTask(prod.deps, "t1");
  assert.deepEqual([prod.pushes[0].emergency, prod.pushes[0].title.startsWith("🔴 Critical")], [true, true]);
  const staging = setup(baseTask({ critical: true }), STAGING_URL);
  await notifyNewTask(staging.deps, "t1");
  assert.equal(staging.pushes[0].emergency, false, "no repeating alarm from test data");
  assert.match(staging.pushes[0].title, /^\[staging\] /);
});

test("with no project the alert says 'a client'; a failed alert is reported and logged on the task", async () => {
  const s = setup(baseTask({ project_code: null, project_name: null }));
  await notifyNewTask(s.deps, "t1");
  assert.match(s.pushes[0].title, /· a client$/);
  s.state.pushFails = true;
  const r = await notifyNewTask(s.deps, "t1");
  assert.ok(!r.ok && /bad token/.test(r.error));
  assert.match(s.logs.at(-1)!.message, /Alert not sent/);
});
