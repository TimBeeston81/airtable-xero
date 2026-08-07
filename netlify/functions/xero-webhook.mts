import type { Context, Config } from "@netlify/functions";
import crypto from "node:crypto";
import { findRecordByField, updateRecord } from "./lib/airtable";
import { getAccessToken, getInvoice, parseXeroDate } from "./lib/xero";

const TABLES = { INVOICES: "Invoices" };

interface XeroWebhookEvent {
  resourceUrl: string;
  resourceId: string;
  eventDateUtc: string;
  eventType: string;
  eventCategory: string;
  tenantId: string;
  tenantType: string;
}

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;

  const webhookKey = Netlify.env.get("XERO_WEBHOOK_KEY");
  if (!webhookKey) return false;

  const computed = crypto.createHmac("sha256", webhookKey).update(rawBody, "utf8").digest("base64");

  const computedBuffer = Buffer.from(computed);
  const providedBuffer = Buffer.from(signature);

  if (computedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(computedBuffer, providedBuffer);
}

// Update-only: acts on an invoice only if a matching Xero Invoice ID already exists
// in Airtable. Never creates a record, so invoices raised directly in Xero (e.g.
// billable expenses) that never came from Airtable are silently ignored.
async function processEvent(evt: XeroWebhookEvent, token: string): Promise<void> {
  if (evt.eventCategory !== "INVOICE") return;

  const xeroInvoice = await getInvoice(evt.resourceId, token);
  if (!xeroInvoice) return;

  // Kills noise from draft edits and keystrokes. There is no PAYMENT event category,
  // payments and reconciliations both arrive as INVOICE / UPDATE and are detected here.
  if (xeroInvoice.Status !== "AUTHORISED" && xeroInvoice.Status !== "PAID") return;

  const record = await findRecordByField(TABLES.INVOICES, "Xero Invoice ID", evt.resourceId);
  if (!record) return;

  const lastSynced = record.fields["Last Synced Xero Date"];
  const updatedDateUtc = parseXeroDate(xeroInvoice.UpdatedDateUTC);
  if (lastSynced && updatedDateUtc && new Date(updatedDateUtc).getTime() <= new Date(lastSynced).getTime()) {
    return; // No-op update, nothing has actually changed since the last write.
  }

  await updateRecord(TABLES.INVOICES, record.id, {
    "Xero Invoice Status": xeroInvoice.Status,
    "Paid": xeroInvoice.AmountPaid ?? 0,
    "Last Synced Xero Date": updatedDateUtc || new Date().toISOString(),
  });
}

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-xero-signature");

  if (!verifySignature(rawBody, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Signature is valid: this also satisfies the Intent to Receive handshake, which
  // sends an empty events array and only checks for a 200 response to a valid signature.
  let payload: { events?: XeroWebhookEvent[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("", { status: 200 });
  }

  const events = Array.isArray(payload.events) ? payload.events : [];

  try {
    if (events.length > 0) {
      const token = await getAccessToken();
      await Promise.all(
        events.map((evt) =>
          processEvent(evt, token).catch((err) => {
            console.error("xero-webhook event processing error:", evt.resourceId, err);
          })
        )
      );
    }
  } catch (err) {
    console.error("xero-webhook error:", err);
  }

  return new Response("", { status: 200 });
};

export const config: Config = {
  path: "/xero-webhook",
};
