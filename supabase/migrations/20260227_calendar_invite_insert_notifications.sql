-- Ensure invitees always receive a plan_invite notification on new invites.
-- This runs server-side and is not blocked by client RLS policies.
-- Also covers re-invites where an existing row is set back to pending.

create or replace function public.calendar_notify_plan_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_plan_name text;
begin
  if tg_op not in ('INSERT', 'UPDATE') then
    return new;
  end if;

  if new.invitee_id is null or new.inviter_id is null then
    return new;
  end if;

  if new.invitee_id = new.inviter_id then
    return new;
  end if;

  if new.status is distinct from 'pending' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  select coalesce(nullif(trim(s.name), ''), 'a plan')
  into row_plan_name
  from public.calendar_shared_plans s
  where s.id = new.plan_id;

  if exists (
    select 1
    from public.calendar_notifications n
    where n.user_id = new.invitee_id
      and n.type = 'plan_invite'
      and coalesce(n.payload->>'plan_id', '') = new.plan_id
      and n.is_read = false
  ) then
    return new;
  end if;

  insert into public.calendar_notifications (user_id, type, title, body, payload, is_read)
  values (
    new.invitee_id,
    'plan_invite',
    'New plan invite',
    'You were invited to ' || coalesce(row_plan_name, 'a plan') || '.',
    jsonb_build_object(
      'plan_id', new.plan_id,
      'inviter_id', new.inviter_id,
      'invitee_id', new.invitee_id,
      'invite_id', new.id
    ),
    false
  );

  return new;
end;
$$;

drop trigger if exists calendar_plan_invites_insert_notification on public.calendar_plan_invites;
drop trigger if exists calendar_plan_invites_notification on public.calendar_plan_invites;
create trigger calendar_plan_invites_notification
after insert or update of status on public.calendar_plan_invites
for each row
execute function public.calendar_notify_plan_invite();
