# calendar-push-dispatch

Receives calendar notification webhook payloads and forwards them to FCM tokens stored in `public.calendar_push_tokens`.

## Required secrets

Set on Supabase project:

- `FCM_SERVICE_ACCOUNT_JSON`: full Firebase service account JSON (single-line JSON string)
- `PUSH_WEBHOOK_SECRET`: shared secret expected in `x-push-secret` header (optional but recommended)

## Expected webhook payload

Either shape is accepted:

```json
{
  "type": "INSERT",
  "table": "calendar_notifications",
  "schema": "public",
  "record": {
    "id": "...",
    "user_id": "...",
    "type": "plan_updated",
    "title": "Plan updated",
    "body": "...",
    "payload": {"plan_id":"..."},
    "is_read": false
  }
}
```

or direct `record` object body.

## Notes

- Invalid/expired tokens are automatically disabled in `calendar_push_tokens`.
- Function uses `SUPABASE_SERVICE_ROLE_KEY` to read token rows.
