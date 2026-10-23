// A real run against your Xero DEMO COMPANY and the STAGING database, from this machine.
// It makes test invoices (organisation "ZZ-WRITE-TEST Demo Org"), syncs them to the demo
// company with the real Xero client, checks what Xero holds, records a card payment,
// voids one, then removes the test rows from staging. The demo company keeps the voided
// invoices and the test contact; that is harmless there.
//
//   cp .env.demo.example .env.demo   # fill in the demo company's values
//   npx tsx scripts/demo-run.mts
//
// Refuses to run unless Xero says the organisation is a "Demo Company", and refuses the
// production database, whatever the settings say.

import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import * as xero from "../netlify/functions/lib/xero";
import { createSupabaseStore } from "../netlify/functions/lib/supabase-store";
import { syncInvoice, voidInvoice, type Deps } from "../netlify/functions/lib/invoice-sync";
import { PRODUCTION_SUPABASE_REF } from "../netlify/functions/lib/environment";

// The functions read settings through Netlify's global; locally that is just the environment.
(globalThis as any).Netlify = { env: { get: (name: string) => process.env[name] } };

if (!existsSync(new URL("../.env.demo", import.meta.url))) {
  console.error("Missing .env.demo. Copy .env.demo.example and fill it in.");
  process.exit(2);
}
process.loadEnvFile(new URL("../.env.demo", import.meta.url).pathname);
const warehouse = new URL("../../timbeeston-uk-warehouse/.env.import", import.meta.url).pathname;
if (existsSync(warehouse)) process.loadEnvFile(warehouse);

const url = process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
if (!url || !key || url.includes(PRODUCTION_SUPABASE_REF)) {
  console.error("Refusing: SUPABASE_URL is missing or is the production project.");
  process.exit(2);
}
const db: any = createClient(url, key, { auth: { persistSession: false } });
const deps: Deps = { store: createSupabaseStore(url, key), xero: xero as unknown as Deps["xero"], env: (n) => process.env[n] };

const must = <T,>(r: { data: T; error: any }) => { if (r.error) throw new Error(r.error.message); return r.data; };
const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, "");
let orgId = "";
const invoices: string[] = [];
let problems = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) problems++; };

try {
  const token = await xero.getAccessToken();
  const orgName = await xero.getOrganisationName(token);
  console.log(`Xero organisation: ${orgName}`);
  if (!/^demo company\b/i.test(orgName)) {
    console.error("Refusing: this Xero connection is not a Demo Company.");
    process.exit(2);
  }

  orgId = must(await db.from("organisations").insert({ name: `ZZ-WRITE-TEST Demo Org ${stamp}`, address_line1: "1 Test Street", city: "Leeds", postcode: "LS1 1AA", is_test: true }).select("id").single()).id;
  const contact = must(await db.from("contacts").insert({ first_name: "Demo", last_name: "Contact", email: `zz-write-test-demo-${stamp}@example.invalid`, is_test: true }).select("id").single());
  must(await db.from("org_contacts").insert({ organisation_id: orgId, contact_id: contact.id, role: "primary" }));

  const make = async (extra: Record<string, unknown>, lines: object[]) => {
    const inv = must(await db.from("invoices").insert({ organisation_id: orgId, reference: `ZZ-DEMO-${stamp}`, issue_on: new Date().toISOString().slice(0, 10), due_on: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), is_test: true, ...extra }).select("id").single());
    invoices.push(inv.id);
    must(await db.from("invoice_lines").insert(lines.map((l, i) => ({ invoice_id: inv.id, position: i, is_test: true, ...l }))));
    return inv.id as string;
  };
  const row = async (id: string) => (await db.from("invoices").select("*").eq("id", id).single()).data;

  console.log("\n1. An ordinary invoice");
  const a = await make({}, [
    { description: "ZZ demo: build", quantity: 2, unit_pence: 45000 },
    { description: "ZZ demo: extra", quantity: 1.5, unit_pence: 1234 },
  ]);
  const r1 = await syncInvoice(deps, a);
  check("sync succeeded", r1.ok, r1.ok ? "" : r1.error);
  const ia = await row(a);
  check("it has an invoice number from Xero", !!ia.number, ia.number);
  check("it is AUTHORISED in Xero and Synced here", ia.xero_status === "AUTHORISED" && ia.xero_sync_status === "Synced");
  check("it has an online link", /^https:\/\//.test(ia.xero_url ?? ""));
  const xa = await xero.getInvoice(ia.xero_invoice_id, token);
  const expected = 2 * 450 + 1.5 * 12.34;
  check("Xero's total matches ours to the penny", Math.abs(xa.Total - expected) < 0.005, `Xero ${xa.Total}, expected ${expected.toFixed(2)}`);
  check("Xero's contact is our organisation", xa.Contact?.Name?.startsWith("ZZ-WRITE-TEST Demo Org"), xa.Contact?.Name);
  const again = await syncInvoice(deps, a);
  check("syncing it again is refused (authorised invoices aren't edited)", !again.ok);

  console.log("\n2. A card deposit already paid");
  const b = await make({ payment_type: "Deposit", stripe_payment_intent: `pi_zz_${stamp}`, stripe_amount_paid_pence: 10000 }, [{ description: "ZZ demo: deposit", quantity: 1, unit_pence: 10000 }]);
  const r2 = await syncInvoice(deps, b);
  check("sync succeeded", r2.ok, r2.ok ? "" : r2.error);
  const ib = await row(b);
  check("recorded as paid in Xero", ib.xero_status === "PAID" && ib.paid_pence === 10000 && ib.balance_pence === 0 && !!ib.xero_payment_id, `${ib.xero_status}, paid ${ib.paid_pence}`);
  check("and no error left on the invoice", !ib.xero_sync_error, ib.xero_sync_error ?? "");

  console.log("\n3. Voiding");
  const v = await voidInvoice(deps, a);
  check("void succeeded", v.ok, v.ok ? "" : v.error);
  const xv = await xero.getInvoice(ia.xero_invoice_id, token);
  check("Xero says VOIDED and so do we", xv.Status === "VOIDED" && (await row(a)).xero_status === "VOIDED");

  console.log("\n4. The safety guard");
  const wrong: Deps = { ...deps, xero: { ...(deps.xero as any), getOrganisationName: async () => "Tim Beeston Ltd" } };
  const c = await make({}, [{ description: "ZZ demo: guard", quantity: 1, unit_pence: 100 }]);
  const rg = await syncInvoice(wrong, c);
  check("a real-looking Xero organisation is refused before anything is sent", !rg.ok && /real Xero/.test(rg.error));
  check("and nothing reached Xero", !(await row(c)).xero_invoice_id);
} catch (err) {
  problems++;
  console.error("\nStopped:", (err as Error).message);
} finally {
  if (invoices.length) {
    await db.from("invoices").delete().in("id", invoices);
    await db.from("events").delete().in("entity_id", invoices);
  }
  if (orgId) {
    await db.from("contacts").delete().like("email", `zz-write-test-demo-${stamp}%`);
    await db.from("organisations").delete().eq("id", orgId);
  }
  console.log(`\nStaging rows removed. ${problems ? `${problems} problem(s).` : "All good."}`);
  process.exit(problems ? 1 : 0);
}
