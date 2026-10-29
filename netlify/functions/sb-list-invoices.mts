import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "./lib/auth";
import { getAccessToken, listSalesInvoicesPage } from "./lib/xero";
import { listSalesInvoices } from "./lib/invoice-list";

// Called by WareHouse's "Check against Xero" page. Read-only: it lists the sales invoices Xero holds so WareHouse can
// compare them with its own. It writes nothing, to Xero or to the database.
export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!isAuthorized(req.headers.get("x-webhook-secret"))) return new Response("Unauthorized", { status: 401 });

  try {
    const token = await getAccessToken();
    const invoices = await listSalesInvoices((page) => listSalesInvoicesPage(page, token));
    return new Response(JSON.stringify({ ok: true, invoices }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch (err) {
    // As the other functions: a business failure is a 200 with ok:false so the page can say why.
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message.slice(0, 400) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};

export const config: Config = {
  path: "/supabase/list-invoices",
};
