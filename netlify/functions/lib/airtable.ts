export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

function tableUrl(table: string, suffix = ""): string {
  const baseId = Netlify.env.get("AIRTABLE_BASE_ID");
  return `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(table)}${suffix}`;
}

async function airtableRequest(method: string, url: string, body?: unknown): Promise<any> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${Netlify.env.get("AIRTABLE_PAT")}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || JSON.stringify(data);
    throw new Error(`Airtable API error (${response.status}): ${message}`);
  }

  return data;
}

export function getRecord(table: string, recordId: string): Promise<AirtableRecord> {
  return airtableRequest("GET", tableUrl(table, `/${recordId}`));
}

export function updateRecord(
  table: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<AirtableRecord> {
  return airtableRequest("PATCH", tableUrl(table, `/${recordId}`), { fields });
}

export async function findRecordByField(
  table: string,
  fieldName: string,
  value: string
): Promise<AirtableRecord | null> {
  const escapedValue = value.replace(/"/g, '\\"');
  const formula = `{${fieldName}} = "${escapedValue}"`;
  const url = `${tableUrl(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const data = await airtableRequest("GET", url);
  return data.records?.[0] || null;
}

// New entries go on top, older entries follow below a --- separator. Pass the
// Automation Log field's current value if already known (e.g. from an earlier
// getRecord/findRecordByField call in the same function) to avoid an extra fetch.
export function buildLogEntry(
  outcome: "Success" | "Error",
  details: string,
  source: string,
  existingLog: string | undefined | null
): string {
  const icon = outcome === "Success" ? "✅" : "❌";
  const entry = `${icon} ${outcome}: ${details} by ${source} at ${new Date().toISOString()}`;
  return existingLog ? `${entry}\n\n---\n\n${existingLog}` : entry;
}
