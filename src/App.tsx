import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createCloudRoom,
  getCloudUser,
  inviteCloudRoomMember,
  isCloudConfigured,
  joinCloudRoom,
  listCloudRoomMembers,
  onCloudAuthStateChange,
  readCloudRoom,
  removeCloudRoomMember,
  rotateCloudRoomJoinCode,
  signInCloud,
  signOutCloud,
  signUpCloud,
  writeCloudRoom,
} from "./lib/cloud";
import type { CloudMember } from "./lib/cloud";

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

type Group = { id: string; name: string };
type Person = { id: string; name: string; groupId: string };
type CloudUser = { id: string; email: string | null };

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

const STORAGE_KEY = "enderfall-calander-data-v1";
const CLOUD_ROOM_KEY = "enderfall-calander-cloud-room";
const CLOUD_AUTO_SYNC_KEY = "enderfall-calander-cloud-auto-sync";
const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
  groups: [
    { id: "family", name: "Family" },
    { id: "friends", name: "Friends" },
    { id: "work", name: "Work" },
  ],
  people: [
    { id: "adam", name: "Adam", groupId: "family" },
    { id: "colin", name: "Colin", groupId: "family" },
    { id: "mia", name: "Mia", groupId: "friends" },
    { id: "you", name: "You", groupId: "work" },
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

const createId = (name: string) =>
  `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Math.random().toString(36).slice(2, 7)}`;

const normalizeRoomId = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]+/g, "").slice(0, 64);

const normalizeMemberEmail = (value: string) => value.trim().toLowerCase();

const isDayStatus = (value: unknown): value is DayStatus =>
  value === "none" || (typeof value === "string" && EDITABLE_STATUS_VALUES.has(value as EditableStatus));

