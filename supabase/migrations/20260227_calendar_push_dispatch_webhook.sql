-- Forward new calendar notifications to Supabase Edge Function for background push delivery.
-- Configure these DB settings in Supabase SQL editor (or dashboard):
--   alter database postgres set app.push_webhook_url = 'https://<project-ref>.functions.supabase.co/calendar-push-dispatch';
--   alter database postgres set app.push_webhook_secret = '<same-secret-as-edge-function-env>';

create or replace function public.calendar_dispatch_push_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  webhook_url text;
  webhook_secret text;
  headers jsonb;
  body jsonb;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  if coalesce(new.is_read, false) then
    return new;
  end if;

  webhook_url := current_setting('app.push_webhook_url', true);
  if webhook_url is null or trim(webhook_url) = '' then
    return new;
  end if;

  webhook_secret := current_setting('app.push_webhook_secret', true);
  headers := jsonb_build_object('Content-Type', 'application/json');
  if webhook_secret is not null and trim(webhook_secret) <> '' then
    headers := headers || jsonb_build_object('x-push-secret', webhook_secret);
  end if;

  body := jsonb_build_object(
    'type', 'INSERT',
    'table', 'calendar_notifications',
    'schema', 'public',
    'record', to_jsonb(new)
  );

  if to_regnamespace('net') is null then
    return new;
  end if;

  begin
    execute 'select net.http_post($1, $2, $3, $4)'
      using webhook_url, headers, body, 2000;
  exception
    when others then
      begin
        execute 'select net.http_post($1, $2, $3, $4, $5)'
          using webhook_url, headers, body, '{}'::jsonb, 2000;
      exception
        when others then
          -- Never block notification writes due to webhook failures.
          null;
      end;
  end;

  return new;
end;
$$;

drop trigger if exists calendar_notifications_push_webhook_trigger on public.calendar_notifications;
create trigger calendar_notifications_push_webhook_trigger
after insert on public.calendar_notifications
for each row
execute function public.calendar_dispatch_push_webhook();
