import type { Route } from "./+types/api.notifications.unseen-count";
import { requireUserId } from "~/lib/access.server";
import { db } from "~/db";
import { countUnseenNotifications } from "~/lib/notifications.server";

// Polled by the bell every 30 seconds while the tab is visible, so it returns
// only the badge count.
export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await requireUserId(request);
  return { unseen: countUnseenNotifications(db, currentUserId) };
}
