// Read-only: every sales invoice Xero holds, boiled down to what a WareHouse check needs to compare. Nothing here writes
// to Xero. The shape is the contract with WareHouse's lib/xeroCheck.ts.

export interface XeroInvoiceSummary {
  number: string;
  status: string;
  contact: string;
  issuedOn: string | null;
  dueOn: string | null;
  totalPence: number;
  paidPence: number;
  duePence: number;
  lines: { description: string; amountPence: number }[];
}

const pence = (n: unknown) => Math.round(Number(n ?? 0) * 100);

// Xero's dates come back as "/Date(1786025738277+0000)/" (or ISO); a day is all a check needs.
function day(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  // An ISO date already says the day; parsing it would shift it by the machine's time zone.
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const net = value.match(/^\/Date\((-?\d+)([+-]\d{4})?\)\/$/);
  const d = net ? new Date(Number(net[1])) : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function summariseInvoice(raw: any): XeroInvoiceSummary {
  return {
    number: String(raw.InvoiceNumber ?? ""),
    status: String(raw.Status ?? ""),
    contact: String(raw.Contact?.Name ?? ""),
    issuedOn: day(raw.DateString ?? raw.Date),
    dueOn: day(raw.DueDateString ?? raw.DueDate),
    totalPence: pence(raw.Total),
    paidPence: pence(raw.AmountPaid),
    duePence: pence(raw.AmountDue),
    lines: (raw.LineItems ?? []).map((l: any) => ({ description: String(l.Description ?? ""), amountPence: pence(l.LineAmount) })),
  };
}

// Xero returns 100 invoices a page (with their lines, when a page is asked for) and nothing says how many pages there
// are, so ask until one comes back short. `maxPages` stops a mistake becoming an endless loop.
export async function listSalesInvoices(fetchPage: (page: number) => Promise<any[]>, maxPages = 40): Promise<XeroInvoiceSummary[]> {
  const out: XeroInvoiceSummary[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await fetchPage(page);
    out.push(...rows.map(summariseInvoice));
    if (rows.length < 100) return out;
  }
  throw new Error(`More than ${maxPages * 100} invoices: stopped rather than keep asking Xero.`);
}
