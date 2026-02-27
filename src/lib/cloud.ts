import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import {
  hasAuthOverrideTokens,
  readAuthOverrideTokens,
  readSharedAuthOverrideTokens,
} from "@enderfall/runtime";

declare global {
  // eslint-disable-next-line no-var
  var __calanderSupabase: SupabaseClient | undefined;
}

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
export const cloudTable = (import.meta.env.VITE_SUPABASE_CALENDAR_TABLE ?? "holiday_calendars").trim();
export const isCloudConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const createSupabaseClient = () =>
  {
    if (typeof window !== "undefined") {
      try {
        const projectRef = (() => {
          try {
            const url = new URL(supabaseUrl);
            return url.hostname.split(".")[0] ?? "";
          } catch {
            return "";
          }
        })();
        const legacyKey = "calander-auth";
        const defaultKey = projectRef ? `sb-${projectRef}-auth-token` : "";
        if (defaultKey) {
          const legacyValue = window.localStorage.getItem(legacyKey);
          const defaultValue = window.localStorage.getItem(defaultKey);
          if (legacyValue && !defaultValue) {
            window.localStorage.setItem(defaultKey, legacyValue);
          }
        }
      } catch {
        // ignore storage migration errors
      }
    }

    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  };

const supabase: SupabaseClient | null = isCloudConfigured
  ? (globalThis.__calanderSupabase ?? (globalThis.__calanderSupabase = createSupabaseClient()))
  : null;
// Notification inserts are frequently blocked by RLS for cross-user writes.
// Keep invite sync independent from notification writes.
let canWriteCalendarNotifications = false;

const readOverrideTokens = async () => {
  const local = readAuthOverrideTokens();
  if (local?.access_token && local.refresh_token) {
    return local;
  }
  const shared = await readSharedAuthOverrideTokens();
  if (shared?.access_token && shared.refresh_token) {
    return shared;
  }
  return null;
};

export const hasCloudOverrideTokens = () => hasAuthOverrideTokens();
export const hasAnyCloudOverrideTokens = async () => {
  if (hasAuthOverrideTokens()) return true;
  const shared = await readSharedAuthOverrideTokens();
  return Boolean(shared?.access_token && shared.refresh_token);
};

export type CloudRecord = {
  room_id: string;
  payload: unknown;
  updated_at: string | null;
  updated_by: string | null;
};

export type CloudMember = {
  user_id: string;
  member_email: string;
  role: "owner" | "member";
  created_at: string | null;
};

export type CloudFriend = {
  friendship_id: string;
  user_id: string;
  username: string;
  avatar_url?: string | null;
  active?: boolean;
};

export type CloudProfile = {
  id: string;
  username: string | null;
  avatar_url: string | null;
};

export const getCloudUser = async () => {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
};

export const syncCloudSessionFromOverride = async () => {
  if (!supabase) {
    return { user: null as User | null, error: "Cloud is not configured." };
  }
  const tokens = await readOverrideTokens();
  if (!tokens?.access_token || !tokens.refresh_token) {
    return { user: null as User | null, error: null as string | null };
  }
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (sessionError) {
    return { user: null as User | null, error: sessionError.message };
  }
  const { data, error } = await supabase.auth.getUser();
  return { user: data.user ?? null, error: error?.message ?? null };
};

export const listCloudFriends = async (userId: string) => {
  if (!supabase) {
    return { friends: [] as CloudFriend[], error: "Cloud is not configured." };
  }
  try {
    const { data: rows, error: rowsError } = await supabase
      .from("friendships")
      .select("id, user_id, friend_id, status")
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
      .eq("status", "accepted");
    if (rowsError) return { friends: [] as CloudFriend[], error: rowsError.message };

    const acceptedRows = (rows ?? []) as Array<{
      id: string;
      user_id: string;
      friend_id: string;
      status?: string | null;
    }>;

    const friendIds = [...new Set(
      acceptedRows.map((row) => (row.user_id === userId ? row.friend_id : row.user_id)).filter(Boolean)
    )];
    if (friendIds.length === 0) {
      return { friends: [] as CloudFriend[], error: null as string | null };
    }

    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, username, avatar_url")
      .in("id", friendIds);
    if (profilesError) {
      return { friends: [] as CloudFriend[], error: profilesError.message };
    }
    const profileById = new Map(
      ((profiles ?? []) as Array<{ id: string; username?: string | null; avatar_url?: string | null }>).map((profile) => [
        profile.id,
        {
          username: profile.username?.trim() || "Friend",
          avatar_url: profile.avatar_url ?? null,
        },
      ])
    );

    let activeFriendIds = new Set<string>();
    const { data: statuses, error: statusError } = await supabase
      .from("user_status")
      .select("user_id, status")
      .in("user_id", friendIds);
    if (!statusError) {
      activeFriendIds = new Set(
        ((statuses ?? []) as Array<{ user_id: string; status?: string | null }>)
          .filter((entry) => entry.user_id && (entry.status ?? "offline") !== "offline")
          .map((entry) => entry.user_id)
      );
    }

    const friends: CloudFriend[] = [];
    const used = new Set<string>();
    for (const row of acceptedRows) {
      const friendId = row.user_id === userId ? row.friend_id : row.user_id;
      if (!friendId || used.has(friendId)) continue;
      friends.push({
        friendship_id: row.id,
        user_id: friendId,
        username: profileById.get(friendId)?.username ?? "Friend",
        avatar_url: profileById.get(friendId)?.avatar_url ?? null,
        active: activeFriendIds.has(friendId),
      });
      used.add(friendId);
    }
    return { friends, error: null as string | null };
  } catch (error) {
    return { friends: [] as CloudFriend[], error: error instanceof Error ? error.message : "Failed to load friends." };
  }
};

