-- Notify plan participants when a shared plan is updated, including what changed.
-- Only invitees (participants) receive this activity notification.

create or replace function public.calendar_notify_plan_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changes text[] := '{}';
  plan_label text;
  old_schedule text;
  new_schedule text;
  old_visibility text;
  new_visibility text;
  old_participants uuid[];
  new_participants uuid[];
  added_participants uuid[];
  removed_participants uuid[];
  added_participants_text text;
  removed_participants_text text;
  old_location text;
  new_location text;
  old_summary text;
  new_summary text;
  recipient record;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.name is distinct from old.name then
    changes := array_append(
      changes,
      E'• Name\n  from: ' || coalesce(nullif(old.name, ''), 'Untitled') || E'\n  to: ' || coalesce(nullif(new.name, ''), 'Untitled')
    );
  end if;

  old_schedule := old.from_date::text || ' to ' || old.to_date::text ||
    case when old.all_day then ' (All day)' else ' | ' || coalesce(old.from_time, '09:00') || '-' || coalesce(old.to_time, '17:00') end;
  new_schedule := new.from_date::text || ' to ' || new.to_date::text ||
    case when new.all_day then ' (All day)' else ' | ' || coalesce(new.from_time, '09:00') || '-' || coalesce(new.to_time, '17:00') end;
  if old_schedule is distinct from new_schedule then
    changes := array_append(changes, E'• Schedule\n  from: ' || old_schedule || E'\n  to: ' || new_schedule);
  end if;

  old_location := coalesce(nullif(trim(old.location), ''), 'None');
  new_location := coalesce(nullif(trim(new.location), ''), 'None');
  if old_location is distinct from new_location then
    changes := array_append(changes, E'• Location\n  from: ' || old_location || E'\n  to: ' || new_location);
  end if;

  old_summary := coalesce(nullif(trim(old.summary), ''), 'None');
  new_summary := coalesce(nullif(trim(new.summary), ''), 'None');
  if old_summary is distinct from new_summary then
    changes := array_append(changes, E'• Summary\n  from: ' || old_summary || E'\n  to: ' || new_summary);
  end if;

  old_visibility := coalesce(array_to_string(coalesce(old.target_group_ids, '{}'::text[]), ', '), '');
  new_visibility := coalesce(array_to_string(coalesce(new.target_group_ids, '{}'::text[]), ', '), '');
  if old_visibility = '' then old_visibility := 'Public (All Friends)'; end if;
  if new_visibility = '' then new_visibility := 'Public (All Friends)'; end if;
  if old_visibility is distinct from new_visibility then
    changes := array_append(changes, E'• Visibility\n  from: ' || old_visibility || E'\n  to: ' || new_visibility);
  end if;

  old_participants := coalesce(old.invited_ids, '{}'::uuid[]);
  new_participants := coalesce(new.invited_ids, '{}'::uuid[]);
  if old_participants is distinct from new_participants then
    select coalesce(array_agg(v), '{}'::uuid[])
    into added_participants
    from unnest(new_participants) as v
    where not (v = any(old_participants));

    select coalesce(array_agg(v), '{}'::uuid[])
    into removed_participants
    from unnest(old_participants) as v
    where not (v = any(new_participants));

    select coalesce(string_agg(coalesce(nullif(trim(p.username), ''), u::text), ', '), '')
    into added_participants_text
    from unnest(added_participants) as u
    left join public.profiles p on p.id = u;

    select coalesce(string_agg(coalesce(nullif(trim(p.username), ''), u::text), ', '), '')
    into removed_participants_text
    from unnest(removed_participants) as u
    left join public.profiles p on p.id = u;

    if added_participants_text <> '' and removed_participants_text <> '' then
      changes := array_append(
        changes,
        E'• Participants\n  added: ' || added_participants_text || E'\n  removed: ' || removed_participants_text
      );
    elsif added_participants_text <> '' then
      changes := array_append(changes, E'• Participants\n  added: ' || added_participants_text);
    elsif removed_participants_text <> '' then
      changes := array_append(changes, E'• Participants\n  removed: ' || removed_participants_text);
    else
      changes := array_append(
        changes,
        E'• Participants\n  from: ' || coalesce(array_to_string(old_participants, ', '), 'None') ||
        E'\n  to: ' || coalesce(array_to_string(new_participants, ', '), 'None')
      );
    end if;
  end if;

  if coalesce(array_length(changes, 1), 0) = 0 then
    return new;
  end if;

  plan_label := coalesce(nullif(trim(new.name), ''), 'A plan');

  for recipient in
    select distinct i.invitee_id
    from public.calendar_plan_invites i
    where i.plan_id = new.id
      and i.status in ('pending', 'going', 'maybe')
  loop
    if recipient.invitee_id = new.owner_id then
      continue;
    end if;

    insert into public.calendar_notifications (user_id, type, title, body, payload, is_read)
    values (
      recipient.invitee_id,
      'plan_updated',
      'Plan updated',
      plan_label || E' was updated:\n' || array_to_string(changes, E'\n'),
      jsonb_build_object(
        'plan_id', new.id,
        'owner_id', new.owner_id,
        'changes', to_jsonb(changes)
      ),
      false
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists calendar_shared_plans_update_notification on public.calendar_shared_plans;
create trigger calendar_shared_plans_update_notification
after update on public.calendar_shared_plans
for each row
execute function public.calendar_notify_plan_update();
