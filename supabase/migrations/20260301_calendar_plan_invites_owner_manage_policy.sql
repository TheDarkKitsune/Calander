-- Allow the plan owner to manage invite rows directly.
-- This fixes stale inviter_id rows blocking uninvite/update sync.

drop policy if exists "calendar_plan_invites_update_participant" on public.calendar_plan_invites;
create policy "calendar_plan_invites_update_participant" on public.calendar_plan_invites
for update
using (
  auth.uid() = inviter_id
  or auth.uid() = invitee_id
  or exists (
    select 1
    from public.calendar_shared_plans p
    where p.id = calendar_plan_invites.plan_id
      and p.owner_id = auth.uid()
  )
)
with check (
  auth.uid() = inviter_id
  or auth.uid() = invitee_id
  or exists (
    select 1
    from public.calendar_shared_plans p
    where p.id = calendar_plan_invites.plan_id
      and p.owner_id = auth.uid()
  )
);

drop policy if exists "calendar_plan_invites_delete_owner" on public.calendar_plan_invites;
create policy "calendar_plan_invites_delete_owner" on public.calendar_plan_invites
for delete
using (
  auth.uid() = inviter_id
  or exists (
    select 1
    from public.calendar_shared_plans p
    where p.id = calendar_plan_invites.plan_id
      and p.owner_id = auth.uid()
  )
);
