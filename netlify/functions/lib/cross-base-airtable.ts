// The one place in this repo that writes into an Airtable base OTHER than WareHouse
// (lib/airtable.ts is deliberately single-base — WareHouse only, via AIRTABLE_BASE_ID/AIRTABLE_PAT).
// Used by sync-task-status.mts to write a WareHouse Task's mapped Status back onto whatever
// record created it. Onboarding a new origin base to that sync feature means adding one line here
// plus one new env var — never a new automation.
const TOKEN_ENV_BY_BASE_ID: Record<string, string> = {
  appHLaxm6scb5xGmA: "HYH_TICKETS_AIRTABLE_TOKEN", // HYH & TISC UK — Support Tickets sync-back only
};

export async function updateRecordInBase(
  baseId: string,
  tableId: string,
  recordId: string,
  fieldsById: Record<string, unknown>,
): Promise<void> {
  const envVar = TOKEN_ENV_BY_BASE_ID[baseId];
  if (!envVar) {
    throw new Error(`No token configured for base ${baseId} — add it to TOKEN_ENV_BY_BASE_ID in lib/cross-base-airtable.ts`);
  }
  const token = Netlify.env.get(envVar);
  if (!token) {
    throw new Error(`${envVar} is not set`);
  }

  // returnFieldsByFieldId=true so fieldsById keys can be fld... IDs (the origin's own
  // convention), matching how hyh-airtable-netlify's lib/airtable.js writes.
  const res = await fetch(
    `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}?returnFieldsByFieldId=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: fieldsById }),
    },
  );

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = data?.error?.message || JSON.stringify(data);
    throw new Error(`Cross-base update (${baseId}/${tableId}/${recordId}) failed (${res.status}): ${message}`);
  }
}
