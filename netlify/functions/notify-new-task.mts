import type { Context, Config } from "@netlify/functions";
import { getRecord, updateRecord, buildLogEntry } from "./lib/airtable";
import { sendPushover, escapeHtml } from "./lib/pushover";
import { isAuthorized } from "./lib/auth";

// Push-notify Tim (via Pushover) when a client's base drops a new Task into WareHouse. Fired by the
// WareHouse-side "Notify New Client Task" automation (Tasks, when Sync Base ID is not empty) — so it
// covers every client base that creates Tasks via the Sync ... scaffolding, with nothing to add per
// client. Only a Critical Task interrupts: it goes as an emergency alert that breaks through Focus
// and repeats until acknowledged; anything else is an ordinary notification that respects Focus.
//
// Success isn't logged to the Task's Notes (that field carries the ticket's own content, and the
// automation's run history already shows the Pushover request ID). Errors are, so a missed
// notification is visible on the Task itself.

const TABLES = { TASKS: "Tasks", PROJECTS: "Projects" };
const SOURCE = "notify-new-task";

async function logError(recordId: string, details: string): Promise<void> {
  try {
    const task = await getRecord(TABLES.TASKS, recordId);
    await updateRecord(TABLES.TASKS, recordId, {
      Notes: buildLogEntry("Error", details, SOURCE, task.fields["Notes"]),
    });
  } catch {
    // Best effort — don't let a logging failure mask the original outcome.
  }
}

async function projectLabel(projectIds: string[] | undefined): Promise<string> {
  if (!projectIds?.length) return "a client";
  const project = await getRecord(TABLES.PROJECTS, projectIds[0]);
  const code = project.fields["Project Code"];
  const name = project.fields["Name"];
  return [code, name].filter(Boolean).join(" · ") || "a client";
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

    const client = await projectLabel(f["Project"]);
    const critical = Boolean(f["Critical"]);

    const requestId = await sendPushover({
      title: `${critical ? "🔴 Critical ticket" : "New ticket"} · ${client}`,
      html: escapeHtml(f["Task"] || "(untitled task)"),
      url: `https://airtable.com/${Netlify.env.get("AIRTABLE_BASE_ID")}/tbl4mU5MKNkLlyK0F/${recordId}`,
      urlTitle: "Open in WareHouse",
      emergency: critical,
    });

    console.log(`notify-new-task: sent Pushover ${requestId} (${critical ? "emergency" : "normal"}) for ${recordId}`);
    return new Response(
      JSON.stringify({ ok: true, requestId, critical }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const error = err as Error;
    console.error("notify-new-task error:", error);
    await logError(recordId, error.message);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

export const config: Config = {
  path: "/notify-new-task",
};
