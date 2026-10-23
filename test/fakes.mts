import type { InvoiceStore, StoredInvoice, StoredOrganisation, XeroInvoiceFacts } from "../netlify/functions/lib/invoice-store";
import type { XeroApi } from "../netlify/functions/lib/invoice-sync";

export const STAGING_URL = "https://abcdefghijklmnop.supabase.co";
export const PRODUCTION_URL = "https://ldfusqzcrcidkqpgqpep.supabase.co";

export class FakeStore implements InvoiceStore {
  invoice: StoredInvoice;
  org: StoredOrganisation;
  status = "Not Synced";
  error: string | null = null;
  saved: { facts?: XeroInvoiceFacts; lineIds?: (string | undefined)[] } = {};
  payment: { id?: string; amountPence?: number } = {};
  voided = false;
  contactSetTo: string | null = null;
  logs: { outcome: string; message: string; automation: string }[] = [];
  calls: string[] = [];
  webhook: XeroInvoiceFacts | null = null;
  syncedAt: string | null = null;

  constructor(overrides: Partial<StoredInvoice> = {}, org: Partial<StoredOrganisation> = {}) {
    this.invoice = {
      id: "inv-1", number: null, organisation_id: "org-1", reference: "PO-9", issue_on: "2026-10-23", due_on: "2026-11-22", approved_at: null,
      xero_invoice_id: null, xero_status: null, xero_payment_id: null, stripe_payment_intent: null, stripe_amount_paid_pence: null,
      lines: [
        { id: "l1", description: "Build", quantity: 2, unit_pence: 45000, position: 0 },
        { id: "l2", description: "Extra", quantity: 1, unit_pence: 1234, position: 1 },
      ],
      ...overrides,
    };
    this.org = { id: "org-1", name: "Acme Ltd", xero_contact_id: null, phone: null, address_line1: "1 High St", address_line2: null, city: "Leeds", region: null, postcode: "LS1", country: "UK", email: "a@acme.test", ...org };
  }
  async claim() { this.calls.push("claim"); if (this.status === "Syncing") return false; this.status = "Syncing"; return true; }
  async getInvoice() { return this.invoice; }
  async getOrganisation() { return this.org; }
  async setContactId(_: string, id: string) { this.contactSetTo = id; this.org.xero_contact_id = id; }
  async saveSynced(_: string, facts: XeroInvoiceFacts, lineIds: (string | undefined)[]) { this.saved = { facts, lineIds }; this.status = "Synced"; this.error = null; this.invoice.xero_invoice_id = facts.xeroInvoiceId; this.syncedAt = facts.syncedAt; }
  async saveClean() { this.status = "Synced"; this.error = null; }
  async saveError(_: string, message: string) { this.status = "Error"; this.error = message; }
  async savePayment(_: string, id: string | undefined, facts: XeroInvoiceFacts, amountPence: number) { this.payment = { id, amountPence }; this.invoice.xero_payment_id = id ?? null; this.saved.facts = facts; }
  async savePaymentError(_: string, message: string) { this.error = message; }
  async saveVoided(_: string, facts: XeroInvoiceFacts) { this.voided = true; this.saved.facts = facts; this.status = "Synced"; }
  async findByXeroId(id: string) { return this.invoice.xero_invoice_id === id ? { id: this.invoice.id, syncedAt: this.syncedAt } : null; }
  async saveWebhookUpdate(_: string, facts: XeroInvoiceFacts) { this.webhook = facts; }
  async log(_: string, outcome: "success" | "failure", message: string, automation: string) { this.logs.push({ outcome, message, automation }); }
}

export class FakeXero implements XeroApi {
  orgName = "Demo Company (UK)";
  // Makes ids and numbers unique across runs, for tests against a real database.
  prefix = "";
  existingContact: any = null;
  invoices = new Map<string, any>();
  calls: string[] = [];
  upserts: any[] = [];
  payments: any[] = [];
  contacts: any[] = [];
  failOn: Record<string, string> = {};
  private n = 0;

  private maybeFail(name: string) { if (this.failOn[name]) throw new Error(this.failOn[name]); }
  async getAccessToken() { this.calls.push("token"); return "tok"; }
  async getOrganisationName() { this.calls.push("org"); return this.orgName; }
  async getInvoice(id: string) { this.calls.push("getInvoice"); return this.invoices.get(id); }
  async upsertInvoice(payload: any) {
    this.calls.push("upsert"); this.maybeFail("upsert"); this.upserts.push(payload);
    const id = payload.InvoiceID ?? `${this.prefix}xi-${++this.n}`;
    const previous = this.invoices.get(id) ?? {};
    const items = (payload.LineItems ?? previous.LineItems ?? []).map((l: any, i: number) => ({ ...l, LineItemID: `xl-${id}-${i}` }));
    const total = items.reduce((s: number, l: any) => s + l.Quantity * l.UnitAmount, 0);
    const inv = { ...previous, ...payload, InvoiceID: id, InvoiceNumber: previous.InvoiceNumber ?? `${this.prefix}INV-${1000 + this.n}`, LineItems: items, Total: total, AmountPaid: previous.AmountPaid ?? 0, AmountDue: total - (previous.AmountPaid ?? 0), UpdatedDateUTC: "/Date(1790000000000+0000)/" };
    this.invoices.set(id, inv);
    return inv;
  }
  async createPayment(p: any) {
    this.calls.push("payment"); this.maybeFail("payment"); this.payments.push(p);
    const inv = this.invoices.get(p.invoiceId);
    inv.AmountPaid = (inv.AmountPaid ?? 0) + p.amount; inv.AmountDue = inv.Total - inv.AmountPaid; if (inv.AmountDue <= 0) inv.Status = "PAID";
    return { PaymentID: `${this.prefix}pay-${this.payments.length}` };
  }
  async getOnlineInvoiceUrl(id: string) { this.calls.push("url"); this.maybeFail("url"); return `https://in.xero.test/${id}`; }
  async findContactByName() { this.calls.push("findContact"); return this.existingContact; }
  async createContact(payload: any) { this.calls.push("createContact"); this.contacts.push(payload); return { ContactID: "xc-new" }; }
  parseXeroDate(value: string | undefined | null) {
    const m = value?.match(/^\/Date\((\d+)/);
    return m ? new Date(Number(m[1])).toISOString() : undefined;
  }
}

export const envFor = (extra: Record<string, string> = {}) => {
  const vars: Record<string, string> = { SUPABASE_URL: STAGING_URL, XERO_LINE_ITEM_ACCOUNT_CODE: "200", XERO_STRIPE_ACCOUNT_CODE: "090", ...extra };
  return (name: string) => vars[name];
};
