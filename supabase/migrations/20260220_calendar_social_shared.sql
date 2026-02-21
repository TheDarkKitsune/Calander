-- Shared calendar plans, invites, notifications, and shared groups

create table if not exists public.calendar_shared_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  group_key text not null,
  name text not null,
  icon text not null,
  color text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, group_key)
);

create table if not exists public.calendar_shared_plans (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  from_date date not null,
  to_date date not null,
  all_day boolean not null default false,
  from_time text not null default '09:00',
  to_time text not null default '17:00',
  target_group_ids text[] not null default '{}',
  invited_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_plan_invites (
  id uuid primary key default gen_random_uuid(),
  plan_id text not null references public.calendar_shared_plans(id) on delete cascade,
  inviter_id uuid not null references public.profiles(id) on delete cascade,
  invitee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, invitee_id)
);

create table if not exists public.calendar_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.calendar_shared_groups enable row level security;
alter table public.calendar_shared_plans enable row level security;
alter table public.calendar_plan_invites enable row level security;
alter table public.calendar_notifications enable row level security;

drop policy if exists "calendar_shared_groups_select" on public.calendar_shared_groups;
create policy "calendar_shared_groups_select" on public.calendar_shared_groups
for select using (
  auth.uid() = owner_id
  or exists (
    select 1 from public.calendar_shared_plans p
    where p.owner_id = calendar_shared_groups.owner_id
      and calendar_shared_groups.group_key = any(p.target_group_ids)
      and (
        p.owner_id = auth.uid()
        or exists (
          select 1 from public.calendar_plan_invites i
          where i.plan_id = p.id
            and i.invitee_id = auth.uid()
            and i.status = 'accepted'
        )
      )
  )
);

drop policy if exists "calendar_shared_groups_write_owner" on public.calendar_shared_groups;
create policy "calendar_shared_groups_write_owner" on public.calendar_shared_groups
for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "calendar_shared_plans_select" on public.calendar_shared_plans;
create policy "calendar_shared_plans_select" on public.calendar_shared_plans
for select using (
  auth.uid() = owner_id
  or exists (
    select 1 from public.calendar_plan_invites i
    where i.plan_id = calendar_shared_plans.id
      and i.invitee_id = auth.uid()
      and i.status = 'accepted'
  )
);

drop policy if exists "calendar_shared_plans_write_owner" on public.calendar_shared_plans;
create policy "calendar_shared_plans_write_owner" on public.calendar_shared_plans
for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "calendar_plan_invites_select" on public.calendar_plan_invites;
create policy "calendar_plan_invites_select" on public.calendar_plan_invites
for select using (auth.uid() = inviter_id or auth.uid() = invitee_id);

drop policy if exists "calendar_plan_invites_insert_owner" on public.calendar_plan_invites;
create policy "calendar_plan_invites_insert_owner" on public.calendar_plan_invites
for insert with check (auth.uid() = inviter_id);

drop policy if exists "calendar_plan_invites_update_participant" on public.calendar_plan_invites;
create policy "calendar_plan_invites_update_participant" on public.calendar_plan_invites
for update using (auth.uid() = inviter_id or auth.uid() = invitee_id);

drop policy if exists "calendar_plan_invites_delete_owner" on public.calendar_plan_invites;
create policy "calendar_plan_invites_delete_owner" on public.calendar_plan_invites
for delete using (auth.uid() = inviter_id);

drop policy if exists "calendar_notifications_select_own" on public.calendar_notifications;
create policy "calendar_notifications_select_own" on public.calendar_notifications
for select using (auth.uid() = user_id);

drop policy if exists "calendar_notifications_insert_owner" on public.calendar_notifications;
create policy "calendar_notifications_insert_owner" on public.calendar_notifications
for insert with check (auth.uid() = user_id);

drop policy if exists "calendar_notifications_update_own" on public.calendar_notifications;
create policy "calendar_notifications_update_own" on public.calendar_notifications
for update using (auth.uid() = user_id);

create or replace function public.calendar_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists calendar_shared_groups_set_updated_at on public.calendar_shared_groups;
create trigger calendar_shared_groups_set_updated_at
before update on public.calendar_shared_groups
for each row execute function public.calendar_set_updated_at();

drop trigger if exists calendar_shared_plans_set_updated_at on public.calendar_shared_plans;
create trigger calendar_shared_plans_set_updated_at
before update on public.calendar_shared_plans
for each row execute function public.calendar_set_updated_at();

drop trigger if exists calendar_plan_invites_set_updated_at on public.calendar_plan_invites;
create trigger calendar_plan_invites_set_updated_at
before update on public.calendar_plan_invites
for each row execute function public.calendar_set_updated_at();

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
exception when duplicate_object then
  null;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.calendar_shared_groups;
  exception when duplicate_object then
    null;
  end;
  begin
    alter publication supabase_realtime add table public.calendar_shared_plans;
  exception when duplicate_object then
    null;
  end;
  begin
    alter publication supabase_realtime add table public.calendar_plan_invites;
  exception when duplicate_object then
    null;
  end;
  begin
    alter publication supabase_realtime add table public.calendar_notifications;
  exception when duplicate_object then
    null;
  end;
end $$;
