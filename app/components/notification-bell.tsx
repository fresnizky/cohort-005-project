import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Bell } from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import { notificationKindLabel } from "~/lib/notification-kinds";
import { NotificationRole, type SentenceSegment } from "~/db/schema";
import type { loader as unseenCountLoader } from "~/routes/api.notifications.unseen-count";
import type { loader as listLoader } from "~/routes/api.notifications";

// The bell in the sidebar header. Its badge counts Notifications that aren't
// Seen yet; opening it lists them and marks them Seen. Every action from the
// dropdown posts an `intent` to /api/notifications through `useFetcher`.

const NOTIFICATIONS_PATH = "/api/notifications";
const UNSEEN_COUNT_PATH = "/api/notifications/unseen-count";
const POLL_INTERVAL_MS = 30_000;

type ListedNotification = NonNullable<
  ReturnType<typeof useFetcher<typeof listLoader>>["data"]
>["notifications"][number];

/**
 * The unseen count, polled every 30 seconds while the tab is visible. Polling
 * pauses while the tab is hidden and fetches at once when it is shown again.
 */
function useUnseenCount(): number {
  const fetcher = useFetcher<typeof unseenCountLoader>();
  const load = useRef(fetcher.load);
  load.current = fetcher.load;

  useEffect(() => {
    let timer: number | undefined;

    function stop() {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    }

    function refresh() {
      void load.current(UNSEEN_COUNT_PATH);
    }

    function onVisibilityChange() {
      stop();
      if (document.visibilityState !== "visible") return;
      refresh();
      timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    }

    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return fetcher.data?.unseen ?? 0;
}

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  onOutside: () => void,
  active: boolean
) {
  useEffect(() => {
    if (!active) return;
    function handle(event: MouseEvent) {
      if (
        ref.current &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
      ) {
        onOutside();
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [active, onOutside, ref]);
}

export function NotificationBell() {
  const unseen = useUnseenCount();
  const [open, setOpen] = useState(false);
  const list = useFetcher<typeof listLoader>();
  const markSeen = useFetcher();
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const notifications = list.data?.notifications;

  // Once the list is shown, everything in it counts as Seen. Ids are sent so
  // a Notification arriving meanwhile stays unseen.
  useEffect(() => {
    if (!open || !notifications || markSeen.state !== "idle") return;
    const unseenIds = notifications
      .filter((notification) => notification.seenAt === null)
      .map((notification) => notification.id);
    if (unseenIds.length === 0) return;

    void markSeen.submit(
      { intent: "mark-seen", notificationIds: unseenIds.join(",") },
      { method: "post", action: NOTIFICATIONS_PATH }
    );
  }, [open, notifications, markSeen]);

  function toggle() {
    if (!open) void list.load(NOTIFICATIONS_PATH);
    setOpen(!open);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        aria-label={
          unseen > 0 ? `Notifications, ${unseen} new` : "Notifications"
        }
        aria-expanded={open}
      >
        <Bell className="size-5" />
        <UnseenBadge count={unseen} />
      </button>

      {open && (
        <div className="absolute left-0 top-10 z-50 w-96 rounded-lg border bg-popover text-popover-foreground shadow-2xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
          </div>
          <NotificationList
            notifications={notifications}
            onOpen={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function UnseenBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
      {count > 9 ? "9+" : count}
    </span>
  );
}

function NotificationList({
  notifications,
  onOpen,
}: {
  notifications: ListedNotification[] | undefined;
  onOpen: () => void;
}) {
  if (!notifications) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
    );
  }

  if (notifications.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        No Notifications yet.
      </p>
    );
  }

  return (
    <ul className="max-h-[26rem] overflow-y-auto">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          notification={notification}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

const ROLE_COLORS: Record<NotificationRole, string> = {
  [NotificationRole.Student]:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  [NotificationRole.Instructor]:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  [NotificationRole.PlatformAdmin]:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  [NotificationRole.TeamAdmin]:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

function NotificationItem({
  notification,
  onOpen,
}: {
  notification: ListedNotification;
  onOpen: () => void;
}) {
  const openFetcher = useFetcher();
  const isRead = notification.readAt !== null;

  // Opening marks it Read; the action then redirects to its link.
  function open() {
    void openFetcher.submit(
      { intent: "open", notificationId: notification.id },
      { method: "post", action: NOTIFICATIONS_PATH }
    );
    onOpen();
  }

  return (
    <li className="border-b last:border-0">
      <button
        type="button"
        onClick={open}
        className={cn(
          "flex w-full gap-2 px-3 py-2.5 text-left hover:bg-muted/60",
          !isRead && "bg-primary/5"
        )}
      >
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            isRead ? "bg-transparent" : "bg-primary"
          )}
          aria-label={isRead ? undefined : "Unread"}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                ROLE_COLORS[notification.role]
              )}
            >
              {notificationKindLabel(notification)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(notification.createdAt)}
            </span>
          </span>
          <span className="mt-1 block text-sm">
            <Sentence segments={notification.sentence} />
          </span>
          {notification.excerpt && (
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {notification.excerpt}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function Sentence({ segments }: { segments: SentenceSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.emphasis ? (
          <strong key={index}>{segment.text}</strong>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}
