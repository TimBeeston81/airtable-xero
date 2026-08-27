import type { Context, Config } from "@netlify/functions";
import { getRecord, updateRecord, buildLogEntry } from "./lib/airtable";
import {
  getAccessToken,
  getInvoice,
  upsertInvoice,
  createPayment,
  getOnlineInvoiceUrl,
  findContactByName,
  createContact,
  parseXeroDate,
} from "./lib/xero";
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

// Resolves the Organisation's Xero Contact ID, searching Xero by exact name
// match first and creating a new contact only if none is found. Writes the
// result back onto the Organisation record immediately, decoupled from the
// rest of the invoice sync - so if something later in this run fails, a
// retry finds Xero Contact ID already set rather than searching/creating
// again and risking a duplicate contact.
async function resolveContactId(
  organisation: { id: string; fields: Record<string, any> },
  organisationId: string,
  token: string,
): Promise<string> {
  const existing = organisation.fields["Xero Contact ID"];
  if (existing) return existing;

  const name = organisation.fields["Organisation"];
  if (!name) {
    throw new Error("Organisation has no name to match or create a Xero contact with.");
  }

  const matched = await findContactByName(name, token);
  let contactId: string;

  if (matched) {
    contactId = matched.ContactID;
  } else {
    const email = organisation.fields["Primary Contact Email"]?.[0];
    const phone = organisation.fields["Phone"];
    const addressLine1 = organisation.fields["Address line 1"];
    const addressLine2 = organisation.fields["Address line 2"];
    const city = organisation.fields["City"];
    const region = organisation.fields["State/Region"];
    const postcode = organisation.fields["Postcode"];
    const country = organisation.fields["Country"];
    const hasAddress = addressLine1 || city || postcode;

    const created = await createContact(
      {
        Name: name,
        EmailAddress: email || undefined,
        Phones: phone ? [{ PhoneType: "DEFAULT", PhoneNumber: phone }] : undefined,
        Addresses: hasAddress
          ? [
              {
                AddressType: "STREET",
                AddressLine1: addressLine1 || undefined,
                AddressLine2: addressLine2 || undefined,
                City: city || undefined,
                Region: region || undefined,
                PostalCode: postcode || undefined,
                Country: country || undefined,
              },
            ]
          : undefined,
      },
      token,
    );
    contactId = created.ContactID;
  }

  await updateRecord(TABLES.ORGANISATIONS, organisationId, { "Xero Contact ID": contactId });
  return contactId;
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

// Attempts the payment and reports the outcome, but deliberately never
// throws. A payment failure here must never cost the caller the fact that
// the *invoice* itself already exists in Xero and has been written back —
// losing that would leave Xero Invoice ID blank in Airtable, and the next
// sync attempt would create a second, duplicate invoice rather than finding
// the one that's already there. Xero Sync Status is left as "Synced" on a
// payment failure for the same reason: the invoice sync genuinely succeeded,
// only the payment needs retrying, and the AUTHORISED-with-outstanding-
// payment branch above is what handles that retry.
async function tryRecordStripePayment(
  recordId: string,
  xeroInvoiceId: string,
  payment: { amount: number; reference?: string },
  token: string,
  precedingLog: string,
): Promise<void> {
  try {
    const { paymentId, invoice } = await recordStripePayment(xeroInvoiceId, payment, token);
    await updateRecord(TABLES.INVOICES, recordId, {
      "Xero Payment ID": paymentId,
      "Xero Invoice Status": invoice.Status,
      "Paid": invoice.AmountPaid ?? 0,
      "Balance": invoice.Total ?? 0,
      "Last Synced Xero Date": parseXeroDate(invoice.UpdatedDateUTC) || new Date().toISOString(),
      "Automation Log": buildLogEntry(
        "Success",
        `Card payment of ${payment.amount} recorded against ${invoice.InvoiceNumber || xeroInvoiceId}`,
        SOURCE,
        precedingLog,
      ),
    });
  } catch (err) {
    const error = err as Error;
    console.error("Failed to record Stripe payment in Xero:", error);
    await updateRecord(TABLES.INVOICES, recordId, {
      "Xero Sync Error": `Invoice synced but card payment not recorded: ${error.message}`,
      "Automation Log": buildLogEntry(
        "Error",
        `Card payment of ${payment.amount} could not be recorded — ${error.message}`,
        SOURCE,
        precedingLog,
      ),
    });
  }
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

    const token = await getAccessToken();

    const contactId = await resolveContactId(organisation, organisationId, token);

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

        // The invoice itself is untouched here — it already existed and is
        // already correctly reflected in Airtable — so mark the sync clean
        // before attempting the payment, on the same reasoning as the
        // first-sync path below: a payment failure must not read as the sync
        // having failed.
        await updateRecord(TABLES.INVOICES, recordId, {
          "Xero Sync Status": "Synced",
          "Xero Sync Error": "",
        });
        await tryRecordStripePayment(recordId, existingInvoiceId, outstanding, token, fields["Automation Log"]);

        return new Response(
          JSON.stringify({ ok: true, xeroInvoiceId: existingInvoiceId }),
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

    const xeroInvoice = await upsertInvoice(invoicePayload, token);

    // The online invoice link is supplementary: if this call fails, the sync itself
    // still succeeded, so don't let it fail the whole write-back.
    let onlineInvoiceUrl: string | undefined;
    try {
      onlineInvoiceUrl = await getOnlineInvoiceUrl(xeroInvoice.InvoiceID, token);
    } catch (err) {
      console.error("Failed to fetch online invoice URL:", err);
    }

    const syncedLog = buildLogEntry(
      "Success",
      `Invoice synced to Xero (${xeroInvoice.InvoiceNumber || xeroInvoice.InvoiceID})`,
      SOURCE,
      fields["Automation Log"],
    );

    // Written back before the payment is attempted, deliberately — see
    // tryRecordStripePayment for why a payment failure must never cost us
    // this. If the process died here (rather than throwing), the next sync
    // would see Xero Invoice ID already set and correctly fall into the
    // AUTHORISED-with-outstanding-payment branch above instead of creating a
    // second invoice.
    await updateRecord(TABLES.INVOICES, recordId, {
      "Invoice Number": xeroInvoice.InvoiceNumber,
      "Xero Invoice ID": xeroInvoice.InvoiceID,
      "Xero Invoice Status": xeroInvoice.Status,
      "Paid": xeroInvoice.AmountPaid ?? 0,
      "Balance": xeroInvoice.Total ?? 0,
      "Invoice URL": onlineInvoiceUrl,
      "Xero Sync Status": "Synced",
      "Xero Sync Error": "",
      "Last Synced Xero Date": parseXeroDate(xeroInvoice.UpdatedDateUTC) || new Date().toISOString(),
      "Approved": true,
      "Automation Log": syncedLog,
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

    // If the portal already took the deposit by card, record it now that the
    // invoice exists in Xero — the payment can't be posted before there's an
    // InvoiceID to attach it to. Failure here is reported but doesn't affect
    // the response below: the invoice sync itself succeeded regardless.
    const outstandingPayment = stripePaymentToRecord(fields);
    if (outstandingPayment) {
      await tryRecordStripePayment(recordId, xeroInvoice.InvoiceID, outstandingPayment, token, syncedLog);
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
