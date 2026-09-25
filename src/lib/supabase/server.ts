import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

export const isSupabaseConfigured = () => supabaseConfig() !== null;

/** Per-request client bound to the user's auth cookies. RLS applies. */
export async function createClient() {
  const cfg = supabaseConfig();
  if (!cfg) throw new Error("Supabase is not configured");
  const cookieStore = await cookies();
  return createServerClient(cfg.url, cfg.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there. The
          // proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

export interface CurrentUser {
  id: string;
  email: string | null;
  displayName: string;
  isStaff: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (!sub) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, is_staff")
    .eq("id", sub)
    .maybeSingle();
  return {
    id: sub,
    email: (data.claims.email as string | undefined) ?? null,
    displayName: profile?.display_name ?? "Coleccionista",
    isStaff: profile?.is_staff ?? false,
  };
}
