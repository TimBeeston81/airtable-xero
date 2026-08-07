import crypto from "node:crypto";

// Constant-time comparison against WAREHOUSE_WEBHOOK_SECRET, shared by every
// function that's called directly from an Airtable Automation.
export function isAuthorized(providedSecret: string | null): boolean {
  const expected = Netlify.env.get("WAREHOUSE_WEBHOOK_SECRET");
  if (!providedSecret || !expected) return false;

  const providedBuffer = Buffer.from(providedSecret);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
