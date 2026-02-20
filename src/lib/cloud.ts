import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

declare global {
  // eslint-disable-next-line no-var
  var __calanderSupabase: SupabaseClient | undefined;
}

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
export const cloudTable = (import.meta.env.VITE_SUPABASE_CALENDAR_TABLE ?? "holiday_calendars").trim();
export const isCloudConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const createSupabaseClient = () =>
  createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "calander-auth",
    },
  });

const supabase: SupabaseClient | null = isCloudConfigured
  ? (globalThis.__calanderSupabase ?? (globalThis.__calanderSupabase = createSupabaseClient()))
  : null;

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

export const getCloudUser = async () => {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
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
