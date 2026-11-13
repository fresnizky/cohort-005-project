import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { requireUserId } from "~/lib/access.server";
import { db } from "~/db";
import { parseFormData } from "~/lib/validation";
import {
  archiveNotification,
  listArchivedNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
  markNotificationsSeen,
  openNotification,
  unarchiveNotification,
} from "~/lib/notifications.server";

// The bell's list (loader) and every action taken from it (action). Each
// action is one `intent`; add new ones to `notificationActionSchema`.

// `?view=archived` lists the Archived Notifications instead of the main list.
// Anything else falls back to the main list.
const notificationViewSchema = z.enum(["list", "archived"]).catch("list");

/** Which list the bell's dropdown shows. */
export type NotificationView = z.infer<typeof notificationViewSchema>;

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await requireUserId(request);
  const view = notificationViewSchema.parse(
    new URL(request.url).searchParams.get("view")
  );
  return {
    notifications:
      view === "archived"
        ? listArchivedNotifications(db, currentUserId)
        : listNotifications(db, currentUserId),
  };
}

const notificationIdSchema = z.coerce.number().int().positive();

const notificationActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("mark-seen"),
    // The ids the bell listed, comma-separated.
    notificationIds: z
      .string()
      .transform((ids) => (ids === "" ? [] : ids.split(",")))
      .pipe(z.array(notificationIdSchema)),
  }),
  z.object({
    intent: z.literal("open"),
    notificationId: notificationIdSchema,
  }),
  z.object({
    intent: z.literal("mark-read"),
    notificationId: notificationIdSchema,
  }),
  z.object({
    intent: z.literal("mark-unread"),
    notificationId: notificationIdSchema,
  }),
  z.object({ intent: z.literal("mark-all-read") }),
  z.object({
    intent: z.literal("archive"),
    notificationId: notificationIdSchema,
  }),
  z.object({
    intent: z.literal("unarchive"),
    notificationId: notificationIdSchema,
  }),
]);

function requireFound(found: boolean) {
  if (!found) throw data("Notification not found", { status: 404 });
  return { ok: true };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await requireUserId(request);
  const parsed = parseFormData(
    await request.formData(),
    notificationActionSchema
  );

  if (!parsed.success) {
    throw data("Invalid notification action", { status: 400 });
  }

  const now = new Date();

  switch (parsed.data.intent) {
    case "mark-seen": {
      markNotificationsSeen(
        db,
        currentUserId,
        parsed.data.notificationIds,
        now
      );
      return { ok: true };
    }
    case "open": {
      const link = openNotification(
        db,
        currentUserId,
        parsed.data.notificationId,
        now
      );
      if (!link) throw data("Notification not found", { status: 404 });
      return redirect(link);
    }
    case "mark-read":
      return requireFound(
        markNotificationRead(db, currentUserId, parsed.data.notificationId, now)
      );
    case "mark-unread":
      return requireFound(
        markNotificationUnread(db, currentUserId, parsed.data.notificationId)
      );
    case "mark-all-read": {
      markAllNotificationsRead(db, currentUserId, now);
      return { ok: true };
    }
    case "archive":
      return requireFound(
        archiveNotification(db, currentUserId, parsed.data.notificationId, now)
      );
    case "unarchive":
      return requireFound(
        unarchiveNotification(db, currentUserId, parsed.data.notificationId)
      );
  }
}
