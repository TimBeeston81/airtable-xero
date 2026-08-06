const crypto = require("crypto");
const { findRecordByField, updateRecord } = require("./lib/airtable");
const { getAccessToken, getInvoice } = require("./lib/xero");

const TABLES = { INVOICES: "Invoices" };

function verifySignature(rawBody, signature) {
  if (!signature) return false;

  const computed = crypto
    .createHmac("sha256", process.env.XERO_WEBHOOK_KEY)
    .update(rawBody, "utf8")
    .digest("base64");

  const computedBuffer = Buffer.from(computed);
  const providedBuffer = Buffer.from(signature);

  if (computedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(computedBuffer, providedBuffer);
}

// Update-only: acts on an invoice only if a matching Xero Invoice ID already exists
// in Airtable. Never creates a record, so invoices raised directly in Xero (e.g.
// billable expenses) that never came from Airtable are silently ignored.
async function processEvent(evt, token) {
  if (evt.eventCategory !== "INVOICE") return;

  const xeroInvoice = await getInvoice(evt.resourceId, token);
  if (!xeroInvoice) return;

  // Kills noise from draft edits and keystrokes. There is no PAYMENT event category,
  // payments and reconciliations both arrive as INVOICE / UPDATE and are detected here.
  if (xeroInvoice.Status !== "AUTHORISED" && xeroInvoice.Status !== "PAID") return;

  const record = await findRecordByField(TABLES.INVOICES, "Xero Invoice ID", evt.resourceId);
  if (!record) return;

  const lastSynced = record.fields["Last Synced Xero Date"];
  const updatedDateUtc = xeroInvoice.UpdatedDateUTC;
  if (lastSynced && updatedDateUtc && new Date(updatedDateUtc).getTime() <= new Date(lastSynced).getTime()) {
    return; // No-op update, nothing has actually changed since the last write.
  }

  await updateRecord(TABLES.INVOICES, record.id, {
    "Xero Invoice Status": xeroInvoice.Status,
    "Last Synced Xero Date": updatedDateUtc || new Date().toISOString(),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  const signature = event.headers["x-xero-signature"];

  if (!verifySignature(rawBody, signature)) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  // Signature is valid: this also satisfies the Intent to Receive handshake, which
  // sends an empty events array and only checks for a 200 response to a valid signature.
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 200, body: "" };
  }

  const events = Array.isArray(payload.events) ? payload.events : [];

  try {
    const token = events.length > 0 ? await getAccessToken() : null;
    await Promise.all(
      events.map((evt) =>
        processEvent(evt, token).catch((err) => {
          console.error("xero-webhook event processing error:", evt.resourceId, err);
        })
      )
    );
  } catch (err) {
    console.error("xero-webhook error:", err);
  }

  return { statusCode: 200, body: "" };
};
