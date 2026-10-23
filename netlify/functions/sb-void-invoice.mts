import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import { voidInvoice } from "./lib/invoice-sync";
import { realDeps } from "./lib/supabase-deps";

// Called by WareHouse (not by an Airtable automation) with { invoiceId: <uuid> }.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  let invoiceId = "";
  try {
    invoiceId = String((await req.json()).invoiceId ?? "");
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!UUID.test(invoiceId)) return new Response("Missing or invalid invoiceId", { status: 400 });

  // Business failures are 200 with ok:false, as the Airtable versions, so the caller can show the reason.
  const result = await voidInvoice(realDeps(), invoiceId);
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config: Config = {
  path: "/supabase/void-invoice",
};
