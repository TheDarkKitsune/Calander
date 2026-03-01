-- Persist instance override metadata so recurring exception edits survive refresh/sync.

alter table if exists public.calendar_shared_plans
  add column if not exists source_plan_id text null references public.calendar_shared_plans(id) on delete set null,
  add column if not exists exception_dates text[] not null default '{}';

update public.calendar_shared_plans
set exception_dates = '{}'
where exception_dates is null;
