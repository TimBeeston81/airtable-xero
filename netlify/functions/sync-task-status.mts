import type { Context, Config } from "@netlify/functions";
import { getRecord, updateRecord, buildLogEntry } from "./lib/airtable";
import { updateRecordInBase } from "./lib/cross-base-airtable";
import { isAuthorized } from "./lib/auth";

// Generic sync-back: when a WareHouse Task's Status changes, write a mapped value onto whatever
// record created that Task (a Ticket in HYH today, potentially something else, in some other
// base, later). Reusable across origins without a new automation — see the "Sync ..." fields on
// a Task for the per-record routing/mapping this function reads:
//   Sync Base ID / Sync Table ID / Sync Record ID  — where to write back
//   Sync Status Field ID                           — which field there to write
//   Sync Status Map                                — JSON {thisStatus: originStatus}
// A Task missing any of these was never meant to participate — skip silently, no Notes churn.
// A Task's current Status not present as a key in its own map is equally expected and silent
// (Status moving through values nobody asked to sync).

const TABLES = { TASKS: "Tasks" };
const SOURCE = "sync-task-status";

async function logOutcome(recordId: string, outcome: "Success" | "Error", details: string): Promise<void> {
  try {
    const task = await getRecord(TABLES.TASKS, recordId);
    await updateRecord(TABLES.TASKS, recordId, {
      Notes: buildLogEntry(outcome, details, SOURCE, task.fields["Notes"]),
    });
  } catch {
    // Best effort — don't let a logging failure mask the original outcome.
  }
}

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!isAuthorized(req.headers.get("x-webhook-secret"))) {
    return new Response("Unauthorized", { status: 401 });
  }

  let recordId: string | undefined;
  try {
    ({ recordId } = await req.json());
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!recordId) {
    return new Response("Missing recordId", { status: 400 });
  }

  try {
    const task = await getRecord(TABLES.TASKS, recordId);
    const f = task.fields;

    const syncBaseId = f["Sync Base ID"];
    const syncTableId = f["Sync Table ID"];
    const syncRecordId = f["Sync Record ID"];
    const syncStatusFieldId = f["Sync Status Field ID"];
    const syncStatusMapRaw = f["Sync Status Map"];

    if (!syncBaseId || !syncTableId || !syncRecordId || !syncStatusFieldId || !syncStatusMapRaw) {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: "not scaffolded for sync" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    let map: Record<string, string>;
    try {
      map = JSON.parse(syncStatusMapRaw);
    } catch {
      throw new Error(`Sync Status Map is not valid JSON: ${syncStatusMapRaw}`);
    }

    const currentStatus = f["Status"];
    const targetStatus = map[currentStatus];

    if (!targetStatus) {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: `no mapping for status "${currentStatus}"` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    await updateRecordInBase(syncBaseId, syncTableId, syncRecordId, { [syncStatusFieldId]: targetStatus });
    await logOutcome(recordId, "Success", `Synced Status → ${targetStatus} (record ${syncRecordId} in base ${syncBaseId})`);

    return new Response(
      JSON.stringify({ ok: true, targetStatus }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const error = err as Error;
    console.error("sync-task-status error:", error);
    await logOutcome(recordId, "Error", error.message);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

export const config: Config = {
  path: "/sync-task-status",
};
