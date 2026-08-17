const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

// Custom Connection tokens expire after 30 minutes. Each function invocation is
// isolated, so a fresh token is requested every time rather than cached.
export async function getAccessToken(): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: Netlify.env.get("XERO_CLIENT_ID") || "",
    client_secret: Netlify.env.get("XERO_CLIENT_SECRET") || "",
  });

  const response = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Xero token request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function xeroRequest(method: string, path: string, token: string, body?: unknown): Promise<any> {
  const response = await fetch(`${XERO_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const validationMessages = data?.Elements?.[0]?.ValidationErrors?.map((e: any) => e.Message).join("; ");
    const message = validationMessages || data?.Detail || data?.Message || JSON.stringify(data);
    throw new Error(`Xero API error (${response.status}): ${message}`);
  }

  return data;
}

// Xero's Accounting API returns datetimes in the old .NET JSON date format
// (e.g. "/Date(1786025738277+0000)/"), not ISO8601, despite the Accept: application/json
// header. Airtable's dateTime field rejects that format outright, so it must be converted.
export function parseXeroDate(value: string | undefined | null): string | undefined {
  if (!value) return undefined;

  const netDateMatch = value.match(/^\/Date\((\d+)([+-]\d{4})?\)\/$/);
  if (netDateMatch) {
    return new Date(Number(netDateMatch[1])).toISOString();
  }

  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export async function getInvoice(invoiceId: string, token: string): Promise<any> {
  const data = await xeroRequest("GET", `/Invoices/${invoiceId}`, token);
  return data.Invoices?.[0];
}

// Xero uses POST for both create and update. Include InvoiceID in the payload to update.
export async function upsertInvoice(invoicePayload: Record<string, unknown>, token: string): Promise<any> {
  const data = await xeroRequest("POST", "/Invoices", token, { Invoices: [invoicePayload] });
  return data.Invoices?.[0];
}

// Records a payment against an invoice, so Xero shows it as PAID rather than
// leaving the money to be reconciled by hand. Used for deposits the portal has
// already collected by card.
//
// `accountCode` is the account the money lands in (the Stripe account), which
// is not the revenue account the invoice's line items are coded to.
//
// Note there is no idempotency key on the Accounting API — calling this twice
// records two payments and overpays the invoice, so callers must guard on the
// stored PaymentID.
export async function createPayment(
  payment: { invoiceId: string; accountCode: string; amount: number; date: string; reference?: string },
  token: string,
): Promise<any> {
  const data = await xeroRequest("PUT", "/Payments", token, {
    Payments: [
      {
        Invoice: { InvoiceID: payment.invoiceId },
        Account: { Code: payment.accountCode },
        Date: payment.date,
        Amount: payment.amount,
        ...(payment.reference ? { Reference: payment.reference } : {}),
      },
    ],
  });
  return data.Payments?.[0];
}

// The customer-facing "pay online" link. Separate endpoint, not part of the Invoice object itself.
export async function getOnlineInvoiceUrl(invoiceId: string, token: string): Promise<string | undefined> {
  const data = await xeroRequest("GET", `/Invoices/${invoiceId}/OnlineInvoice`, token);
  return data.OnlineInvoices?.[0]?.OnlineInvoiceUrl;
}
