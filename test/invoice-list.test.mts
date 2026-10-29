import { test } from "node:test";
import assert from "node:assert/strict";
import { listSalesInvoices, summariseInvoice } from "../netlify/functions/lib/invoice-list";

const raw = (n: number, over: Record<string, unknown> = {}) => ({
  InvoiceNumber: `INV-${String(n).padStart(4, "0")}`, Status: "AUTHORISED", Contact: { Name: "Therapy and Education Limited" },
  DateString: "2026-07-14T00:00:00", DueDateString: "2026-08-13T00:00:00", Total: 280.96, AmountPaid: 0, AmountDue: 280.96,
  LineItems: [{ Description: "IATE Google Workspace", LineAmount: 18 }, { Description: "Another", LineAmount: 262.96 }], ...over,
});

test("an invoice is boiled down to whole pence and plain dates", () => {
  const s = summariseInvoice(raw(88));
  assert.deepEqual([s.number, s.status, s.issuedOn, s.dueOn, s.totalPence, s.paidPence, s.duePence], ["INV-0088", "AUTHORISED", "2026-07-14", "2026-08-13", 28096, 0, 28096]);
  assert.deepEqual(s.lines, [{ description: "IATE Google Workspace", amountPence: 1800 }, { description: "Another", amountPence: 26296 }]);
});

test("pence do not drift on awkward amounts, and the .NET date format is understood", () => {
  const s = summariseInvoice(raw(1, { Total: 1742.82, AmountPaid: 1742.82, AmountDue: 0, DateString: undefined, Date: "/Date(1742860800000+0000)/", LineItems: [{ Description: "x", LineAmount: 206.82 }] }));
  assert.deepEqual([s.totalPence, s.paidPence, s.duePence, s.issuedOn, s.lines[0].amountPence], [174282, 174282, 0, "2025-03-25", 20682]);
});

test("pages are asked for until one comes back short, and a runaway is stopped", async () => {
  const asked: number[] = [];
  const pages = [Array.from({ length: 100 }, (_, i) => raw(i)), Array.from({ length: 100 }, (_, i) => raw(100 + i)), [raw(200)]];
  const all = await listSalesInvoices(async (p) => { asked.push(p); return pages[p - 1] ?? []; });
  assert.equal(all.length, 201);
  assert.deepEqual(asked, [1, 2, 3]);
  await assert.rejects(listSalesInvoices(async () => Array.from({ length: 100 }, (_, i) => raw(i)), 3), /More than 300 invoices/);
});
