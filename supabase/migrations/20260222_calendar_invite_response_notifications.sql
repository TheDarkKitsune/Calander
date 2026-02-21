-- Create activity notifications for plan invite responses (going/maybe/cant).
-- This runs in the database so owners receive notifications in realtime.

create or replace function public.calendar_notify_invite_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invitee_name text;
  plan_name text;
  status_label text;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status not in ('going', 'maybe', 'cant') then
    return new;
  end if;

  select coalesce(nullif(trim(p.username), ''), 'A friend')
  into invitee_name
  from public.profiles p
  where p.id = new.invitee_id;

  select coalesce(nullif(trim(s.name), ''), 'a plan')
  into plan_name
  from public.calendar_shared_plans s
  where s.id = new.plan_id;

  status_label := case new.status
    when 'going' then 'Going'
    when 'maybe' then 'Maybe'
    when 'cant' then 'Can''t go'
    else new.status
  end;

  insert into public.calendar_notifications (user_id, type, title, body, payload, is_read)
  values (
    new.inviter_id,
    'plan_response',
    'Invite response',
    invitee_name || ' responded ' || status_label || ' for ' || plan_name || '.',
    jsonb_build_object(
      'plan_id', new.plan_id,
      'invitee_id', new.invitee_id,
      'status', new.status
    ),
    false
  );

  return new;
end;
$$;

drop trigger if exists calendar_plan_invites_response_notification on public.calendar_plan_invites;
create trigger calendar_plan_invites_response_notification
after update on public.calendar_plan_invites
for each row
execute function public.calendar_notify_invite_response();

