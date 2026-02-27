import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const NOTIFICATIONS_ENABLED_KEY = "enderfall-calander-notifications-enabled";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

const requestRuntimePermissions = async () => {
  if (typeof window === "undefined") return;
  const notificationsEnabled = localStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
  if (notificationsEnabled === "false") return;

  const capacitor = (window as typeof window & {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: Record<string, unknown>;
    };
  }).Capacitor;

  if (capacitor?.isNativePlatform?.()) {
    try {
      const localNotificationsPlugin = capacitor.Plugins?.LocalNotifications as
        | {
            checkPermissions?: () => Promise<{ display?: string }>;
            requestPermissions?: () => Promise<{ display?: string }>;
          }
        | undefined;
      if (!localNotificationsPlugin?.checkPermissions || !localNotificationsPlugin?.requestPermissions) {
        return;
      }
      const status = await localNotificationsPlugin.checkPermissions();
      if (status.display === "prompt" || status.display === "prompt-with-rationale") {
        await localNotificationsPlugin.requestPermissions();
      }
      return;
    } catch {
      // Ignore unavailable plugin/platform errors.
    }
  }

  try {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch {
    // Ignore browser notification errors.
  }
};

void requestRuntimePermissions();

if ("serviceWorker" in navigator) {
  if (import.meta.env.DEV) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => undefined);
    if ("caches" in window) {
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => undefined);
    }
  } else {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    });
  }
}
