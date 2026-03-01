import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const DEV_RESET_ENABLED = (Deno.env.get("DEV_RESET_ENABLED") ?? "").trim().toLowerCase() === "true";
const DEV_ADMIN_USER_IDS = (Deno.env.get("DEV_ADMIN_USER_IDS") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const DEV_ADMIN_EMAILS = (Deno.env.get("DEV_ADMIN_EMAILS") ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });

const notNullFilter = "id";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return json(200, { ok: true });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }
  if (!DEV_RESET_ENABLED) {
    return json(403, { error: "Dev reset is disabled." });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Server secrets are not configured." });
  }

  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return json(401, { error: "Missing bearer token." });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  });

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    return json(401, { error: "Invalid user session." });
  }

  const userId = authData.user.id;
  const userEmail = String(authData.user.email ?? "").trim().toLowerCase();
  const isAllowedAdmin =
    DEV_ADMIN_USER_IDS.includes(userId) || (userEmail && DEV_ADMIN_EMAILS.includes(userEmail));
  if (!isAllowedAdmin) {
    return json(403, { error: "Admin access required." });
  }

  const { error: deletePlansError } = await supabase
    .from("calendar_shared_plans")
    .delete()
    .not(notNullFilter, "is", null);
  if (deletePlansError) {
    return json(500, { error: `Failed clearing shared plans: ${deletePlansError.message}` });
  }

  const { error: deleteInvitesError } = await supabase
    .from("calendar_plan_invites")
    .delete()
    .not(notNullFilter, "is", null);
  if (deleteInvitesError) {
    return json(500, { error: `Failed clearing plan invites: ${deleteInvitesError.message}` });
  }

  const { error: deleteNotificationsError } = await supabase
    .from("calendar_notifications")
    .delete()
    .not(notNullFilter, "is", null);
  if (deleteNotificationsError) {
    return json(500, { error: `Failed clearing notifications: ${deleteNotificationsError.message}` });
  }

  return json(200, {
    ok: true,
    cleared: ["calendar_shared_plans", "calendar_plan_invites", "calendar_notifications"],
    at: new Date().toISOString(),
  });
});