export const onCloudFriendStatusChange = (friendUserIds: string[], onChange: () => void) => {
  if (!supabase || friendUserIds.length === 0) return () => undefined;
  const friendIdSet = new Set(friendUserIds);
  const channel = supabase
    .channel(`calendar-friend-status-${friendUserIds.slice(0, 6).join("-")}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "user_status" }, (payload) => {
      const nextUserId = String((payload as { new?: { user_id?: string } }).new?.user_id ?? "");
      const prevUserId = String((payload as { old?: { user_id?: string } }).old?.user_id ?? "");
      if (friendIdSet.has(nextUserId) || friendIdSet.has(prevUserId)) {
        onChange();
      }
    })
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
};

export const getCloudProfile = async (userId: string) => {
  if (!supabase) return { profile: null as CloudProfile | null, error: "Cloud is not configured." };
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, avatar_url")
    .eq("id", userId)
    .maybeSingle<CloudProfile>();
  return { profile: data ?? null, error: error?.message ?? null };
};

export const sendCloudFriendRequestByUsername = async (userId: string, username: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const normalized = username.trim();
  if (!normalized) {
    return { error: "Enter a username." };
  }
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, username")
    .ilike("username", normalized)
    .maybeSingle<{ id: string; username: string }>();
  if (profileError) {
    return { error: profileError.message };
  }
  if (!profile) {
    return { error: "User not found." };
  }
  if (profile.id === userId) {
    return { error: "You cannot friend yourself." };
  }

  const { data: existing, error: existingError } = await supabase
    .from("friendships")
    .select("id")
    .or(`and(user_id.eq.${userId},friend_id.eq.${profile.id}),and(user_id.eq.${profile.id},friend_id.eq.${userId})`)
    .limit(1);
  if (existingError) {
    return { error: existingError.message };
  }
  if ((existing ?? []).length > 0) {
    return { error: "Friendship or request already exists." };
  }

  const { error } = await supabase.from("friendships").insert({
    user_id: userId,
    friend_id: profile.id,
    status: "pending",
  });
  if (error) return { error: error.message };

  const { error: notificationError } = await supabase.from("calendar_notifications").insert({
    user_id: profile.id,
    type: "friend_request",
    title: "Friend request",
    body: `${normalized} sent you a friend request.`,
    payload: { requester_id: userId },
  });
  return { error: notificationError?.message ?? null };
};

export const removeCloudFriend = async (friendshipId: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.from("friendships").delete().eq("id", friendshipId);
  return { error: error?.message ?? null };
};

export const onCloudAuthStateChange = (handler: (user: User | null) => void) => {
  if (!supabase) {
    handler(null);
    return () => undefined;
  }
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    handler(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
};

export const signInCloud = async (email: string, password: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: error?.message ?? null };
};

export const signUpCloud = async (email: string, password: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.auth.signUp({ email, password });
  return { error: error?.message ?? null };
};

export const signOutCloud = async () => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.auth.signOut();
  return { error: error?.message ?? null };
};

export const createCloudRoom = async (roomId: string, joinCode: string, payload: unknown) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.rpc("create_holiday_room", {
    p_room_id: roomId,
    p_join_code: joinCode,
    p_payload: payload,
  });
  return { error: error?.message ?? null };
};

export const joinCloudRoom = async (roomId: string, joinCode: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.rpc("join_holiday_room", {
    p_room_id: roomId,
    p_join_code: joinCode,
  });
  return { error: error?.message ?? null };
};

export const listCloudRoomMembers = async (roomId: string) => {
  if (!supabase) {
    return { members: [] as CloudMember[], error: "Cloud is not configured." };
  }
  const { data, error } = await supabase.rpc("list_holiday_room_members", {
    p_room_id: roomId,
  });
  if (error) {
    return { members: [] as CloudMember[], error: error.message };
  }
  return {
    members: (data ?? []) as CloudMember[],
    error: null as string | null,
  };
};

export const inviteCloudRoomMember = async (roomId: string, email: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.rpc("invite_holiday_room_member", {
    p_room_id: roomId,
    p_member_email: email,
  });
  return { error: error?.message ?? null };
};

export const removeCloudRoomMember = async (roomId: string, email: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.rpc("remove_holiday_room_member", {
    p_room_id: roomId,
    p_member_email: email,
  });
  return { error: error?.message ?? null };
};

export const rotateCloudRoomJoinCode = async (roomId: string, joinCode: string) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }
  const { error } = await supabase.rpc("rotate_holiday_room_join_code", {
    p_room_id: roomId,
    p_new_join_code: joinCode,
  });
  return { error: error?.message ?? null };
};

export const readCloudRoom = async (roomId: string) => {
  if (!supabase) {
    return { record: null as CloudRecord | null, error: "Cloud is not configured." };
  }
  const { data, error } = await supabase
    .from(cloudTable)
    .select("room_id,payload,updated_at,updated_by")
    .eq("room_id", roomId)
    .maybeSingle<CloudRecord>();

  if (error) {
    return { record: null as CloudRecord | null, error: error.message };
  }

  return { record: data ?? null, error: null as string | null };
};

export const writeCloudRoom = async (roomId: string, payload: unknown) => {
  if (!supabase) {
    return { error: "Cloud is not configured." };
  }

  const user = await getCloudUser();
  if (!user) {
    return { error: "Please sign in first." };
  }

  const { error } = await supabase.from(cloudTable).upsert(
    {
      room_id: roomId,
      payload,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "room_id" }
  );

  return { error: error?.message ?? null };
};

export type SharedGroupPayload = {
  owner_id: string;
  group_key: string;
  name: string;
  icon: string;
  color: string;
};

export type SharedPlanPayload = {
  id: string;
  owner_id: string;
  name: string;
  summary?: string | null;
  location?: string | null;
  from_date: string;
  to_date: string;
  all_day: boolean;
  from_time: string;
  to_time: string;
  target_group_ids: string[];
  invited_ids: string[];
};

export type SharedGroupRecord = {
  owner_id: string;
  group_key: string;
  name: string;
  icon: string;
  color: string;
};

export type SharedInvitePayload = {
  id: string;
  plan_id: string;
  inviter_id: string;
  invitee_id: string;
  status: "pending" | "going" | "maybe" | "cant" | "accepted" | "rejected";
  created_at: string | null;
  updated_at: string | null;
};
export type OwnedPlanInviteStatus = {
  plan_id: string;
  invitee_id: string;
  status: "pending" | "going" | "maybe" | "cant" | "accepted" | "rejected";
};

export type CloudNotification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
};

export type PushPlatform = "android" | "ios" | "web";

export const registerPushToken = async (
  userId: string,
  token: string,
  platform: PushPlatform,
  deviceLabel: string | null = null
) => {
  if (!supabase) return { error: "Cloud is not configured." };
  const normalizedToken = token.trim();
  if (!normalizedToken) return { error: "Push token is empty." };
  const { error } = await supabase.from("calendar_push_tokens").upsert(
    {
      user_id: userId,
      token: normalizedToken,
      platform,
      device_label: deviceLabel,
      enabled: true,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "token" }
  );
  return { error: error?.message ?? null };
};

export const disablePushToken = async (userId: string, token: string) => {
  if (!supabase) return { error: "Cloud is not configured." };
  const normalizedToken = token.trim();
  if (!normalizedToken) return { error: null as string | null };
  const { error } = await supabase
    .from("calendar_push_tokens")
    .update({ enabled: false, last_seen_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("token", normalizedToken);
  return { error: error?.message ?? null };
};

export const upsertSharedGroups = async (ownerId: string, groups: SharedGroupPayload[]) => {
  if (!supabase) return { error: "Cloud is not configured." };
  if (groups.length === 0) return { error: null as string | null };
  const payload = groups.map((group) => ({ ...group, owner_id: ownerId }));
  const { error } = await supabase
    .from("calendar_shared_groups")
    .upsert(payload, { onConflict: "owner_id,group_key" });
  return { error: error?.message ?? null };
};

export const upsertSharedPlans = async (ownerId: string, plans: SharedPlanPayload[]) => {
  if (!supabase) return { error: "Cloud is not configured." };
  const payload = plans.map((plan) => ({ ...plan, owner_id: ownerId }));
  const { error } = await supabase.from("calendar_shared_plans").upsert(payload, { onConflict: "id" });
  return { error: error?.message ?? null };
};

export const deleteSharedPlan = async (ownerId: string, planId: string) => {
  if (!supabase) return { error: "Cloud is not configured." };
  const { error } = await supabase
    .from("calendar_shared_plans")
    .delete()
    .eq("id", planId)
    .eq("owner_id", ownerId);
  return { error: error?.message ?? null };
};

export const syncSharedPlanInvites = async (ownerId: string, planId: string, inviteeIds: string[]) => {
  if (!supabase) return { error: "Cloud is not configured." };

  const { data: existingRows, error: existingError } = await supabase
    .from("calendar_plan_invites")
    .select("id, invitee_id, inviter_id, status")
    .eq("plan_id", planId);
  if (existingError) return { error: existingError.message };

  const existing = (existingRows ?? []) as Array<{ id: string; invitee_id: string; inviter_id: string; status: string }>;
  const existingByInvitee = new Map(existing.map((row) => [row.invitee_id, row]));
  const desiredSet = new Set(inviteeIds);

  const toInsert = inviteeIds.filter((id) => !existingByInvitee.has(id));
  const toDelete = existing
    .filter((row) => row.inviter_id === ownerId && !desiredSet.has(row.invitee_id))
    .map((row) => row.id);

  if (toInsert.length > 0) {
    const rows = toInsert.map((inviteeId) => ({
      plan_id: planId,
      inviter_id: ownerId,
      invitee_id: inviteeId,
      status: "pending",
    }));
    const { error } = await supabase.from("calendar_plan_invites").insert(rows);
    if (error) {
      const code = ((error as { code?: string } | null)?.code ?? "").toLowerCase();
      const message = (error.message ?? "").toLowerCase();
      const isDuplicateConflict = code === "23505" || message.includes("duplicate key") || message.includes("conflict");
      if (!isDuplicateConflict) return { error: error.message };
    }

    const notifications = toInsert.map((inviteeId) => ({
      user_id: inviteeId,
      type: "plan_invite",
      title: "New plan invite",
      body: "You have been invited to a plan.",
      payload: { plan_id: planId, inviter_id: ownerId },
    }));
    if (canWriteCalendarNotifications) {
      const { error: notificationError } = await supabase.from("calendar_notifications").insert(notifications);
      if (notificationError) {
        const message = (notificationError.message ?? "").toLowerCase();
        if (message.includes("forbidden") || message.includes("permission") || message.includes("row-level security")) {
          canWriteCalendarNotifications = false;
        }
        // Notification policies can block cross-user inserts; invites should still succeed.
      }
    }
  }

  if (toDelete.length > 0) {
    const { error } = await supabase.from("calendar_plan_invites").delete().in("id", toDelete);
    if (error) return { error: error.message };
  }

  return { error: null as string | null };
};

export const listVisibleSharedPlans = async (userId: string) => {
  if (!supabase) {
    return { plans: [] as SharedPlanPayload[], error: "Cloud is not configured." };
  }
  const { data: ownedRows, error: ownedError } = await supabase
    .from("calendar_shared_plans")
    .select("*")
    .eq("owner_id", userId);
  if (ownedError) return { plans: [] as SharedPlanPayload[], error: ownedError.message };

  const { data: acceptedInvites, error: inviteError } = await supabase
    .from("calendar_plan_invites")
    .select("plan_id,status")
    .eq("invitee_id", userId)
    .in("status", ["pending", "going", "maybe", "accepted"]);
  if (inviteError) return { plans: [] as SharedPlanPayload[], error: inviteError.message };

  const invitedPlanIds = [...new Set((acceptedInvites ?? []).map((row) => (row as { plan_id: string }).plan_id))];
  const { data: invitedByVisibilityRows, error: invitedByVisibilityError } = await supabase
    .from("calendar_shared_plans")
    .select("*")
    .contains("invited_ids", [userId]);
  if (invitedByVisibilityError) return { plans: [] as SharedPlanPayload[], error: invitedByVisibilityError.message };

  let invitedRows: SharedPlanPayload[] = [];
  if (invitedPlanIds.length > 0) {
    const { data, error } = await supabase
      .from("calendar_shared_plans")
      .select("*")
      .in("id", invitedPlanIds);
    if (error) return { plans: [] as SharedPlanPayload[], error: error.message };
    invitedRows = (data ?? []) as SharedPlanPayload[];
  }

  const merged = [
    ...((ownedRows ?? []) as SharedPlanPayload[]),
    ...invitedRows,
    ...((invitedByVisibilityRows ?? []) as SharedPlanPayload[]),
  ];
  const byId = new Map<string, SharedPlanPayload>();
  merged.forEach((plan) => byId.set(plan.id, plan));
  return { plans: [...byId.values()], error: null as string | null };
};

export const listSharedGroupsForOwners = async (ownerIds: string[]) => {
  if (!supabase) {
    return { groups: [] as SharedGroupRecord[], error: "Cloud is not configured." };
  }
  const uniqueOwners = [...new Set(ownerIds.filter(Boolean))];
  if (uniqueOwners.length === 0) {
    return { groups: [] as SharedGroupRecord[], error: null as string | null };
  }
  const { data, error } = await supabase
    .from("calendar_shared_groups")
    .select("owner_id,group_key,name,icon,color")
    .in("owner_id", uniqueOwners);
  return { groups: (data ?? []) as SharedGroupRecord[], error: error?.message ?? null };
};

export const listIncomingPlanInvites = async (userId: string) => {
  if (!supabase) {
    return { invites: [] as SharedInvitePayload[], error: "Cloud is not configured." };
  }
  const { data, error } = await supabase
    .from("calendar_plan_invites")
    .select("*")
    .eq("invitee_id", userId)
    .order("created_at", { ascending: false });
  return { invites: ((data ?? []) as SharedInvitePayload[]), error: error?.message ?? null };
};

export const listOwnedPlanInvites = async (ownerId: string, planIds: string[] = []) => {
  if (!supabase) {
    return { invites: [] as OwnedPlanInviteStatus[], error: "Cloud is not configured." };
  }
  let query = supabase
    .from("calendar_plan_invites")
    .select("plan_id,invitee_id,status")
    .eq("inviter_id", ownerId);
  const uniquePlanIds = [...new Set(planIds.filter(Boolean))];
  if (uniquePlanIds.length > 0) {
    query = query.in("plan_id", uniquePlanIds);
  }
  const { data, error } = await query;
  return { invites: ((data ?? []) as OwnedPlanInviteStatus[]), error: error?.message ?? null };
};

export const respondToPlanInvite = async (inviteId: string, response: "going" | "maybe" | "cant") => {
  if (!supabase) return { error: "Cloud is not configured." };
  const { error } = await supabase
    .from("calendar_plan_invites")
    .update({ status: response })
    .eq("id", inviteId);
  return { error: error?.message ?? null };
};

export const listNotifications = async (userId: string) => {
  if (!supabase) {
    return { notifications: [] as CloudNotification[], error: "Cloud is not configured." };
  }
  const { data, error } = await supabase
    .from("calendar_notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  return { notifications: (data ?? []) as CloudNotification[], error: error?.message ?? null };
};

export const markNotificationRead = async (notificationId: string) => {
  if (!supabase) return { error: "Cloud is not configured." };
  const { error } = await supabase
    .from("calendar_notifications")
    .update({ is_read: true })
    .eq("id", notificationId);
  return { error: error?.message ?? null };
};

export const deleteNotification = async (notificationId: string) => {
  if (!supabase) return { error: "Cloud is not configured." };
  const { error } = await supabase
    .from("calendar_notifications")
    .delete()
    .eq("id", notificationId);
  return { error: error?.message ?? null };
};

export const clearNotificationsByIds = async (notificationIds: string[]) => {
  if (!supabase) return { error: "Cloud is not configured." };
  const uniqueIds = [...new Set(notificationIds.filter(Boolean))];
  if (uniqueIds.length === 0) return { error: null as string | null };
  const { error } = await supabase
    .from("calendar_notifications")
    .delete()
    .in("id", uniqueIds);
  return { error: error?.message ?? null };
};

export const onCalendarRealtimeChange = (userId: string, onChange: () => void) => {
  if (!supabase) return () => undefined;
  const channel = supabase
    .channel(`calendar-realtime-${userId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "calendar_shared_plans" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "calendar_plan_invites", filter: `invitee_id=eq.${userId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "calendar_plan_invites", filter: `inviter_id=eq.${userId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "calendar_notifications", filter: `user_id=eq.${userId}` }, onChange)
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
};
