-- Null-safe patch for plan membership notification bodies when plans are deleted directly.
-- Replaces the existing trigger function with NULL-safe plan label handling.

create or replace function public.calendar_notify_invite_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_plan_id text;
  row_inviter_id uuid;
  row_invitee_id uuid;
  row_invitee_name text;
  row_plan_name text;
  change_line text;
  recipient record;
begin
  if tg_op = 'INSERT' then
    row_plan_id := new.plan_id;
    row_inviter_id := new.inviter_id;
    row_invitee_id := new.invitee_id;
  elsif tg_op = 'DELETE' then
    row_plan_id := old.plan_id;
    row_inviter_id := old.inviter_id;
    row_invitee_id := old.invitee_id;
  else
    return coalesce(new, old);
  end if;

  select coalesce(nullif(trim(p.username), ''), row_invitee_id::text)
  into row_invitee_name
  from public.profiles p
  where p.id = row_invitee_id;

  select coalesce(nullif(trim(s.name), ''), 'A plan')
  into row_plan_name
  from public.calendar_shared_plans s
  where s.id = row_plan_id;

  row_plan_name := coalesce(row_plan_name, 'a plan');

  change_line := case
    when tg_op = 'INSERT' then E'• Participants\n  invited: ' || row_invitee_name
    else E'• Participants\n  removed: ' || row_invitee_name
  end;

  if tg_op = 'DELETE' and row_invitee_id is not null and row_invitee_id <> row_inviter_id then
    insert into public.calendar_notifications (user_id, type, title, body, payload, is_read)
    values (
      row_invitee_id,
      'plan_removed',
      'Removed from plan',
      'You were removed from ' || coalesce(row_plan_name, 'a plan') || '.',
      jsonb_build_object(
        'plan_id', row_plan_id,
        'owner_id', row_inviter_id,
        'inviter_id', row_inviter_id,
        'change_type', 'participant_removed',
        'participant_id', row_invitee_id
      ),
      false
    );
  end if;

  for recipient in
    select distinct i.invitee_id
    from public.calendar_plan_invites i
    where i.plan_id = row_plan_id
      and i.status = 'going'
  loop
    if recipient.invitee_id = row_inviter_id then
      continue;
    end if;

    insert into public.calendar_notifications (user_id, type, title, body, payload, is_read)
    values (
      recipient.invitee_id,
      'plan_updated',
      'Plan updated',
      coalesce(row_plan_name, 'A plan') || E' was updated:\n' || change_line,
      jsonb_build_object(
        'plan_id', row_plan_id,
        'owner_id', row_inviter_id,
        'changes', to_jsonb(array[change_line]),
        'change_type', case when tg_op = 'INSERT' then 'participant_invited' else 'participant_removed' end,
        'participant_id', row_invitee_id
      ),
      false
    );
  end loop;

  return coalesce(new, old);
end;
$$;
