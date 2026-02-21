-- Allow shared plan visibility for pending/going/maybe invites and invited_ids recipients.

drop policy if exists "calendar_shared_plans_select" on public.calendar_shared_plans;
create policy "calendar_shared_plans_select" on public.calendar_shared_plans
for select using (
  auth.uid() = owner_id
  or auth.uid() = any(invited_ids)
  or exists (
    select 1 from public.calendar_plan_invites i
    where i.plan_id = calendar_shared_plans.id
      and i.invitee_id = auth.uid()
      and i.status in ('pending', 'going', 'maybe', 'accepted')
  )
);

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
        or auth.uid() = any(p.invited_ids)
        or exists (
          select 1 from public.calendar_plan_invites i
          where i.plan_id = p.id
            and i.invitee_id = auth.uid()
            and i.status in ('pending', 'going', 'maybe', 'accepted')
        )
      )
  )
);
