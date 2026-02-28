package com.enderfall.calendar;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.RemoteMessage;
import com.capacitorjs.plugins.pushnotifications.MessagingService;

import java.util.Map;

public class CalendarFirebaseMessagingService extends MessagingService {
    private static final String CHANNEL_ID = "calendar_updates";
    private static final String CHANNEL_NAME = "Calendar Updates";

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Map<String, String> data = remoteMessage.getData();
        if (data == null || data.isEmpty()) {
            return;
        }

        String type = value(data, "type");
        if (!"plan_invite".equalsIgnoreCase(type)) {
            return;
        }

        String inviteId = value(data, "invite_id");
        if (inviteId.isEmpty()) {
            return;
        }

        String title = value(data, "title");
        String body = value(data, "body");
        if (title.isEmpty()) title = "New plan invite";
        if (body.isEmpty()) body = "You have a new invite.";

        createChannelIfNeeded();

        PendingIntent openIntent = buildActionIntent(inviteId, null, 0);
        PendingIntent goingIntent = buildActionIntent(inviteId, "going", 1);
        PendingIntent maybeIntent = buildActionIntent(inviteId, "maybe", 2);
        PendingIntent cantIntent = buildActionIntent(inviteId, "cant", 3);

        int notificationId = parseNotificationId(value(data, "notification_id"), inviteId);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openIntent)
            .addAction(0, "Going", goingIntent)
            .addAction(0, "Maybe", maybeIntent)
            .addAction(0, "Can't", cantIntent);

        NotificationManagerCompat.from(this).notify(notificationId, builder.build());
    }

    private PendingIntent buildActionIntent(String inviteId, String response, int requestCodeOffset) {
        Uri.Builder uriBuilder = Uri.parse("enderfallcalendar://invite-action").buildUpon()
            .appendQueryParameter("invite_id", inviteId);
        if (response != null && !response.isEmpty()) {
            uriBuilder.appendQueryParameter("response", response);
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, uriBuilder.build(), this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.putExtra("invite_id", inviteId);
        if (response != null && !response.isEmpty()) {
            intent.putExtra("response", response);
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        int requestCode = Math.abs((inviteId + ":" + (response == null ? "open" : response)).hashCode()) + requestCodeOffset;
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    private void createChannelIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel != null) return;
        NotificationChannel created = new NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH
        );
        created.setDescription("Plan invites and calendar updates");
        manager.createNotificationChannel(created);
    }

    private int parseNotificationId(String raw, String fallbackSeed) {
        try {
            long parsed = Long.parseLong(raw);
            long normalized = Math.abs(parsed % 2147483000L);
            if (normalized == 0L) normalized = Math.abs(fallbackSeed.hashCode());
            return (int) normalized;
        } catch (Exception ignored) {
            int fallback = Math.abs(fallbackSeed.hashCode());
            return fallback == 0 ? 1 : fallback;
        }
    }

    private String value(Map<String, String> data, String key) {
        String v = data.get(key);
        return v == null ? "" : v.trim();
    }
}
