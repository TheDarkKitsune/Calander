-- Persist recurrence metadata for shared plans so one plan can render multiple occurrences
-- without duplicating rows (which previously caused invite spam).

alter table if exists public.calendar_shared_plans
  add column if not exists recurring boolean not null default false,
  add column if not exists recurrence_type text not null default 'weekly',
  add column if not exists recurrence_custom_days integer not null default 7,
  add column if not exists recurrence_count integer not null default 0,
  add column if not exists recurrence_infinite boolean not null default false;

update public.calendar_shared_plans
set recurrence_type = 'weekly'
where recurrence_type is null or btrim(recurrence_type) = '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'calendar_shared_plans_recurrence_type_check'
  ) then
    alter table public.calendar_shared_plans
      add constraint calendar_shared_plans_recurrence_type_check
      check (recurrence_type in ('weekly', 'fortnightly', 'four-weekly', 'monthly', 'yearly', 'custom'));
  end if;
end;
$$;
