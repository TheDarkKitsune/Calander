import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type CalendarNotificationRecord = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  is_read: boolean;
};

type WebhookPayload = {
  type?: string;
  table?: string;
  schema?: string;
  record?: CalendarNotificationRecord;
};

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUSH_WEBHOOK_SECRET = Deno.env.get("PUSH_WEBHOOK_SECRET") ?? "";
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON") ?? "";

const decodePem = (pem: string) => {
  const cleaned = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const base64UrlEncode = (input: string | Uint8Array) => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const signJwt = async (account: ServiceAccount, nowSeconds: number) => {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePem(account.private_key),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
};

const getFcmAccessToken = async (account: ServiceAccount) => {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60_000) {
    return cachedAccessToken.token;
  }

  const nowSeconds = Math.floor(now / 1000);
  const jwt = await signJwt(account, nowSeconds);
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FCM OAuth failed: ${response.status} ${text}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: now + Math.max(300_000, (data.expires_in - 60) * 1000),
  };
  return data.access_token;
};

const sendFcm = async (
  account: ServiceAccount,
  accessToken: string,
  targetToken: string,
  notification: CalendarNotificationRecord,
) => {
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const body = {
    message: {
      token: targetToken,
      notification: {
        title: notification.title || "Calendar",
        body: notification.body || "You have a new update.",
      },
      data: {
        notification_id: String(notification.id ?? ""),
        type: String(notification.type ?? ""),
        user_id: String(notification.user_id ?? ""),
        plan_id: String(notification.payload?.plan_id ?? ""),
      },
      android: {
        priority: "high",
      },
      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.ok) return { ok: true as const, disableToken: false };

  const text = await response.text();
  const normalized = text.toLowerCase();
  const disableToken =
    normalized.includes("unregistered") ||
    normalized.includes("invalid registration") ||
    normalized.includes("registration-token-not-registered");

  return { ok: false as const, disableToken, error: `FCM send failed: ${response.status} ${text}` };
};

Deno.serve(async (req) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response("Missing Supabase env", { status: 500 });
    }
    if (!FCM_SERVICE_ACCOUNT_JSON) {
      return new Response("Missing FCM_SERVICE_ACCOUNT_JSON", { status: 500 });
    }

    if (PUSH_WEBHOOK_SECRET) {
      const incoming = req.headers.get("x-push-secret") ?? "";
      if (!incoming || incoming !== PUSH_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let payload: WebhookPayload | CalendarNotificationRecord | null = null;
    try {
      payload = (await req.json()) as WebhookPayload | CalendarNotificationRecord;
    } catch {
      payload = null;
    }
    const queryRecordRaw = new URL(req.url).searchParams.get("record");
    const queryRecord = (() => {
      if (!queryRecordRaw) return null;
      try {
        return JSON.parse(queryRecordRaw) as CalendarNotificationRecord;
      } catch {
        return null;
      }
    })();
    const record =
      ((payload as WebhookPayload | null)?.record ?? null) ??
      ((payload as CalendarNotificationRecord | null) ?? null) ??
      queryRecord;

    if (!record?.user_id || !record?.id) {
      return new Response(JSON.stringify({ skipped: true, reason: "Missing record/user_id" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (record.is_read) {
      return new Response(JSON.stringify({ skipped: true, reason: "Already read" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: tokens, error: tokenError } = await supabase
      .from("calendar_push_tokens")
      .select("id, token, enabled")
      .eq("user_id", record.user_id)
      .eq("enabled", true);

    if (tokenError) {
      return new Response(JSON.stringify({ error: tokenError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0, skipped: true, reason: "No tokens" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const account = JSON.parse(FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    const accessToken = await getFcmAccessToken(account);

    let sent = 0;
    const disableIds: string[] = [];
    const errors: string[] = [];

    for (const row of tokens as Array<{ id: string; token: string; enabled: boolean }>) {
      const result = await sendFcm(account, accessToken, row.token, record);
      if (result.ok) {
        sent += 1;
      } else {
        errors.push(result.error);
        if (result.disableToken) disableIds.push(row.id);
      }
    }

    if (disableIds.length > 0) {
      await supabase
        .from("calendar_push_tokens")
        .update({ enabled: false, last_seen_at: new Date().toISOString() })
        .in("id", disableIds);
    }

    return new Response(JSON.stringify({ sent, disabled: disableIds.length, errors }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
