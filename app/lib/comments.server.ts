import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments } from "~/db/schema";
import { notifyCommentPosted } from "~/lib/notifications.server";

type Db = BetterSQLite3Database<typeof schema>;

type NewComment = {
  userId: number;
  lessonId: number;
  parentId: number | null;
  body: string;
};

/**
 * Stores an already-validated comment and writes its Notifications in the
 * same transaction, so a comment never exists without them.
 */
export function insertComment(db: Db, comment: NewComment, now: Date) {
  return db.transaction((tx) => {
    const inserted = tx.insert(comments).values(comment).returning().get();
    notifyCommentPosted(tx, inserted.id, now);
    return inserted;
  });
}
