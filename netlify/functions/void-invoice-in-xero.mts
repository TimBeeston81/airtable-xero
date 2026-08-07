import type { Context, Config } from "@netlify/functions";
import { getRecord, updateRecord, buildLogEntry } from "./lib/airtable";
import { getAccessToken, upsertInvoice, parseXeroDate } from "./lib/xero";
import { isAuthorized } from "./lib/auth";

const TABLES = { INVOICES: "Invoices" };

const SOURCE = "void-invoice-in-xero";

async function markError(recordId: string, message: string): Promise<void> {
  let existingLog: string | undefined;
  try {
    const record = await getRecord(TABLES.INVOICES, recordId);
    existingLog = record.fields["Automation Log"];
  } catch {
    // Couldn't fetch the record at all - proceed without log history rather than fail.
  }

  await updateRecord(TABLES.INVOICES, recordId, {
    "Xero Sync Status": "Error",
    "Xero Sync Error": message,
    "Automation Log": buildLogEntry("Error", message, SOURCE, existingLog),
  });
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
    const invoice = await getRecord(TABLES.INVOICES, recordId);
    const xeroInvoiceId = invoice.fields["Xero Invoice ID"];
    if (!xeroInvoiceId) {
      throw new Error("Invoice has no Xero Invoice ID to void.");
    }

    const token = await getAccessToken();

    // Xero rejects this with a clear validation error if a payment or credit note is
    // allocated to the invoice - that error surfaces to Xero Sync Error as-is below.
    const xeroInvoice = await upsertInvoice({ InvoiceID: xeroInvoiceId, Status: "VOIDED" }, token);

    const successDetails = `Invoice voided in Xero (${xeroInvoice.InvoiceNumber || xeroInvoice.InvoiceID})`;

    await updateRecord(TABLES.INVOICES, recordId, {
      "Xero Invoice Status": xeroInvoice.Status,
      "Xero Sync Status": "Synced",
      "Xero Sync Error": "",
      "Last Synced Xero Date": parseXeroDate(xeroInvoice.UpdatedDateUTC) || new Date().toISOString(),
      "Automation Log": buildLogEntry("Success", successDetails, SOURCE, invoice.fields["Automation Log"]),
    });

    return new Response(
      JSON.stringify({ ok: true, xeroInvoiceId: xeroInvoice.InvoiceID, status: xeroInvoice.Status }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const error = err as Error;
    console.error("void-invoice-in-xero error:", error);
    try {
      await markError(recordId, error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (writeErr) {
      const writeError = writeErr as Error;
      console.error("Failed to write error state to Airtable:", writeError);
      return new Response(
        JSON.stringify({ ok: false, error: error.message, writeError: writeError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }
};

export const config: Config = {
  path: "/void-invoice-in-xero",
};
