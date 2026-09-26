import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client for the few writes users must never make themselves (grading detections,
 * migration 0009). Server only; null when SUPABASE_SERVICE_ROLE_KEY is not set.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
}
