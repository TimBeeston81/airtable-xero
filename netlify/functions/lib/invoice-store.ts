// What the invoice functions need from the database, as an interface, so the Supabase
// implementation (lib/supabase-store.ts) and a fake in the tests are interchangeable.
// Money is in pence here and converted to pounds only where Xero needs it.

export interface StoredLine {
  id: string;
  description: string;
  quantity: number;
  unit_pence: number;
  position: number;
}

export interface StoredInvoice {
  id: string;
  number: string | null;
  organisation_id: string;
  reference: string | null;
  issue_on: string | null;
  due_on: string | null;
  approved_at: string | null;
  xero_invoice_id: string | null;
  xero_status: string | null;
  xero_payment_id: string | null;
  stripe_payment_intent: string | null;
  stripe_amount_paid_pence: number | null;
  lines: StoredLine[];
}

export interface StoredOrganisation {
  id: string;
  name: string;
  xero_contact_id: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  email: string | null;
}

export interface XeroInvoiceFacts {
  number?: string;
  xeroInvoiceId: string;
  xeroStatus: string;
  paidPence: number;
  balancePence: number;
  url?: string;
  syncedAt: string;
}

export interface InvoiceStore {
  // Takes the invoice for syncing, atomically. False if another run has it.
  claim(invoiceId: string): Promise<boolean>;
  getInvoice(invoiceId: string): Promise<StoredInvoice | null>;
  getOrganisation(organisationId: string): Promise<StoredOrganisation | null>;
  setContactId(organisationId: string, xeroContactId: string): Promise<void>;
  // Writes the result of a sync and releases the claim.
  saveSynced(invoiceId: string, facts: XeroInvoiceFacts, lineXeroIds: (string | undefined)[]): Promise<void>;
  // Releases the claim with the invoice left as it was, but recording a clean state.
  saveClean(invoiceId: string): Promise<void>;
  saveError(invoiceId: string, message: string): Promise<void>;
  // A card payment has been recorded in Xero.
  savePayment(invoiceId: string, paymentId: string | undefined, facts: XeroInvoiceFacts, amountPence: number): Promise<void>;
  savePaymentError(invoiceId: string, message: string): Promise<void>;
  saveVoided(invoiceId: string, facts: XeroInvoiceFacts): Promise<void>;
  findByXeroId(xeroInvoiceId: string): Promise<{ id: string; syncedAt: string | null } | null>;
  // From a Xero webhook: status, paid and balance only.
  saveWebhookUpdate(invoiceId: string, facts: XeroInvoiceFacts): Promise<void>;
  log(invoiceId: string, outcome: "success" | "failure", message: string, automation: string): Promise<void>;
}
