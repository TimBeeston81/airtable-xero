import * as xero from "./xero";
import { createSupabaseStore } from "./supabase-store";
import type { Deps } from "./invoice-sync";

// The real wiring: this deployment's Supabase project and Xero connection.
export function realDeps(): Deps {
  const url = Netlify.env.get("SUPABASE_URL") || "";
  const key = Netlify.env.get("SUPABASE_SECRET_KEY") || "";
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.");
  return { store: createSupabaseStore(url, key), xero: xero as unknown as Deps["xero"], env: (name) => Netlify.env.get(name) };
}
