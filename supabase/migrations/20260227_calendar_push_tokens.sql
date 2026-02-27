-- Store per-device push tokens so server-side push can target users while app is closed.

create table if not exists public.calendar_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('android', 'ios', 'web')),
  device_label text,
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_push_tokens_user_id_idx on public.calendar_push_tokens(user_id);
create index if not exists calendar_push_tokens_enabled_idx on public.calendar_push_tokens(enabled);

alter table public.calendar_push_tokens enable row level security;

drop policy if exists "Users can read own push tokens" on public.calendar_push_tokens;
create policy "Users can read own push tokens"
  on public.calendar_push_tokens
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own push tokens" on public.calendar_push_tokens;
create policy "Users can insert own push tokens"
  on public.calendar_push_tokens
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own push tokens" on public.calendar_push_tokens;
create policy "Users can update own push tokens"
  on public.calendar_push_tokens
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own push tokens" on public.calendar_push_tokens;
create policy "Users can delete own push tokens"
  on public.calendar_push_tokens
  for delete
  using (auth.uid() = user_id);

create or replace function public.calendar_touch_push_token_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists calendar_push_tokens_touch_updated_at on public.calendar_push_tokens;
create trigger calendar_push_tokens_touch_updated_at
before update on public.calendar_push_tokens
for each row
execute function public.calendar_touch_push_token_updated_at();

