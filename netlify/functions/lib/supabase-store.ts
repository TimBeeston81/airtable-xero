import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InvoiceStore, StoredInvoice, StoredOrganisation, XeroInvoiceFacts } from "./invoice-store";

// The InvoiceStore on Supabase, using the service key (server-side only). Every write
// names the invoice by its id and touches only the columns it owns.

// A claim older than this is assumed to belong to a run that died, so the invoice can be retried.
const CLAIM_MAX_AGE_MS = 5 * 60_000;

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`Supabase ${context} failed: ${error?.message ?? "no data"}`);
}

export function createSupabaseStore(url: string, key: string, db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } })): InvoiceStore {
  const update = async (table: string, id: string, values: Record<string, unknown>, context: string) => {
    const { error } = await db.from(table).update(values).eq("id", id);
    if (error) fail(context, error);
  };
  const factsColumns = (f: XeroInvoiceFacts) => ({
    xero_status: f.xeroStatus,
    paid_pence: f.paidPence,
    balance_pence: f.balancePence,
    xero_synced_at: f.syncedAt,
  });

  return {
    async claim(invoiceId) {
      const stale = new Date(Date.now() - CLAIM_MAX_AGE_MS).toISOString();
      const { data, error } = await db
        .from("invoices")
        .update({ xero_sync_status: "Syncing" })
        .eq("id", invoiceId)
        .or(`xero_sync_status.neq.Syncing,updated_at.lt.${stale}`)
        .select("id");
      if (error) fail("claim", error);
      return (data?.length ?? 0) > 0;
    },

    async getInvoice(invoiceId): Promise<StoredInvoice | null> {
      const { data, error } = await db
        .from("invoices")
        .select("id, number, organisation_id, reference, issue_on, due_on, approved_at, xero_invoice_id, xero_status, xero_payment_id, stripe_payment_intent, stripe_amount_paid_pence")
        .eq("id", invoiceId)
        .maybeSingle();
      if (error) fail("invoice lookup", error);
      if (!data) return null;
      const { data: lines, error: lineError } = await db
        .from("invoice_lines")
        .select("id, description, quantity, unit_pence, position")
        .eq("invoice_id", invoiceId)
        .order("position");
      if (lineError) fail("line lookup", lineError);
      return { ...data, lines: (lines ?? []).map((l) => ({ ...l, quantity: Number(l.quantity) })) } as StoredInvoice;
    },

    async getOrganisation(organisationId): Promise<StoredOrganisation | null> {
      const { data, error } = await db
        .from("organisations")
        .select("id, name, xero_contact_id, phone, address_line1, address_line2, city, region, postcode, country, invoice_email")
        .eq("id", organisationId)
        .maybeSingle();
      if (error) fail("organisation lookup", error);
      if (!data) return null;
      const { data: primary } = await db.from("org_contacts").select("contacts(email)").eq("organisation_id", organisationId).eq("role", "primary").limit(1);
      const email = (primary as any)?.[0]?.contacts?.email ?? data.invoice_email ?? null;
      const { invoice_email: _unused, ...rest } = data;
      return { ...rest, email } as StoredOrganisation;
    },

    async setContactId(organisationId, xeroContactId) {
      await update("organisations", organisationId, { xero_contact_id: xeroContactId, xero_synced_at: new Date().toISOString(), xero_sync_error: null }, "contact id save");
    },

    async saveSynced(invoiceId, facts, lineXeroIds) {
      const values = {
        xero_invoice_id: facts.xeroInvoiceId,
        ...factsColumns(facts),
        xero_url: facts.url ?? null,
        xero_sync_status: "Synced",
        xero_sync_error: null as string | null,
      };
      const first = await db.from("invoices").update({ ...values, ...(facts.number ? { number: facts.number } : {}) }).eq("id", invoiceId);
      if (first.error) {
        // Xero has already created the invoice, so its id must be saved whatever else goes wrong:
        // losing it would make the next attempt create a duplicate. If only the number is the
        // problem (another invoice here already has it), save everything but the number and say so.
        if (!/invoices_number_key/.test(first.error.message)) fail("invoice save", first.error);
        await update("invoices", invoiceId, { ...values, xero_sync_error: `Xero numbered this invoice ${facts.number}, but another invoice here already has that number.` }, "invoice save (without number)");
      }
      // Approved is stamped by the first successful sync, as the Airtable version did.
      await db.from("invoices").update({ approved_at: new Date().toISOString() }).eq("id", invoiceId).is("approved_at", null);
      const { data: lines } = await db.from("invoice_lines").select("id").eq("invoice_id", invoiceId).order("position");
      await Promise.all(
        (lines ?? []).map((l, i) => (lineXeroIds[i] ? update("invoice_lines", l.id, { xero_line_item_id: lineXeroIds[i] }, "line save") : Promise.resolve())),
      );
    },

    async saveClean(invoiceId) {
      await update("invoices", invoiceId, { xero_sync_status: "Synced", xero_sync_error: null }, "clean save");
    },

    async saveError(invoiceId, text) {
      await update("invoices", invoiceId, { xero_sync_status: "Error", xero_sync_error: text }, "error save");
    },

    async savePayment(invoiceId, paymentId, facts) {
      await update("invoices", invoiceId, { ...(paymentId ? { xero_payment_id: paymentId } : {}), ...factsColumns(facts) }, "payment save");
    },

    async savePaymentError(invoiceId, text) {
      await update("invoices", invoiceId, { xero_sync_error: text }, "payment error save");
    },

    async saveVoided(invoiceId, facts) {
      await update("invoices", invoiceId, { ...factsColumns(facts), xero_sync_status: "Synced", xero_sync_error: null }, "void save");
    },

    async findByXeroId(xeroInvoiceId) {
      const { data, error } = await db.from("invoices").select("id, xero_synced_at").eq("xero_invoice_id", xeroInvoiceId).maybeSingle();
      if (error) fail("invoice lookup by Xero id", error);
      return data ? { id: data.id, syncedAt: data.xero_synced_at } : null;
    },

    async saveWebhookUpdate(invoiceId, facts) {
      await update("invoices", invoiceId, factsColumns(facts), "webhook save");
    },

    async log(invoiceId, outcome, text, automation) {
      try {
        const { error } = await db.from("events").insert({ entity_type: "invoices", entity_id: invoiceId, kind: "automation", automation, outcome, message: text, actor: automation });
        if (error) throw error;
      } catch (err) {
        console.error(`Could not write the log line for invoice ${invoiceId}:`, err);
      }
    },
  };
}
