// Runs the sync logic against the real Supabase store on STAGING, with a faked Xero, to
// check the SQL: the atomic claim, the columns written, the constraints. Skipped unless
// SUPABASE_URL and SUPABASE_SECRET_KEY are set, and refuses the production project.
//
//   set -a; . ../timbeeston-uk-warehouse/.env.import; set +a; npm test

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseStore } from "../netlify/functions/lib/supabase-store";
import { applyWebhookEvent, syncInvoice, voidInvoice } from "../netlify/functions/lib/invoice-sync";
import { PRODUCTION_SUPABASE_REF } from "../netlify/functions/lib/environment";
import { FakeXero, envFor } from "./fakes.mts";

const url = process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const skip = !url || !key || url.includes(PRODUCTION_SUPABASE_REF) ? "needs staging SUPABASE_URL and SUPABASE_SECRET_KEY" : false;

const db: any = skip ? null : createClient(url, key, { auth: { persistSession: false } });
const made = { org: "", contact: "", invoices: [] as string[] };
const must = <T,>(r: { data: T; error: any }) => { if (r.error) throw new Error(r.error.message); return r.data; };
const deps = (xero: FakeXero) => ({ store: createSupabaseStore(url, key), xero, env: envFor({ SUPABASE_URL: url }), now: () => new Date("2026-10-23T12:00:00Z") });

async function makeInvoice(extra: Record<string, unknown> = {}) {
  const inv = must(await db.from("invoices").insert({ organisation_id: made.org, reference: "ZZ-XERO-TEST", issue_on: "2026-10-23", due_on: "2026-11-22", is_test: true, ...extra }).select("id").single());
  made.invoices.push(inv.id);
  must(await db.from("invoice_lines").insert([
    { invoice_id: inv.id, position: 0, description: "ZZ Build", quantity: 2, unit_pence: 45000, is_test: true },
    { invoice_id: inv.id, position: 1, description: "ZZ Extra", quantity: 1, unit_pence: 1234, is_test: true },
  ]));
  return inv.id as string;
}
let run = 0;
const newXero = () => { const x = new FakeXero(); x.prefix = `zz${Date.now()}-${++run}-`; return x; };
const row = async (id: string) => (await db.from("invoices").select("*").eq("id", id).single()).data;

before(async () => {
  if (skip) return;
  const org = must(await db.from("organisations").insert({ name: "ZZ-WRITE-TEST Xero Org", phone: "0113", address_line1: "1 High St", city: "Leeds", postcode: "LS1 1AA", is_test: true }).select("id").single());
  made.org = org.id;
  const c = must(await db.from("contacts").insert({ first_name: "Xi", last_name: "Zed", email: "zz-write-test-xero@example.invalid", is_test: true }).select("id").single());
  made.contact = c.id;
  must(await db.from("org_contacts").insert({ organisation_id: org.id, contact_id: c.id, role: "primary" }));
});

after(async () => {
  if (skip) return;
  if (made.invoices.length) {
    await db.from("invoices").delete().in("id", made.invoices);
    await db.from("events").delete().in("entity_id", [...made.invoices, made.org]);
  }
  await db.from("contacts").delete().eq("id", made.contact);
  await db.from("organisations").delete().eq("id", made.org);
});

test("a real sync writes the number, ids, money in pence, link, status and line ids", { skip }, async () => {
  const id = await makeInvoice();
  const xero = newXero();
  const r = await syncInvoice(deps(xero), id);
  assert.ok(r.ok, r.ok ? "" : r.error);
  const inv = await row(id);
  assert.deepEqual(
    [inv.number, inv.xero_invoice_id, inv.xero_status, inv.xero_sync_status, inv.xero_sync_error, inv.paid_pence, inv.balance_pence, inv.xero_url],
    [`${xero.prefix}INV-1001`, `${xero.prefix}xi-1`, "AUTHORISED", "Synced", null, 0, 91234, `https://in.xero.test/${xero.prefix}xi-1`],
  );
  assert.ok(inv.approved_at && inv.xero_synced_at);
  const { data: lines } = await db.from("invoice_lines").select("xero_line_item_id").eq("invoice_id", id).order("position");
  assert.deepEqual(lines.map((l: any) => l.xero_line_item_id), [`xl-${xero.prefix}xi-1-0`, `xl-${xero.prefix}xi-1-1`]);
  const org = (await db.from("organisations").select("xero_contact_id").eq("id", made.org).single()).data;
  assert.equal(org.xero_contact_id, "xc-new");
  await db.from("organisations").update({ xero_contact_id: null }).eq("id", made.org);
  assert.equal(xero.contacts[0].EmailAddress, "zz-write-test-xero@example.invalid", "the primary contact's email goes to Xero");
  const { data: ev } = await db.from("events").select("outcome, automation").eq("entity_id", id);
  assert.deepEqual(ev.map((e: any) => [e.outcome, e.automation]), [["success", "sync-invoice-to-xero"]]);
  assert.equal((await db.from("invoice_summaries").select("status").eq("invoice_id", id).single()).data.status, "Outstanding");
});

