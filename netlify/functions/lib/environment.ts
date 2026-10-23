// The one mistake that must be impossible: staging data raising invoices in the real
// Xero books, or real data going to the demo company. Each deployment is configured
// with one Supabase project and one Xero connection; this refuses any pairing that
// isn't "production database with the real Xero" or "staging database with a Xero
// demo company". It runs before every sync, void and webhook.

export const PRODUCTION_SUPABASE_REF = "ldfusqzcrcidkqpgqpep";

// Xero's demo companies are named "Demo Company (UK)", "(US)", "(Global)" and so on.
const DEMO_NAME = /^demo company\b/i;

// Returns null when the pairing is allowed, otherwise a sentence saying why not.
export function checkPairing(supabaseUrl: string | undefined, xeroOrganisationName: string): string | null {
  const url = (supabaseUrl ?? "").trim();
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(url)) {
    return "SUPABASE_URL is missing or isn't a Supabase project address.";
  }
  if (!xeroOrganisationName.trim()) return "Couldn't read the Xero organisation's name.";
  const production = url.includes(PRODUCTION_SUPABASE_REF);
  const demo = DEMO_NAME.test(xeroOrganisationName.trim());
  if (production && demo) return `The production database is connected to a Xero demo company (${xeroOrganisationName}). Refusing.`;
  if (!production && !demo) {
    return `A non-production database is connected to a real Xero organisation (${xeroOrganisationName}). Refusing: only a demo company may be used with staging.`;
  }
  return null;
}
