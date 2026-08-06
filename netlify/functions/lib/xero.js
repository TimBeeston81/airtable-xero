const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

// Custom Connection tokens expire after 30 minutes. Each function invocation is
// isolated, so a fresh token is requested every time rather than cached.
async function getAccessToken() {
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.XERO_CLIENT_ID,
    client_secret: process.env.XERO_CLIENT_SECRET,
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

async function xeroRequest(method, path, token, body) {
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
    const validationMessages = data?.Elements?.[0]?.ValidationErrors?.map((e) => e.Message).join("; ");
    const message = validationMessages || data?.Detail || data?.Message || JSON.stringify(data);
    throw new Error(`Xero API error (${response.status}): ${message}`);
  }

  return data;
}

async function getInvoice(invoiceId, token) {
  const data = await xeroRequest("GET", `/Invoices/${invoiceId}`, token);
  return data.Invoices?.[0];
}

// Xero uses POST for both create and update. Include InvoiceID in the payload to update.
async function upsertInvoice(invoicePayload, token) {
  const data = await xeroRequest("POST", "/Invoices", token, { Invoices: [invoicePayload] });
  return data.Invoices?.[0];
}

module.exports = { getAccessToken, getInvoice, upsertInvoice };
