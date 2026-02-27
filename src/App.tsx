import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type TouchEvent } from "react";
import { Button, Dropdown, FloatingFooter, Input, MainHeader, Modal, Panel, PreferencesModal, SideMenu, SideMenuSubmenu, Toggle, applyTheme, getStoredTheme } from "@enderfall/ui";
import { FaBell, FaCircle, FaEdit, FaList, FaPen, FaTrashAlt, FaUserFriends, FaUsers } from "react-icons/fa";
import { FaInfinity } from "react-icons/fa6";
import { readSharedPreferences, writeSharedPreferences, isTauri as runtimeIsTauri } from "@enderfall/runtime";
import {
  createCloudRoom,
  getCloudUser,
  getCloudProfile,
  inviteCloudRoomMember,
  isCloudConfigured,
  joinCloudRoom,
  listIncomingPlanInvites,
  listOwnedPlanInvites,
  listNotifications,
  listVisibleSharedPlans,
  listCloudFriends,
  listCloudRoomMembers,
  markNotificationRead,
  deleteNotification,
  clearNotificationsByIds,
  registerPushToken,
  disablePushToken,
  onCalendarRealtimeChange,
  onCloudFriendStatusChange,
  onCloudAuthStateChange,
  respondToPlanInvite,
  readCloudRoom,
  removeCloudFriend,
  removeCloudRoomMember,
  rotateCloudRoomJoinCode,
  sendCloudFriendRequestByUsername,
  signInCloud,
  signOutCloud,
  signUpCloud,
  hasAnyCloudOverrideTokens,
  syncCloudSessionFromOverride,
  syncSharedPlanInvites,
  upsertSharedPlans,
  deleteSharedPlan,
  writeCloudRoom,
} from "./lib/cloud";
import type { CloudFriend, CloudMember, CloudNotification, OwnedPlanInviteStatus, SharedInvitePayload, SharedPlanPayload } from "./lib/cloud";

type DayStatus =
  | "none"
  | "available"
  | "unavailable"
  | "booked"
  | "rest-available"
  | "rest-unavailable"
  | "rest-booked"
  | "unpaid-leave";

type EditableStatus = Exclude<DayStatus, "none">;
type SyncState = "idle" | "syncing" | "error";
type ThemeMode = "galaxy" | "system" | "light" | "plain-light" | "plain-dark";

type Group = { id: string; name: string; icon: string; color: string };
type Person = { id: string; name: string; groupIds: string[]; color: string };
type CloudUser = { id: string; email: string | null; avatarUrl?: string | null };
type Plan = {
  id: string;
  name: string;
  summary: string;
  location: string;
  ownerId: string;
  targetGroupIds: string[];
  excludedPersonIds: string[];
  isPrivate: boolean;
  fromDate: string;
  toDate: string;
  allDay: boolean;
  fromTime: string;
  toTime: string;
  invitedIds: string[];
};
type LegacyPlan = {
  id?: string;
  name?: string;
  summary?: string;
  location?: string;
  ownerId?: string;
  targetCalendarId?: string;
  targetGroupIds?: string[];
  excludedPersonIds?: string[];
  isPrivate?: boolean;
  fromDate?: string;
  toDate?: string;
  allDay?: boolean;
  fromTime?: string;
  toTime?: string;
  invitedIds?: string[];
};
type RecurrenceType = "weekly" | "fortnightly" | "four-weekly" | "monthly" | "yearly" | "custom";
type InviteResponse = "going" | "maybe" | "cant";

type CalendarStore = {
  version: 2;
  updatedAt: number;
  groups: Group[];
  people: Person[];
  entries: Record<string, DayStatus>;
};

type LegacyCalendarStore = {
  version: 1;
  groups: Group[];
  people: Person[];
  entries: Record<string, DayStatus>;
};

type StatusOption = {
  id: EditableStatus;
  label: string;
  short: string;
  cellClass: string;
  swatchClass: string;
};

const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_HOURS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
const STORAGE_KEY = "enderfall-calander-data-v1";
const PLAN_STORAGE_KEY = "enderfall-calander-plans-v1";
const CLOUD_ROOM_KEY = "enderfall-calander-cloud-room";
const CLOUD_AUTO_SYNC_KEY = "enderfall-calander-cloud-auto-sync";
const HIDE_OUTSIDE_MONTH_DAYS_KEY = "enderfall-calander-hide-outside-month-days";
const NOTIFICATIONS_ENABLED_KEY = "enderfall-calander-notifications-enabled";
const PUSH_TOKEN_STORAGE_KEY = "enderfall-calander-push-token";
const THEME_STORAGE_KEY = "themeMode";
const APP_ID = "enderfall-calander";
const isMobilePlatform = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  return /android|iphone|ipad|ipod|mobile/.test(ua);
};
const GROUP_ICON_FRIENDS = "\uD83D\uDC65";
const GROUP_ICON_FAMILY = "\uD83C\uDFE1";
const GROUP_ICON_WORK = "\uD83D\uDCBC";
const GROUP_ICON_FALLBACK = "\uD83D\uDDC2\uFE0F";
const DEFAULT_GROUP_ID_FRIENDS = "f6f6b7c8-6d64-4f68-944a-26a8ac5226ae";
const DEFAULT_GROUP_ID_FAMILY = "e3de7ea4-91d8-4f85-8a16-f8f332bd4ca8";
const DEFAULT_GROUP_ID_WORK = "8f19eb20-3ef0-4477-a8d7-e3b1adf8e2f0";
const LEGACY_GROUP_ID_ALIASES: Record<string, string> = {
  friends: DEFAULT_GROUP_ID_FRIENDS,
  family: DEFAULT_GROUP_ID_FAMILY,
  work: DEFAULT_GROUP_ID_WORK,
};
const PREDEFINED_GROUPS: Group[] = [
  { id: DEFAULT_GROUP_ID_FRIENDS, name: "Friends", icon: GROUP_ICON_FRIENDS, color: "#20c9a6" },
  { id: DEFAULT_GROUP_ID_FAMILY, name: "Family", icon: GROUP_ICON_FAMILY, color: "#5f9dff" },
  { id: DEFAULT_GROUP_ID_WORK, name: "Work", icon: GROUP_ICON_WORK, color: "#ff8a65" },
];
const PRESET_PERSON_COLORS = ["#20c9a6", "#5f9dff", "#ff8a65", "#f9d65c", "#d682ff", "#ff6f9f"];
const COMMON_GROUP_EMOJIS: Array<{ value: string; label: string }> = [
  { value: "\uD83D\uDC65", label: "Friends" },
  { value: "\uD83C\uDFE1", label: "Home" },
  { value: "\uD83D\uDCBC", label: "Work" },
  { value: "\uD83C\uDFAE", label: "Gaming" },
  { value: "\uD83C\uDFC3", label: "Fitness" },
  { value: "\uD83C\uDFB5", label: "Music" },
  { value: "\uD83D\uDCDA", label: "Study" },
  { value: "\uD83C\uDF7D\uFE0F", label: "Food" },
  { value: "\u2708\uFE0F", label: "Travel" },
  { value: "\uD83E\uDE7A", label: "Health" },
  { value: "\uD83C\uDF89", label: "Events" },
  { value: "\uD83E\uDDE0", label: "Focus" },
];
const RECURRENCE_OPTIONS: Array<{ value: RecurrenceType; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "fortnightly", label: "Fortnightly" },
  { value: "four-weekly", label: "Four Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "custom", label: "Custom" },
];
const DEV_FAKE_FRIENDS: CloudFriend[] = [
  { friendship_id: "7b4f9da2-3f4b-4fda-b7fd-5c77e1961a01", user_id: "0f1c22f5-6a9c-4df4-9c5c-6f66c318b101", username: "Ava Test" },
  { friendship_id: "9a2b5af3-1a65-4f1d-9e2a-dab57dc2f302", user_id: "1e3d4a66-80ce-4db4-8de4-66a7329a2202", username: "Milo Test" },
  { friendship_id: "3f96d3c8-9f30-49cb-a541-0f8d87f63303", user_id: "2d7a2b9f-0199-4c8f-ae8f-1fc4df7f3303", username: "Nora Test" },
  { friendship_id: "56c95a7d-6f27-4c0b-9538-b2305d8f6404", user_id: "3c2e7ef7-4f7f-4fbe-9a2c-3a9d39fb4404", username: "Kai Test" },
  { friendship_id: "aa8a0be4-2e91-4f96-83de-9fe3a8859605", user_id: "4b95ce74-2aab-4a34-85ec-ccdb20d65505", username: "Lena Test" },
];
const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System (Default)" },
  { value: "galaxy", label: "Galaxy (Dark)" },
  { value: "light", label: "Galaxy (Light)" },
  { value: "plain-light", label: "Plain Light" },
  { value: "plain-dark", label: "Plain Dark" },
];
const SHARED_PRIVATE_TAG = "__visibility_private__";
const SHARED_EXCLUDE_TAG_PREFIX = "__exclude__:";

const STATUS_OPTIONS: StatusOption[] = [
  { id: "available", label: "Holiday available", short: "Available", cellClass: "status-available", swatchClass: "swatch-available" },
  { id: "unavailable", label: "Holiday not available", short: "Unavailable", cellClass: "status-unavailable", swatchClass: "swatch-unavailable" },
  { id: "booked", label: "Holiday booked", short: "Booked", cellClass: "status-booked", swatchClass: "swatch-booked" },
  { id: "rest-available", label: "Holiday available on a rest day", short: "Rest + Available", cellClass: "status-rest-available", swatchClass: "swatch-rest-available" },
  { id: "rest-unavailable", label: "Holiday not available on a rest day", short: "Rest + Unavailable", cellClass: "status-rest-unavailable", swatchClass: "swatch-rest-unavailable" },
  { id: "rest-booked", label: "Holiday booked on a rest day", short: "Rest + Booked", cellClass: "status-rest-booked", swatchClass: "swatch-rest-booked" },
  { id: "unpaid-leave", label: "Unpaid leave available", short: "Unpaid Leave", cellClass: "status-unpaid-leave", swatchClass: "swatch-unpaid-leave" },
];

const EDITABLE_STATUS_VALUES = new Set<EditableStatus>(STATUS_OPTIONS.map((status) => status.id));

const EMPTY_COUNTS: Record<EditableStatus, number> = {
  available: 0,
  unavailable: 0,
  booked: 0,
  "rest-available": 0,
  "rest-unavailable": 0,
  "rest-booked": 0,
  "unpaid-leave": 0,
};

const createDefaultStore = (): CalendarStore => ({
  version: 2,
  updatedAt: Date.now(),
  groups: PREDEFINED_GROUPS,
  people: [
    { id: "you", name: "You", groupIds: [DEFAULT_GROUP_ID_WORK], color: "#d682ff" },
  ],
  entries: {},
});

const STATUS_LOOKUP = STATUS_OPTIONS.reduce(
  (result, status) => {
    result[status.id] = status;
    return result;
  },
  {} as Record<EditableStatus, StatusOption>
);

const toKeyDate = (value: Date) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const startOfMonth = (value: Date) => new Date(value.getFullYear(), value.getMonth(), 1);
const endOfMonth = (value: Date) => new Date(value.getFullYear(), value.getMonth() + 1, 0);

const createId = (name: string) =>
  `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Math.random().toString(36).slice(2, 7)}`;

const normalizeRoomId = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]+/g, "").slice(0, 64);

