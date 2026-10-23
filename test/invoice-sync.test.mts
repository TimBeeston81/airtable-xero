import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWebhookEvent, syncInvoice, voidInvoice } from "../netlify/functions/lib/invoice-sync";
import { checkPairing } from "../netlify/functions/lib/environment";
import { FakeStore, FakeXero, PRODUCTION_URL, STAGING_URL, envFor } from "./fakes.mts";

const deps = (store: FakeStore, xero: FakeXero, env = envFor()) => ({ store, xero, env, now: () => new Date("2026-10-23T12:00:00Z") });

test("only production-with-real-Xero and staging-with-demo are allowed", () => {
  assert.equal(checkPairing(STAGING_URL, "Demo Company (UK)"), null);
  assert.equal(checkPairing(STAGING_URL, "Demo Company (Global)"), null);
  assert.equal(checkPairing(PRODUCTION_URL, "Tim Beeston Ltd"), null);
  assert.match(checkPairing(PRODUCTION_URL, "Demo Company (UK)")!, /production database.*demo/i);
  assert.match(checkPairing(STAGING_URL, "Tim Beeston Ltd")!, /non-production database.*real Xero/i);
  assert.match(checkPairing(undefined, "Demo Company (UK)")!, /SUPABASE_URL/);
  assert.match(checkPairing("http://evil.test", "Demo Company (UK)")!, /SUPABASE_URL/);
  assert.match(checkPairing(STAGING_URL, " ")!, /name/);
  assert.match(checkPairing(STAGING_URL, "The Demo Company Ltd")!, /real Xero/i, "a real company with 'demo' later in its name isn't a demo company");
});

test("first sync: contact created, invoice in pounds with the account code, everything written back", async () => {
  const store = new FakeStore();
  const xero = new FakeXero();
  const r = await syncInvoice(deps(store, xero), "inv-1");
  assert.deepEqual([r.ok, store.status, store.error], [true, "Synced", null]);
  assert.equal(xero.contacts[0].Name, "Acme Ltd");
  assert.equal(xero.contacts[0].EmailAddress, "a@acme.test");
  assert.equal(store.contactSetTo, "xc-new");
  const p = xero.upserts[0];
  assert.deepEqual([p.Type, p.Status, p.LineAmountType, p.Reference, p.Date, p.DueDate, p.Contact.ContactID], ["ACCREC", "AUTHORISED", "Exclusive", "PO-9", "2026-10-23", "2026-11-22", "xc-new"]);
  assert.deepEqual(p.LineItems.map((l: any) => [l.Description, l.Quantity, l.UnitAmount, l.AccountCode]), [["Build", 2, 450, "200"], ["Extra", 1, 12.34, "200"]]);
  const f = store.saved.facts!;
  assert.deepEqual([f.number, f.xeroStatus, f.paidPence, f.balancePence, f.url, f.syncedAt], ["INV-1001", "AUTHORISED", 0, 91234, "https://in.xero.test/xi-1", "2026-09-21T14:13:20.000Z"]);
  assert.deepEqual(store.saved.lineIds, ["xl-xi-1-0", "xl-xi-1-1"]);
  assert.equal(store.logs.at(-1)?.outcome, "success");
  assert.equal(xero.payments.length, 0);
});

test("an organisation already in Xero is reused, by saved id or by exact name", async () => {
  const saved = new FakeStore({}, { xero_contact_id: "xc-saved" });
  const x1 = new FakeXero();
  await syncInvoice(deps(saved, x1), "inv-1");
  assert.equal(x1.upserts[0].Contact.ContactID, "xc-saved");
  assert.ok(!x1.calls.includes("findContact") && !x1.calls.includes("createContact"));

  const byName = new FakeStore();
  const x2 = new FakeXero();
  x2.existingContact = { ContactID: "xc-found" };
  await syncInvoice(deps(byName, x2), "inv-1");
  assert.equal(x2.upserts[0].Contact.ContactID, "xc-found");
  assert.equal(byName.contactSetTo, "xc-found");
  assert.ok(!x2.calls.includes("createContact"));
});

test("the wrong pairing stops everything before Xero is touched", async () => {
  const store = new FakeStore();
  const xero = new FakeXero();
  xero.orgName = "Tim Beeston Ltd";
  const r = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(!r.ok && /real Xero/.test(r.error));
  assert.equal(xero.upserts.length, 0);
  assert.equal(xero.contacts.length, 0);
  assert.equal(store.status, "Error");
});

test("an invoice already being synced is refused without calling Xero", async () => {
  const store = new FakeStore();
  store.status = "Syncing";
  const xero = new FakeXero();
  const r = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(!r.ok && /already being synced/.test(r.error));
  assert.deepEqual(xero.calls, []);
});

test("a failure leaves the invoice marked Error with the reason, and releases it for a retry", async () => {
  const store = new FakeStore();
  const xero = new FakeXero();
  xero.failOn.upsert = "Xero API error (400): bad account";
  const r = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(!r.ok && /bad account/.test(r.error));
  assert.deepEqual([store.status, store.error], ["Error", "Xero API error (400): bad account"]);
  assert.equal(store.logs.at(-1)?.outcome, "failure");
  delete xero.failOn.upsert;
  assert.ok((await syncInvoice(deps(store, xero), "inv-1")).ok, "a retry works");
});

