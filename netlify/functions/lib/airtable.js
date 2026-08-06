const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

function tableUrl(table, suffix = "") {
  return `${AIRTABLE_API_BASE}/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${suffix}`;
}

async function airtableRequest(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_PAT}`,
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

function getRecord(table, recordId) {
  return airtableRequest("GET", tableUrl(table, `/${recordId}`));
}

function updateRecord(table, recordId, fields) {
  return airtableRequest("PATCH", tableUrl(table, `/${recordId}`), { fields });
}

async function findRecordByField(table, fieldName, value) {
  const escapedValue = value.replace(/"/g, '\\"');
  const formula = `{${fieldName}} = "${escapedValue}"`;
  const url = `${tableUrl(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const data = await airtableRequest("GET", url);
  return data.records?.[0] || null;
}

module.exports = { getRecord, updateRecord, findRecordByField };