const normalizeStore = (value: unknown): CalendarStore | null => {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<CalendarStore> & Partial<LegacyCalendarStore>;

  const groups = Array.isArray(input.groups)
    ? input.groups
        .filter((group) => group && typeof group.id === "string" && typeof group.name === "string")
        .map((group) => ({ id: group.id.trim(), name: group.name.trim() }))
        .filter((group) => group.id && group.name)
    : [];

  const groupIds = new Set(groups.map((group) => group.id));
  const people = Array.isArray(input.people)
    ? input.people
        .filter((person) => person && typeof person.id === "string" && typeof person.name === "string")
        .map((person) => ({ id: person.id.trim(), name: person.name.trim(), groupId: String(person.groupId ?? "").trim() }))
        .filter((person) => person.id && person.name && groupIds.has(person.groupId))
    : [];

  if (groups.length === 0 || people.length === 0) return null;

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
    groups,
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

const toDateInputValue = (value: Date) => toKeyDate(value);

const fromDateInputValue = (value: string) => {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
};

export default function App() {
  const initialStore = useMemo(() => loadStore(), []);
  const [store, setStore] = useState<CalendarStore>(initialStore);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(initialStore.people[0]?.id ?? null);
  const [activeStatus, setActiveStatus] = useState<EditableStatus>("available");
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(new Date()));
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() =>
    initialStore.groups.reduce((result, group) => {
      result[group.id] = true;
      return result;
    }, {} as Record<string, boolean>)
  );
  const [newGroupName, setNewGroupName] = useState("");
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonGroupId, setNewPersonGroupId] = useState<string>(initialStore.groups[0]?.id ?? "");
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [roomMembers, setRoomMembers] = useState<CloudMember[]>([]);
  const [memberEmailDraft, setMemberEmailDraft] = useState("");
  const [newJoinCodeDraft, setNewJoinCodeDraft] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberMessage, setMemberMessage] = useState("");
  const [rangeStart, setRangeStart] = useState(() => toDateInputValue(new Date()));
  const [rangeEnd, setRangeEnd] = useState(() => toDateInputValue(new Date()));
  const [patternStart, setPatternStart] = useState(() => toDateInputValue(new Date()));
  const [patternOnDays, setPatternOnDays] = useState("4");
  const [patternOffDays, setPatternOffDays] = useState("4");
  const [patternCycles, setPatternCycles] = useState("4");
  const [batchMessage, setBatchMessage] = useState("");

  const storeRef = useRef(store);
  const remoteApplyRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    storeRef.current = store;
  }, [store]);

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
        setStore(remoteStore);
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
          setStore(remoteStore);
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
    document.documentElement.setAttribute("data-theme", "galaxy");
    document.body.classList.add("ef-galaxy");
    return () => {
      document.body.classList.remove("ef-galaxy");
    };
  }, []);

  useEffect(() => {
    if (!isCloudConfigured) return;
    let active = true;

    getCloudUser()
      .then((user) => {
        if (!active) return;
        setCloudUser(user ? { id: user.id, email: user.email ?? null } : null);
      })
      .catch(() => undefined);

    const unsubscribe = onCloudAuthStateChange((user) => {
      if (!active) return;
      setCloudUser(user ? { id: user.id, email: user.email ?? null } : null);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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
    if (store.groups.length === 0) {
      setNewPersonGroupId("");
      return;
    }
    if (!store.groups.some((group) => group.id === newPersonGroupId)) {
      setNewPersonGroupId(store.groups[0].id);
    }
  }, [newPersonGroupId, store.groups]);

  useEffect(() => {
    setExpandedGroups((current) => {
      const next = { ...current };
      for (const group of store.groups) {
        if (!(group.id in next)) next[group.id] = true;
      }
      return next;
    });
  }, [store.groups]);

  const selectedPerson = useMemo(
    () => store.people.find((person) => person.id === selectedPersonId) ?? null,
    [selectedPersonId, store.people]
  );

  const selectedGroupName = useMemo(() => {
    if (!selectedPerson) return "";
    return store.groups.find((group) => group.id === selectedPerson.groupId)?.name ?? "";
  }, [selectedPerson, store.groups]);

  const monthLabel = useMemo(
    () => monthAnchor.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    [monthAnchor]
  );

  const calendarDays = useMemo(() => buildCalendarDays(monthAnchor), [monthAnchor]);

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

  const setDayStatus = (date: Date) => {
    if (!selectedPerson) return;
    const key = `${selectedPerson.id}:${toKeyDate(date)}`;
    updateStore((current) => {
      const nextEntries = { ...current.entries };
      if (nextEntries[key] === activeStatus) {
        delete nextEntries[key];
      } else {
        nextEntries[key] = activeStatus;
      }
      return { ...current, entries: nextEntries };
    });
  };

  const clearMonthForSelected = () => {
    if (!selectedPerson) return;
    const monthPrefix = `${monthAnchor.getFullYear()}-${String(monthAnchor.getMonth() + 1).padStart(2, "0")}-`;
    const personPrefix = `${selectedPerson.id}:${monthPrefix}`;
    updateStore((current) => {
      const nextEntries = { ...current.entries };
      for (const key of Object.keys(nextEntries)) {
        if (key.startsWith(personPrefix)) delete nextEntries[key];
      }
      return { ...current, entries: nextEntries };
    });
  };

  const applyDateRange = () => {
    if (!selectedPerson) {
      setBatchMessage("Select a person first.");
      return;
    }
    const start = fromDateInputValue(rangeStart);
    const end = fromDateInputValue(rangeEnd);
    if (!start || !end) {
      setBatchMessage("Choose valid start/end dates.");
      return;
    }

    const startMs = start.getTime();
    const endMs = end.getTime();
    const from = startMs <= endMs ? start : end;
    const to = startMs <= endMs ? end : start;

    updateStore((current) => {
      const nextEntries = { ...current.entries };
      const cursor = new Date(from);
      while (cursor.getTime() <= to.getTime()) {
        const key = `${selectedPerson.id}:${toKeyDate(cursor)}`;
        nextEntries[key] = activeStatus;
        cursor.setDate(cursor.getDate() + 1);
      }
      return { ...current, entries: nextEntries };
    });

    setBatchMessage(`Applied "${STATUS_LOOKUP[activeStatus].short}" from ${toKeyDate(from)} to ${toKeyDate(to)}.`);
  };

  const applyRepeatPattern = () => {
    if (!selectedPerson) {
      setBatchMessage("Select a person first.");
      return;
    }
    const start = fromDateInputValue(patternStart);
    const onDays = Number(patternOnDays);
    const offDays = Number(patternOffDays);
    const cycles = Number(patternCycles);
    if (!start || onDays < 1 || offDays < 0 || cycles < 1) {
      setBatchMessage("Use valid pattern values. On>=1, Off>=0, Cycles>=1.");
      return;
    }

    updateStore((current) => {
      const nextEntries = { ...current.entries };
      const cursor = new Date(start);
      for (let cycleIndex = 0; cycleIndex < cycles; cycleIndex += 1) {
        for (let onIndex = 0; onIndex < onDays; onIndex += 1) {
          const key = `${selectedPerson.id}:${toKeyDate(cursor)}`;
          nextEntries[key] = activeStatus;
          cursor.setDate(cursor.getDate() + 1);
        }
        cursor.setDate(cursor.getDate() + offDays);
      }
      return { ...current, entries: nextEntries };
    });

    setBatchMessage(`Applied ${onDays} on / ${offDays} off for ${cycles} cycle(s) from ${toKeyDate(start)}.`);
  };

  const addGroup = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    const id = createId(trimmed);
    updateStore((current) => ({ ...current, groups: [...current.groups, { id, name: trimmed }] }));
    setExpandedGroups((current) => ({ ...current, [id]: true }));
    if (!newPersonGroupId) setNewPersonGroupId(id);
    setNewGroupName("");
  };

  const addPerson = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newPersonName.trim();
    if (!trimmed || !newPersonGroupId) return;
    const id = createId(trimmed);
    updateStore((current) => ({
      ...current,
      people: [...current.people, { id, name: trimmed, groupId: newPersonGroupId }],
    }));
    setSelectedPersonId(id);
    setNewPersonName("");
    setExpandedGroups((current) => ({ ...current, [newPersonGroupId]: true }));
  };

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
  };

  const signOut = async () => {
    setAuthBusy(true);
    const { error } = await signOutCloud();
    setAuthBusy(false);
    setAuthMessage(error ? `Sign out failed: ${error}` : "Signed out.");
    setCloudRoomId("");
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

  const syncReady = Boolean(cloudRoomId && isCloudConfigured && cloudUser);
  const syncMessageClass = syncState === "error" ? "cloud-status is-error" : "cloud-status";
  const currentMember = cloudUser ? roomMembers.find((member) => member.user_id === cloudUser.id) ?? null : null;
  const isRoomOwner = currentMember?.role === "owner";

  return (
    <div className="calendar-app">
      <button
        type="button"
        aria-label="Close side menu"
        className={`backdrop ${sidebarOpen ? "is-visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <header className="sidebar-header">
          <h2>Calendars</h2>
          <button type="button" className="close-sidebar" onClick={() => setSidebarOpen(false)}>
            Close
          </button>
        </header>
        <p className="sidebar-subtitle">Pick a group, then choose a person to edit their days.</p>

        <div className="sidebar-groups">
          {store.groups.map((group) => {
            const groupPeople = store.people.filter((person) => person.groupId === group.id);
            const expanded = expandedGroups[group.id] ?? true;
            return (
              <section key={group.id} className="group-block">
                <button
                  type="button"
                  className="group-toggle"
                  onClick={() => setExpandedGroups((current) => ({ ...current, [group.id]: !expanded }))}
                >
                  <span>{group.name}</span>
                  <span className={`caret ${expanded ? "is-open" : ""}`}>^</span>
                </button>
                {expanded ? (
                  <div className="group-list">
                    {groupPeople.length > 0 ? (
                      groupPeople.map((person) => (
                        <button
                          key={person.id}
                          type="button"
                          className={`person-button ${person.id === selectedPersonId ? "is-active" : ""}`}
                          onClick={() => {
                            setSelectedPersonId(person.id);
                            setSidebarOpen(false);
                          }}
                        >
                          {person.name}
                        </button>
                      ))
                    ) : (
                      <p className="empty-group">No calendars yet.</p>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>

        <form className="sidebar-form" onSubmit={addGroup}>
          <label htmlFor="new-group-name">New Group</label>
          <div className="form-row">
            <input id="new-group-name" value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="Family, Friends, Team" />
            <button type="submit">Add</button>
          </div>
        </form>

        <form className="sidebar-form" onSubmit={addPerson}>
          <label htmlFor="new-person-name">New Person Calendar</label>
          <input id="new-person-name" value={newPersonName} onChange={(event) => setNewPersonName(event.target.value)} placeholder="Person name" />
          <select value={newPersonGroupId} onChange={(event) => setNewPersonGroupId(event.target.value)}>
            {store.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          <button type="submit">Create Calendar</button>
        </form>

        <section className="sidebar-form cloud-card">
          <label>Private Cloud Sync</label>
          {!isCloudConfigured ? (
            <p className="cloud-status is-error">Missing Supabase env vars.</p>
          ) : (
            <>
              {cloudUser ? (
                <div className="auth-state">
                  <p className="cloud-meta">Signed in as {cloudUser.email ?? cloudUser.id}</p>
                  <button type="button" onClick={() => void signOut()} disabled={authBusy}>
                    Sign Out
                  </button>
                </div>
              ) : (
                <form className="auth-form" onSubmit={(event) => void signIn(event)}>
                  <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="Email" />
                  <input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Password" />
                  <div className="cloud-actions two-cols">
                    <button type="submit" disabled={authBusy}>Sign In</button>
                    <button type="button" onClick={() => void signUp()} disabled={authBusy}>Sign Up</button>
                  </div>
                </form>
              )}
              {authMessage ? <p className="cloud-status">{authMessage}</p> : null}

              <label htmlFor="cloud-room-id">Room ID</label>
              <form className="cloud-connect" onSubmit={connectCloud}>
                <input
                  id="cloud-room-id"
                  className="input-mono"
                  value={cloudRoomDraft}
                  onChange={(event) => setCloudRoomDraft(event.target.value)}
                  placeholder="family-2026"
                />
                <button type="submit" disabled={!cloudUser}>
                  Connect
                </button>
              </form>

              <label htmlFor="cloud-join-code">Join Code</label>
              <input
                id="cloud-join-code"
                className="input-mono"
                value={cloudJoinCodeDraft}
                onChange={(event) => setCloudJoinCodeDraft(event.target.value)}
                placeholder="room secret code"
              />

              <div className="cloud-actions">
                <button type="button" onClick={() => void createRoom()} disabled={!cloudUser || syncState === "syncing"}>
                  Create Room
                </button>
                <button type="button" onClick={() => void joinRoom()} disabled={!cloudUser || syncState === "syncing"}>
                  Join Room
                </button>
                <button type="button" onClick={disconnectCloud} disabled={!cloudRoomId}>
                  Disconnect
                </button>
              </div>

              <label className="toggle-row" htmlFor="cloud-auto-sync">
                <input
                  id="cloud-auto-sync"
                  type="checkbox"
                  checked={cloudAutoSync}
                  onChange={(event) => setCloudAutoSync(event.target.checked)}
                />
                <span>Auto sync every 12s</span>
              </label>

              <div className="cloud-actions">
                <button
                  type="button"
                  onClick={() => void pullFromCloud("manual")}
                  disabled={!syncReady || syncState === "syncing"}
                >
                  Pull
                </button>
                <button
                  type="button"
                  onClick={() => void pushToCloud("manual")}
                  disabled={!syncReady || syncState === "syncing"}
                >
                  Push
                </button>
                <button type="button" onClick={() => setCloudJoinCodeDraft("")}>
                  Clear Code
                </button>
              </div>

              <p className={syncMessageClass}>{syncMessage}</p>
              <p className="cloud-meta">
                Room: {cloudRoomId || "none"} | Last sync: {formatSyncTime(lastSyncAt)}
              </p>

              {cloudRoomId && cloudUser ? (
                <div className="member-manager">
                  <div className="member-header">
                    <span>Room Members</span>
                    <button type="button" onClick={() => void loadRoomMembers()} disabled={memberBusy}>
                      Refresh
                    </button>
                  </div>

                  {isRoomOwner ? (
                    <div className="member-owner-tools">
                      <div className="member-invite">
                        <input
                          type="email"
                          value={memberEmailDraft}
                          onChange={(event) => setMemberEmailDraft(event.target.value)}
                          placeholder="invite@email.com"
                        />
                        <button type="button" onClick={() => void inviteMember()} disabled={memberBusy}>
                          Invite
                        </button>
                      </div>
                      <div className="member-code">
                        <input
                          type="password"
                          className="input-mono"
                          value={newJoinCodeDraft}
                          onChange={(event) => setNewJoinCodeDraft(event.target.value)}
                          placeholder="new room join code"
                        />
                        <button type="button" onClick={() => void rotateJoinCode()} disabled={memberBusy}>
                          Update Code
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="cloud-meta">Only room owner can invite or remove members.</p>
                  )}

                  {memberMessage ? (
                    <p className={`cloud-status ${memberMessage.toLowerCase().includes("failed") ? "is-error" : ""}`}>
                      {memberMessage}
                    </p>
                  ) : null}

                  <div className="member-list">
                    {roomMembers.length > 0 ? (
                      roomMembers.map((member) => {
                        const isSelf = cloudUser.id === member.user_id;
                        return (
                          <div key={`${member.user_id}-${member.member_email}`} className="member-row">
                            <div className="member-info">
                              <span>{member.member_email || member.user_id}</span>
                              <small>
                                {member.role}
                                {isSelf ? " (you)" : ""}
                              </small>
                            </div>
                            {isRoomOwner && !isSelf && member.role !== "owner" ? (
                              <button
                                type="button"
                                className="member-remove"
                                onClick={() => void removeMember(member.member_email)}
                                disabled={memberBusy || !member.member_email}
                              >
                                Remove
                              </button>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <p className="cloud-meta">No members loaded yet.</p>
                    )}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button type="button" className="open-sidebar" onClick={() => setSidebarOpen(true)}>
            Menu
          </button>
          <div className="title-block">
            <p className="kicker">EnderFall Planner</p>
            <h1>Holiday Calendar</h1>
          </div>
          <div className={`sync-pill ${syncState === "error" ? "is-error" : ""}`}>
            {syncReady ? "Cloud Connected" : cloudUser ? "Signed In" : "Local Only"}
          </div>
          <div className="person-pill">
            {selectedPerson ? `${selectedPerson.name} (${selectedGroupName})` : "No person selected"}
          </div>
        </header>

        <section className="toolbar">
          <div className="month-controls">
            <button type="button" onClick={() => shiftMonth(-1)}>
              Prev
            </button>
            <p>{monthLabel}</p>
            <button type="button" onClick={() => shiftMonth(1)}>
              Next
            </button>
            <button type="button" onClick={() => setMonthAnchor(startOfMonth(new Date()))}>
              Today
            </button>
          </div>
          <button type="button" className="danger" disabled={!selectedPerson} onClick={clearMonthForSelected}>
            Clear Selected Month
          </button>
        </section>

        <section className="status-toolbar">
          <h2>Tap a status, then tap days in the calendar</h2>
          <div className="status-list">
            {STATUS_OPTIONS.map((status) => (
              <button
                key={status.id}
                type="button"
                className={`status-chip ${status.swatchClass} ${activeStatus === status.id ? "is-active" : ""}`}
                onClick={() => setActiveStatus(status.id)}
              >
                {status.short}
              </button>
            ))}
          </div>
          <div className="batch-tools">
            <div className="batch-card">
              <h3>Book Multiple Days</h3>
              <div className="batch-grid">
                <input type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} />
                <input type="date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} />
                <button type="button" onClick={applyDateRange} disabled={!selectedPerson}>
                  Apply Range
                </button>
              </div>
            </div>
            <div className="batch-card">
              <h3>Repeat Pattern (Example 4 On / 4 Off)</h3>
              <div className="batch-grid pattern-grid">
                <input type="date" value={patternStart} onChange={(event) => setPatternStart(event.target.value)} />
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={patternOnDays}
                  onChange={(event) => setPatternOnDays(event.target.value)}
                  placeholder="On days"
                />
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={patternOffDays}
                  onChange={(event) => setPatternOffDays(event.target.value)}
                  placeholder="Off days"
                />
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={patternCycles}
                  onChange={(event) => setPatternCycles(event.target.value)}
                  placeholder="Cycles"
                />
                <button type="button" onClick={applyRepeatPattern} disabled={!selectedPerson}>
                  Apply Pattern
                </button>
              </div>
            </div>
          </div>
          {batchMessage ? <p className="batch-message">{batchMessage}</p> : null}
        </section>

        <section className="calendar-panel">
          <div className="weekday-row">
            {WEEK_DAYS.map((day) => (
              <div key={day} className="weekday-cell">
                {day}
              </div>
            ))}
          </div>
          <div className="calendar-grid">
            {calendarDays.map((day) => {
              const keyDate = toKeyDate(day);
              const entryKey = selectedPerson ? `${selectedPerson.id}:${keyDate}` : "";
              const status = selectedPerson ? store.entries[entryKey] ?? "none" : "none";
              const meta = status !== "none" ? STATUS_LOOKUP[status] : null;
              const isOtherMonth = day.getMonth() !== monthAnchor.getMonth();
              const isToday = keyDate === toKeyDate(new Date());

              return (
                <button
                  key={keyDate}
                  type="button"
                  disabled={!selectedPerson}
                  className={`day-cell ${meta?.cellClass ?? ""} ${isOtherMonth ? "is-other-month" : ""} ${isToday ? "is-today" : ""}`}
                  onClick={() => setDayStatus(day)}
                  aria-label={`${day.toDateString()} ${meta?.label ?? "No status"}`}
                >
                  <span className="day-number">{day.getDate()}</span>
                  {status === "unpaid-leave" ? <span className="day-star">*</span> : null}
                  {meta ? <span className="day-caption">{meta.short}</span> : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="legend-panel">
          <h2>Calendar key</h2>
          <div className="legend-grid">
            {STATUS_OPTIONS.map((status) => (
              <article className="legend-item" key={status.id}>
                <span className={`legend-swatch ${status.swatchClass}`} />
                <div>
                  <h3>{status.label}</h3>
                  <p>{selectedPerson ? `${monthCounts[status.id]} day(s) this month` : "Select a person to edit"}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