test("two syncs at once: only one gets the invoice, so Xero is only asked once", { skip }, async () => {
  const id = await makeInvoice();
  const xero = newXero();
  xero.existingContact = { ContactID: "xc-saved" };
  const [a, b] = await Promise.all([syncInvoice(deps(xero), id), syncInvoice(deps(xero), id)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(xero.upserts.length, 1);
  const loser: any = [a, b].find((r) => !r.ok);
  assert.match(loser.error, /already being synced/);
});

test("a fresh claim stands, and a failed sync releases the invoice for a retry", { skip }, async () => {
  const id = await makeInvoice();
  await db.from("invoices").update({ xero_sync_status: "Syncing" }).eq("id", id);
  const store = createSupabaseStore(url, key);
  assert.equal(await store.claim(id), false, "a claim made a moment ago stands");
  const xero = newXero();
  xero.failOn.upsert = "boom";
  await db.from("invoices").update({ xero_sync_status: "Not Synced" }).eq("id", id);
  const r = await syncInvoice(deps(xero), id);
  assert.ok(!r.ok);
  assert.equal((await row(id)).xero_sync_status, "Error");
  assert.equal(await store.claim(id), true, "an errored invoice can be retried");
});

test("a card deposit is recorded and the invoice ends up paid", { skip }, async () => {
  const id = await makeInvoice({ stripe_payment_intent: `pi_zz_${Date.now()}`, stripe_amount_paid_pence: 91234, payment_type: "Deposit" });
  const xero = newXero();
  const r = await syncInvoice(deps(xero), id);
  assert.ok(r.ok);
  const inv = await row(id);
  assert.deepEqual([inv.xero_status, inv.paid_pence, inv.balance_pence, inv.xero_payment_id], ["PAID", 91234, 0, `${xero.prefix}pay-1`]);
  assert.equal((await db.from("invoice_summaries").select("status").eq("invoice_id", id).single()).data.status, "Paid");
});

test("webhook updates and a void are written", { skip }, async () => {
  const id = await makeInvoice();
  const xero = newXero();
  await syncInvoice(deps(xero), id);
  const xi = xero.invoices.get(`${xero.prefix}xi-1`);
  xi.AmountPaid = 300; xi.AmountDue = xi.Total - 300; xi.UpdatedDateUTC = "/Date(1800000000000+0000)/";
  await applyWebhookEvent(deps(xero), { eventCategory: "INVOICE", resourceId: `${xero.prefix}xi-1` }, "tok");
  const paid = await row(id);
  assert.deepEqual([paid.paid_pence, paid.balance_pence], [30000, 61234]);
  const v = await voidInvoice(deps(xero), id);
  assert.ok(v.ok);
  const voided = await row(id);
  assert.deepEqual([voided.xero_status, voided.xero_sync_status], ["VOIDED", "Synced"]);
  assert.equal((await db.from("invoice_summaries").select("status").eq("invoice_id", id).single()).data.status, "Voided");
  const again = await syncInvoice(deps(xero), id);
  assert.ok(!again.ok && /voided/.test(again.error));
});

test("if Xero's number is already used here, the invoice is still recorded, so a retry can't duplicate it", { skip }, async () => {
  const other = await makeInvoice({ number: `ZZ-DUP-${Date.now()}` });
  const id = await makeInvoice();
  const xero = newXero();
  const number = (await row(other)).number as string;
  xero.prefix = "";
  const original = xero.upsertInvoice.bind(xero);
  xero.upsertInvoice = async (p: any) => ({ ...(await original(p)), InvoiceNumber: number, InvoiceID: `zz-dup-${Date.now()}` });
  const r = await syncInvoice(deps(xero), id);
  assert.ok(r.ok);
  const inv = await row(id);
  assert.ok(inv.xero_invoice_id, "the Xero id is saved");
  assert.equal(inv.number, null);
  assert.match(inv.xero_sync_error, /already has that number/);
  assert.equal(inv.xero_sync_status, "Synced");
});

import { createSupabaseTaskStore } from "../netlify/functions/lib/task-store";
import { syncTaskStatus, notifyNewTask } from "../netlify/functions/lib/task-sync";

test("the real task store: reads origin columns and project, logs events, and staging writes nothing", { skip }, async () => {
  const project = must(await db.from("projects").insert({ organisation_id: made.org, name: "ZZ client project", is_test: true }).select("id, code").single());
  const task = must(await db.from("tasks").insert({
    title: "ZZ ticket", project_id: project.id, status: "Done", is_test: true,
    origin_base_id: "appZZZZZZZZZZZZZZ", origin_table_id: "tblZZZZZZZZZZZZZZ", origin_record_id: "recZZZZZZZZZZZZZZ", origin_status_field_id: "fldZZZZZZZZZZZZZZ", origin_status_map: { Done: "Resolved" },
  }).select("id").single());
  const store = createSupabaseTaskStore(url, key);
  const got = await store.getTask(task.id);
  assert.deepEqual([got?.project_code, got?.origin_status_map, got?.status], [project.code, { Done: "Resolved" }, "Done"]);
  const writes: unknown[] = [];
  const pushes: any[] = [];
  const deps = { store, env: (n: string) => (n === "SUPABASE_URL" ? url : undefined), sendPushover: async (o: any) => { pushes.push(o); return "r"; }, updateOrigin: async (...a: unknown[]) => void writes.push(a), escapeHtml: (s: string) => s };
  const r = await syncTaskStatus(deps, task.id);
  assert.ok(r.ok && r.skipped);
  assert.equal(writes.length, 0, "staging data never writes to a client base");
  await notifyNewTask({ ...deps, sendPushover: async () => { throw new Error("pushover down"); } }, task.id);
  const { data: ev } = await db.from("events").select("outcome, automation").eq("entity_id", task.id);
  assert.deepEqual(ev.map((e: any) => [e.outcome, e.automation]), [["failure", "notify-new-task"]]);
  await db.from("tasks").delete().eq("id", task.id);
  await db.from("projects").delete().eq("id", project.id);
  await db.from("events").delete().eq("entity_id", task.id);
  assert.equal((await notifyNewTask(deps, task.id)).ok, false, "a task that doesn't exist is an error");
  assert.equal(pushes.length, 0);
});
