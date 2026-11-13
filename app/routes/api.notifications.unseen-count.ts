import { data } from "react-router";
import type { Route } from "./+types/api.notifications.unseen-count";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { countUnseenNotifications } from "~/lib/notifications.server";

// Polled by the bell every 30 seconds while the tab is visible, so it returns
// only the badge count.
export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel", { status: 401 });
  }

  return { unseen: countUnseenNotifications(db, currentUserId) };
}
