import type { Context, Config } from "@netlify/functions";
import { getRecord, updateRecord, buildLogEntry } from "./lib/airtable";
import { getAccessToken, getInvoice, upsertInvoice, createPayment, getOnlineInvoiceUrl, parseXeroDate } from "./lib/xero";
import { isAuthorized } from "./lib/auth";

const TABLES = {
  ORGANISATIONS: "Organisations",
  INVOICES: "Invoices",
  LINE_ITEMS: "Line Items",
};

const SOURCE = "sync-invoice-to-xero";

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

// A deposit the portal already collected by card. The Stripe fields are set by
// the portal when it raises the invoice; Xero Payment ID is set here once the
// payment has been recorded, and is what stops it being recorded twice — the
// Xero Accounting API has no idempotency key of its own.
function stripePaymentToRecord(fields: Record<string, any>): { amount: number; reference?: string } | null {
  if (fields["Xero Payment ID"]) return null;
  const amount = Number(fields["Stripe Amount Paid"] ?? 0);
  if (!(amount > 0)) return null;
  return { amount, reference: fields["Stripe Payment Intent"] || undefined };
}

// Posting the payment and re-reading the invoice is needed from two places: a
// first sync that creates the invoice, and a re-run finishing an earlier
// attempt that created the invoice but failed before paying it.
async function recordStripePayment(
  xeroInvoiceId: string,
  payment: { amount: number; reference?: string },
  token: string,
): Promise<{ paymentId?: string; invoice: any }> {
  const accountCode = Netlify.env.get("XERO_STRIPE_ACCOUNT_CODE");
  if (!accountCode) {
    throw new Error("XERO_STRIPE_ACCOUNT_CODE environment variable is not set.");
  }

  const created = await createPayment(
    {
      invoiceId: xeroInvoiceId,
      accountCode,
      amount: payment.amount,
      date: new Date().toISOString().slice(0, 10),
      reference: payment.reference,
    },
    token,
  );

  // Re-read so the write-back reflects PAID and the new AmountPaid rather than
  // the pre-payment state returned by the invoice call.
  const invoice = await getInvoice(xeroInvoiceId, token);
  return { paymentId: created?.PaymentID, invoice };
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
        // Editing an authorised invoice is still refused. But a previous run
        // may have created it and then failed before recording the card
        // payment, and that is worth being able to finish — otherwise the
        // money stays unreconciled with no way to retry short of voiding.
        const outstanding = stripePaymentToRecord(fields);
        if (!outstanding) {
          throw new Error(
            "Invoice already authorised in Xero. Void manually in Xero before editing here."
          );
        }

        const { paymentId, invoice: paidInvoice } = await recordStripePayment(
          existingInvoiceId,
          outstanding,
          token,
        );
        const details = `Card payment of ${outstanding.amount} recorded against ${paidInvoice.InvoiceNumber || existingInvoiceId}`;

        await updateRecord(TABLES.INVOICES, recordId, {
          "Xero Payment ID": paymentId,
          "Xero Invoice Status": paidInvoice.Status,
          "Paid": paidInvoice.AmountPaid ?? 0,
          "Xero Sync Status": "Synced",
          "Xero Sync Error": "",
          "Last Synced Xero Date": parseXeroDate(paidInvoice.UpdatedDateUTC) || new Date().toISOString(),
          "Automation Log": buildLogEntry("Success", details, SOURCE, fields["Automation Log"]),
        });

        return new Response(
          JSON.stringify({ ok: true, xeroInvoiceId: existingInvoiceId, status: paidInvoice.Status, paymentId }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // InvoiceNumber is deliberately omitted: Xero assigns it (requires automatic
    // invoice numbering to be enabled in Xero's Invoice settings), and the assigned
    // number is written back onto the Airtable record below.
    const invoicePayload = {
      Type: "ACCREC",
      Contact: { ContactID: contactId },
      LineItems: xeroLineItems,
      LineAmountType: "Exclusive",
      Status: "AUTHORISED",
      Reference: fields["Reference"] || undefined,
      Date: fields["Issue Date"] || undefined,
      DueDate: fields["Due Date"] || undefined,
      ...(existingInvoiceId ? { InvoiceID: existingInvoiceId } : {}),
    };

    let xeroInvoice = await upsertInvoice(invoicePayload, token);

    // If the portal already took the deposit by card, record it now that the
    // invoice exists in Xero — the payment can't be posted before there's an
    // InvoiceID to attach it to.
    let stripePaymentId: string | undefined;
    const outstandingPayment = stripePaymentToRecord(fields);
    if (outstandingPayment) {
      const paid = await recordStripePayment(xeroInvoice.InvoiceID, outstandingPayment, token);
      stripePaymentId = paid.paymentId;
      xeroInvoice = paid.invoice ?? xeroInvoice;
    }

    // The online invoice link is supplementary: if this call fails, the sync itself
    // still succeeded, so don't let it fail the whole write-back.
    let onlineInvoiceUrl: string | undefined;
    try {
      onlineInvoiceUrl = await getOnlineInvoiceUrl(xeroInvoice.InvoiceID, token);
    } catch (err) {
      console.error("Failed to fetch online invoice URL:", err);
    }

    const successDetails = stripePaymentId
      ? `Invoice synced to Xero (${xeroInvoice.InvoiceNumber || xeroInvoice.InvoiceID}) and card payment of ${outstandingPayment?.amount} recorded`
      : `Invoice synced to Xero (${xeroInvoice.InvoiceNumber || xeroInvoice.InvoiceID})`;

    await updateRecord(TABLES.INVOICES, recordId, {
      "Invoice Number": xeroInvoice.InvoiceNumber,
      "Xero Invoice ID": xeroInvoice.InvoiceID,
      "Xero Invoice Status": xeroInvoice.Status,
      "Paid": xeroInvoice.AmountPaid ?? 0,
      ...(stripePaymentId ? { "Xero Payment ID": stripePaymentId } : {}),
      "Invoice URL": onlineInvoiceUrl,
      "Xero Sync Status": "Synced",
      "Xero Sync Error": "",
      "Last Synced Xero Date": parseXeroDate(xeroInvoice.UpdatedDateUTC) || new Date().toISOString(),
      "Approved": true,
      "Automation Log": buildLogEntry("Success", successDetails, SOURCE, fields["Automation Log"]),
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
