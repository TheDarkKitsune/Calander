-- Prevent deleted shared-plan rows from being resurrected by stale client upserts.

create table if not exists public.calendar_deleted_shared_plans (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  plan_id text not null,
  deleted_at timestamptz not null default now(),
  primary key (owner_id, plan_id)
);

alter table public.calendar_deleted_shared_plans enable row level security;

drop policy if exists "calendar_deleted_shared_plans_select_owner" on public.calendar_deleted_shared_plans;
create policy "calendar_deleted_shared_plans_select_owner" on public.calendar_deleted_shared_plans
for select
using (auth.uid() = owner_id);

drop policy if exists "calendar_deleted_shared_plans_insert_owner" on public.calendar_deleted_shared_plans;
create policy "calendar_deleted_shared_plans_insert_owner" on public.calendar_deleted_shared_plans
for insert
with check (auth.uid() = owner_id);

drop policy if exists "calendar_deleted_shared_plans_update_owner" on public.calendar_deleted_shared_plans;
create policy "calendar_deleted_shared_plans_update_owner" on public.calendar_deleted_shared_plans
for update
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create or replace function public.calendar_mark_deleted_shared_plan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.calendar_deleted_shared_plans (owner_id, plan_id, deleted_at)
  values (old.owner_id, old.id, now())
  on conflict (owner_id, plan_id)
  do update set deleted_at = excluded.deleted_at;
  return old;
end;
$$;

drop trigger if exists calendar_shared_plans_mark_deleted on public.calendar_shared_plans;
create trigger calendar_shared_plans_mark_deleted
after delete on public.calendar_shared_plans
for each row execute function public.calendar_mark_deleted_shared_plan();

create or replace function public.calendar_block_deleted_shared_plan_resurrection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.calendar_deleted_shared_plans d
    where d.owner_id = new.owner_id
      and d.plan_id = new.id
  ) then
    raise exception 'Shared plan % was deleted and cannot be recreated with the same id.', new.id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists calendar_shared_plans_block_resurrection on public.calendar_shared_plans;
create trigger calendar_shared_plans_block_resurrection
before insert or update on public.calendar_shared_plans
for each row execute function public.calendar_block_deleted_shared_plan_resurrection();
