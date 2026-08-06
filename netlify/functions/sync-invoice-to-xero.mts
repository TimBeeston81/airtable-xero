import type { Context, Config } from "@netlify/functions";
import crypto from "node:crypto";
import { getRecord, updateRecord } from "./lib/airtable";
import { getAccessToken, getInvoice, upsertInvoice } from "./lib/xero";

const TABLES = {
  ORGANISATIONS: "Organisations",
  INVOICES: "Invoices",
  LINE_ITEMS: "Line Items",
};

async function markError(recordId: string, message: string): Promise<void> {
  await updateRecord(TABLES.INVOICES, recordId, {
    "Xero Sync Status": "Error",
    "Xero Sync Error": message,
  });
}

function isAuthorized(providedSecret: string | null): boolean {
  const expected = Netlify.env.get("WAREHOUSE_WEBHOOK_SECRET");
  if (!providedSecret || !expected) return false;

  const providedBuffer = Buffer.from(providedSecret);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
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
    const accountCode = Netlify.env.get("XERO_LINE_ITEM_ACCOUNT_CODE");
    if (!accountCode) {
      throw new Error("XERO_LINE_ITEM_ACCOUNT_CODE environment variable is not set.");
    }

    const invoice = await getRecord(TABLES.INVOICES, recordId);
    const fields = invoice.fields;

    const organisationId = fields["Organisation"]?.[0];
    if (!organisationId) {
      throw new Error("Invoice has no linked Organisation.");
    }
    const organisation = await getRecord(TABLES.ORGANISATIONS, organisationId);
    const contactId = organisation.fields["Xero Contact ID"];
    if (!contactId) {
      throw new Error("Organisation is missing Xero Contact ID. Add it in Airtable before syncing.");
    }

    const lineItemIds: string[] = fields["Line Items"] || [];
    if (lineItemIds.length === 0) {
      throw new Error("Invoice has no Line Items.");
    }
    const lineItemRecords = await Promise.all(
      lineItemIds.map((id) => getRecord(TABLES.LINE_ITEMS, id))
    );

    const xeroLineItems = lineItemRecords.map((record) => ({
      Description: record.fields["Description"] || "",
      Quantity: record.fields["Qty."] ?? 1,
      UnitAmount: record.fields["Unit Amount"] ?? 0,
      AccountCode: accountCode,
    }));

    const token = await getAccessToken();

    const existingInvoiceId = fields["Xero Invoice ID"];

    if (existingInvoiceId) {
      const currentXeroInvoice = await getInvoice(existingInvoiceId, token);
      if (!currentXeroInvoice) {
        throw new Error(`Xero Invoice ID ${existingInvoiceId} was not found in Xero.`);
      }
      if (currentXeroInvoice.Status === "AUTHORISED" || currentXeroInvoice.Status === "PAID") {
        throw new Error(
          "Invoice already authorised in Xero. Void manually in Xero before editing here."
        );
      }
    }

    const invoicePayload = {
      Type: "ACCREC",
      Contact: { ContactID: contactId },
      LineItems: xeroLineItems,
      LineAmountType: "Exclusive",
      Status: "AUTHORISED",
      InvoiceNumber: fields["Invoice Number"],
      Reference: fields["Reference"] || undefined,
      Date: fields["Issue Date"] || undefined,
      DueDate: fields["Due Date"] || undefined,
      ...(existingInvoiceId ? { InvoiceID: existingInvoiceId } : {}),
    };

    const xeroInvoice = await upsertInvoice(invoicePayload, token);

    await updateRecord(TABLES.INVOICES, recordId, {
      "Xero Invoice ID": xeroInvoice.InvoiceID,
      "Xero Invoice Status": xeroInvoice.Status,
      "Xero Sync Status": "Synced",
      "Xero Sync Error": "",
      "Last Synced Xero Date": xeroInvoice.UpdatedDateUTC || new Date().toISOString(),
    });

    // Xero returns LineItems in the same order they were submitted, so they can be
    // matched back to the source Airtable records by index.
    if (Array.isArray(xeroInvoice.LineItems)) {
      await Promise.all(
        xeroInvoice.LineItems.map((xeroLine: any, index: number) => {
          const record = lineItemRecords[index];
          if (!record || !xeroLine.LineItemID) return Promise.resolve();
          return updateRecord(TABLES.LINE_ITEMS, record.id, {
            "Xero Line Item ID": xeroLine.LineItemID,
          });
        })
      );
    }

    return new Response(
      JSON.stringify({ ok: true, xeroInvoiceId: xeroInvoice.InvoiceID, status: xeroInvoice.Status }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const error = err as Error;
    console.error("sync-invoice-to-xero error:", error);
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
  path: "/sync-invoice-to-xero",
};
