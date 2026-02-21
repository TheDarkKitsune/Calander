-- Add location/summary to shared plans and expand invite response statuses.

alter table public.calendar_shared_plans
  add column if not exists location text not null default '',
  add column if not exists summary text not null default '';

update public.calendar_plan_invites
set status = case
  when status = 'accepted' then 'going'
  when status = 'rejected' then 'cant'
  else status
end
where status in ('accepted', 'rejected');

alter table public.calendar_plan_invites
  drop constraint if exists calendar_plan_invites_status_check;

alter table public.calendar_plan_invites
  add constraint calendar_plan_invites_status_check
  check (status in ('pending', 'going', 'maybe', 'cant'));