const normalizeMemberEmail = (value: string) => value.trim().toLowerCase();
const isUuid = (value: string | null | undefined) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash32 = (input: string, seed: number) => {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
const stableUuidFromText = (text: string) => {
  const normalized = text.trim().toLowerCase();
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35];
  const hex = seeds.map((seed) => hash32(normalized, seed).toString(16).padStart(8, "0")).join("").slice(0, 32).split("");
  hex[12] = "4";
  const variant = parseInt(hex[16], 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20, 32)}`;
};
const createUuid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : stableUuidFromText(`${Date.now()}-${Math.random()}`);
const parseSharedGroupRef = (value: string) => {
  const divider = value.indexOf(":");
  if (divider <= 0) return null;
  const ownerId = value.slice(0, divider).trim().toLowerCase();
  const groupKey = value.slice(divider + 1).trim();
  if (!isUuid(ownerId) || !groupKey) return null;
  return { ownerId, groupKey };
};
const normalizeLocalGroupId = (value: string, fallback = "") => {
  const raw = value.trim();
  if (!raw) return stableUuidFromText(`group:${fallback || "default"}`);
  const alias = LEGACY_GROUP_ID_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (isUuid(raw)) return raw.toLowerCase();
  return stableUuidFromText(`group:${raw.toLowerCase()}`);
};
const normalizeGroupRef = (value: string, fallback = "") => {
  const shared = parseSharedGroupRef(value);
  if (!shared) return normalizeLocalGroupId(value, fallback);
  return normalizeLocalGroupId(shared.groupKey, fallback);
};
const encodeSharedTargetGroupIds = (plan: Pick<Plan, "isPrivate" | "excludedPersonIds">) => {
  const encoded = [] as string[];
  if (plan.isPrivate) encoded.push(SHARED_PRIVATE_TAG);
  for (const personId of plan.excludedPersonIds) {
    if (isUuid(personId)) encoded.push(`${SHARED_EXCLUDE_TAG_PREFIX}${personId.toLowerCase()}`);
  }
  return encoded;
};
const decodeSharedTargetGroupIds = (value: string[] | null | undefined) => {
  const targetGroupIds: string[] = [];
  const excludedPersonIds: string[] = [];
  let isPrivate = false;
  for (const entry of value ?? []) {
    if (entry === SHARED_PRIVATE_TAG) {
      isPrivate = true;
      continue;
    }
    if (entry.startsWith(SHARED_EXCLUDE_TAG_PREFIX)) {
      const personId = entry.slice(SHARED_EXCLUDE_TAG_PREFIX.length).trim().toLowerCase();
      if (isUuid(personId)) excludedPersonIds.push(personId);
      continue;
    }
    targetGroupIds.push(entry);
  }
  return { targetGroupIds, excludedPersonIds, isPrivate };
};
const inferGroupIcon = (groupName: string, groupId = "") => {
  const source = `${groupName} ${groupId}`.trim().toLowerCase();
  if (source.includes("friend")) return GROUP_ICON_FRIENDS;
  if (source.includes("family")) return GROUP_ICON_FAMILY;
  if (source.includes("work")) return GROUP_ICON_WORK;
  return GROUP_ICON_FALLBACK;
};
const inferGroupColor = (groupName: string, groupId = "") => {
  const source = `${groupName} ${groupId}`.trim().toLowerCase();
  if (source.includes("friend")) return "#20c9a6";
  if (source.includes("family")) return "#5f9dff";
  if (source.includes("work")) return "#ff8a65";
  return PRESET_PERSON_COLORS[0];
};

const isDayStatus = (value: unknown): value is DayStatus =>
  value === "none" || (typeof value === "string" && EDITABLE_STATUS_VALUES.has(value as EditableStatus));

const normalizeStore = (value: unknown): CalendarStore | null => {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<CalendarStore> & Partial<LegacyCalendarStore>;

  const groups = Array.isArray(input.groups)
    ? input.groups
        .filter((group) => group && typeof group.id === "string" && typeof group.name === "string")
        .map((group) => {
          const id = normalizeGroupRef(group.id, group.name);
          const name = group.name.trim();
          const icon =
            typeof (group as { icon?: string }).icon === "string" && (group as { icon: string }).icon.trim()
              ? (group as { icon: string }).icon.trim()
              : inferGroupIcon(name, id);
          const color =
            typeof (group as { color?: string }).color === "string" && (group as { color: string }).color.trim()
              ? (group as { color: string }).color.trim()
              : inferGroupColor(name, id);
          return { id, name, icon, color };
        })
        .filter((group) => group.id && group.name)
    : [];
  const mergedGroups = [...PREDEFINED_GROUPS];
  for (const group of groups) {
    if (!mergedGroups.some((existing) => existing.id === group.id)) {
      mergedGroups.push(group);
    }
  }

  const groupIds = new Set(mergedGroups.map((group) => group.id));
  const people = Array.isArray(input.people)
    ? input.people
        .filter((person) => person && typeof person.id === "string" && typeof person.name === "string")
        .map((person, index) => {
          const legacyGroupId = String((person as { groupId?: string }).groupId ?? "").trim();
          const rawGroupIds = Array.isArray((person as { groupIds?: string[] }).groupIds)
            ? (person as { groupIds: string[] }).groupIds
            : legacyGroupId
              ? [legacyGroupId]
              : [];
          const validGroupIds = rawGroupIds.map((id) => normalizeGroupRef(id)).filter((id) => id && groupIds.has(id));
          const color = typeof (person as { color?: string }).color === "string" ? (person as { color: string }).color : PRESET_PERSON_COLORS[index % PRESET_PERSON_COLORS.length];
          return { id: person.id.trim(), name: person.name.trim(), groupIds: validGroupIds, color };
        })
        .filter((person) => person.id && person.name)
    : [];

  if (mergedGroups.length === 0 || people.length === 0) return null;

  const entries: Record<string, DayStatus> = {};
  if (input.entries && typeof input.entries === "object") {
    for (const [key, status] of Object.entries(input.entries)) {
      if (typeof key !== "string" || !isDayStatus(status) || status === "none") continue;
      entries[key] = status;
    }
  }

  return {
    version: 2,
    updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
    groups: mergedGroups,
    people,
    entries,
  };
};

const loadStore = (): CalendarStore => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultStore();
    return normalizeStore(JSON.parse(raw)) ?? createDefaultStore();
  } catch {
    return createDefaultStore();
  }
};

const buildCalendarDays = (anchorMonth: Date) => {
  const monthStart = startOfMonth(anchorMonth);
  const shift = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate() - shift);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
};

const formatSyncTime = (timestamp: number | null) =>
  timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Never";
const normalizeInviteStatus = (status: string): "pending" | InviteResponse => {
  if (status === "accepted") return "going";
  if (status === "rejected") return "cant";
  if (status === "going" || status === "maybe" || status === "cant") return status;
  return "pending";
};

const notificationPayloadPlanId = (payload: Record<string, unknown> | null | undefined): string => {
  if (!payload) return "";
  const planId = payload.plan_id;
  return typeof planId === "string" ? planId : "";
};

const notificationSourceUserId = (payload: Record<string, unknown> | null | undefined): string => {
  if (!payload) return "";
  const candidateKeys = ["invitee_id", "requester_id", "actor_id", "from_user_id", "owner_id", "inviter_id", "user_id"];
  for (const key of candidateKeys) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
};

const formatNotificationSourceType = (type: string): string => {
  if (!type) return "Activity";
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
};

const toLocalDateKey = (value: string | null | undefined) => {
  if (!value) return toKeyDate(new Date());
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return toKeyDate(new Date());
  return toKeyDate(date);
};

const formatDateDividerLabel = (dateKey: string) => {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  const date = new Date(year, (month || 1) - 1, day || 1);
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};

const formatNotificationTimeLabel = (value: string | null | undefined, nowMs: number) => {
  if (!value) return "Now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";
  const diffMs = Math.max(0, nowMs - date.getTime());
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  if (diffMs < 60000) return "Now";
  if (diffMin < 60) return `${diffMin} min`;
  if (diffHr < 24) return `${diffHr} hr`;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const isDateInRange = (dateKey: string, fromDate: string, toDate: string) => {
  const [start, end] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate];
  return dateKey >= start && dateKey <= end;
};

const normalizePlans = (value: unknown, groups: Group[], defaultOwnerId: string): Plan[] => {
  if (!Array.isArray(value)) return [];
  const groupIds = new Set(groups.map((group) => group.id));
  return value
    .map((rawPlan, index) => {
      if (!rawPlan || typeof rawPlan !== "object") return null;
      const plan = rawPlan as LegacyPlan;
      const rawTargets = Array.isArray(plan.targetGroupIds)
        ? plan.targetGroupIds
        : typeof plan.targetCalendarId === "string" && plan.targetCalendarId.trim()
          ? [plan.targetCalendarId.trim()]
          : [];
      const targetGroupIds = rawTargets
        .filter((id) => typeof id === "string")
        .map((id) => normalizeGroupRef(id))
        .filter((id) => id && groupIds.has(id));
      const excludedPersonIds = Array.isArray(plan.excludedPersonIds)
        ? plan.excludedPersonIds
            .filter((personId): personId is string => typeof personId === "string")
            .map((personId) => personId.trim().toLowerCase())
            .filter((personId) => isUuid(personId))
        : [];
      if (!plan.name || !plan.fromDate || !plan.toDate) return null;
      const name = String(plan.name).trim();
      const id = typeof plan.id === "string" && plan.id.trim() ? plan.id.trim() : createId(`${name}-${index + 1}`);
      return {
        id,
        name,
        summary: typeof plan.summary === "string" ? plan.summary.trim() : "",
        location: typeof plan.location === "string" ? plan.location.trim() : "",
        ownerId: typeof plan.ownerId === "string" && plan.ownerId.trim() ? plan.ownerId.trim() : defaultOwnerId,
        targetGroupIds,
        excludedPersonIds,
        isPrivate: Boolean(plan.isPrivate),
        fromDate: String(plan.fromDate),
        toDate: String(plan.toDate),
        allDay: Boolean(plan.allDay),
        fromTime: typeof plan.fromTime === "string" && plan.fromTime ? plan.fromTime : "09:00",
        toTime: typeof plan.toTime === "string" && plan.toTime ? plan.toTime : "17:00",
        invitedIds: Array.isArray(plan.invitedIds)
          ? plan.invitedIds.filter((personId): personId is string => typeof personId === "string")
          : [],
      } satisfies Plan;
    })
    .filter((plan): plan is Plan => Boolean(plan));
};

const mergeRemoteStorePreservingLocalPersonColors = (localStore: CalendarStore, remoteStore: CalendarStore): CalendarStore => {
  const localColorByPersonId = new Map(localStore.people.map((person) => [person.id, person.color] as const));
  return {
    ...remoteStore,
    people: remoteStore.people.map((person) => ({
      ...person,
      color: localColorByPersonId.get(person.id) ?? person.color,
    })),
  };
};

const shiftKeyDate = (dateKey: string, days: number) => {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  const next = new Date(year, month - 1, day);
  next.setDate(next.getDate() + days);
  return toKeyDate(next);
};

const timeToMinutes = (value: string) => {
  const [hour, minute] = value.split(":").map((part) => Number(part));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return Math.max(0, Math.min(24 * 60, hour * 60 + minute));
};
const rangesOverlap = (startA: string, endA: string, startB: string, endB: string) => {
  return !(endA < startB || endB < startA);
};
const plansOverlap = (a: Pick<Plan, "fromDate" | "toDate" | "allDay" | "fromTime" | "toTime">, b: Pick<Plan, "fromDate" | "toDate" | "allDay" | "fromTime" | "toTime">) => {
  if (!rangesOverlap(a.fromDate, a.toDate, b.fromDate, b.toDate)) return false;
  if (a.allDay || b.allDay) return true;
  const aStart = timeToMinutes(a.fromTime);
  const aEnd = timeToMinutes(a.toTime);
  const bStart = timeToMinutes(b.fromTime);
  const bEnd = timeToMinutes(b.toTime);
  return aStart < bEnd && bStart < aEnd;
};
const formatConflictSummary = (plan: Pick<Plan, "name" | "fromDate" | "toDate" | "allDay" | "fromTime" | "toTime" | "location">) =>
  `${plan.name} (${plan.fromDate}${plan.allDay ? "" : ` ${plan.fromTime}`} -> ${plan.toDate}${plan.allDay ? " All day" : ` ${plan.toTime}`}${plan.location ? ` @ ${plan.location}` : ""})`;
const getPlanDayWindowMinutes = (plan: Plan, dateKey: string) => {
  if (!isDateInRange(dateKey, plan.fromDate, plan.toDate)) return null;
  if (plan.allDay) return { start: 0, end: 24 * 60 };
  const start = dateKey === plan.fromDate ? timeToMinutes(plan.fromTime) : 0;
  const end = dateKey === plan.toDate ? timeToMinutes(plan.toTime) : 24 * 60;
  return { start: Math.max(0, Math.min(start, 24 * 60)), end: Math.max(0, Math.min(Math.max(end, start + 1), 24 * 60)) };
};
const buildDayTimelineSegments = (plans: Plan[], dateKey: string) => {
  const timed = plans
    .map((plan) => {
      const window = getPlanDayWindowMinutes(plan, dateKey);
      if (!window) return null;
      return { plan, start: window.start, end: window.end };
    })
    .filter((entry): entry is { plan: Plan; start: number; end: number } => Boolean(entry))
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const laneEndByIndex: number[] = [];
  const laneByPlanId = new Map<string, number>();
  for (const entry of timed) {
    let lane = laneEndByIndex.findIndex((value) => value <= entry.start);
    if (lane === -1) {
      lane = laneEndByIndex.length;
      laneEndByIndex.push(entry.end);
    } else {
      laneEndByIndex[lane] = entry.end;
    }
    laneByPlanId.set(entry.plan.id, lane);
  }
  const laneCount = Math.max(1, laneEndByIndex.length);
  return timed.map((entry) => ({
    plan: entry.plan,
    start: entry.start,
    end: entry.end,
    lane: laneByPlanId.get(entry.plan.id) ?? 0,
    laneCount,
  }));
};
const parseKeyDate = (value: string) => {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day);
};

const fromDateObject = (value: Date) => toKeyDate(value);

const addRecurrenceStep = (
  fromDate: string,
  toDate: string,
  recurrenceType: RecurrenceType,
  customDays: number
) => {
  if (recurrenceType === "weekly") {
    return { fromDate: shiftKeyDate(fromDate, 7), toDate: shiftKeyDate(toDate, 7) };
  }
  if (recurrenceType === "fortnightly") {
    return { fromDate: shiftKeyDate(fromDate, 14), toDate: shiftKeyDate(toDate, 14) };
  }
  if (recurrenceType === "four-weekly") {
    return { fromDate: shiftKeyDate(fromDate, 28), toDate: shiftKeyDate(toDate, 28) };
  }
  if (recurrenceType === "custom") {
    return { fromDate: shiftKeyDate(fromDate, customDays), toDate: shiftKeyDate(toDate, customDays) };
  }
  if (recurrenceType === "monthly") {
    const nextFrom = parseKeyDate(fromDate);
    const nextTo = parseKeyDate(toDate);
    nextFrom.setMonth(nextFrom.getMonth() + 1);
    nextTo.setMonth(nextTo.getMonth() + 1);
    return { fromDate: fromDateObject(nextFrom), toDate: fromDateObject(nextTo) };
  }
  const nextFrom = parseKeyDate(fromDate);
  const nextTo = parseKeyDate(toDate);
  nextFrom.setFullYear(nextFrom.getFullYear() + 1);
  nextTo.setFullYear(nextTo.getFullYear() + 1);
  return { fromDate: fromDateObject(nextFrom), toDate: fromDateObject(nextTo) };
};

const IconChevronDown = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M6 9l6 6 6-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const IconPlus = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export default function App() {
  const initialStore = useMemo(() => loadStore(), []);
  const defaultSelfPersonId = initialStore.people.find((person) => person.name.toLowerCase() === "you")?.id ?? initialStore.people[0]?.id ?? "";
  const [selfPersonId] = useState<string>(defaultSelfPersonId);
  const [store, setStore] = useState<CalendarStore>(initialStore);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(defaultSelfPersonId || null);
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(new Date()));
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupIcon, setNewGroupIcon] = useState("");
  const [newGroupColor, setNewGroupColor] = useState(PRESET_PERSON_COLORS[0]);
  const [newGroupCustomIcon, setNewGroupCustomIcon] = useState(false);
  const [groupCreatorOpen, setGroupCreatorOpen] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonGroupIds, setNewPersonGroupIds] = useState<string[]>([DEFAULT_GROUP_ID_FRIENDS]);
  const [newPersonColor, setNewPersonColor] = useState(PRESET_PERSON_COLORS[0]);
  const [menuOpen, setMenuOpen] = useState<"file" | "view" | "help" | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [hideOutsideMonthDays, setHideOutsideMonthDays] = useState<boolean>(() => localStorage.getItem(HIDE_OUTSIDE_MONTH_DAYS_KEY) === "true");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    getStoredTheme({
      storageKey: THEME_STORAGE_KEY,
      defaultTheme: "system",
      allowed: ["galaxy", "system", "light", "plain-light", "plain-dark"],
    })
  );
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = localStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
    return raw === null ? true : raw === "true";
  });
  const sharedThemeUpdatedAtRef = useRef<number>(0);
  const sharedThemeApplyRef = useRef<ThemeMode | null>(null);
  const sharedAnimationsApplyRef = useRef<boolean | null>(null);
  const sharedNotificationsApplyRef = useRef<boolean | null>(null);
  const sharedThemeAllowed = useMemo(
    () => new Set<ThemeMode>(["system", "galaxy", "light", "plain-light", "plain-dark"]),
    []
  );
  const [isMobileClient] = useState<boolean>(() => isMobilePlatform());
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 760px)").matches : false
  );

  const [cloudRoomDraft, setCloudRoomDraft] = useState(() => localStorage.getItem(CLOUD_ROOM_KEY) ?? "");
  const [cloudRoomId, setCloudRoomId] = useState(() => localStorage.getItem(CLOUD_ROOM_KEY) ?? "");
  const [cloudJoinCodeDraft, setCloudJoinCodeDraft] = useState("");
  const [cloudAutoSync, setCloudAutoSync] = useState(() => localStorage.getItem(CLOUD_AUTO_SYNC_KEY) !== "false");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [syncMessage, setSyncMessage] = useState(() =>
    isCloudConfigured ? "Cloud disconnected. Sign in and connect a room." : "Cloud disabled (missing env vars)."
  );
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const [cloudProfileAvatarUrl, setCloudProfileAvatarUrl] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [roomMembers, setRoomMembers] = useState<CloudMember[]>([]);
  const [memberEmailDraft, setMemberEmailDraft] = useState("");
  const [newJoinCodeDraft, setNewJoinCodeDraft] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberMessage, setMemberMessage] = useState("");
  const [dayModalDate, setDayModalDate] = useState<Date | null>(null);
  const [plans, setPlans] = useState<Plan[]>(() => {
    try {
      const raw = localStorage.getItem(PLAN_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return normalizePlans(parsed, initialStore.groups, defaultSelfPersonId || "you");
    } catch {
      return [];
    }
  });
  const [createPlanOpen, setCreatePlanOpen] = useState(false);
  const [plansListOpen, setPlansListOpen] = useState(false);
  const [planDetailsPlanId, setPlanDetailsPlanId] = useState<string | null>(null);
  const [friendsListOpen, setFriendsListOpen] = useState(false);
  const [groupsListOpen, setGroupsListOpen] = useState(false);
  const [personCreatorOpen, setPersonCreatorOpen] = useState(false);
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [cloudFriends, setCloudFriends] = useState<CloudFriend[]>([]);
  const [cloudFriendsError, setCloudFriendsError] = useState("");
  const [friendRequestOpen, setFriendRequestOpen] = useState(false);
  const [friendRequestUsername, setFriendRequestUsername] = useState("");
  const [friendRequestBusy, setFriendRequestBusy] = useState(false);
  const [friendRequestMessage, setFriendRequestMessage] = useState("");
  const [deleteFriendConfirmOpen, setDeleteFriendConfirmOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsTab, setNotificationsTab] = useState<"activity" | "invites">("activity");
  const [notificationClockMs, setNotificationClockMs] = useState(() => Date.now());
  const [inviteActionMessage, setInviteActionMessage] = useState("");
  const [cloudNotifications, setCloudNotifications] = useState<CloudNotification[]>([]);
  const [incomingPlanInvites, setIncomingPlanInvites] = useState<SharedInvitePayload[]>([]);
  const [ownedPlanInvites, setOwnedPlanInvites] = useState<OwnedPlanInviteStatus[]>([]);
  const [sharedPlans, setSharedPlans] = useState<Plan[]>([]);
  const [planName, setPlanName] = useState("");
  const [planSummary, setPlanSummary] = useState("");
  const [planLocation, setPlanLocation] = useState("");
  const [planTargetGroupIds, setPlanTargetGroupIds] = useState<string[]>([]);
  const [planIsPrivate, setPlanIsPrivate] = useState(false);
  const [planCustomizeMembers, setPlanCustomizeMembers] = useState(false);
  const [planExcludedPersonIds, setPlanExcludedPersonIds] = useState<string[]>([]);
  const [planFromDate, setPlanFromDate] = useState(() => toKeyDate(new Date()));
  const [planToDate, setPlanToDate] = useState(() => toKeyDate(new Date()));
  const [planAllDay, setPlanAllDay] = useState(false);
  const [planFromTime, setPlanFromTime] = useState("09:00");
  const [planToTime, setPlanToTime] = useState("17:00");
  const [planInvitedIds, setPlanInvitedIds] = useState<string[]>([]);
  const [planRecurring, setPlanRecurring] = useState(false);
  const [planRecurrenceType, setPlanRecurrenceType] = useState<RecurrenceType>("weekly");
  const [planCustomRecurrenceDays, setPlanCustomRecurrenceDays] = useState(7);
  const [planRecurrenceCount, setPlanRecurrenceCount] = useState(1);
  const [planRecurrenceInfinite, setPlanRecurrenceInfinite] = useState(false);
  const [planModalMessage, setPlanModalMessage] = useState("");
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [hiddenFriendIds, setHiddenFriendIds] = useState<string[]>([]);
  const [hiddenGroupIds, setHiddenGroupIds] = useState<string[]>([]);
  const [collapsedPersonIds, setCollapsedPersonIds] = useState<string[]>([]);
  const [dayTimelineRowSize, setDayTimelineRowSize] = useState(22);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const dayTimelineRef = useRef<HTMLDivElement | null>(null);
  const activityListRef = useRef<HTMLDivElement | null>(null);
  const activityAutoReadPendingRef = useRef<Set<string>>(new Set());
  const seenActivityNotificationIdsRef = useRef<Set<string>>(new Set());
  const seenPendingInviteIdsRef = useRef<Set<string>>(new Set());
  const systemNotificationHydratedRef = useRef(false);
  const socialUserId = isUuid(cloudUser?.id) ? (cloudUser?.id ?? null) : null;

  const storeRef = useRef(store);
  const remoteApplyRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);
  const sharedPlanIdsRef = useRef<string[]>([]);
  const lastSharedSyncSignatureRef = useRef("");

  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => {
    setStore((current) => {
      const nextGroups = [...PREDEFINED_GROUPS];
      for (const group of current.groups) {
        const normalizedId = normalizeLocalGroupId(group.id, group.name);
        if (nextGroups.some((entry) => entry.id === normalizedId)) continue;
        nextGroups.push({
          ...group,
          id: normalizedId,
        });
      }
      const validIds = new Set(nextGroups.map((group) => group.id));
      return {
        ...current,
        groups: nextGroups,
        people: current.people.map((person) => ({
          ...person,
          groupIds: person.groupIds
            .map((groupId) => normalizeLocalGroupId(groupId))
            .filter((groupId) => validIds.has(groupId)),
        })),
      };
    });
    setPlans((current) =>
      current.map((plan) => ({
        ...plan,
        targetGroupIds: plan.targetGroupIds
          .map((groupId) => normalizeLocalGroupId(groupId))
          .filter((groupId, index, source) => source.indexOf(groupId) === index),
      }))
    );
  }, []);

  const updateStore = (updater: (current: CalendarStore) => CalendarStore) => {
    setStore((current) => {
      const next = updater(current);
      if (next === current) return current;
      return { ...next, version: 2, updatedAt: Date.now() };
    });
  };

  const pullFromCloud = useCallback(
    async (source: "manual" | "poll" | "connect") => {
      if (!isCloudConfigured) {
        setSyncState("error");
        setSyncMessage("Cloud disabled (missing env vars).");
        return;
      }
      if (!cloudUser) {
        setSyncState("error");
        setSyncMessage("Please sign in to sync.");
        return;
      }

      const roomId = normalizeRoomId(cloudRoomId);
      if (!roomId) {
        setSyncState("idle");
        setSyncMessage("Cloud disconnected. Choose a room.");
        return;
      }

      setSyncState("syncing");
      const { record, error } = await readCloudRoom(roomId);
      if (error) {
        setSyncState("error");
        setSyncMessage(`Pull failed: ${error}`);
        return;
      }

      if (!record?.payload) {
        setSyncState("idle");
        setLastSyncAt(Date.now());
        setSyncMessage(source === "manual" ? "No cloud data yet for this room." : "Room connected.");
        return;
      }

      const remoteStore = normalizeStore(record.payload);
      if (!remoteStore) {
        setSyncState("error");
        setSyncMessage("Cloud payload is invalid.");
        return;
      }

      const localUpdatedAt = storeRef.current.updatedAt;
      if (remoteStore.updatedAt > localUpdatedAt) {
        remoteApplyRef.current = true;
        setStore((current) => mergeRemoteStorePreservingLocalPersonColors(current, remoteStore));
        setSyncMessage("Pulled latest changes from cloud.");
      } else if (source === "manual") {
        setSyncMessage("Already up to date.");
      } else {
        setSyncMessage("Cloud sync active.");
      }

      setLastSyncAt(Date.now());
      setSyncState("idle");
    },
    [cloudRoomId, cloudUser]
  );

  const pushToCloud = useCallback(
    async (source: "manual" | "auto") => {
      if (!isCloudConfigured) {
        setSyncState("error");
        setSyncMessage("Cloud disabled (missing env vars).");
        return;
      }
      if (!cloudUser) {
        setSyncState("error");
        setSyncMessage("Please sign in to sync.");
        return;
      }

      const roomId = normalizeRoomId(cloudRoomId);
      if (!roomId) {
        setSyncState("error");
        setSyncMessage("Set a room ID before pushing.");
        return;
      }

      const localSnapshot = storeRef.current;
      setSyncState("syncing");

      const { record, error: readError } = await readCloudRoom(roomId);
      if (readError) {
        setSyncState("error");
        setSyncMessage(`Push failed: ${readError}`);
        return;
      }

      if (record?.payload) {
        const remoteStore = normalizeStore(record.payload);
        if (remoteStore && remoteStore.updatedAt > localSnapshot.updatedAt) {
          remoteApplyRef.current = true;
          setStore((current) => mergeRemoteStorePreservingLocalPersonColors(current, remoteStore));
          setSyncState("idle");
          setLastSyncAt(Date.now());
          setSyncMessage("Cloud had newer data, so it was pulled instead.");
          return;
        }
      }

      const { error } = await writeCloudRoom(roomId, localSnapshot);
      if (error) {
        setSyncState("error");
        setSyncMessage(`Push failed: ${error}`);
        return;
      }

      setSyncState("idle");
      setLastSyncAt(Date.now());
      setSyncMessage(source === "auto" ? "Auto-sync complete." : "Pushed local changes to cloud.");
    },
    [cloudRoomId, cloudUser]
  );

  const loadRoomMembers = useCallback(async () => {
    if (!cloudUser || !cloudRoomId || !isCloudConfigured) {
      setRoomMembers([]);
      return;
    }
    const roomId = normalizeRoomId(cloudRoomId);
    if (!roomId) {
      setRoomMembers([]);
      return;
    }
    const { members, error } = await listCloudRoomMembers(roomId);
    if (error) {
      setMemberMessage(`Member list failed: ${error}`);
      return;
    }
    setRoomMembers(members);
    setMemberMessage("");
  }, [cloudRoomId, cloudUser]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }, [store]);

  useEffect(() => {
    localStorage.setItem(CLOUD_ROOM_KEY, cloudRoomId);
  }, [cloudRoomId]);

  useEffect(() => {
    localStorage.setItem(CLOUD_AUTO_SYNC_KEY, cloudAutoSync ? "true" : "false");
  }, [cloudAutoSync]);

  useEffect(() => {
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans));
  }, [plans]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyResolvedTheme = () => {
      const resolvedTheme = themeMode === "system" ? (media.matches ? "galaxy" : "light") : themeMode;
      const isGalaxy = resolvedTheme === "galaxy";
      const isLight = resolvedTheme === "light";
      document.documentElement.setAttribute("data-theme", resolvedTheme);
      document.body.classList.toggle("ef-galaxy", isGalaxy);
      document.body.classList.toggle("ef-galaxy-light", isLight);
    };
    if (themeMode !== "system") {
      applyTheme(themeMode, {
        storageKey: THEME_STORAGE_KEY,
        defaultTheme: "system",
        allowed: ["galaxy", "system", "light", "plain-light", "plain-dark"],
      });
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, "system");
    }
    applyResolvedTheme();
    if (themeMode !== "system") return;
    const onChange = () => applyResolvedTheme();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    document.documentElement.setAttribute("data-reduce-motion", animationsEnabled ? "false" : "true");
  }, [animationsEnabled]);
  useEffect(() => {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, notificationsEnabled ? "true" : "false");
  }, [notificationsEnabled]);
  useEffect(() => {
    if (!notificationsEnabled || typeof window === "undefined") return;
    const requestPermission = async () => {
      const capacitor = (window as typeof window & {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          Plugins?: Record<string, unknown>;
        };
      }).Capacitor;
      if (capacitor?.isNativePlatform?.()) {
        try {
          const localNotificationsPlugin = capacitor.Plugins?.LocalNotifications as
            | {
                checkPermissions?: () => Promise<{ display?: string }>;
                requestPermissions?: () => Promise<{ display?: string }>;
              }
            | undefined;
          if (localNotificationsPlugin?.checkPermissions && localNotificationsPlugin?.requestPermissions) {
            const status = await localNotificationsPlugin.checkPermissions();
            if (status.display === "prompt" || status.display === "prompt-with-rationale") {
              await localNotificationsPlugin.requestPermissions();
            }
          }
        } catch {
          // Ignore unavailable plugin/platform errors.
        }
        return;
      }
      try {
        if ("Notification" in window && Notification.permission === "default") {
          await Notification.requestPermission();
        }
      } catch {
        // Ignore browser notification errors.
      }
    };
    void requestPermission();
  }, [notificationsEnabled]);
  useEffect(() => {
    if (!socialUserId || !notificationsEnabled || typeof window === "undefined") return;
    const capacitor = (window as typeof window & {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        getPlatform?: () => string;
        Plugins?: Record<string, unknown>;
      };
    }).Capacitor;
    if (!capacitor?.isNativePlatform?.()) return;

    const pushPlugin = capacitor.Plugins?.PushNotifications as
      | {
          checkPermissions?: () => Promise<{ receive?: string }>;
          requestPermissions?: () => Promise<{ receive?: string }>;
          register?: () => Promise<void>;
          addListener?: (
            eventName: "registration" | "registrationError",
            listener: (value: { value?: string; error?: unknown }) => void
          ) => Promise<{ remove: () => Promise<void> }>;
        }
      | undefined;
    if (!pushPlugin?.checkPermissions || !pushPlugin?.requestPermissions || !pushPlugin?.register || !pushPlugin?.addListener) return;
    const checkPermissions = pushPlugin.checkPermissions;
    const requestPermissions = pushPlugin.requestPermissions;
    const register = pushPlugin.register;
    const addListener = pushPlugin.addListener;

    let disposed = false;
    let registrationHandle: { remove: () => Promise<void> } | null = null;
    let registrationErrorHandle: { remove: () => Promise<void> } | null = null;

    const registerForPush = async () => {
      const registrationListener = await addListener("registration", ({ value }) => {
        if (disposed) return;
        const token = String(value ?? "").trim();
        if (!token) return;
        localStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
        const platform = capacitor.getPlatform?.() === "ios" ? "ios" : "android";
        void registerPushToken(
          socialUserId,
          token,
          platform,
          typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 250) : null
        );
      });
      registrationHandle = registrationListener;

      const errorListener = await addListener("registrationError", () => {
        // Keep silent; user can still receive in-app notifications.
      });
      registrationErrorHandle = errorListener;

      const permission = await checkPermissions();
      if (permission.receive === "prompt") {
        const requested = await requestPermissions();
        if (requested.receive !== "granted") return;
      } else if (permission.receive !== "granted") {
        return;
      }
      await register();
    };

    void registerForPush();

    return () => {
      disposed = true;
      if (registrationHandle) void registrationHandle.remove();
      if (registrationErrorHandle) void registrationErrorHandle.remove();
    };
  }, [notificationsEnabled, socialUserId]);
  useEffect(() => {
    if (notificationsEnabled || !socialUserId || typeof window === "undefined") return;
    const token = localStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
    if (!token) return;
    void disablePushToken(socialUserId, token);
  }, [notificationsEnabled, socialUserId]);
  useEffect(() => {
    localStorage.setItem(HIDE_OUTSIDE_MONTH_DAYS_KEY, hideOutsideMonthDays ? "true" : "false");
  }, [hideOutsideMonthDays]);
  useEffect(() => {
    if (!runtimeIsTauri) return;
    let active = true;
    readSharedPreferences()
      .then((prefs) => {
        if (!active || !prefs) return;
        const updatedAt = prefs.updatedAt ?? 0;
        sharedThemeUpdatedAtRef.current = updatedAt;
        if (prefs.themeMode) {
          const nextTheme = prefs.themeMode as ThemeMode;
          if (sharedThemeAllowed.has(nextTheme) && nextTheme !== themeMode) {
            sharedThemeApplyRef.current = nextTheme;
            setThemeMode(nextTheme);
          }
        }
        if (typeof prefs.animationsEnabled === "boolean" && prefs.animationsEnabled !== animationsEnabled) {
          sharedAnimationsApplyRef.current = prefs.animationsEnabled;
          setAnimationsEnabled(prefs.animationsEnabled);
        }
        if (typeof prefs.notificationsEnabled === "boolean" && prefs.notificationsEnabled !== notificationsEnabled) {
          sharedNotificationsApplyRef.current = prefs.notificationsEnabled;
          setNotificationsEnabled(prefs.notificationsEnabled);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!runtimeIsTauri) return;
    if (sharedThemeApplyRef.current === themeMode) {
      sharedThemeApplyRef.current = null;
      return;
    }
    if (!sharedThemeAllowed.has(themeMode)) return;
    writeSharedPreferences({ themeMode })
      .then((prefs) => {
        if (prefs?.updatedAt) sharedThemeUpdatedAtRef.current = prefs.updatedAt;
      })
      .catch(() => undefined);
  }, [sharedThemeAllowed, themeMode]);
  useEffect(() => {
    if (!runtimeIsTauri) return;
    if (sharedAnimationsApplyRef.current === animationsEnabled) {
      sharedAnimationsApplyRef.current = null;
      return;
    }
    writeSharedPreferences({ animationsEnabled })
      .then((prefs) => {
        if (prefs?.updatedAt) sharedThemeUpdatedAtRef.current = prefs.updatedAt;
      })
      .catch(() => undefined);
  }, [animationsEnabled]);
  useEffect(() => {
    if (!runtimeIsTauri) return;
    if (sharedNotificationsApplyRef.current === notificationsEnabled) {
      sharedNotificationsApplyRef.current = null;
      return;
    }
    writeSharedPreferences({ notificationsEnabled })
      .then((prefs) => {
        if (prefs?.updatedAt) sharedThemeUpdatedAtRef.current = prefs.updatedAt;
      })
      .catch(() => undefined);
  }, [notificationsEnabled]);
  useEffect(() => {
    if (!runtimeIsTauri) return;
    const interval = window.setInterval(async () => {
      try {
        const prefs = await readSharedPreferences();
        if (!prefs) return;
        const updatedAt = prefs.updatedAt ?? 0;
        if (updatedAt <= sharedThemeUpdatedAtRef.current) return;
        sharedThemeUpdatedAtRef.current = updatedAt;
        if (prefs.themeMode) {
          const nextTheme = prefs.themeMode as ThemeMode;
          if (sharedThemeAllowed.has(nextTheme) && nextTheme !== themeMode) {
            sharedThemeApplyRef.current = nextTheme;
            setThemeMode(nextTheme);
          }
        }
        if (typeof prefs.animationsEnabled === "boolean" && prefs.animationsEnabled !== animationsEnabled) {
          sharedAnimationsApplyRef.current = prefs.animationsEnabled;
          setAnimationsEnabled(prefs.animationsEnabled);
        }
        if (typeof prefs.notificationsEnabled === "boolean" && prefs.notificationsEnabled !== notificationsEnabled) {
          sharedNotificationsApplyRef.current = prefs.notificationsEnabled;
          setNotificationsEnabled(prefs.notificationsEnabled);
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);
    return () => window.clearInterval(interval);
  }, [animationsEnabled, notificationsEnabled, sharedThemeAllowed, themeMode]);
  useEffect(() => {
    if (!runtimeIsTauri || isMobileClient) return;
    const syncFromHub = async () => {
      if (await hasAnyCloudOverrideTokens()) {
        await syncCloudSessionFromOverride();
        return;
      }
      await signOutCloud();
      setCloudUser(null);
      setCloudProfileAvatarUrl(null);
      setAuthMessage("");
    };
    void syncFromHub();
    const interval = window.setInterval(() => {
      void syncFromHub();
    }, 10 * 1000);
    return () => window.clearInterval(interval);
  }, [isMobileClient]);

  useEffect(() => {
    if (!isCloudConfigured) return;
    let active = true;

    const resolveUser = async () => {
      if (runtimeIsTauri && !isMobileClient) {
        await syncCloudSessionFromOverride();
      }
      const user = await getCloudUser();
      if (!active) return;
      setCloudUser(user ? { id: user.id, email: user.email ?? null, avatarUrl: (user.user_metadata as { avatar_url?: string } | undefined)?.avatar_url ?? null } : null);
    };

    void resolveUser();

    const unsubscribe = onCloudAuthStateChange((user) => {
      if (!active) return;
      setCloudUser(user ? { id: user.id, email: user.email ?? null, avatarUrl: (user.user_metadata as { avatar_url?: string } | undefined)?.avatar_url ?? null } : null);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [isMobileClient]);

  useEffect(() => {
    if (!socialUserId) {
      setCloudProfileAvatarUrl(null);
      return;
    }
    let active = true;
    void getCloudProfile(socialUserId).then(({ profile }) => {
      if (!active) return;
      setCloudProfileAvatarUrl(profile?.avatar_url ?? null);
    });
    return () => {
      active = false;
    };
  }, [socialUserId]);

  useEffect(() => {
    if (!cloudUser) {
      if (isCloudConfigured) {
        setSyncState("idle");
        setSyncMessage("Signed out. Local storage is still active.");
      }
      setRoomMembers([]);
      return;
    }
    if (!cloudRoomId) {
      setSyncState("idle");
      setSyncMessage("Signed in. Connect or create a room.");
      setRoomMembers([]);
      return;
    }
    void pullFromCloud("connect");
  }, [cloudRoomId, cloudUser, pullFromCloud]);

  useEffect(() => {
    if (!cloudUser || !cloudRoomId) {
      setRoomMembers([]);
      return;
    }
    void loadRoomMembers();
  }, [cloudRoomId, cloudUser, loadRoomMembers]);

  useEffect(() => {
    if (!cloudAutoSync || !cloudRoomId || !isCloudConfigured || !cloudUser) return;

    if (remoteApplyRef.current) {
      remoteApplyRef.current = false;
      return;
    }

    if (pushTimerRef.current !== null) {
      window.clearTimeout(pushTimerRef.current);
    }

    pushTimerRef.current = window.setTimeout(() => {
      void pushToCloud("auto");
    }, 900);

    return () => {
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current);
      }
    };
  }, [cloudAutoSync, cloudRoomId, cloudUser, pushToCloud, store.updatedAt]);

  useEffect(() => {
    if (!cloudAutoSync || !cloudRoomId || !isCloudConfigured || !cloudUser) return;
    const interval = window.setInterval(() => {
      void pullFromCloud("poll");
    }, 12000);
    return () => window.clearInterval(interval);
  }, [cloudAutoSync, cloudRoomId, cloudUser, pullFromCloud]);

  useEffect(() => {
    if (store.people.length === 0) {
      setSelectedPersonId(null);
      return;
    }
    if (!selectedPersonId || !store.people.some((person) => person.id === selectedPersonId)) {
      setSelectedPersonId(store.people[0].id);
    }
  }, [selectedPersonId, store.people]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobileViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!selfPersonId) return;
    updateStore((current) => {
      const peopleById = new Map(current.people.map((person) => [person.id, person] as const));
      let changed = false;

      cloudFriends.forEach((friend, index) => {
        if (friend.user_id === selfPersonId) return;
        const existing = peopleById.get(friend.user_id);
        if (existing) return;
        changed = true;
        peopleById.set(friend.user_id, {
          id: friend.user_id,
          name: friend.username || "Friend",
          groupIds: [DEFAULT_GROUP_ID_FRIENDS],
          color: PRESET_PERSON_COLORS[index % PRESET_PERSON_COLORS.length],
        });
      });

      if (!changed) return current;
      return {
        ...current,
        people: [...peopleById.values()],
      };
    });
  }, [cloudFriends, selfPersonId]);

  useEffect(() => {
    if (store.groups.length === 0) {
      setNewPersonGroupIds([]);
      return;
    }
    setNewPersonGroupIds((current) => {
      const valid = current.filter((id) => store.groups.some((group) => group.id === id));
      return valid.length > 0 ? valid : [store.groups[0].id];
    });
  }, [store.groups]);
  useEffect(() => {
    setHiddenGroupIds((current) => current.filter((id) => store.groups.some((group) => group.id === id)));
  }, [store.groups]);
  useEffect(() => {
    setHiddenFriendIds((current) => current.filter((id) => store.people.some((person) => person.id === id)));
  }, [store.people]);

  useEffect(() => {
    if (!selfPersonId) return;
    const me = store.people.find((person) => person.id === selfPersonId);
    if (!me) return;
    const allGroupIds = store.groups.map((group) => group.id);
    const isMissingAny = allGroupIds.some((groupId) => !me.groupIds.includes(groupId));
    if (!isMissingAny) return;
    updateStore((current) => ({
      ...current,
      people: current.people.map((person) =>
        person.id === selfPersonId
          ? { ...person, groupIds: [...new Set([...person.groupIds, ...current.groups.map((group) => group.id)])] }
          : person
      ),
    }));
  }, [selfPersonId, store.groups, store.people]);

  const selectedPerson = useMemo(
    () => store.people.find((person) => person.id === selectedPersonId) ?? null,
    [selectedPersonId, store.people]
  );
  const selfPerson = useMemo(
    () => store.people.find((person) => person.id === selfPersonId) ?? null,
    [selfPersonId, store.people]
  );

  const selectedGroupName = useMemo(() => {
    if (!selectedPerson) return "";
    const names = selectedPerson.groupIds
      .map((id) => store.groups.find((group) => group.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return names.join(", ");
  }, [selectedPerson, store.groups]);

  const cloudFriendPeople = useMemo(
    () =>
      cloudFriends.map((friend, index) => {
        const localPrefs = store.people.find((person) => person.id === friend.user_id);
        return {
          id: friend.user_id,
          name: friend.username || localPrefs?.name || "Friend",
          groupIds:
            localPrefs && localPrefs.groupIds.length > 0
              ? localPrefs.groupIds
              : [DEFAULT_GROUP_ID_FRIENDS],
          color: localPrefs?.color ?? PRESET_PERSON_COLORS[index % PRESET_PERSON_COLORS.length],
          avatarUrl: friend.avatar_url ?? null,
        };
      }),
    [cloudFriends, store.people]
  );
  const planInvitePeople = useMemo(
    () => cloudFriendPeople.filter((person) => person.id !== selfPersonId),
    [cloudFriendPeople, selfPersonId]
  );
  const editingCloudFriend = useMemo(
    () => cloudFriends.find((friend) => friend.user_id === editingPersonId) ?? null,
    [cloudFriends, editingPersonId]
  );
  const planSelectedGroupMemberIds = useMemo(() => {
    if (planTargetGroupIds.length === 0) return [] as string[];
    const memberIds = new Set<string>();
    for (const person of cloudFriendPeople) {
      if (person.id === selfPersonId) continue;
      if (person.groupIds.some((groupId) => planTargetGroupIds.includes(groupId))) {
        memberIds.add(person.id);
      }
    }
    return [...memberIds];
  }, [cloudFriendPeople, planTargetGroupIds, selfPersonId]);
  const planCanCustomizeMembers = planTargetGroupIds.length > 0 && planSelectedGroupMemberIds.length > 1;
  useEffect(() => {
    if (!planCanCustomizeMembers) {
      setPlanCustomizeMembers(false);
      setPlanExcludedPersonIds([]);
      return;
    }
    setPlanExcludedPersonIds((current) => current.filter((personId) => planSelectedGroupMemberIds.includes(personId)));
  }, [planCanCustomizeMembers, planSelectedGroupMemberIds]);
  const shareRecipientIdsByPlan = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const plan of plans) {
      const recipients = new Set<string>();
      if (!plan.isPrivate) {
        if (plan.targetGroupIds.length > 0) {
          for (const person of cloudFriendPeople) {
            if (person.id === selfPersonId) continue;
            if (plan.excludedPersonIds.includes(person.id)) continue;
            if (person.groupIds.some((groupId) => plan.targetGroupIds.includes(groupId))) {
              recipients.add(person.id);
            }
          }
        } else {
          for (const person of cloudFriendPeople) {
            if (person.id === selfPersonId) continue;
            if (plan.excludedPersonIds.includes(person.id)) continue;
            recipients.add(person.id);
          }
        }
      }
      for (const participantId of plan.invitedIds) {
        if (participantId === selfPersonId || plan.excludedPersonIds.includes(participantId)) continue;
        recipients.add(participantId);
      }
      result.set(plan.id, [...recipients]);
    }
    return result;
  }, [cloudFriendPeople, plans, selfPersonId]);
  const acceptedInviteeColorByPlan = useMemo(() => {
    const acceptedByPlan = new Map<string, string[]>();
    const colorByPersonId = new Map<string, string>();
    for (const person of store.people) colorByPersonId.set(person.id, person.color);
    for (const person of cloudFriendPeople) {
      if (!colorByPersonId.has(person.id)) colorByPersonId.set(person.id, person.color);
    }
    for (const invite of ownedPlanInvites) {
      const normalizedStatus = normalizeInviteStatus(invite.status);
      if (normalizedStatus !== "going") continue;
      const color = colorByPersonId.get(invite.invitee_id);
      if (!color) continue;
      const current = acceptedByPlan.get(invite.plan_id) ?? [];
      if (!current.includes(color)) current.push(color);
      acceptedByPlan.set(invite.plan_id, current);
    }
    return acceptedByPlan;
  }, [cloudFriendPeople, ownedPlanInvites, store.people]);
  const inviteResponseByPlanAndPerson = useMemo(() => {
    const statusMap = new Map<string, InviteResponse>();
    for (const invite of ownedPlanInvites) {
      const normalizedStatus = normalizeInviteStatus(invite.status);
      if (normalizedStatus === "pending") continue;
      statusMap.set(`${invite.plan_id}:${invite.invitee_id}`, normalizedStatus);
    }
    return statusMap;
  }, [ownedPlanInvites]);
  const incomingInviteStatusByPlan = useMemo(() => {
    const map = new Map<string, "pending" | InviteResponse>();
    for (const invite of incomingPlanInvites) {
      map.set(invite.plan_id, normalizeInviteStatus(invite.status));
    }
    return map;
  }, [incomingPlanInvites]);
  const personColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of store.people) map.set(person.id, person.color);
    for (const person of cloudFriendPeople) {
      if (!map.has(person.id)) map.set(person.id, person.color);
    }
    const selfColor = store.people.find((person) => person.id === selfPersonId)?.color;
    if (selfColor) map.set(selfPersonId, selfColor);
    return map;
  }, [cloudFriendPeople, selfPersonId, store.people]);
  const allPlans = useMemo(() => {
    const byId = new Map<string, Plan>();
    plans.forEach((plan) => byId.set(plan.id, plan));
    sharedPlans.forEach((plan) => {
      if (!byId.has(plan.id)) byId.set(plan.id, plan);
    });
    return [...byId.values()];
  }, [plans, sharedPlans]);
  const planDetailsPlan = useMemo(
    () => (planDetailsPlanId ? allPlans.find((plan) => plan.id === planDetailsPlanId) ?? null : null),
    [allPlans, planDetailsPlanId]
  );
  const groupedPlansForList = useMemo(() => {
    const sorted = [...allPlans].sort((a, b) => {
      const dateCompare = a.fromDate.localeCompare(b.fromDate);
      if (dateCompare !== 0) return dateCompare;
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.fromTime.localeCompare(b.fromTime);
    });
    const groups = new Map<string, Plan[]>();
    sorted.forEach((plan) => {
      const key = plan.fromDate;
      const list = groups.get(key) ?? [];
      list.push(plan);
      groups.set(key, list);
    });
    return [...groups.entries()].map(([date, plansForDate]) => ({ date, plans: plansForDate }));
  }, [allPlans]);
  const visibleGroupIds = useMemo(
    () => store.groups.map((group) => group.id).filter((groupId) => !hiddenGroupIds.includes(groupId)),
    [hiddenGroupIds, store.groups]
  );
  const isPlanVisibleByGroups = useCallback(
    (plan: Plan) =>
      plan.targetGroupIds.length === 0 ||
      plan.targetGroupIds.some((groupId) => visibleGroupIds.includes(groupId)),
    [visibleGroupIds]
  );
  const isPlanVisibleByFriendToggle = useCallback(
    (plan: Plan) => !hiddenFriendIds.includes(plan.ownerId),
    [hiddenFriendIds]
  );
  const planAppliesToPerson = useCallback(
    (plan: Plan, personId: string) => {
      if (plan.ownerId === personId) return true;
      if (plan.invitedIds.includes(personId)) return true;
      if (personId === selfPersonId) {
        const incomingStatus = incomingInviteStatusByPlan.get(plan.id);
        return incomingStatus === "pending" || incomingStatus === "going" || incomingStatus === "maybe";
      }
      return false;
    },
    [incomingInviteStatusByPlan, selfPersonId]
  );
  const getPlansForDay = useCallback(
    (dateKey: string, personId: string) =>
      allPlans.filter(
        (plan) =>
          isDateInRange(dateKey, plan.fromDate, plan.toDate) &&
          isPlanVisibleByGroups(plan) &&
          isPlanVisibleByFriendToggle(plan) &&
          planAppliesToPerson(plan, personId)
      ),
    [allPlans, isPlanVisibleByFriendToggle, isPlanVisibleByGroups, planAppliesToPerson]
  );
  const getCalendarCellPlansForDay = useCallback(
    (dateKey: string, personId: string) =>
      allPlans.filter(
        (plan) =>
          isDateInRange(dateKey, plan.fromDate, plan.toDate) &&
          isPlanVisibleByGroups(plan) &&
          isPlanVisibleByFriendToggle(plan) &&
          (personId === selfPersonId || planAppliesToPerson(plan, personId))
      ),
    [allPlans, isPlanVisibleByFriendToggle, isPlanVisibleByGroups, planAppliesToPerson, selfPersonId]
  );
  const getPlanPillStyle = useCallback(
    (plan: Plan, personColor: string, participantStripeColors?: string[]): CSSProperties => {
      const firstGroupColor = plan.targetGroupIds
        .map((groupId) => store.groups.find((group) => group.id === groupId)?.color ?? null)
        .find((color): color is string => Boolean(color));
      const inviteStripeColors = (participantStripeColors ?? acceptedInviteeColorByPlan.get(plan.id) ?? [])
        .filter((color, index, source) => Boolean(color) && source.indexOf(color) === index);
      const firstInviteStripeColor = inviteStripeColors[0] ?? null;
      const style: CSSProperties = {
        ["--plan-color" as string]: personColor,
        ["--plan-gradient" as string]: `linear-gradient(120deg, ${personColor} 0 100%)`,
        ["--plan-border-color" as string]: personColor,
        ["--plan-stripe-color" as string]: "transparent",
      };
      if (firstGroupColor && inviteStripeColors.length > 0) {
        const stripeStart = 62;
        const stripeEnd = 84;
        const stripeSize = (stripeEnd - stripeStart) / inviteStripeColors.length;
        const stripeStops = inviteStripeColors
          .map((color, index) => {
            const start = stripeStart + stripeSize * index;
            const end = stripeStart + stripeSize * (index + 1);
            return `${color} ${start}% ${end}%`;
          })
          .join(", ");
        style["--plan-gradient" as string] =
          `linear-gradient(120deg, ${personColor} 0 ${stripeStart}%, ${stripeStops}, ${firstGroupColor} ${stripeEnd}% 100%)`;
        style["--plan-border-color" as string] = `${firstGroupColor}`;
        style["--plan-stripe-color" as string] = `${firstInviteStripeColor ?? "transparent"}`;
      } else if (firstGroupColor) {
        style["--plan-gradient" as string] =
          `linear-gradient(120deg, ${personColor} 0 75%, ${firstGroupColor} 75% 100%)`;
        style["--plan-border-color" as string] =
          `${firstGroupColor}`;
      } else if (inviteStripeColors.length > 0) {
        const stripeStart = 84;
        const stripeEnd = 100;
        const stripeSize = (stripeEnd - stripeStart) / inviteStripeColors.length;
        const stripeStops = inviteStripeColors
          .map((color, index) => {
            const start = stripeStart + stripeSize * index;
            const end = stripeStart + stripeSize * (index + 1);
            return `${color} ${start}% ${end}%`;
          })
          .join(", ");
        style["--plan-gradient" as string] =
          `linear-gradient(120deg, ${personColor} 0 ${stripeStart}%, ${stripeStops})`;
        style["--plan-border-color" as string] = `${personColor}`;
        style["--plan-stripe-color" as string] = `${firstInviteStripeColor ?? "transparent"}`;
      }
      return style;
    },
    [acceptedInviteeColorByPlan, store.groups]
  );
  const formatPlanWhen = (plan: Plan) => {
    if (plan.allDay) return `${plan.fromDate} to ${plan.toDate} (All day)`;
    return `${plan.fromDate} ${plan.fromTime} to ${plan.toDate} ${plan.toTime}`;
  };

  const planCalendarSections = useMemo(() => {
    return [
      {
        label: "Target Groups",
        options: store.groups.map((group) => ({ value: group.id, label: group.name })),
      },
    ];
  }, [store.groups]);
  const recurrenceDropdownSections = useMemo(
    () => [
      {
        label: "Repeat",
        options: RECURRENCE_OPTIONS,
      },
    ],
    []
  );
  const groupEmojiSections = useMemo(
    () => [
      {
        label: "Common Emojis",
        options: COMMON_GROUP_EMOJIS.map((item) => ({
          value: item.value,
          label: `${item.value} ${item.label}`,
        })),
      },
    ],
    []
  );

  const friendPeople = useMemo(
    () => cloudFriendPeople.filter((person) => person.id !== selectedPerson?.id),
    [cloudFriendPeople, selectedPerson?.id]
  );
  const visibleFriendPool = useMemo(
    () => friendPeople.filter((person) => !hiddenFriendIds.includes(person.id)),
    [friendPeople, hiddenFriendIds]
  );

  const dayModalLabel = useMemo(
    () => (dayModalDate ? dayModalDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : ""),
    [dayModalDate]
  );
  const dayModalKeyDate = useMemo(() => (dayModalDate ? toKeyDate(dayModalDate) : ""), [dayModalDate]);
  const dayDetailBasePerson = useMemo(
    () =>
      selectedPerson ??
      store.people.find((person) => person.id === selfPersonId) ??
      store.people[0] ??
      null,
    [selectedPerson, selfPersonId, store.people]
  );
  const dayDetailFriendPeople = useMemo(() => {
    if (!dayModalKeyDate || !dayDetailBasePerson) return [] as Person[];
    return visibleFriendPool.filter((person) => getPlansForDay(dayModalKeyDate, person.id).length > 0);
  }, [dayDetailBasePerson, dayModalKeyDate, getPlansForDay, visibleFriendPool]);
  const dayDetailPeople = useMemo(() => {
    if (!dayDetailBasePerson) return [] as Person[];
    return [dayDetailBasePerson, ...dayDetailFriendPeople];
  }, [dayDetailBasePerson, dayDetailFriendPeople]);
  useEffect(() => {
    if (!dayModalDate) return;
    const node = dayTimelineRef.current;
    if (!node) return;
    const updateRowSize = () => {
      const styles = getComputedStyle(node);
      const rawHeader = styles.getPropertyValue("--day-header-height").trim();
      const rawHeaderGap = styles.getPropertyValue("--day-header-gap").trim();
      const rawHourGap = styles.getPropertyValue("--day-hour-gap").trim();
      const headerHeight = Number.parseFloat(rawHeader.replace("px", "")) || 74;
      const headerGap = Number.parseFloat(rawHeaderGap.replace("px", "")) || 0;
      const hourGap = Number.parseFloat(rawHourGap.replace("px", "")) || 0;
      const available = Math.max(0, node.clientHeight - headerHeight - headerGap - (hourGap * 23));
      const next = Math.max(18, available / 24);
      setDayTimelineRowSize((current) => (Math.abs(current - next) < 0.2 ? current : next));
    };
    updateRowSize();
    const observer = new ResizeObserver(updateRowSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [dayDetailPeople.length, dayModalDate]);

  const monthLabel = useMemo(
    () => monthAnchor.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    [monthAnchor]
  );

  const calendarDays = useMemo(() => buildCalendarDays(monthAnchor), [monthAnchor]);
  const visiblePlanLanesByDay = useMemo(() => {
    const layoutByDay = new Map<string, Array<{ plan: Plan; lane: number }>>();
    if (!selectedPerson || calendarDays.length === 0) return layoutByDay;

    const visibleStart = toKeyDate(calendarDays[0]);
    const visibleEnd = toKeyDate(calendarDays[calendarDays.length - 1]);
    const relevantPlans = allPlans
      .filter(
        (plan) =>
          isPlanVisibleByGroups(plan) &&
          isPlanVisibleByFriendToggle(plan) &&
          (selectedPerson.id === selfPersonId || planAppliesToPerson(plan, selectedPerson.id)) &&
          !(plan.toDate < visibleStart || plan.fromDate > visibleEnd)
      )
      .slice()
      .sort((left, right) => {
        if (left.fromDate !== right.fromDate) return left.fromDate.localeCompare(right.fromDate);
        return timeToMinutes(left.fromTime) - timeToMinutes(right.fromTime);
      });

    const laneEndDate: Array<string | null> = [null, null, null];
    const laneByPlanId = new Map<string, number>();
    for (const plan of relevantPlans) {
      const clampedStart = plan.fromDate < visibleStart ? visibleStart : plan.fromDate;
      const clampedEnd = plan.toDate > visibleEnd ? visibleEnd : plan.toDate;
      let lane = -1;
      for (let candidate = 0; candidate < laneEndDate.length; candidate += 1) {
        const occupiedUntil = laneEndDate[candidate];
        if (!occupiedUntil || occupiedUntil < clampedStart) {
          lane = candidate;
          break;
        }
      }
      if (lane === -1) continue;
      laneByPlanId.set(plan.id, lane);
      laneEndDate[lane] = clampedEnd;
    }

    for (const day of calendarDays) {
      const dayKey = toKeyDate(day);
      const dayItems = relevantPlans
        .filter((plan) => isDateInRange(dayKey, plan.fromDate, plan.toDate))
        .map((plan) => ({ plan, lane: laneByPlanId.get(plan.id) ?? -1 }))
        .filter((entry) => entry.lane >= 0)
        .sort((left, right) => left.lane - right.lane);
      layoutByDay.set(dayKey, dayItems);
    }

    return layoutByDay;
  }, [allPlans, calendarDays, isPlanVisibleByFriendToggle, isPlanVisibleByGroups, planAppliesToPerson, selectedPerson, selfPersonId]);
  const monthCounts = useMemo(() => {
    const counts = { ...EMPTY_COUNTS };
    if (!selectedPerson) return counts;
    const monthPrefix = `${monthAnchor.getFullYear()}-${String(monthAnchor.getMonth() + 1).padStart(2, "0")}-`;
    const personPrefix = `${selectedPerson.id}:`;
    for (const [key, status] of Object.entries(store.entries)) {
      if (!key.startsWith(personPrefix) || !key.startsWith(`${personPrefix}${monthPrefix}`)) continue;
      if (status !== "none") counts[status] += 1;
    }
    return counts;
  }, [monthAnchor, selectedPerson, store.entries]);

  const getDayStatus = useCallback(
    (personId: string, dateKey: string): DayStatus => store.entries[`${personId}:${dateKey}`] ?? "none",
    [store.entries]
  );

  const openDayModal = (date: Date) => {
    if (!selectedPerson) return;
    setDayModalDate(date);
  };

  const closeDayModal = () => {
    setDayModalDate(null);
  };

  const openPlanDetailsFromPill = (event: MouseEvent<HTMLElement>, planId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setPlanDetailsPlanId(planId);
  };

  const togglePlanInvite = (personId: string) => {
    const isCurrentlyInvited = planInvitedIds.includes(personId);
    if (isCurrentlyInvited && editingPlanId) {
      const status = inviteResponseByPlanAndPerson.get(`${editingPlanId}:${personId}`) ?? "pending";
      if (status !== "pending") {
        const personName =
          store.people.find((person) => person.id === personId)?.name ??
          cloudFriendPeople.find((person) => person.id === personId)?.name ??
          "This person";
        const statusLabel = status === "going" ? "Going" : status === "maybe" ? "Maybe" : "Can't";
        const confirmed = window.confirm(
          `${personName} has already responded "${statusLabel}" to this event. Continue and remove them from the plan?`
        );
        if (!confirmed) return;
      }
    }
    setPlanInvitedIds((current) =>
      current.includes(personId) ? current.filter((id) => id !== personId) : [...current, personId]
    );
  };

  const resetPlanForm = () => {
    const today = toKeyDate(new Date());
    setPlanName("");
    setPlanSummary("");
    setPlanLocation("");
    setPlanTargetGroupIds([]);
    setPlanIsPrivate(false);
    setPlanCustomizeMembers(false);
    setPlanExcludedPersonIds([]);
    setPlanFromDate(today);
    setPlanToDate(today);
    setPlanAllDay(false);
    setPlanFromTime("09:00");
    setPlanToTime("17:00");
    setPlanInvitedIds([]);
    setPlanRecurring(false);
    setPlanRecurrenceType("weekly");
    setPlanCustomRecurrenceDays(7);
    setPlanRecurrenceCount(1);
    setPlanRecurrenceInfinite(false);
    setPlanModalMessage("");
    setEditingPlanId(null);
  };

  const openCreatePlanModal = () => {
    resetPlanForm();
    setCreatePlanOpen(true);
  };

  const openEditPlanModal = (plan: Plan) => {
    if (!canEditPlan(plan)) return;
    setEditingPlanId(plan.id);
    setPlanName(plan.name);
    setPlanSummary(plan.summary ?? "");
    setPlanLocation(plan.location ?? "");
    setPlanTargetGroupIds([...plan.targetGroupIds]);
    setPlanIsPrivate(plan.isPrivate);
    setPlanCustomizeMembers(plan.excludedPersonIds.length > 0);
    setPlanExcludedPersonIds([...plan.excludedPersonIds]);
    setPlanFromDate(plan.fromDate);
    setPlanToDate(plan.toDate);
    setPlanAllDay(plan.allDay);
    setPlanFromTime(plan.fromTime);
    setPlanToTime(plan.toTime);
    setPlanInvitedIds([...plan.invitedIds]);
    setPlanRecurring(false);
    setPlanRecurrenceType("weekly");
    setPlanCustomRecurrenceDays(7);
    setPlanRecurrenceCount(1);
    setPlanRecurrenceInfinite(false);
    setPlanModalMessage("");
    setCreatePlanOpen(true);
  };

  const deletePlan = (planId: string) => {
    const removed = plans.find((plan) => plan.id === planId);
    if (removed && removed.ownerId !== selfPersonId) return;
    setPlans((current) => current.filter((plan) => plan.id !== planId));
    if (removed && cloudUser?.id && removed.invitedIds.length > 0) {
      void deleteSharedPlan(cloudUser.id, planId);
    }
    if (editingPlanId === planId) {
      setCreatePlanOpen(false);
      setEditingPlanId(null);
    }
  };

  const savePlan = (event: FormEvent) => {
    event.preventDefault();
    if (!planName.trim()) {
      setPlanModalMessage("Plan name is required.");
      return;
    }
    if (!planFromDate || !planToDate) {
      setPlanModalMessage("Select both from and to dates.");
      return;
    }
    if (!planAllDay && (!planFromTime || !planToTime)) {
      setPlanModalMessage("Select both from and to times.");
      return;
    }
    if (planRecurring && planRecurrenceType === "custom" && planCustomRecurrenceDays < 1) {
      setPlanModalMessage("Custom recurrence must be at least 1 day.");
      return;
    }
    if (planRecurring && !planRecurrenceInfinite && planRecurrenceCount < 1) {
      setPlanModalMessage("Set recurrence count to at least 1.");
      return;
    }
    if (editingPlanId) {
      const existingPlan = allPlans.find((plan) => plan.id === editingPlanId);
      if (existingPlan && !canEditPlan(existingPlan)) {
        setPlanModalMessage("Only the host or invited users marked Going can edit this plan.");
        return;
      }
    }

    const baseCandidate: Plan = {
      id: editingPlanId ?? createId(planName),
      name: planName.trim(),
      summary: planSummary.trim(),
      location: planLocation.trim(),
      ownerId: editingPlanId ? plans.find((plan) => plan.id === editingPlanId)?.ownerId ?? selfPersonId : selfPersonId,
      targetGroupIds: planTargetGroupIds,
      excludedPersonIds: [],
      isPrivate: planIsPrivate,
      fromDate: planFromDate,
      toDate: planToDate,
      allDay: planAllDay,
      fromTime: planFromTime,
      toTime: planToTime,
      invitedIds: [],
    };
    const candidateInstances: Plan[] = [baseCandidate];
    if (!editingPlanId && planRecurring) {
      const repeatCount = planRecurrenceInfinite ? 260 : planRecurrenceCount;
      let fromDateCursor = planFromDate;
      let toDateCursor = planToDate;
      for (let index = 0; index < repeatCount; index += 1) {
        const shifted = addRecurrenceStep(
          fromDateCursor,
          toDateCursor,
          planRecurrenceType,
          Math.max(1, planCustomRecurrenceDays)
        );
        fromDateCursor = shifted.fromDate;
        toDateCursor = shifted.toDate;
        candidateInstances.push({
          ...baseCandidate,
          id: createId(`${planName}-${index + 1}`),
          fromDate: shifted.fromDate,
          toDate: shifted.toDate,
        });
      }
    }
    const conflicts = candidateInstances
      .flatMap((candidate) =>
        allPlans
          .filter((plan) => plan.id !== editingPlanId)
          .filter((plan) => (plan.ownerId === selfPersonId || plan.invitedIds.includes(selfPersonId)))
          .filter((plan) => plansOverlap(plan, candidate))
      );
    if (conflicts.length > 0) {
      setPlanModalMessage(`You're busy at that time. Conflicts with: ${conflicts.slice(0, 2).map((plan) => formatConflictSummary(plan)).join(" | ")}`);
      return;
    }

    const normalizedExcludedIds = planCustomizeMembers
      ? planExcludedPersonIds.filter((personId) => planSelectedGroupMemberIds.includes(personId))
      : [];
    const normalizedInvitedIds = [...new Set(planInvitedIds.filter((personId) => personId && personId !== selfPersonId))];

    const nextPlan: Plan = {
      id: editingPlanId ?? createId(planName),
      name: planName.trim(),
      summary: planSummary.trim(),
      location: planLocation.trim(),
      ownerId: editingPlanId ? plans.find((plan) => plan.id === editingPlanId)?.ownerId ?? selfPersonId : selfPersonId,
      targetGroupIds: planTargetGroupIds,
      excludedPersonIds: normalizedExcludedIds,
      isPrivate: planIsPrivate,
      fromDate: planFromDate,
      toDate: planToDate,
      allDay: planAllDay,
      fromTime: planFromTime,
      toTime: planToTime,
      invitedIds: normalizedInvitedIds,
    };
    if (editingPlanId) {
      setPlans((current) => current.map((plan) => (plan.id === editingPlanId ? nextPlan : plan)));
      setPlanModalMessage("Plan updated.");
    } else {
      if (!planRecurring) {
        setPlans((current) => [nextPlan, ...current]);
        setPlanModalMessage("Plan created.");
      } else {
        const repeatCount = planRecurrenceInfinite ? 260 : planRecurrenceCount;
        let fromDateCursor = planFromDate;
        let toDateCursor = planToDate;
        const generatedPlans: Plan[] = [nextPlan];
        for (let index = 0; index < repeatCount; index += 1) {
          const shifted = addRecurrenceStep(
            fromDateCursor,
            toDateCursor,
            planRecurrenceType,
            Math.max(1, planCustomRecurrenceDays)
          );
          fromDateCursor = shifted.fromDate;
          toDateCursor = shifted.toDate;
          generatedPlans.push({
            ...nextPlan,
            id: createId(`${planName}-${index + 1}`),
            fromDate: shifted.fromDate,
            toDate: shifted.toDate,
          });
        }
        setPlans((current) => [...generatedPlans, ...current]);
        setPlanModalMessage(
          planRecurrenceInfinite
            ? `Recurring plan created (${generatedPlans.length} future instances generated).`
            : `Recurring plan created (${generatedPlans.length} instances).`
        );
      }
    }
  };

  const planTargetLabel = (targetGroupIds: string[], isPrivate = false) => {
    if (isPrivate) return "Private (Only You)";
    const labels = targetGroupIds
      .map((groupId) => store.groups.find((group) => group.id === groupId)?.name)
      .filter((name): name is string => Boolean(name));
    return labels.length > 0 ? labels.join(", ") : "Public (All Friends)";
  };

  const getInviteStatusForPerson = useCallback(
    (plan: Plan, personId: string): "pending" | InviteResponse | null => {
      if (plan.ownerId === personId) return "going";
      if (!plan.invitedIds.includes(personId)) return null;
      const ownerTracked = inviteResponseByPlanAndPerson.get(`${plan.id}:${personId}`);
      if (ownerTracked) return ownerTracked;
      if (personId === selfPersonId) {
        return incomingInviteStatusByPlan.get(plan.id) ?? "pending";
      }
      return "pending";
    },
    [incomingInviteStatusByPlan, inviteResponseByPlanAndPerson, selfPersonId]
  );
  const getPlanParticipationStatus = (plan: Plan, personId: string) => {
    if (plan.ownerId === personId) return "Host";
    if (!plan.invitedIds.includes(personId)) return "Viewer";
    const response = getInviteStatusForPerson(plan, personId);
    if (response === "going") return "Going";
    if (response === "maybe") return "Maybe";
    if (response === "cant") return "Can't";
    return "Pending";
  };
  const planDetailsParticipants = useMemo(() => {
    if (!planDetailsPlan) return [] as Array<{ id: string; name: string; response: "going" | "maybe" | "cant" | "waiting" }>;
    const ownerName =
      store.people.find((person) => person.id === planDetailsPlan.ownerId)?.name ??
      cloudFriendPeople.find((person) => person.id === planDetailsPlan.ownerId)?.name ??
      (planDetailsPlan.ownerId === selfPersonId ? "You" : "Friend");
    const inviteeRows = planDetailsPlan.invitedIds.map((inviteeId) => {
      const name =
        store.people.find((person) => person.id === inviteeId)?.name ??
        cloudFriendPeople.find((person) => person.id === inviteeId)?.name ??
        (inviteeId === selfPersonId ? "You" : "Friend");
      const status = getInviteStatusForPerson(planDetailsPlan, inviteeId);
      return {
        id: inviteeId,
        name,
        response: status === "going" || status === "maybe" || status === "cant" ? status : "waiting",
      };
    });
    return [{ id: planDetailsPlan.ownerId, name: ownerName, response: "going" as const }, ...inviteeRows];
  }, [cloudFriendPeople, getInviteStatusForPerson, planDetailsPlan, selfPersonId, store.people]);
  const getGoingStripeColorsForPlan = useCallback(
    (plan: Plan) => {
      const colors = [...(acceptedInviteeColorByPlan.get(plan.id) ?? [])];
      const selfIncomingStatus = incomingInviteStatusByPlan.get(plan.id);
      if (selfIncomingStatus === "going" && plan.ownerId !== selfPersonId) {
        const selfColor = personColorById.get(selfPersonId);
        if (selfColor && !colors.includes(selfColor)) colors.push(selfColor);
      }
      return colors;
    },
    [acceptedInviteeColorByPlan, incomingInviteStatusByPlan, personColorById, selfPersonId]
  );
  const incomingInviteByPlanId = useMemo(() => {
    const map = new Map<string, SharedInvitePayload>();
    for (const invite of incomingPlanInvites) {
      map.set(invite.plan_id, invite);
    }
    return map;
  }, [incomingPlanInvites]);
  const getViewerInviteStatusForPlan = useCallback(
    (plan: Plan) => {
      const invite = incomingInviteByPlanId.get(plan.id);
      return invite ? normalizeInviteStatus(invite.status) : null;
    },
    [incomingInviteByPlanId]
  );
  const canEditPlan = useCallback(
    (plan: Plan) => {
      if (plan.ownerId === selfPersonId) return true;
      return getViewerInviteStatusForPlan(plan) === "going";
    },
    [getViewerInviteStatusForPlan, selfPersonId]
  );

  const resetGroupForm = () => {
    setEditingGroupId(null);
    setNewGroupName("");
    setNewGroupIcon("");
    setNewGroupColor(PRESET_PERSON_COLORS[0]);
    setNewGroupCustomIcon(false);
  };
  const addGroup = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    const id = editingGroupId ?? createUuid();
    const icon = newGroupIcon.trim() || inferGroupIcon(trimmed, id);
    const color = newGroupColor || inferGroupColor(trimmed, id);
    updateStore((current) => ({
      ...current,
      groups: editingGroupId
        ? current.groups.map((group) => (group.id === editingGroupId ? { ...group, name: trimmed, icon, color } : group))
        : current.groups.some((group) => group.id === id || group.name.trim().toLowerCase() === trimmed.toLowerCase())
          ? current.groups
          : [...current.groups, { id, name: trimmed, icon, color }],
    }));
    if (newPersonGroupIds.length === 0) setNewPersonGroupIds([id]);
    resetGroupForm();
    setGroupCreatorOpen(false);
  };
  const openGroupCreator = () => {
    resetGroupForm();
    setGroupsListOpen(false);
    setGroupCreatorOpen(true);
  };
  const openEditGroupCreator = (group: Group) => {
    setEditingGroupId(group.id);
    setNewGroupName(group.name);
    setNewGroupIcon(group.icon);
    setNewGroupColor(group.color);
    setNewGroupCustomIcon(false);
    setGroupsListOpen(false);
    setGroupCreatorOpen(true);
  };
  const deleteGroup = (groupId: string) => {
    updateStore((current) => ({
      ...current,
      groups: current.groups.filter((group) => group.id !== groupId),
      people: current.people.map((person) => ({
        ...person,
        groupIds: person.groupIds.filter((id) => id !== groupId),
      })),
    }));
    setPlans((current) =>
      current.map((plan) => ({
        ...plan,
        targetGroupIds: plan.targetGroupIds.filter((id) => id !== groupId),
      }))
    );
    setHiddenGroupIds((current) => current.filter((id) => id !== groupId));
    setPlanTargetGroupIds((current) => current.filter((id) => id !== groupId));
    setNewPersonGroupIds((current) => current.filter((id) => id !== groupId));
    if (editingGroupId === groupId) {
      resetGroupForm();
      setGroupCreatorOpen(false);
    }
  };
  const toggleFriendVisibility = (personId: string) => {
    setHiddenFriendIds((current) =>
      current.includes(personId) ? current.filter((id) => id !== personId) : [...current, personId]
    );
  };
  const toggleGroupVisibility = (groupId: string) => {
    setHiddenGroupIds((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]
    );
  };
  const togglePersonCard = (personId: string) => {
    setCollapsedPersonIds((current) =>
      current.includes(personId) ? current.filter((id) => id !== personId) : [...current, personId]
    );
  };

  const resetPersonForm = () => {
    setEditingPersonId(null);
    setNewPersonName("");
    setNewPersonGroupIds([DEFAULT_GROUP_ID_FRIENDS]);
    setNewPersonColor(PRESET_PERSON_COLORS[0]);
  };
  const addPerson = (event: FormEvent) => {
    event.preventDefault();
    if (!editingPersonId) return;
    const trimmed = newPersonName.trim();
    if (!trimmed || newPersonGroupIds.length === 0) return;
    const id = editingPersonId;
    updateStore((current) => ({
      ...current,
      people: current.people.some((person) => person.id === editingPersonId)
        ? current.people.map((person) =>
            person.id === editingPersonId
              ? {
                  ...person,
                  name: trimmed,
                  groupIds: [...newPersonGroupIds],
                  color: newPersonColor,
                }
              : person
          )
        : [...current.people, { id, name: trimmed, groupIds: [...newPersonGroupIds], color: newPersonColor }],
    }));
    resetPersonForm();
    setPersonCreatorOpen(false);
  };
  const openPersonCreator = () => {
    resetPersonForm();
    setFriendsListOpen(false);
    setPersonCreatorOpen(true);
  };
  const openEditPersonCreator = (person: Person) => {
    setEditingPersonId(person.id);
    setNewPersonName(person.name);
    setNewPersonGroupIds([...person.groupIds]);
    setNewPersonColor(person.color);
    setFriendsListOpen(false);
    setPersonCreatorOpen(true);
  };
  const deletePerson = (personId: string) => {
    if (personId === selfPersonId) return;
    updateStore((current) => ({
      ...current,
      people: current.people.filter((person) => person.id !== personId),
    }));
    setPlans((current) =>
      current
        .filter((plan) => plan.ownerId !== personId)
        .map((plan) => ({
          ...plan,
          invitedIds: plan.invitedIds.filter((id) => id !== personId),
        }))
    );
    setHiddenFriendIds((current) => current.filter((id) => id !== personId));
    setCollapsedPersonIds((current) => current.filter((id) => id !== personId));
    if (selectedPersonId === personId) setSelectedPersonId(selfPersonId || null);
    if (editingPersonId === personId) {
      resetPersonForm();
      setPersonCreatorOpen(false);
    }
  };

  const togglePersonGroup = (personId: string, groupId: string) => {
    if (personId === selfPersonId) return;
    updateStore((current) => ({
      ...current,
      people: current.people.map((person) => {
        if (person.id !== personId) return person;
        const hasGroup = person.groupIds.includes(groupId);
        const nextGroupIds = hasGroup ? person.groupIds.filter((id) => id !== groupId) : [...person.groupIds, groupId];
        return { ...person, groupIds: nextGroupIds };
      }),
    }));
  };

  const setPersonColor = (personId: string, color: string) => {
    updateStore((current) => ({
      ...current,
      people: current.people.map((person) => (person.id === personId ? { ...person, color } : person)),
    }));
  };

  const refreshCloudFriends = useCallback(async () => {
    if (!socialUserId) {
      setCloudFriends([]);
      setCloudFriendsError("");
      return;
    }
    const { friends, error } = await listCloudFriends(socialUserId);
    if (error) {
      setCloudFriends([]);
      setCloudFriendsError(error);
      return;
    }
    const nextFriends = import.meta.env.DEV
      ? [...friends, ...DEV_FAKE_FRIENDS.filter((fake) => !friends.some((real) => real.user_id === fake.user_id))]
      : friends;
    setCloudFriends((current) => {
      if (current.length === nextFriends.length) {
        const currentKey = [...current]
          .map((entry) => `${entry.friendship_id}:${entry.user_id}:${entry.username}:${entry.avatar_url ?? ""}:${entry.active ? "1" : "0"}`)
          .sort()
          .join("|");
        const nextKey = [...nextFriends]
          .map((entry) => `${entry.friendship_id}:${entry.user_id}:${entry.username}:${entry.avatar_url ?? ""}:${entry.active ? "1" : "0"}`)
          .sort()
          .join("|");
        if (currentKey === nextKey) return current;
      }
      return nextFriends;
    });
    setCloudFriendsError("");
  }, [socialUserId]);

  const refreshSharedPlans = useCallback(async () => {
    if (!socialUserId) {
      setSharedPlans([]);
      return;
    }
    const { plans: remotePlans, error } = await listVisibleSharedPlans(socialUserId);
    if (error) {
      setSyncState("error");
      setSyncMessage(`Shared plans failed: ${error}`);
      return;
    }
    const normalized: Plan[] = remotePlans.map((plan) => {
      const decodedTargets = decodeSharedTargetGroupIds(Array.isArray(plan.target_group_ids) ? plan.target_group_ids : []);
      const isOwnedByViewer = plan.owner_id === socialUserId;
      return {
        id: plan.id,
        name: plan.name,
        summary: typeof plan.summary === "string" ? plan.summary : "",
        location: typeof plan.location === "string" ? plan.location : "",
        ownerId: plan.owner_id,
        targetGroupIds: isOwnedByViewer ? decodedTargets.targetGroupIds.map((groupId) => normalizeLocalGroupId(groupId)) : [],
        excludedPersonIds: decodedTargets.excludedPersonIds,
        isPrivate: decodedTargets.isPrivate,
        fromDate: plan.from_date,
        toDate: plan.to_date,
        allDay: Boolean(plan.all_day),
        fromTime: plan.from_time || "09:00",
        toTime: plan.to_time || "17:00",
        invitedIds: isOwnedByViewer && Array.isArray(plan.invited_ids) ? plan.invited_ids : [],
      };
    });
    setSharedPlans(normalized);
  }, [socialUserId]);

  const refreshNotifications = useCallback(async () => {
    if (!socialUserId) {
      setCloudNotifications([]);
      setIncomingPlanInvites([]);
      return;
    }
    const [{ notifications, error: notificationsError }, { invites, error: invitesError }] = await Promise.all([
      listNotifications(socialUserId),
      listIncomingPlanInvites(socialUserId),
    ]);
    if (!notificationsError) setCloudNotifications(notifications);
    if (!invitesError) setIncomingPlanInvites(invites);
  }, [socialUserId]);

  const refreshOwnedPlanInvites = useCallback(async () => {
    if (!socialUserId) {
      setOwnedPlanInvites([]);
      return;
    }
    const { invites, error } = await listOwnedPlanInvites(socialUserId);
    if (error) return;
    setOwnedPlanInvites(invites);
  }, [socialUserId]);

  const openFriendRequestModal = () => {
    setFriendRequestUsername("");
    setFriendRequestMessage("");
    setFriendRequestOpen(true);
  };

  const sendFriendRequest = async (event: FormEvent) => {
    event.preventDefault();
    if (!socialUserId) {
      setFriendRequestMessage("Sign in to add friends.");
      return;
    }
    setFriendRequestBusy(true);
    const { error } = await sendCloudFriendRequestByUsername(socialUserId, friendRequestUsername);
    setFriendRequestBusy(false);
    if (error) {
      setFriendRequestMessage(error);
      return;
    }
    setFriendRequestMessage("Friend request sent.");
    setFriendRequestUsername("");
    await refreshCloudFriends();
  };

  const deleteCloudFriendship = async (friendshipId: string, friendUserId: string) => {
    const { error } = await removeCloudFriend(friendshipId);
    if (error) return;
    setCloudFriends((current) => current.filter((friend) => friend.friendship_id !== friendshipId));
    updateStore((current) => ({
      ...current,
      people: current.people.filter((person) => person.id !== friendUserId),
    }));
    setHiddenFriendIds((current) => current.filter((id) => id !== friendUserId));
  };

  const requestDeleteEditingFriend = () => {
    if (!editingCloudFriend) return;
    setDeleteFriendConfirmOpen(true);
  };

  const confirmDeleteEditingFriend = async () => {
    if (!editingCloudFriend) return;
    await deleteCloudFriendship(editingCloudFriend.friendship_id, editingCloudFriend.user_id);
    setDeleteFriendConfirmOpen(false);
    setPersonCreatorOpen(false);
    resetPersonForm();
  };

  const handleInviteResponse = async (inviteId: string, response: InviteResponse) => {
    setInviteActionMessage("");
    const invite = incomingPlanInvites.find((entry) => entry.id === inviteId);
    const relatedPlan = invite ? allPlans.find((plan) => plan.id === invite.plan_id) : null;
    let overlapNotice = "";
    if (relatedPlan && (response === "going" || response === "maybe") && selfPersonId) {
      const conflicts = allPlans
        .filter((plan) => plan.id !== relatedPlan.id)
        .filter((plan) => (plan.ownerId === selfPersonId || plan.invitedIds.includes(selfPersonId)))
        .filter((plan) => plansOverlap(plan, relatedPlan));
      if (conflicts.length > 0) {
        overlapNotice = ` Overlap: ${conflicts.slice(0, 2).map((plan) => formatConflictSummary(plan)).join(" | ")}`;
      }
    }
    const { error } = await respondToPlanInvite(inviteId, response);
    if (error) return;
    if (invite) {
      const inviteNotificationIds = cloudNotifications
        .filter((notification) => String(notification.type ?? "").toLowerCase() === "plan_invite")
        .filter((notification) => notificationPayloadPlanId(notification.payload) === invite.plan_id)
        .map((notification) => notification.id);
      if (inviteNotificationIds.length > 0) {
        await clearNotificationsByIds(inviteNotificationIds);
        setCloudNotifications((current) =>
          current.filter((notification) => !inviteNotificationIds.includes(notification.id))
        );
      }
    }
    setInviteActionMessage(`Invite updated: ${response === "going" ? "Going" : response === "maybe" ? "Maybe" : "Can't"}.${overlapNotice}`);
    setIncomingPlanInvites((current) => current.filter((inviteRow) => inviteRow.id !== inviteId));
    await refreshNotifications();
    await refreshSharedPlans();
  };

  const markAsRead = async (notificationId: string) => {
    const { error } = await markNotificationRead(notificationId);
    if (error) return;
    setCloudNotifications((current) =>
      current.map((notification) =>
        notification.id === notificationId ? { ...notification, is_read: true } : notification
      )
    );
  };

  const deleteActivityNotification = async (notificationId: string) => {
    const { error } = await deleteNotification(notificationId);
    if (error) return;
    setCloudNotifications((current) => current.filter((notification) => notification.id !== notificationId));
  };

  const clearActivityNotifications = async () => {
    const ids = cloudNotifications
      .filter((notification) => String(notification.type ?? "").toLowerCase() !== "plan_invite")
      .map((notification) => notification.id);
    if (ids.length === 0) return;
    const { error } = await clearNotificationsByIds(ids);
    if (error) return;
    setCloudNotifications((current) => current.filter((notification) => !ids.includes(notification.id)));
  };

  useEffect(() => {
    void refreshCloudFriends();
  }, [refreshCloudFriends]);

  useEffect(() => {
    if (!socialUserId || !isCloudConfigured) return;
    void refreshSharedPlans();
    void refreshNotifications();
    void refreshOwnedPlanInvites();
  }, [socialUserId, refreshNotifications, refreshSharedPlans, refreshOwnedPlanInvites]);

  useEffect(() => {
    if (!socialUserId || !isCloudConfigured) return;
    const unsubscribe = onCalendarRealtimeChange(socialUserId, () => {
      void refreshSharedPlans();
      void refreshNotifications();
      void refreshOwnedPlanInvites();
    });
    return () => unsubscribe();
  }, [socialUserId, refreshNotifications, refreshOwnedPlanInvites, refreshSharedPlans]);

  useEffect(() => {
    if (!socialUserId || !isCloudConfigured) return;
    const interval = window.setInterval(() => {
      void refreshSharedPlans();
      void refreshNotifications();
      void refreshOwnedPlanInvites();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [socialUserId, refreshNotifications, refreshOwnedPlanInvites, refreshSharedPlans]);

  useEffect(() => {
    if (!inviteActionMessage) return;
    const timeout = window.setTimeout(() => setInviteActionMessage(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [inviteActionMessage]);

  useEffect(() => {
    if (!friendRequestMessage) return;
    const timeout = window.setTimeout(() => setFriendRequestMessage(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [friendRequestMessage]);

  useEffect(() => {
    if (!socialUserId || !isCloudConfigured || cloudFriends.length === 0) return;
    const unsubscribe = onCloudFriendStatusChange(
      cloudFriends.map((friend) => friend.user_id).filter(Boolean),
      () => {
        void refreshCloudFriends();
      }
    );
    return () => unsubscribe();
  }, [cloudFriends, refreshCloudFriends, socialUserId]);

  useEffect(() => {
    if (!notificationsOpen) return;
    setNotificationClockMs(Date.now());
    const interval = window.setInterval(() => setNotificationClockMs(Date.now()), 30000);
    return () => window.clearInterval(interval);
  }, [notificationsOpen]);

  useEffect(() => {
    if (!notificationsOpen || notificationsTab !== "activity") return;
    const root = activityListRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.55) continue;
          const target = entry.target as HTMLElement;
          const notificationId = target.dataset.notificationId ?? "";
          const readFlag = target.dataset.notificationRead ?? "0";
          if (!notificationId || readFlag === "1") continue;
          if (activityAutoReadPendingRef.current.has(notificationId)) continue;
          activityAutoReadPendingRef.current.add(notificationId);
          void markAsRead(notificationId).finally(() => {
            activityAutoReadPendingRef.current.delete(notificationId);
          });
        }
      },
      { root, threshold: [0.55] }
    );
    const cards = root.querySelectorAll<HTMLElement>("[data-notification-id]");
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [cloudNotifications, markAsRead, notificationsOpen, notificationsTab]);

  useEffect(() => {
    if (!socialUserId || !isCloudConfigured) {
      sharedPlanIdsRef.current = [];
      lastSharedSyncSignatureRef.current = "";
      return;
    }
    const ownedSharedPlans = plans.filter((plan) => (shareRecipientIdsByPlan.get(plan.id)?.length ?? 0) > 0);
    const planPayload: SharedPlanPayload[] = ownedSharedPlans.map((plan) => ({
      id: plan.id,
      owner_id: socialUserId,
      name: plan.name,
      summary: plan.summary,
      location: plan.location,
      from_date: plan.fromDate,
      to_date: plan.toDate,
      all_day: plan.allDay,
      from_time: plan.fromTime,
      to_time: plan.toTime,
      target_group_ids: encodeSharedTargetGroupIds(plan).sort(),
      invited_ids: (shareRecipientIdsByPlan.get(plan.id) ?? [])
        .filter((id) => id && id !== socialUserId && isUuid(id))
        .sort(),
    }));
    const sortedPayload = [...planPayload].sort((a, b) => a.id.localeCompare(b.id));
    const inviteSyncPayload = ownedSharedPlans
      .map((plan) => ({
        id: plan.id,
        invitee_ids: plan.invitedIds
          .filter((id) => id && id !== socialUserId && isUuid(id))
          .filter((id) => !plan.excludedPersonIds.includes(id))
          .sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const syncSignature = JSON.stringify({
      shared: sortedPayload,
      invites: inviteSyncPayload,
    });
    if (syncSignature === lastSharedSyncSignatureRef.current) {
      return;
    }
    lastSharedSyncSignatureRef.current = syncSignature;

    void (async () => {
      const upsertResult = await upsertSharedPlans(socialUserId, sortedPayload);
      if (upsertResult.error) {
        setSyncState("error");
        setSyncMessage(`Plan sync failed: ${upsertResult.error}`);
        return;
      }

      for (const plan of ownedSharedPlans) {
        const participantInvitees = inviteSyncPayload.find((entry) => entry.id === plan.id)?.invitee_ids ?? [];
        const inviteResult = await syncSharedPlanInvites(
          socialUserId,
          plan.id,
          participantInvitees
        );
        if (inviteResult.error) {
          setSyncState("error");
          setSyncMessage(`Invite sync failed: ${inviteResult.error}`);
          return;
        }
      }
    })();

    const previousIds = new Set(sharedPlanIdsRef.current);
    const currentIds = new Set(ownedSharedPlans.map((plan) => plan.id));
    previousIds.forEach((planId) => {
      if (!currentIds.has(planId)) {
        void deleteSharedPlan(socialUserId, planId);
      }
    });
    sharedPlanIdsRef.current = [...currentIds];
  }, [plans, shareRecipientIdsByPlan, socialUserId]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthMessage("Enter both email and password.");
      return;
    }
    setAuthBusy(true);
    setAuthMessage("");
    const { error } = await signInCloud(authEmail.trim(), authPassword);
    setAuthBusy(false);
    setAuthMessage(error ? `Sign in failed: ${error}` : "Signed in.");
    if (!error) {
      setAuthModalOpen(false);
      await refreshCloudFriends();
    }
  };

  const signUp = async () => {
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthMessage("Enter both email and password.");
      return;
    }
    setAuthBusy(true);
    setAuthMessage("");
    const { error } = await signUpCloud(authEmail.trim(), authPassword);
    setAuthBusy(false);
    setAuthMessage(error ? `Sign up failed: ${error}` : "Account created. Check email if confirmation is enabled.");
    if (!error) setAuthModalOpen(false);
  };

  const signOut = async () => {
    setAuthBusy(true);
    if (socialUserId) {
      const token = localStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
      if (token) {
        await disablePushToken(socialUserId, token);
      }
    }
    const { error } = await signOutCloud();
    setAuthBusy(false);
    setAuthMessage(error ? `Sign out failed: ${error}` : "Signed out.");
    setCloudRoomId("");
    setCloudFriends([]);
  };

  const connectCloud = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRoomId(cloudRoomDraft);
    setCloudRoomDraft(normalized);
    if (!normalized) {
      setSyncState("error");
      setSyncMessage("Room ID must include letters or numbers.");
      return;
    }
    setCloudRoomId(normalized);
  };

  const createRoom = async () => {
    if (!cloudUser) {
      setSyncState("error");
      setSyncMessage("Sign in before creating rooms.");
      return;
    }
    const roomId = normalizeRoomId(cloudRoomDraft);
    if (!roomId) {
      setSyncState("error");
      setSyncMessage("Room ID must include letters or numbers.");
      return;
    }
    if (cloudJoinCodeDraft.trim().length < 6) {
      setSyncState("error");
      setSyncMessage("Join code must be at least 6 characters.");
      return;
    }
    setSyncState("syncing");
    const { error } = await createCloudRoom(roomId, cloudJoinCodeDraft.trim(), storeRef.current);
    if (error) {
      setSyncState("error");
      setSyncMessage(`Create room failed: ${error}`);
      return;
    }
    setCloudRoomId(roomId);
    setSyncState("idle");
    setSyncMessage("Room created and connected.");
    setLastSyncAt(Date.now());
    void loadRoomMembers();
  };

  const joinRoom = async () => {
    if (!cloudUser) {
      setSyncState("error");
      setSyncMessage("Sign in before joining rooms.");
      return;
    }
    const roomId = normalizeRoomId(cloudRoomDraft);
    if (!roomId) {
      setSyncState("error");
      setSyncMessage("Room ID must include letters or numbers.");
      return;
    }
    if (cloudJoinCodeDraft.trim().length < 6) {
      setSyncState("error");
      setSyncMessage("Join code must be at least 6 characters.");
      return;
    }
    setSyncState("syncing");
    const { error } = await joinCloudRoom(roomId, cloudJoinCodeDraft.trim());
    if (error) {
      setSyncState("error");
      setSyncMessage(`Join room failed: ${error}`);
      return;
    }
    setCloudRoomId(roomId);
    setSyncState("idle");
    setSyncMessage("Joined room successfully.");
    void pullFromCloud("manual");
    void loadRoomMembers();
  };

  const inviteMember = async () => {
    if (!cloudUser || !cloudRoomId) {
      setMemberMessage("Connect to a room first.");
      return;
    }
    const email = normalizeMemberEmail(memberEmailDraft);
    if (!email || !email.includes("@")) {
      setMemberMessage("Enter a valid member email.");
      return;
    }
    setMemberBusy(true);
    const { error } = await inviteCloudRoomMember(cloudRoomId, email);
    setMemberBusy(false);
    if (error) {
      setMemberMessage(`Invite failed: ${error}`);
      return;
    }
    setMemberEmailDraft("");
    setMemberMessage(`Invited ${email}.`);
    await loadRoomMembers();
  };

  const removeMember = async (email: string) => {
    if (!cloudUser || !cloudRoomId) {
      setMemberMessage("Connect to a room first.");
      return;
    }
    setMemberBusy(true);
    const { error } = await removeCloudRoomMember(cloudRoomId, email);
    setMemberBusy(false);
    if (error) {
      setMemberMessage(`Remove failed: ${error}`);
      return;
    }
    setMemberMessage(`Removed ${email}.`);
    await loadRoomMembers();
  };

  const rotateJoinCode = async () => {
    if (!cloudUser || !cloudRoomId) {
      setMemberMessage("Connect to a room first.");
      return;
    }
    const nextCode = cloudJoinCodeDraft.trim() || newJoinCodeDraft.trim();
    if (nextCode.length < 6) {
      setMemberMessage("New join code must be at least 6 characters.");
      return;
    }
    setMemberBusy(true);
    const { error } = await rotateCloudRoomJoinCode(cloudRoomId, nextCode);
    setMemberBusy(false);
    if (error) {
      setMemberMessage(`Join code update failed: ${error}`);
      return;
    }
    setNewJoinCodeDraft("");
    setCloudJoinCodeDraft("");
    setMemberMessage("Room join code updated.");
  };

  const disconnectCloud = () => {
    setCloudRoomId("");
    setSyncState("idle");
    setSyncMessage("Cloud disconnected. Local storage is still active.");
    setMemberMessage("");
    setRoomMembers([]);
  };

  const shiftMonth = (direction: -1 | 1) => {
    setMonthAnchor((current) => new Date(current.getFullYear(), current.getMonth() + direction, 1));
  };
  const onCalendarTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const onCalendarTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!touch || !start) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const minSwipeDistance = 48;
    if (Math.abs(deltaX) < minSwipeDistance || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    shiftMonth(deltaX < 0 ? 1 : -1);
  };

  const syncReady = Boolean(cloudRoomId && isCloudConfigured && cloudUser);
  const syncMessageClass = syncState === "error" ? "cloud-status is-error" : "cloud-status";
  const currentMember = cloudUser ? roomMembers.find((member) => member.user_id === cloudUser.id) ?? null : null;
  const isRoomOwner = currentMember?.role === "owner";
  const authDisplayName = cloudUser?.email?.split("@")[0] ?? "User";
  const authAvatarFallback = authDisplayName.slice(0, 1).toUpperCase();
  const authAvatarUrl = cloudProfileAvatarUrl ?? cloudUser?.avatarUrl ?? null;
  const planModalMessageIsError = useMemo(
    () => (planModalMessage ? !/created|updated|generated/i.test(planModalMessage) : false),
    [planModalMessage]
  );
  const unreadNotificationCount = useMemo(
    () =>
      cloudNotifications.filter((notification) => !notification.is_read).length +
      incomingPlanInvites.filter((invite) => normalizeInviteStatus(invite.status) === "pending").length,
    [cloudNotifications, incomingPlanInvites]
  );
  const pendingIncomingPlanInvites = useMemo(
    () => incomingPlanInvites.filter((invite) => normalizeInviteStatus(invite.status) === "pending"),
    [incomingPlanInvites]
  );
  const activityNotifications = useMemo(
    () =>
      cloudNotifications.filter((notification) => {
        const type = String(notification.type ?? "").toLowerCase();
        return type !== "plan_invite";
      }),
    [cloudNotifications]
  );
  const groupedInviteNotifications = useMemo(() => {
    const groups = new Map<string, SharedInvitePayload[]>();
    const sorted = [...pendingIncomingPlanInvites].sort((left, right) => {
      const leftTime = left.created_at ? new Date(left.created_at).getTime() : 0;
      const rightTime = right.created_at ? new Date(right.created_at).getTime() : 0;
      return rightTime - leftTime;
    });
    for (const invite of sorted) {
      const dateKey = toLocalDateKey(invite.created_at);
      const bucket = groups.get(dateKey) ?? [];
      bucket.push(invite);
      groups.set(dateKey, bucket);
    }
    return [...groups.entries()].map(([dateKey, invites]) => ({
      dateKey,
      label: formatDateDividerLabel(dateKey),
      invites,
    }));
  }, [pendingIncomingPlanInvites]);
  const groupedActivityNotifications = useMemo(() => {
    const groups = new Map<string, CloudNotification[]>();
    const sorted = [...activityNotifications].sort((left, right) => {
      const leftTime = left.created_at ? new Date(left.created_at).getTime() : 0;
      const rightTime = right.created_at ? new Date(right.created_at).getTime() : 0;
      return rightTime - leftTime;
    });
    for (const notification of sorted) {
      const dateKey = toLocalDateKey(notification.created_at);
      const bucket = groups.get(dateKey) ?? [];
      bucket.push(notification);
      groups.set(dateKey, bucket);
    }
    return [...groups.entries()].map(([dateKey, notifications]) => ({
      dateKey,
      label: formatDateDividerLabel(dateKey),
      notifications,
    }));
  }, [activityNotifications]);
  const unreadActivityCount = useMemo(
    () => activityNotifications.filter((notification) => !notification.is_read).length,
    [activityNotifications]
  );

  const sendSystemNotification = useCallback(
    async (title: string, body: string, tag: string) => {
      if (!notificationsEnabled) return;
      if (typeof window === "undefined") return;

      const capacitor = (window as typeof window & {
        Capacitor?: {
          isNativePlatform?: () => boolean;
        };
      }).Capacitor;

      if (capacitor?.isNativePlatform?.()) {
        // Native platforms are handled by server push (FCM/APNs), not local browser notifications.
        return;
      }

      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(title, {
            body,
            tag,
            icon: "/brand/enderfall-mark.png",
          });
        }
      } catch {
        // Ignore browser notification errors.
      }
    },
    [notificationsEnabled]
  );

  useEffect(() => {
    if (!socialUserId) {
      seenActivityNotificationIdsRef.current = new Set();
      seenPendingInviteIdsRef.current = new Set();
      systemNotificationHydratedRef.current = false;
      return;
    }

    const currentActivityIds = new Set(activityNotifications.map((item) => item.id));
    const currentInviteIds = new Set(pendingIncomingPlanInvites.map((item) => item.id));

    if (!systemNotificationHydratedRef.current) {
      seenActivityNotificationIdsRef.current = currentActivityIds;
      seenPendingInviteIdsRef.current = currentInviteIds;
      systemNotificationHydratedRef.current = true;
      return;
    }

    const newActivity = activityNotifications.filter(
      (item) => !seenActivityNotificationIdsRef.current.has(item.id) && !item.is_read
    );
    const newInvites = pendingIncomingPlanInvites.filter(
      (item) => !seenPendingInviteIdsRef.current.has(item.id)
    );

    seenActivityNotificationIdsRef.current = currentActivityIds;
    seenPendingInviteIdsRef.current = currentInviteIds;

    for (const notification of newActivity) {
      void sendSystemNotification("Calendar update", notification.body || "You have a new update.", `activity-${notification.id}`);
    }

    for (const invite of newInvites) {
      const relatedPlan = allPlans.find((plan) => plan.id === invite.plan_id);
      const inviteTitle = relatedPlan?.name ? `Plan invite: ${relatedPlan.name}` : "New plan invite";
      const inviteBody = relatedPlan
        ? `${relatedPlan.fromDate} to ${relatedPlan.toDate}`
        : "You received a new invite.";
      void sendSystemNotification(inviteTitle, inviteBody, `invite-${invite.id}`);
    }
  }, [socialUserId, activityNotifications, pendingIncomingPlanInvites, allPlans, sendSystemNotification]);
  const unreadInviteCount = useMemo(
    () => pendingIncomingPlanInvites.length,
    [pendingIncomingPlanInvites]
  );
  const headerMenus = [
    {
      id: "file",
      label: "File",
      content: (
        <>
          <button className="ef-menu-item" type="button" onClick={() => { setMonthAnchor(startOfMonth(new Date())); setMenuOpen(null); }}>
            Jump to Today
          </button>
          <div className="ef-menu-divider" />
          <button className="ef-menu-item" type="button" onClick={() => { setAuthModalOpen(true); setMenuOpen(null); }}>
            Account
          </button>
          <button className="ef-menu-item" type="button" onClick={() => { setPreferencesOpen(true); setMenuOpen(null); }}>
            Preferences
          </button>
        </>
      ),
    },
    {
      id: "view",
      label: "View",
      content: (
        <SideMenu resetKey={menuOpen === "view" ? "open" : "closed"}>
          <SideMenuSubmenu
            id="theme"
            className="ef-menu-group"
            panelClassName="ef-menu-sub ef-menu-sub--header"
            enableViewportFlip
            variant="header"
            trigger={(triggerProps) => (
              <button
                className="ef-menu-item"
                type="button"
                onClick={triggerProps.onClick}
                aria-expanded={triggerProps["aria-expanded"]}
                disabled={triggerProps.disabled}
              >
                <span>Theme</span>
                <span className="ef-menu-sub-caret">
                  <IconChevronDown />
                </span>
              </button>
            )}
          >
            {themeOptions.map((item) => (
              <Button
                key={item.value}
                className={`theme-preview theme-preview--${item.value}`}
                variant="primary"
                type="button"
                onClick={() => {
                  setThemeMode(item.value);
                  setMenuOpen(null);
                }}
              >
                {item.label}
              </Button>
            ))}
          </SideMenuSubmenu>
        </SideMenu>
      ),
    },
    {
      id: "help",
      label: "Help",
      content: (
        <button className="ef-menu-item" type="button" onClick={() => { setDayModalDate(new Date()); setMenuOpen(null); }}>
          Open Today Details
        </button>
      ),
    },
  ];

  const headerUserItems = [
    ...(isMobileViewport
      ? [
          { label: "Preferences", onClick: () => { setPreferencesOpen(true); setMenuOpen(null); } },
        ]
      : []),
    { label: "Account", onClick: () => setAuthModalOpen(true) },
    ...(cloudUser ? [{ label: "Logout", onClick: () => void signOut() }] : []),
  ];

  return (
    <div className="calendar-app">
      <main className="main-content">
        <MainHeader
          logoSrc="/brand/enderfall-mark.png"
          title="Holiday Calendar"
          subtitle="Enderfall Planner"
          menus={headerMenus}
          menuOpen={menuOpen}
          onOpenMenu={(id) => setMenuOpen(id as "file" | "view" | "help")}
          onCloseMenu={() => setMenuOpen(null)}
          actions={
            <div className="header-actions">
              {cloudUser ? (
                <Dropdown
                  variant="user"
                  name={authDisplayName}
                  avatarUrl={authAvatarUrl}
                  avatarFallback={authAvatarFallback}
                  items={headerUserItems}
                />
              ) : (
                <>
                  {isMobileViewport ? (
                    <Button type="button" variant="ghost" onClick={() => setPreferencesOpen(true)}>
                      Preferences
                    </Button>
                  ) : null}
                  <Button type="button" variant="primary" onClick={() => setAuthModalOpen(true)}>
                    Login
                  </Button>
                </>
              )}
            </div>
          }
        />

        <Panel variant="full" borderWidth={2} className="secondary-toolbar">
          <article className="secondary-toolbar-column">
            <h3>Friends</h3>
            <div className="secondary-pill-list">
              {selfPerson ? (
                <button
                  key={`friend-visibility-self-${selfPerson.id}`}
                  type="button"
                  className={`secondary-pill is-person ${!hiddenFriendIds.includes(selfPerson.id) ? "is-active" : "is-hidden"}`}
                  style={{ ["--plan-color" as string]: selfPerson.color }}
                  onClick={() => toggleFriendVisibility(selfPerson.id)}
                >
                  <span className="pill-icon-badge user-pill-avatar" aria-hidden="true">
                    {authAvatarUrl ? <img src={authAvatarUrl} alt={selfPerson.name} loading="eager" referrerPolicy="no-referrer" crossOrigin="anonymous" /> : selfPerson.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{selfPerson.name}</span>
                </button>
              ) : null}
              {friendPeople.map((person) => {
                const isVisible = !hiddenFriendIds.includes(person.id);
                return (
                  <button
                    key={`friend-visibility-${person.id}`}
                    type="button"
                    className={`secondary-pill is-person ${isVisible ? "is-active" : "is-hidden"}`}
                    style={{ ["--plan-color" as string]: person.color }}
                    onClick={() => toggleFriendVisibility(person.id)}
                  >
                    <span className="pill-icon-badge user-pill-avatar" aria-hidden="true">
                      {person.avatarUrl ? <img src={person.avatarUrl} alt={person.name} loading="eager" referrerPolicy="no-referrer" crossOrigin="anonymous" /> : person.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{person.name}</span>
                  </button>
                );
              })}
            </div>
          </article>
          <article className="secondary-toolbar-column">
            <h3>Groups</h3>
            <div className="secondary-pill-list">
              {store.groups.map((group) => {
                const isVisible = !hiddenGroupIds.includes(group.id);
                return (
                  <button
                    key={`group-visibility-${group.id}`}
                    type="button"
                    className={`secondary-pill is-group ${isVisible ? "is-active" : "is-hidden"}`}
                    style={{ ["--plan-color" as string]: group.color }}
                    onClick={() => toggleGroupVisibility(group.id)}
                  >
                    <span className="pill-icon-badge group-pill-icon" aria-hidden="true">{group.icon}</span>
                    <span>{group.name}</span>
                  </button>
                );
              })}
            </div>
          </article>
        </Panel>
        <Panel variant="full" borderWidth={2} className="toolbar">
          <div className="month-controls">
            <button type="button" onClick={() => shiftMonth(-1)}>
              Prev
            </button>
            <p>{monthLabel}</p>
            <button type="button" onClick={() => shiftMonth(1)}>
              Next
            </button>
          </div>
        </Panel>

        <div
          className="calendar-grid"
          onTouchStart={onCalendarTouchStart}
          onTouchEnd={onCalendarTouchEnd}
        >
            {WEEK_DAYS.map((day) => (
              <div key={`weekday-${day}`} className="weekday-cell" aria-hidden="true">
                {day}
              </div>
            ))}
            <div className="calendar-weekday-separator" aria-hidden="true" />
            {calendarDays.map((day, dayIndex) => {
              const isOtherMonth = day.getMonth() !== monthAnchor.getMonth();
              if (hideOutsideMonthDays && isOtherMonth) {
                return <div key={toKeyDate(day)} className="day-cell day-cell-placeholder" aria-hidden="true" />;
              }
              const keyDate = toKeyDate(day);
              const entryKey = selectedPerson ? `${selectedPerson.id}:${keyDate}` : "";
              const status = selectedPerson ? store.entries[entryKey] ?? "none" : "none";
              const dayPlans = selectedPerson ? getCalendarCellPlansForDay(keyDate, selectedPerson.id) : [];
              const laidOutDayPlans = visiblePlanLanesByDay.get(keyDate) ?? [];
              const weekStartIndex = Math.floor(dayIndex / 7) * 7;
              const weekEndIndex = weekStartIndex + 6;
              const visiblePlanSegments = laidOutDayPlans.slice(0, 3).flatMap(({ plan, lane }) => {
                const startsToday = keyDate === plan.fromDate;
                const hasPrevInWeek =
                  dayIndex > weekStartIndex &&
                  isDateInRange(shiftKeyDate(keyDate, -1), plan.fromDate, plan.toDate);
                if (hasPrevInWeek) return [];
                const hasPrev = isDateInRange(shiftKeyDate(keyDate, -1), plan.fromDate, plan.toDate);

                const startPct = plan.allDay || !startsToday ? 0 : (timeToMinutes(plan.fromTime) / (24 * 60)) * 100;
                let runEndIndex = dayIndex;
                for (let cursor = dayIndex + 1; cursor <= weekEndIndex; cursor += 1) {
                  const cursorKey = toKeyDate(calendarDays[cursor]);
                  if (!isDateInRange(cursorKey, plan.fromDate, plan.toDate)) break;
                  runEndIndex = cursor;
                }
                const runDays = runEndIndex - dayIndex + 1;
                const runEndKey = toKeyDate(calendarDays[runEndIndex]);
                const bridgesIntoCurrentMonth =
                  isOtherMonth &&
                  runEndIndex > dayIndex &&
                  calendarDays[runEndIndex].getMonth() === monthAnchor.getMonth();
                const hasNext = isDateInRange(shiftKeyDate(runEndKey, 1), plan.fromDate, plan.toDate);
                const endsOnRunEnd = runEndKey === plan.toDate;
                const runEndPctRaw = plan.allDay || !endsOnRunEnd ? 100 : (timeToMinutes(plan.toTime) / (24 * 60)) * 100;
                const runEndPct = Math.max(1, runEndPctRaw);
                const firstSlicePct = Math.max(1, 100 - startPct);
                const middleDays = Math.max(0, runDays - 2);
                const widthExpr =
                  runDays === 1
                    ? `${Math.max(1, runEndPct - startPct)}%`
                    : `calc(${firstSlicePct}% + ${middleDays} * 100% + ${runEndPct}% + ${(runDays - 1)}px)`;
                const firstGroupId = plan.targetGroupIds[0];
                const groupIcon = firstGroupId ? store.groups.find((group) => group.id === firstGroupId)?.icon ?? null : null;
                const planBaseColor = personColorById.get(plan.ownerId) ?? selectedPerson?.color ?? "#20c9a6";
                const participantStatus = selectedPerson ? getInviteStatusForPerson(plan, selectedPerson.id) : null;
                const participantStripeColors = getGoingStripeColorsForPlan(plan);
                if (
                  selectedPerson &&
                  participantStatus === "going" &&
                  plan.ownerId !== selectedPerson.id
                ) {
                  const selectedColor = personColorById.get(selectedPerson.id) ?? selectedPerson.color;
                  if (selectedColor && !participantStripeColors.includes(selectedColor)) {
                    participantStripeColors.push(selectedColor);
                  }
                }
                const segmentStyle: CSSProperties = {
                  left: `${startPct}%`,
                  width: widthExpr,
                  top: `${lane * 17}px`,
                  ...getPlanPillStyle(plan, planBaseColor, participantStripeColors),
                };
                return [{ plan, hasPrev, hasNext, segmentStyle, groupIcon, bridgesIntoCurrentMonth }];
              });
              const meta = status !== "none" ? STATUS_LOOKUP[status] : null;
              const isToday = keyDate === toKeyDate(new Date());

              return (
                <button
                  key={keyDate}
                  type="button"
                  disabled={!selectedPerson}
                  className={`day-cell ${meta?.cellClass ?? ""} ${isOtherMonth ? "is-other-month" : ""} ${isToday ? "is-today" : ""}`}
                  onClick={() => openDayModal(day)}
                  aria-label={`${day.toDateString()} ${meta?.label ?? "No status"}`}
                >
                  <span className="day-number">{day.getDate()}</span>
                  {status === "unpaid-leave" ? <span className="day-star">*</span> : null}
                  <div className="day-plan-stack">
                    {visiblePlanSegments.map(({ plan, hasPrev, hasNext, segmentStyle, groupIcon, bridgesIntoCurrentMonth }) => (
                      <span
                        key={plan.id}
                        className={`day-plan-bar ${hasPrev ? "is-continued-prev" : ""} ${hasNext ? "is-continued-next" : ""} ${bridgesIntoCurrentMonth ? "bridges-current-month" : ""}`}
                        style={segmentStyle}
                        title={plan.name}
                        onClick={(event) => openPlanDetailsFromPill(event, plan.id)}
                      >
                        <span className="day-plan-content">
                          <span className="day-plan-name">{plan.name}</span>
                        </span>
                        {groupIcon ? <span className="day-plan-icon" aria-hidden="true">{groupIcon}</span> : null}
                      </span>
                    ))}
                  </div>
                  {dayPlans.length > 3 ? <span className="day-plan-count">+{dayPlans.length - 3}</span> : null}
                  {meta ? <span className="day-caption">{meta.short}</span> : null}
                </button>
              );
            })}
        </div>

        <Modal
          isOpen={Boolean(dayModalDate)}
          title="Day Details"
          subtitle={dayModalLabel}
          className="day-details-modal"
          size="wide"
          onClose={closeDayModal}
        >
          {dayModalDate ? (
            <>
              <div className="ef-modal-form">
                <div
                  ref={dayTimelineRef}
                  className="day-timeline"
                  style={{ ["--day-row-size" as string]: `${dayTimelineRowSize}px` }}
                >
                  <div className="day-time-labels">
                    <div className="day-time-label-spacer" />
                    <div className="day-time-label-hours">
                      {DAY_HOURS.map((hour) => (
                        <div key={`day-hour-${hour}`} className="day-time-label">
                          <span className="day-time-label-text">{hour}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div
                    className="day-time-columns-scroll"
                    style={{ ["--day-visible-friends" as string]: String(Math.min(3, dayDetailFriendPeople.length)) }}
                  >
                    <div className="day-time-columns">
                      {dayDetailPeople.map((person, index) => {
                        const isSelfColumn = index === 0;
                        const dayPlans = getPlansForDay(dayModalKeyDate, person.id);
                        const segments = buildDayTimelineSegments(dayPlans, dayModalKeyDate);
                        return (
                          <Panel
                            key={person.id}
                            variant="card"
                            borderWidth={1}
                            className={`day-time-column prefs-section ${isSelfColumn ? "is-self" : ""}`}
                            style={{ ["--plan-color" as string]: person.color }}
                          >
                            <div className="day-time-column-header">
                              <h3 className="day-person-heading">
                                <span className="pill-icon-badge user-pill-avatar" aria-hidden="true">
                                  {isSelfColumn
                                    ? (authAvatarUrl ? <img src={authAvatarUrl} alt="You" loading="eager" referrerPolicy="no-referrer" crossOrigin="anonymous" /> : "Y")
                                    : (person.avatarUrl ? <img src={person.avatarUrl} alt={person.name} loading="eager" referrerPolicy="no-referrer" crossOrigin="anonymous" /> : person.name.slice(0, 1).toUpperCase())}
                                </span>
                                {isSelfColumn ? "You" : person.name}
                              </h3>
                              <p>{isSelfColumn ? person.name : "Friend"}</p>
                            </div>
                            <div className="day-time-grid">
                              {DAY_HOURS.map((hour) => (
                                <div key={`${person.id}-${hour}`} className="day-time-row" />
                              ))}
                              <div className="day-time-plan-layer">
                                {segments.map(({ plan, start, end, lane, laneCount }) => {
                                  const firstGroupId = plan.targetGroupIds[0];
                                  const groupIcon = firstGroupId ? store.groups.find((group) => group.id === firstGroupId)?.icon ?? null : null;
                                  const participantStatus = getInviteStatusForPerson(plan, person.id);
                                  const participantStripeColors = getGoingStripeColorsForPlan(plan);
                                  if (participantStatus === "going" && plan.ownerId !== person.id) {
                                    const personStripeColor = personColorById.get(person.id) ?? person.color;
                                    if (personStripeColor && !participantStripeColors.includes(personStripeColor)) {
                                      participantStripeColors.push(personStripeColor);
                                    }
                                  }
                                  return (
                                    <div
                                      key={`${person.id}-${plan.id}-${start}-${lane}`}
                                      className="day-time-plan"
                                      onClick={(event) => openPlanDetailsFromPill(event, plan.id)}
                                      style={{
                                        top: `${(start / (24 * 60)) * 100}%`,
                                        height: `${Math.max(2, ((end - start) / (24 * 60)) * 100)}%`,
                                        ["--lane-index" as string]: lane,
                                        ["--lane-count" as string]: laneCount,
                                        ...getPlanPillStyle(
                                          plan,
                                          person.color,
                                          participantStripeColors
                                        ),
                                      }}
                                      title={`${plan.name} - ${getPlanParticipationStatus(plan, person.id)}`}
                                    >
                                      <div className="day-time-plan-main">
                                        <span className="day-time-plan-name">{plan.name}</span>
                                        <div className="day-time-plan-details">
                                          {plan.location ? <span className="day-time-plan-detail">📍 {plan.location}</span> : null}
                                          {plan.summary ? <span className="day-time-plan-detail">{plan.summary}</span> : null}
                                        </div>
                                      </div>
                                      {groupIcon ? <span className="day-time-plan-icon" aria-hidden="true">{groupIcon}</span> : null}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </Panel>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
              <div className="ef-modal-actions">
                <Button variant="primary" type="button" onClick={closeDayModal}>
                  Close
                </Button>
              </div>
            </>
          ) : null}
        </Modal>
        <Modal
          isOpen={groupCreatorOpen}
          title={editingGroupId ? "Edit Group" : "Create Group"}
          subtitle="Set a name, icon, and color"
          size="compact"
          onClose={() => {
            setGroupCreatorOpen(false);
            resetGroupForm();
          }}
        >
          <div className="ef-modal-form">
            <form className="group-create-form" onSubmit={addGroup}>
              <label>
                Group Name
                <Input
                  id="new-group-name"
                  type="text"
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder="Raid Team, Gym, etc"
                />
              </label>
              <div className="plan-date-row">
                <div className="group-icon-picker">
                  {newGroupCustomIcon ? (
                    <label>
                      Custom Emoji
                      <Input
                        type="text"
                        value={newGroupIcon}
                        onChange={(event) => setNewGroupIcon(event.target.value)}
                        placeholder="Type an emoji"
                      />
                    </label>
                  ) : (
                    <Dropdown
                      variant="bookmark"
                      label="Common Emojis"
                      layout="row"
                      value={newGroupIcon}
                      triggerLabel={newGroupIcon ? `Selected ${newGroupIcon}` : "Choose emoji"}
                      placeholder="Pick an emoji"
                      sections={groupEmojiSections}
                      onChange={(value) => setNewGroupIcon(value)}
                      emptyLabel="No emoji options."
                    />
                  )}
                </div>
                <Toggle
                  variant="checkbox"
                  checked={newGroupCustomIcon}
                  onChange={(event) => setNewGroupCustomIcon(event.target.checked)}
                  label="Custom"
                />
              </div>
              <label>Group Color</label>
              <div className="person-color-row">
                {PRESET_PERSON_COLORS.map((color) => (
                  <button
                    key={`group-${color}`}
                    type="button"
                    className={`color-swatch ${newGroupColor === color ? "is-selected" : ""}`}
                    style={{ ["--swatch-color" as string]: color }}
                    onClick={() => setNewGroupColor(color)}
                  />
                ))}
                <div className="color-wheel" style={{ ["--swatch-color" as string]: newGroupColor }}>
                  <Input
                    type="color"
                    value={newGroupColor}
                    onChange={(event) => setNewGroupColor(event.target.value)}
                    className="color-wheel-input"
                    aria-label="Custom group color"
                  />
                  <span className="color-wheel-icon" aria-hidden="true">
                    <FaPen />
                  </span>
                </div>
              </div>
              <div className="ef-modal-actions">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setGroupCreatorOpen(false);
                    resetGroupForm();
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  {editingGroupId ? "Save Group" : "Create Group"}
                </Button>
              </div>
            </form>
          </div>
        </Modal>
        <Modal
          isOpen={personCreatorOpen}
          title="Friend Settings"
          subtitle="Set local color and groups for this friend"
          size="compact"
          onClose={() => {
            setPersonCreatorOpen(false);
            resetPersonForm();
          }}
        >
          <div className="ef-modal-form">
            <form className="group-create-form" onSubmit={addPerson}>
              <label>
                Friend
                <Input value={newPersonName} onChange={(event) => setNewPersonName(event.target.value)} placeholder="Friend name" readOnly />
              </label>
              <div className="person-groups">
                {store.groups.map((group) => (
                  <Toggle
                    key={`modal-${group.id}`}
                    variant="switch"
                    className="person-group-toggle"
                    checked={newPersonGroupIds.includes(group.id)}
                    disabled={!editingPersonId}
                    onChange={() =>
                      setNewPersonGroupIds((current) =>
                        current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id]
                      )
                    }
                    label={group.name}
                  />
                ))}
              </div>
              <label>Color</label>
              <div className="person-color-row">
                {PRESET_PERSON_COLORS.map((color) => (
                  <button
                    key={`modal-person-${color}`}
                    type="button"
                    className={`color-swatch ${newPersonColor === color ? "is-selected" : ""}`}
                    style={{ ["--swatch-color" as string]: color }}
                    onClick={() => setNewPersonColor(color)}
                  />
                ))}
                <div className="color-wheel" style={{ ["--swatch-color" as string]: newPersonColor }}>
                  <Input
                    type="color"
                    value={newPersonColor}
                    onChange={(event) => setNewPersonColor(event.target.value)}
                    className="color-wheel-input"
                    aria-label="Custom friend color"
                  />
                  <span className="color-wheel-icon" aria-hidden="true">
                    <FaPen />
                  </span>
                </div>
              </div>
              <div className="ef-modal-actions">
                {editingCloudFriend ? (
                  <Button
                    type="button"
                    variant="delete"
                    onClick={requestDeleteEditingFriend}
                  >
                    Delete Friend
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPersonCreatorOpen(false);
                    resetPersonForm();
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Save Settings
                </Button>
              </div>
            </form>
          </div>
        </Modal>
        <Modal
          isOpen={deleteFriendConfirmOpen}
          title="Remove Friend"
          subtitle="This will remove the friendship and local friend settings."
          size="compact"
          onClose={() => setDeleteFriendConfirmOpen(false)}
        >
          <div className="ef-modal-form">
            <p className="cloud-meta">
              Are you sure you want to remove {editingCloudFriend?.username ?? "this friend"}?
            </p>
            <div className="ef-modal-actions">
              <Button type="button" variant="ghost" onClick={() => setDeleteFriendConfirmOpen(false)}>
                Cancel
              </Button>
              <Button type="button" variant="delete" onClick={() => void confirmDeleteEditingFriend()}>
                Delete
              </Button>
            </div>
          </div>
        </Modal>
        <Modal isOpen={createPlanOpen} title={editingPlanId ? "Edit Plan" : "Create Plan"} subtitle="Set time range and invite people" size="wide" onClose={() => setCreatePlanOpen(false)}>
          <div className="ef-modal-form">
            <form className="plan-create-form" onSubmit={savePlan}>
              {planModalMessage ? (
                <p className={`cloud-status notifications-toast${planModalMessageIsError ? " is-error" : ""}`}>
                  {planModalMessage}
                </p>
              ) : null}
              <label>
                Plan Name
                <Input
                  type="text"
                  value={planName}
                  onChange={(event) => setPlanName(event.target.value)}
                  placeholder="Plan name"
                />
              </label>
              <label>
                Location (Optional)
                <Input
                  type="text"
                  value={planLocation}
                  onChange={(event) => setPlanLocation(event.target.value)}
                  placeholder="Location"
                />
              </label>
              <label>
                Summary (Optional)
                <Input
                  type="text"
                  value={planSummary}
                  onChange={(event) => setPlanSummary(event.target.value)}
                  placeholder="Plan summary"
                />
              </label>
              <div className="plan-calendar-row">
                <Dropdown
                  variant="bookmark"
                  label="Groups"
                  layout="row"
                  value={planTargetGroupIds[0] ?? ""}
                  triggerLabel={planTargetLabel(planTargetGroupIds, planIsPrivate)}
                  placeholder="Choose groups"
                  sections={planCalendarSections}
                  onChange={(value) =>
                    setPlanTargetGroupIds((current) =>
                      current.includes(value) ? current.filter((id) => id !== value) : [...current, value]
                    )
                  }
                  emptyLabel="No groups available."
                  disabled={planIsPrivate}
                />
                <div className="plan-group-chips">
                  {planTargetGroupIds.map((groupId) => {
                    const groupName = store.groups.find((group) => group.id === groupId)?.name ?? groupId;
                    return (
                      <button
                        key={groupId}
                        type="button"
                        className="plan-group-chip"
                        onClick={() => setPlanTargetGroupIds((current) => current.filter((id) => id !== groupId))}
                      >
                        {groupName}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="plan-date-row">
                <Toggle
                  variant="checkbox"
                  checked={planIsPrivate}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setPlanIsPrivate(checked);
                    if (checked) {
                      setPlanTargetGroupIds([]);
                      setPlanCustomizeMembers(false);
                      setPlanExcludedPersonIds([]);
                    }
                  }}
                  label="Private plan"
                />
                {planCanCustomizeMembers ? (
                  <Toggle
                    variant="checkbox"
                    checked={planCustomizeMembers}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setPlanCustomizeMembers(checked);
                      if (!checked) setPlanExcludedPersonIds([]);
                    }}
                    label="Customize group sharing"
                  />
                ) : null}
              </div>
              {planCustomizeMembers && !planIsPrivate ? (
                <fieldset className="plan-invite-list">
                  <legend>Hide From Specific Group Members</legend>
                  {planInvitePeople.filter((person) => planSelectedGroupMemberIds.includes(person.id)).map((person) => (
                    <Toggle
                      key={`exclude-${person.id}`}
                      variant="switch"
                      className="plan-invite-item"
                      checked={planExcludedPersonIds.includes(person.id)}
                      onChange={() =>
                        setPlanExcludedPersonIds((current) =>
                          current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id]
                        )
                      }
                      label={person.name}
                    />
                  ))}
                </fieldset>
              ) : null}
              <div className="plan-date-row">
                <div className="plan-date-grid">
                  <label>
                    From Date
                    <Input type="date" value={planFromDate} onChange={(event) => setPlanFromDate(event.target.value)} />
                  </label>
                  <label>
                    To Date
                    <Input type="date" value={planToDate} onChange={(event) => setPlanToDate(event.target.value)} />
                  </label>
                </div>
                <Toggle
                  variant="checkbox"
                  checked={planRecurring}
                  onChange={(event) => setPlanRecurring(event.target.checked)}
                  label="Recurring plan"
                />
              </div>

              {planRecurring ? (
                <div className="plan-recurrence-grid">
                  <Dropdown
                    variant="bookmark"
                    label="Repeat"
                    layout="row"
                    value={planRecurrenceType}
                    triggerLabel={RECURRENCE_OPTIONS.find((option) => option.value === planRecurrenceType)?.label ?? "Weekly"}
                    placeholder="Choose repeat"
                    sections={recurrenceDropdownSections}
                    onChange={(value) => setPlanRecurrenceType(value as RecurrenceType)}
                    emptyLabel="No recurrence options."
                  />
                  {planRecurrenceType === "custom" ? (
                    <label>
                      Custom Amount (Days Between)
                      <Input
                        type="number"
                        min={1}
                        value={planCustomRecurrenceDays}
                        onChange={(event) => setPlanCustomRecurrenceDays(Number(event.target.value || 1))}
                      />
                    </label>
                  ) : null}
                  <div className="recurrence-count-row">
                    <label>
                      Recurrence Count
                      <Input
                        type="number"
                        min={1}
                        value={planRecurrenceCount}
                        onChange={(event) => setPlanRecurrenceCount(Number(event.target.value || 1))}
                        disabled={planRecurrenceInfinite}
                      />
                    </label>
                    <div className="recurrence-infinite-control">
                      <Toggle
                        variant="checkbox"
                        checked={planRecurrenceInfinite}
                        onChange={(event) => setPlanRecurrenceInfinite(event.target.checked)}
                        aria-label="Infinite recurrence"
                      />
                      <FaInfinity aria-hidden="true" />
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="plan-time-row">
                <div className="plan-date-grid">
                  <label>
                    From Time
                    <Input
                      type="time"
                      value={planFromTime}
                      onChange={(event) => setPlanFromTime(event.target.value)}
                      disabled={planAllDay}
                    />
                  </label>
                  <label>
                    To Time
                    <Input
                      type="time"
                      value={planToTime}
                      onChange={(event) => setPlanToTime(event.target.value)}
                      disabled={planAllDay}
                    />
                  </label>
                </div>
                <Toggle
                  variant="checkbox"
                  checked={planAllDay}
                  onChange={(event) => setPlanAllDay(event.target.checked)}
                  label="All day"
                />
              </div>

              <fieldset className="plan-invite-list">
                <legend>Invite Friends / Family</legend>
                {planInvitePeople.length > 0 ? (
                  planInvitePeople.map((person) => {
                    const participantFriend = cloudFriendPeople.find((friend) => friend.id === person.id);
                    const participantAvatar = participantFriend?.avatarUrl ?? null;
                    const isInvited = planInvitedIds.includes(person.id);
                    const response = editingPlanId
                      ? inviteResponseByPlanAndPerson.get(`${editingPlanId}:${person.id}`) ?? "pending"
                      : "pending";
                    return (
                    <div key={person.id} className="plan-invite-row">
                      <span className="plan-invite-left">
                        <Toggle
                          variant="switch"
                          className="plan-invite-item"
                          checked={planInvitedIds.includes(person.id)}
                          onChange={() => togglePlanInvite(person.id)}
                          disabled={planIsPrivate}
                          aria-label={`Invite ${person.name}`}
                        />
                        <span className="plan-invite-person">
                          <span className="pill-icon-badge user-pill-avatar manager-card-avatar plan-invite-avatar" aria-hidden="true">
                            {participantAvatar ? (
                              <img src={participantAvatar} alt={person.name} loading="lazy" referrerPolicy="no-referrer" crossOrigin="anonymous" />
                            ) : (
                              person.name.slice(0, 1).toUpperCase()
                            )}
                          </span>
                          <span className="plan-invite-name">{person.name}</span>
                        </span>
                      </span>
                      {editingPlanId ? (
                        <span className={`notification-chip ${isInvited ? `status-${response}` : "status-read"}`}>
                          {!isInvited
                            ? "Not invited"
                            : response === "going"
                              ? "Going"
                              : response === "maybe"
                                ? "Maybe"
                                : response === "cant"
                                  ? "Can't"
                                  : "Pending"}
                        </span>
                      ) : null}
                    </div>
                    );
                  })
                ) : (
                  <p className="cloud-meta">No friend/family users available.</p>
                )}
              </fieldset>

              <div className="ef-modal-actions">
                <Button type="button" variant="ghost" onClick={() => setCreatePlanOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  {editingPlanId ? "Update Plan" : "Save Plan"}
                </Button>
              </div>
            </form>
          </div>
        </Modal>
        <Modal
          isOpen={authModalOpen}
          title="Account"
          subtitle="Sign in or create an account"
          size="default"
          onClose={() => setAuthModalOpen(false)}
        >
          <div className="ef-modal-form">
            {cloudUser ? (
              <div className="auth-state">
                <p className="cloud-meta">Signed in as {cloudUser.email ?? cloudUser.id}</p>
                <div className="ef-modal-actions">
                  <Button type="button" variant="delete" onClick={() => void signOut()} disabled={authBusy}>
                    Logout
                  </Button>
                </div>
              </div>
            ) : (
              <form className="auth-form" onSubmit={(event) => void signIn(event)}>
                <label>
                  Email
                  <Input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@email.com" />
                </label>
                <label>
                  Password
                  <Input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="********" />
                </label>
                <div className="ef-modal-actions">
                  <Button type="submit" variant="primary" disabled={authBusy}>
                    Sign In
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => void signUp()} disabled={authBusy}>
                    Sign Up
                  </Button>
                </div>
              </form>
            )}
            {authMessage ? <p className="cloud-status">{authMessage}</p> : null}
          </div>
        </Modal>
        <PreferencesModal
          isOpen={preferencesOpen}
          onClose={() => setPreferencesOpen(false)}
          themeMode={themeMode}
          onThemeChange={(value) => setThemeMode(value as ThemeMode)}
          themeOptions={themeOptions}
          animationsEnabled={animationsEnabled}
          onAnimationsChange={setAnimationsEnabled}
        >
          <Toggle
            checked={notificationsEnabled}
            onChange={(event) => setNotificationsEnabled(event.target.checked)}
            label="Enable notifications"
          />
          <Toggle
            checked={hideOutsideMonthDays}
            onChange={(event) => setHideOutsideMonthDays(event.target.checked)}
            label="Hide non-month days"
          />
        </PreferencesModal>
        <Modal
          isOpen={plansListOpen}
          title="All Plans"
          subtitle="List view"
          size="wide"
          onClose={() => setPlansListOpen(false)}
          actions={
            <Button variant="primary" type="button" onClick={() => setPlansListOpen(false)}>
              Close
            </Button>
          }
        >
          <div className="ef-modal-form manager-modal">
            <div className="notifications-summary-grid">
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Total Plans</span>
                <strong>{allPlans.length}</strong>
              </Panel>
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Editable Plans</span>
                <strong>{allPlans.filter((plan) => canEditPlan(plan)).length}</strong>
              </Panel>
            </div>
            <Panel variant="card" borderWidth={1} className="notifications-section manager-section">
              <div className="notifications-section-header manager-header">
                <h3>Plans</h3>
                <span className="notifications-count">{allPlans.length}</span>
              </div>
              <div className="notifications-list manager-list">
                {groupedPlansForList.length > 0 ? (
                  groupedPlansForList.map(({ date, plans }) => (
                    <div key={`plan-group-${date}`} className="plan-date-group">
                      <div className="plan-date-divider"><span>{date}</span></div>
                      <div className="plan-date-group-list">
                        {plans.map((plan) => {
                          const viewerInvite = incomingInviteByPlanId.get(plan.id);
                          const viewerInviteStatus = viewerInvite ? normalizeInviteStatus(viewerInvite.status) : null;
                          const planOwnerColor = personColorById.get(plan.ownerId) ?? "#20c9a6";
                          const participantStripeColors = getGoingStripeColorsForPlan(plan);
                          const ownerCloudPerson = cloudFriendPeople.find((person) => person.id === plan.ownerId);
                          const ownerLocalPerson = store.people.find((person) => person.id === plan.ownerId);
                          const isSelfOwner = plan.ownerId === selfPersonId;
                          const ownerName = isSelfOwner ? "You" : ownerLocalPerson?.name ?? ownerCloudPerson?.name ?? "Friend";
                          const ownerAvatar = isSelfOwner ? authAvatarUrl : ownerCloudPerson?.avatarUrl ?? null;
                          return (
                            <Panel
                              key={plan.id}
                              variant="card"
                              borderWidth={1}
                              className="notification-card manager-card prefs-section plan-list-clickable plan-list-pill-card"
                              style={{
                                ...getPlanPillStyle(plan, planOwnerColor, participantStripeColors),
                              }}
                              onClick={() => setPlanDetailsPlanId(plan.id)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setPlanDetailsPlanId(plan.id);
                                }
                              }}
                            >
                              <div className="notification-card-head">
                                <span className="notification-owner-inline">
                                  <span className="pill-icon-badge user-pill-avatar manager-card-avatar" aria-hidden="true">
                                    {ownerAvatar ? (
                                      <img src={ownerAvatar} alt={ownerName} loading="eager" referrerPolicy="no-referrer" crossOrigin="anonymous" />
                                    ) : (
                                      ownerName.slice(0, 1).toUpperCase()
                                    )}
                                  </span>
                                  <span className="notification-owner-name">{ownerName}</span>
                                </span>
                                <h4>{plan.name}</h4>
                                <span className={`notification-chip ${
                                  viewerInviteStatus
                                    ? `status-${viewerInviteStatus}`
                                    : plan.ownerId === selfPersonId
                                      ? "status-going"
                                      : "status-read"
                                }`}>
                                  {viewerInviteStatus
                                    ? viewerInviteStatus === "going"
                                      ? "Going"
                                      : viewerInviteStatus === "maybe"
                                        ? "Maybe"
                                        : viewerInviteStatus === "cant"
                                          ? "Can't"
                                          : "Pending"
                                    : plan.ownerId === selfPersonId
                                      ? "Owner"
                                      : "Shared"}
                                </span>
                              </div>
                              {viewerInvite ? (
                                <div
                                  className="notification-actions"
                                  onClick={(event) => event.stopPropagation()}
                                  onMouseDown={(event) => event.stopPropagation()}
                                >
                                  <Button
                                    type="button"
                                    variant="success"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleInviteResponse(viewerInvite.id, "going");
                                    }}
                                  >
                                    Going
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="info"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleInviteResponse(viewerInvite.id, "maybe");
                                    }}
                                  >
                                    Maybe
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="delete"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleInviteResponse(viewerInvite.id, "cant");
                                    }}
                                  >
                                    Can't
                                  </Button>
                                </div>
                              ) : null}
                            </Panel>
                          );
                        })}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="cloud-meta">No plans created yet.</p>
                )}
              </div>
            </Panel>
          </div>
        </Modal>
        <Modal
          isOpen={Boolean(planDetailsPlan)}
          title={planDetailsPlan?.name ?? "Plan Details"}
          subtitle="Plan details and participant responses"
          size="wide"
          onClose={() => setPlanDetailsPlanId(null)}
          headerActions={
            planDetailsPlan && canEditPlan(planDetailsPlan) ? (
              <>
                <button
                  type="button"
                  className="icon-action small ef-modal-head-action is-info"
                  onClick={() => {
                    const planToEdit = planDetailsPlan;
                    setPlansListOpen(false);
                    setPlanDetailsPlanId(null);
                    window.setTimeout(() => {
                      openEditPlanModal(planToEdit);
                    }, 0);
                  }}
                  title="Edit plan"
                  aria-label="Edit plan"
                >
                  <FaEdit />
                </button>
                {planDetailsPlan.ownerId === selfPersonId ? (
                  <button
                    type="button"
                    className="icon-action small ef-modal-head-action is-delete"
                    onClick={() => {
                      const planIdToDelete = planDetailsPlan.id;
                      setPlansListOpen(false);
                      setPlanDetailsPlanId(null);
                      window.setTimeout(() => deletePlan(planIdToDelete), 0);
                    }}
                    title="Delete plan"
                    aria-label="Delete plan"
                  >
                    <FaTrashAlt />
                  </button>
                ) : null}
              </>
            ) : null
          }
          actions={
            <Button variant="primary" type="button" onClick={() => setPlanDetailsPlanId(null)}>
              Close
            </Button>
          }
        >
          {planDetailsPlan ? (
            <div className="ef-modal-form manager-modal">
              <Panel variant="card" borderWidth={1} className="notifications-section manager-section">
                <div className="notifications-section-header manager-header">
                  <h3>Details</h3>
                </div>
                <p className="notification-card-meta">
                  {planDetailsPlan.fromDate} to {planDetailsPlan.toDate}
                  {planDetailsPlan.allDay ? " (All day)" : ` | ${planDetailsPlan.fromTime} to ${planDetailsPlan.toTime}`}
                </p>
                {planDetailsPlan.location ? <p className="notification-card-meta">Location: {planDetailsPlan.location}</p> : null}
                {planDetailsPlan.summary ? <p className="notification-card-meta">Summary: {planDetailsPlan.summary}</p> : null}
                <p className="notification-card-meta">Visibility: {planTargetLabel(planDetailsPlan.targetGroupIds, planDetailsPlan.isPrivate)}</p>
              </Panel>
              <Panel variant="card" borderWidth={1} className="notifications-section manager-section">
                <div className="notifications-section-header manager-header">
                  <h3>Participants</h3>
                  <span className="notifications-count">{planDetailsParticipants.length}</span>
                </div>
                <div className="notifications-list manager-list">
                  {planDetailsParticipants.map((participant) => {
                    const participantFriend = cloudFriendPeople.find((friend) => friend.id === participant.id);
                    const participantAvatar = participant.id === selfPersonId
                      ? authAvatarUrl
                      : participantFriend?.avatarUrl ?? null;
                    const participantColor = personColorById.get(participant.id) ?? "#20c9a6";
                    return (
                      <div
                        key={`${planDetailsPlan.id}-${participant.id}`}
                        className="manager-card-button plan-participant-row"
                        style={{ ["--plan-color" as string]: participantColor }}
                      >
                        <span className="pill-icon-badge user-pill-avatar manager-card-avatar" aria-hidden="true">
                          {participantAvatar ? (
                            <img src={participantAvatar} alt={participant.name} loading="lazy" referrerPolicy="no-referrer" crossOrigin="anonymous" />
                          ) : (
                            participant.name.slice(0, 1).toUpperCase()
                          )}
                        </span>
                        <span className="manager-card-name">{participant.name}</span>
                        <span className={`manager-card-meta ${
                          participant.response === "going"
                            ? "status-text-going"
                            : participant.response === "maybe"
                              ? "status-text-maybe"
                              : participant.response === "cant"
                                ? "status-text-cant"
                                : "status-text-pending"
                        }`}>
                          {participant.response === "going"
                            ? "Going"
                            : participant.response === "maybe"
                              ? "Maybe"
                              : participant.response === "cant"
                                ? "Can't"
                                : "Waiting for response"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const viewerInvite = incomingInviteByPlanId.get(planDetailsPlan.id);
                  return viewerInvite ? (
                    <div className="notification-actions">
                      <Button type="button" variant="success" onClick={() => void handleInviteResponse(viewerInvite.id, "going")}>
                        Going
                      </Button>
                      <Button type="button" variant="info" onClick={() => void handleInviteResponse(viewerInvite.id, "maybe")}>
                        Maybe
                      </Button>
                      <Button type="button" variant="delete" onClick={() => void handleInviteResponse(viewerInvite.id, "cant")}>
                        Can't
                      </Button>
                    </div>
                  ) : null;
                })()}
              </Panel>
            </div>
          ) : null}
        </Modal>
        <Modal
          isOpen={friendsListOpen}
          title="Friends"
          subtitle="Manage people"
          size="wide"
          onClose={() => setFriendsListOpen(false)}
          actions={
            <Button variant="primary" type="button" onClick={() => setFriendsListOpen(false)}>
              Close
            </Button>
          }
        >
          <div className="ef-modal-form manager-modal">
            <div className="notifications-summary-grid">
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Connected Friends</span>
                <strong>{cloudFriends.length}</strong>
              </Panel>
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Active Friends</span>
                <strong>{cloudFriends.filter((friend) => friend.active).length}</strong>
              </Panel>
            </div>
            <Panel variant="card" borderWidth={1} className="notifications-section manager-section">
              <div className="notifications-section-header manager-header">
                <h3>Friends</h3>
                {socialUserId ? (
                  <div className="manager-actions">
                    <Button type="button" variant="primary" onClick={openFriendRequestModal}>
                      New Friend
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => void refreshCloudFriends()}>
                      Refresh
                    </Button>
                  </div>
                ) : (
                  <p className="cloud-meta">Sign in to manage friends.</p>
                )}
              </div>
              {cloudFriendsError ? <p className="cloud-status is-error notifications-toast">Friends load failed: {cloudFriendsError}</p> : null}
              <div className="notifications-list manager-list">
                {cloudFriends.length > 0 ? (
                  cloudFriends.map((person) => {
                    const merged = cloudFriendPeople.find((entry) => entry.id === person.user_id);
                    const displayName = merged?.name ?? person.username;
                    const avatarUrl = merged?.avatarUrl ?? person.avatar_url ?? null;
                    const accentColor = merged?.color ?? PRESET_PERSON_COLORS[0];
                    return (
                      <Button
                        key={person.friendship_id}
                        type="button"
                        variant="ghost"
                        className="manager-card-button"
                        style={{ ["--plan-color" as string]: accentColor }}
                        onClick={() => {
                          if (merged) openEditPersonCreator(merged);
                        }}
                        title="Edit friend settings"
                      >
                        <span className="pill-icon-badge user-pill-avatar manager-card-avatar" aria-hidden="true">
                          {avatarUrl ? (
                            <img src={avatarUrl} alt={displayName} loading="lazy" referrerPolicy="no-referrer" crossOrigin="anonymous" />
                          ) : (
                            displayName.slice(0, 1).toUpperCase()
                          )}
                        </span>
                        <span className="manager-card-name">{displayName}</span>
                        <span className="manager-card-meta">{person.active ? "Active" : "Offline"}</span>
                      </Button>
                    );
                  })
                ) : (
                  <p className="cloud-meta">
                    {cloudUser
                      ? "No friends yet."
                      : "Sign in to load friends."}
                  </p>
                )}
              </div>
            </Panel>
          </div>
        </Modal>
        <Modal
          isOpen={groupsListOpen}
          title="Groups"
          subtitle="Manage groups"
          size="wide"
          onClose={() => setGroupsListOpen(false)}
          actions={
            <Button variant="primary" type="button" onClick={() => setGroupsListOpen(false)}>
              Close
            </Button>
          }
        >
          <div className="ef-modal-form manager-modal">
            <div className="notifications-summary-grid">
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Total Groups</span>
                <strong>{store.groups.length}</strong>
              </Panel>
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Total Memberships</span>
                <strong>{store.people.filter((person) => person.id !== selfPersonId).reduce((total, person) => total + person.groupIds.length, 0)}</strong>
              </Panel>
            </div>
            <Panel variant="card" borderWidth={1} className="notifications-section manager-section">
              <div className="notifications-section-header manager-header">
                <h3>Groups</h3>
                <div className="manager-actions">
                  <Button type="button" variant="primary" onClick={openGroupCreator}>
                    New Group
                  </Button>
                </div>
              </div>
              <div className="notifications-list manager-list">
                {store.groups.length > 0 ? (
                  store.groups.map((group) => (
                    <Button
                      key={group.id}
                      type="button"
                      variant="ghost"
                      className="manager-card-button manager-group-button"
                      style={{ ["--plan-color" as string]: group.color }}
                      onClick={() => openEditGroupCreator(group)}
                      title="Edit group"
                    >
                      <span className="pill-icon-badge manager-group-icon" aria-hidden="true">
                        {group.icon}
                      </span>
                      <span className="manager-card-name">{group.name}</span>
                      <span className="manager-card-meta">
                        {store.people.filter((person) => person.id !== selfPersonId && person.groupIds.includes(group.id)).length}
                      </span>
                    </Button>
                  ))
                ) : (
                  <p className="cloud-meta">No groups yet.</p>
                )}
              </div>
            </Panel>
          </div>
        </Modal>
        <Modal
          isOpen={notificationsOpen}
          title="Notifications"
          subtitle="Invites and activity"
          size="wide"
          onClose={() => setNotificationsOpen(false)}
          actions={
            <Button variant="primary" type="button" onClick={() => setNotificationsOpen(false)}>
              Close
            </Button>
          }
        >
          <div className="ef-modal-form notifications-modal">
            {inviteActionMessage ? <p className="cloud-status notifications-toast">{inviteActionMessage}</p> : null}
            <div className="notifications-summary-grid">
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Pending Invites</span>
                <strong>{pendingIncomingPlanInvites.length}</strong>
              </Panel>
              <Panel variant="card" borderWidth={1} className="notifications-summary-card">
                <span className="notifications-summary-label">Unread Activity</span>
                <strong>{unreadActivityCount}</strong>
              </Panel>
            </div>
            <div className="notifications-tabs" role="tablist" aria-label="Notifications tabs">
              <Button
                type="button"
                variant={notificationsTab === "activity" ? "primary" : "ghost"}
                className="notifications-tab-btn"
                onClick={() => setNotificationsTab("activity")}
              >
                <span>Activity</span>
                {unreadActivityCount > 0 ? <span className="notifications-tab-count">{unreadActivityCount}</span> : null}
              </Button>
              <Button
                type="button"
                variant={notificationsTab === "invites" ? "primary" : "ghost"}
                className="notifications-tab-btn"
                onClick={() => setNotificationsTab("invites")}
              >
                <span>Plan Invites</span>
                {unreadInviteCount > 0 ? <span className="notifications-tab-count">{unreadInviteCount}</span> : null}
              </Button>
            </div>
            <div className="notifications-sections">
              {notificationsTab === "invites" ? (
              <Panel variant="card" borderWidth={1} className="notifications-section">
                <div className="notifications-section-header">
                  <h3>Plan Invites</h3>
                  <span className="notifications-count">{pendingIncomingPlanInvites.length}</span>
                </div>
                <div className="notifications-list">
                  {groupedInviteNotifications.length > 0 ? (
                    groupedInviteNotifications.map(({ dateKey, label, invites }) => (
                      <div key={`invite-group-${dateKey}`} className="plan-date-group">
                        <div className="plan-date-divider"><span>{label}</span></div>
                        <div className="plan-date-group-list">
                    {invites.map((invite) => {
                      const relatedPlan = allPlans.find((plan) => plan.id === invite.plan_id);
                      const inviteStatus = normalizeInviteStatus(invite.status);
                      const inviteStatusLabel = inviteStatus === "going"
                        ? "Going"
                        : inviteStatus === "maybe"
                          ? "Maybe"
                            : inviteStatus === "cant"
                              ? "Can't"
                              : "Pending";
                      const inviteCardStyle: CSSProperties | undefined = relatedPlan
                        ? getPlanPillStyle(
                            relatedPlan,
                            personColorById.get(relatedPlan.ownerId) ?? "#20c9a6",
                            getGoingStripeColorsForPlan(relatedPlan)
                          )
                        : undefined;
                      const isSelfOwner = relatedPlan ? relatedPlan.ownerId === selfPersonId : false;
                      const ownerCloudPerson = relatedPlan
                        ? cloudFriendPeople.find((person) => person.id === relatedPlan.ownerId)
                        : null;
                      const ownerLocalPerson = relatedPlan
                        ? store.people.find((person) => person.id === relatedPlan.ownerId)
                        : null;
                      const ownerName = isSelfOwner ? "You" : ownerLocalPerson?.name ?? ownerCloudPerson?.name ?? "Friend";
                      const ownerAvatar = isSelfOwner ? authAvatarUrl : ownerCloudPerson?.avatarUrl ?? null;
                      const inviteTimeLabel = formatNotificationTimeLabel(invite.created_at ?? null, notificationClockMs);
                      return (
                        <Panel
                          key={invite.id}
                          variant="card"
                          borderWidth={1}
                          className="notification-card notification-card-invite prefs-section"
                          style={inviteCardStyle}
                        >
                          <div className="notification-card-head">
                            <span className="notification-owner-inline">
                              <span className="pill-icon-badge user-pill-avatar manager-card-avatar" aria-hidden="true">
                                {ownerAvatar ? (
                                  <img src={ownerAvatar} alt={ownerName} loading="eager" referrerPolicy="no-referrer" crossOrigin="anonymous" />
                                ) : (
                                  ownerName.slice(0, 1).toUpperCase()
                                )}
                              </span>
                              <span className="notification-owner-name">{ownerName}</span>
                              <span className="notification-time-separator" aria-hidden="true"><FaCircle /></span>
                              <span className="notification-time">{inviteTimeLabel}</span>
                            </span>
                            <h4>{relatedPlan?.name ?? "Plan Invite"}</h4>
                            <span className={`notification-chip status-${inviteStatus}`}>{inviteStatusLabel}</span>
                          </div>
                          <p className="notification-card-body">
                            {relatedPlan
                              ? `${relatedPlan.fromDate} to ${relatedPlan.toDate}${relatedPlan.allDay ? " (All day)" : ` | ${relatedPlan.fromTime}-${relatedPlan.toTime}`}`
                              : invite.plan_id}
                          </p>
                          <div className="notification-actions">
                            <Button type="button" variant="success" onClick={() => void handleInviteResponse(invite.id, "going")}>
                              Going
                            </Button>
                            <Button type="button" variant="info" onClick={() => void handleInviteResponse(invite.id, "maybe")}>
                              Maybe
                            </Button>
                            <Button type="button" variant="delete" onClick={() => void handleInviteResponse(invite.id, "cant")}>
                              Can't
                            </Button>
                          </div>
                        </Panel>
                      );
                    })}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="cloud-meta">No plan invites.</p>
                  )}
                </div>
              </Panel>
              ) : null}
              {notificationsTab === "activity" ? (
              <Panel variant="card" borderWidth={1} className="notifications-section">
                <div className="notifications-section-header">
                  <h3>Activity</h3>
                  <div className="notifications-section-actions">
                    <span className="notifications-count">{activityNotifications.length}</span>
                    <Button type="button" variant="ghost" onClick={() => void clearActivityNotifications()}>
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="notifications-list" ref={activityListRef}>
                  {groupedActivityNotifications.length > 0 ? (
                    groupedActivityNotifications.map(({ dateKey, label, notifications }) => (
                      <div key={`activity-group-${dateKey}`} className="plan-date-group">
                        <div className="plan-date-divider"><span>{label}</span></div>
                        <div className="plan-date-group-list">
                    {notifications.map((notification) => {
                      const sourceUserId = notificationSourceUserId(notification.payload);
                      const isSelfSource = Boolean(sourceUserId && socialUserId && sourceUserId === socialUserId);
                      const sourcePerson = sourceUserId ? cloudFriendPeople.find((person) => person.id === sourceUserId) : null;
                      const sourceName = sourceUserId
                        ? isSelfSource
                          ? "You"
                          : sourcePerson?.name ?? "User"
                        : formatNotificationSourceType(notification.type);
                      const sourceAvatar = sourceUserId
                        ? isSelfSource
                          ? authAvatarUrl
                          : sourcePerson?.avatarUrl ?? null
                        : null;
                      const notificationTimeLabel = formatNotificationTimeLabel(notification.created_at ?? null, notificationClockMs);
                      return (
                      <Panel
                        key={notification.id}
                        variant="card"
                        borderWidth={1}
                        className="notification-card prefs-section"
                        data-notification-id={notification.id}
                        data-notification-read={notification.is_read ? "1" : "0"}
                      >
                        <div className="notification-card-head">
                          <span className="notification-owner-inline">
                            {sourceAvatar ? (
                              <span className="pill-icon-badge user-pill-avatar manager-card-avatar" aria-hidden="true">
                                <img src={sourceAvatar} alt={sourceName} loading="eager" referrerPolicy="no-referrer" crossOrigin="anonymous" />
                              </span>
                            ) : null}
                            <span className="notification-owner-name">{sourceName}</span>
                            <span className="notification-time-separator" aria-hidden="true"><FaCircle /></span>
                            <span className="notification-time">{notificationTimeLabel}</span>
                          </span>
                          <span className={`notification-chip ${notification.is_read ? "status-read" : "status-unread"}`}>
                            {notification.is_read ? "Read" : "Unread"}
                          </span>
                        </div>
                        <p className="notification-card-body">{notification.body}</p>
                        <div className="notification-actions">
                          <Button type="button" variant="delete" onClick={() => void deleteActivityNotification(notification.id)}>
                            Delete
                          </Button>
                        </div>
                      </Panel>
                    );
                    })}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="cloud-meta">No activity items.</p>
                  )}
                </div>
              </Panel>
              ) : null}
            </div>
          </div>
        </Modal>
        <Modal isOpen={friendRequestOpen} title="Add Friend" subtitle="Send a Supabase friend request" size="compact" onClose={() => setFriendRequestOpen(false)}>
          <div className="ef-modal-form">
            <form className="group-create-form" onSubmit={sendFriendRequest}>
              <label>
                Username
                <Input
                  value={friendRequestUsername}
                  onChange={(event) => setFriendRequestUsername(event.target.value)}
                  placeholder="friend username"
                />
              </label>
              {friendRequestMessage ? <p className="cloud-status">{friendRequestMessage}</p> : null}
              <div className="ef-modal-actions">
                <Button type="button" variant="ghost" onClick={() => setFriendRequestOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={friendRequestBusy}>
                  Send Request
                </Button>
              </div>
            </form>
          </div>
        </Modal>

        <FloatingFooter
          className="planner-footer"
          title="Planner"
          subtitle={allPlans.length > 0 ? `${allPlans.length} plan(s) saved` : "No plans yet"}
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                className="footer-side-button footer-side-notifications"
                onClick={() => setNotificationsOpen(true)}
                aria-label={`Notifications${unreadNotificationCount > 0 ? ` (${unreadNotificationCount} unread)` : ""}`}
              >
                <span className="footer-side-icon" aria-hidden="true">
                  <FaBell />
                </span>
                {unreadNotificationCount > 0 ? <span className="footer-notification-badge">{unreadNotificationCount}</span> : null}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="footer-side-button footer-side-left"
                onClick={() => setFriendsListOpen(true)}
                aria-label="Friends"
              >
                <span className="footer-side-icon" aria-hidden="true">
                  <FaUserFriends />
                </span>
              </Button>
              <Button type="button" variant="primary" onClick={openCreatePlanModal} className="create-plan-button" aria-label="Create plan">
                <span className="create-plan-icon">
                  <IconPlus />
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="footer-side-button footer-side-right"
                onClick={() => setGroupsListOpen(true)}
                aria-label="Groups"
              >
                <span className="footer-side-icon" aria-hidden="true">
                  <FaUsers />
                </span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="footer-side-button footer-side-plans"
                onClick={() => setPlansListOpen(true)}
                aria-label="Plans"
              >
                <span className="footer-side-icon" aria-hidden="true">
                  <FaList />
                </span>
              </Button>
            </>
          }
        />
      </main>
    </div>
  );
}