test("an invoice with no lines, a missing account code, or a voided invoice is refused", async () => {
  const none = await syncInvoice(deps(new FakeStore({ lines: [] }), new FakeXero()), "inv-1");
  assert.ok(!none.ok && /no Line Items/.test(none.error));
  const noCode = await syncInvoice(deps(new FakeStore(), new FakeXero(), (n) => (n === "SUPABASE_URL" ? STAGING_URL : undefined)), "inv-1");
  assert.ok(!noCode.ok && /XERO_LINE_ITEM_ACCOUNT_CODE/.test(noCode.error));
  const x = new FakeXero();
  const voided = await syncInvoice(deps(new FakeStore({ xero_status: "VOIDED" }), x), "inv-1");
  assert.ok(!voided.ok && /voided/.test(voided.error));
  assert.equal(x.upserts.length, 0);
});

test("an authorised invoice is never edited", async () => {
  const store = new FakeStore();
  const xero = new FakeXero();
  await syncInvoice(deps(store, xero), "inv-1");
  const again = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(!again.ok && /already authorised/.test(again.error));
  assert.equal(xero.upserts.length, 1);
});

test("a card deposit is recorded as a payment, once, and the invoice shows paid", async () => {
  const store = new FakeStore({ stripe_amount_paid_pence: 91234, stripe_payment_intent: "pi_1" });
  const xero = new FakeXero();
  const r = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(r.ok);
  assert.deepEqual(xero.payments.map((p) => [p.amount, p.accountCode, p.reference, p.date]), [[912.34, "090", "pi_1", "2026-10-23"]]);
  assert.deepEqual([store.payment.id, store.payment.amountPence, store.saved.facts!.xeroStatus, store.saved.facts!.paidPence, store.saved.facts!.balancePence], ["pay-1", 91234, "PAID", 91234, 0]);
  const again = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(!again.ok);
  assert.equal(xero.payments.length, 1, "never a second payment");
});

test("a payment failure never costs the invoice, and a retry finishes the payment", async () => {
  const store = new FakeStore({ stripe_amount_paid_pence: 5000, stripe_payment_intent: "pi_2" });
  const xero = new FakeXero();
  xero.failOn.payment = "Xero API error (400): account closed";
  const r = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(r.ok, "the invoice sync itself succeeded");
  assert.equal(store.invoice.xero_invoice_id, "xi-1");
  assert.equal(store.status, "Synced");
  assert.match(store.error!, /card payment not recorded.*account closed/);
  assert.equal(store.invoice.xero_payment_id, null);
  delete xero.failOn.payment;
  const retry = await syncInvoice(deps(store, xero), "inv-1");
  assert.ok(retry.ok);
  assert.equal(xero.upserts.length, 1, "the invoice isn't created twice");
  assert.equal(xero.payments.length, 1);
  assert.equal(store.invoice.xero_payment_id, "pay-1");
});

test("a failed online-link lookup doesn't fail the sync", async () => {
  const store = new FakeStore();
  const xero = new FakeXero();
  xero.failOn.url = "no link";
  assert.ok((await syncInvoice(deps(store, xero), "inv-1")).ok);
  assert.equal(store.saved.facts?.url, undefined);
});

test("voiding: needs a Xero invoice, voids it there, records it", async () => {
  const none = await voidInvoice(deps(new FakeStore(), new FakeXero()), "inv-1");
  assert.ok(!none.ok && /no Xero Invoice ID/.test(none.error));
  const store = new FakeStore();
  const xero = new FakeXero();
  await syncInvoice(deps(store, xero), "inv-1");
  const r = await voidInvoice(deps(store, xero), "inv-1");
  assert.ok(r.ok);
  assert.equal(xero.upserts.at(-1).Status, "VOIDED");
  assert.equal(xero.upserts.at(-1).InvoiceID, "xi-1");
});

test("voiding checks the pairing first", async () => {
  const store = new FakeStore({ xero_invoice_id: "xi-9" });
  const xero = new FakeXero();
  xero.orgName = "Tim Beeston Ltd";
  const r = await voidInvoice(deps(store, xero), "inv-1");
  assert.ok(!r.ok);
  assert.equal(xero.upserts.length, 0);
});

test("webhook: updates paid and balance for known authorised invoices, ignores the rest", async () => {
  const store = new FakeStore();
  const xero = new FakeXero();
  await syncInvoice(deps(store, xero), "inv-1");
  const inv = xero.invoices.get("xi-1");
  inv.AmountPaid = 400; inv.AmountDue = inv.Total - 400; inv.UpdatedDateUTC = "/Date(1800000000000+0000)/";
  await applyWebhookEvent(deps(store, xero), { eventCategory: "INVOICE", resourceId: "xi-1" }, "tok");
  assert.deepEqual([store.webhook?.paidPence, store.webhook?.balancePence, store.webhook?.xeroStatus], [40000, 51234, "AUTHORISED"]);

  const fresh = new FakeStore();
  await applyWebhookEvent(deps(fresh, xero), { eventCategory: "INVOICE", resourceId: "xi-unknown" }, "tok");
  await applyWebhookEvent(deps(fresh, xero), { eventCategory: "CONTACT", resourceId: "xi-1" }, "tok");
  assert.equal(fresh.webhook, null);

  store.webhook = null;
  inv.UpdatedDateUTC = "/Date(1000000000000+0000)/"; // older than what was last written
  await applyWebhookEvent(deps(store, xero), { eventCategory: "INVOICE", resourceId: "xi-1" }, "tok");
  assert.equal(store.webhook, null, "a no-op update is skipped");
  inv.UpdatedDateUTC = "/Date(1900000000000+0000)/"; inv.Status = "DRAFT";
  await applyWebhookEvent(deps(store, xero), { eventCategory: "INVOICE", resourceId: "xi-1" }, "tok");
  assert.equal(store.webhook, null, "draft edits are noise");
});
