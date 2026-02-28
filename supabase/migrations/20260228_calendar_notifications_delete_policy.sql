-- Allow users to delete their own calendar notifications.
-- Without this, client-side clear can appear to work locally but rows remain in DB.

drop policy if exists "calendar_notifications_delete_own" on public.calendar_notifications;
create policy "calendar_notifications_delete_own"
  on public.calendar_notifications
  for delete
  using (auth.uid() = user_id);

