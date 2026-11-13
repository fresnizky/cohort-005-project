import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { marked, type Token } from "marked";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  comments,
  coupons,
  courses,
  enrollments,
  lessons,
  modules,
  notifications,
  notificationSettings,
  NotificationRole,
  purchases,
  refunds,
  teamMembers,
  TeamMemberRole,
  users,
  UserRole,
  type NotificationKindName,
  type SentenceSegment,
} from "~/db/schema";
import { commentAnchorId } from "~/lib/comments";
import {
  ALL_NOTIFICATION_KINDS,
  NotificationKinds,
  type NotificationKind,
} from "~/lib/notification-kinds";

// ─── Notifications ───
// Every Notification rule lives here. See GLOSSARY.md (Notification,
// Notification Kind, Seen, Read, Archive) and docs/adr/0013.
//
// - Event functions (`notify…`) take the facts of one event, work out the
//   recipients and write Notifications through `writeNotification`. They run
//   inside the caller's transaction when there is one.
// - Bell functions are always scoped to the person acting: nobody can read or
//   change another person's Notifications.
//
// Every function takes the database (or a transaction) first, so tests can
// hand in an in-memory one. Uses positional parameters (project convention).

type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

// ─── Sentences ───

function bold(text: string): SentenceSegment {
  return { text, emphasis: true };
}

function plain(text: string): SentenceSegment {
  return { text, emphasis: false };
}

// ─── Excerpts ───

const EXCERPT_LENGTH = 100;

function plainTextOf(tokens: Token[], separator: string): string {
  return tokens
    .map((token): string => {
      if (token.type === "list") {
        return plainTextOf(token.items, " ");
      }
      if ("tokens" in token && token.tokens) {
        // Block tokens hold inline tokens, which run together as one line.
        return plainTextOf(token.tokens, "");
      }
      if (
        token.type === "space" ||
        token.type === "hr" ||
        token.type === "br"
      ) {
        return " ";
      }
      // Raw HTML tags are markup, not words.
      if (token.type === "html") return "";
      return "text" in token && typeof token.text === "string"
        ? token.text
        : "";
    })
    .join(separator);
}

/**
 * The first ~100 characters of a comment's Markdown as plain text, cut at a
 * word boundary where there is one.
 */
function commentExcerpt(body: string): string {
  const text = plainTextOf(marked.lexer(body), " ").replace(/\s+/g, " ").trim();
  if (text.length <= EXCERPT_LENGTH) return text;

  let cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  if (text[EXCERPT_LENGTH] !== " " && lastSpace > 0) {
    cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}…`;
}

// ─── Writing ───

type NewNotification = {
  recipientUserId: number;
  kind: NotificationKind;
  sentence: SentenceSegment[];
  excerpt: string | null;
  link: string;
};

/**
 * The one place a Notification is written. Every event function goes through
 * here, so rules that apply to all kinds (such as a recipient's settings)
 * belong here too.
 */
function writeNotification(
  db: Queryable,
  notification: NewNotification,
  now: Date
) {
  if (
    !isNotificationKindEnabled(
      db,
      notification.recipientUserId,
      notification.kind
    )
  ) {
    return;
  }

  db.insert(notifications)
    .values({
      recipientUserId: notification.recipientUserId,
      role: notification.kind.role,
      kind: notification.kind.kind,
      sentence: notification.sentence,
      excerpt: notification.excerpt,
      link: notification.link,
      createdAt: now.toISOString(),
    })
    .run();
}

// ─── Events ───

// A Team Licence is the Purchase that granted Seats (see refunds.server.ts).
function isTeamLicence(db: Queryable, purchaseId: number): boolean {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
}

/**
 * A buyer raised a Refund Request: every Platform Admin except the buyer gets
 * Platform Admin · Refunds.
 */
export function notifyRefundRequestRaised(
  db: Queryable,
  refundRequestId: number,
  now: Date
) {
  const raised = db
    .select({
      purchaseId: purchases.id,
      buyerId: users.id,
      buyerName: users.name,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!raised) return;

  const platformAdmins = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, UserRole.Admin), ne(users.id, raised.buyerId)))
    .all();

  const sentence = [
    bold(raised.buyerName),
    plain(" requested a refund for "),
    bold(raised.courseTitle),
    ...(isTeamLicence(db, raised.purchaseId) ? [plain(" (Team Licence)")] : []),
  ];

  for (const admin of platformAdmins) {
    writeNotification(
      db,
      {
        recipientUserId: admin.id,
        kind: NotificationKinds.PlatformAdminRefunds,
        sentence,
        excerpt: null,
        link: "/admin/refunds",
      },
      now
    );
  }
}

/**
 * A Platform Admin approved or declined a Refund Request: the buyer is told
 * the outcome. Call it after the decision is stored.
 */
export function notifyRefundRequestDecided(
  db: Queryable,
  refundRequestId: number,
  deciderUserId: number,
  now: Date
) {
  const decided = db
    .select({
      status: refunds.status,
      purchaseId: purchases.id,
      buyerId: purchases.userId,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  // A buyer who decided their own Refund Request isn't told about it.
  if (!decided || decided.buyerId === deciderUserId) return;

  const outcome = `was ${decided.status}`;
  const notification = isTeamLicence(db, decided.purchaseId)
    ? {
        kind: NotificationKinds.TeamAdminRefunds,
        sentence: [
          plain("Your Refund Request for your "),
          bold(decided.courseTitle),
          plain(` Team Licence ${outcome}`),
        ],
        link: "/team",
      }
    : {
        kind: NotificationKinds.StudentRefunds,
        sentence: [
          plain("Your Refund Request for "),
          bold(decided.courseTitle),
          plain(` ${outcome}`),
        ],
        link: `/courses/${decided.courseSlug}`,
      };

  writeNotification(
    db,
    { recipientUserId: decided.buyerId, excerpt: null, ...notification },
    now
  );
}

/**
 * A Student got an Enrollment (Individual Purchase or Claimed Seat): the
 * course's Instructor gets Instructor · Enrollments, unless they are the one
 * enrolling.
 */
export function notifyEnrollmentCreated(
  db: Queryable,
  enrollmentId: number,
  now: Date
) {
  const enrolled = db
    .select({
      studentId: users.id,
      studentName: users.name,
      courseId: courses.id,
      courseTitle: courses.title,
      instructorId: courses.instructorId,
    })
    .from(enrollments)
    .innerJoin(users, eq(enrollments.userId, users.id))
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.id, enrollmentId))
    .get();

  if (!enrolled) return;
  if (enrolled.instructorId === enrolled.studentId) return;

  writeNotification(
    db,
    {
      recipientUserId: enrolled.instructorId,
      kind: NotificationKinds.InstructorEnrollments,
      sentence: [
        bold(enrolled.studentName),
        plain(" enrolled in "),
        bold(enrolled.courseTitle),
      ],
      excerpt: null,
      link: `/instructor/${enrolled.courseId}/students`,
    },
    now
  );
}

/**
 * A Student claimed a Seat on a Team Licence: the Team Admin(s) of the team
 * that owns it get Team Admin · Seats, except the one claiming.
 */
export function notifySeatClaimed(db: Queryable, seatId: number, now: Date) {
  const claimed = db
    .select({
      teamId: coupons.teamId,
      claimerId: users.id,
      claimerName: users.name,
      courseTitle: courses.title,
    })
    .from(coupons)
    .innerJoin(users, eq(coupons.redeemedByUserId, users.id))
    .innerJoin(courses, eq(coupons.courseId, courses.id))
    .where(eq(coupons.id, seatId))
    .get();

  if (!claimed) return;

  const teamAdmins = db
    .select({ id: teamMembers.userId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, claimed.teamId),
        eq(teamMembers.role, TeamMemberRole.Admin),
        ne(teamMembers.userId, claimed.claimerId)
      )
    )
    .all();

  const sentence = [
    bold(claimed.claimerName),
    plain(" claimed a Seat on your "),
    bold(claimed.courseTitle),
    plain(" Team Licence"),
  ];

  for (const teamAdmin of teamAdmins) {
    writeNotification(
      db,
      {
        recipientUserId: teamAdmin.id,
        kind: NotificationKinds.TeamAdminSeats,
        sentence,
        excerpt: null,
        link: "/team",
      },
      now
    );
  }
}

/**
 * Someone posted a comment. A top-level comment from anyone but the course's
 * Instructor or a Platform Admin gets the Instructor · Comments.
 */
export function notifyCommentPosted(
  db: Queryable,
  commentId: number,
  now: Date
) {
  const posted = db
    .select({
      body: comments.body,
      parentId: comments.parentId,
      authorId: users.id,
      authorName: users.name,
      authorRole: users.role,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .innerJoin(lessons, eq(comments.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(comments.id, commentId))
    .get();

  if (!posted) return;

  const lessonPath = `/courses/${posted.courseSlug}/lessons/${posted.lessonId}`;
  const byStaff =
    posted.authorId === posted.instructorId ||
    posted.authorRole === UserRole.Admin;

  if (posted.parentId !== null) {
    if (!byStaff) return;
    const question = db
      .select({ authorId: comments.userId })
      .from(comments)
      .where(eq(comments.id, posted.parentId))
      .get();
    if (!question || question.authorId === posted.authorId) return;
    // A Lapsed author can't see the comments, so isn't sent to them.
    const enrolled = db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, question.authorId),
          eq(enrollments.courseId, posted.courseId)
        )
      )
      .get();
    if (!enrolled) return;

    writeNotification(
      db,
      {
        recipientUserId: question.authorId,
        kind: NotificationKinds.StudentComments,
        sentence: [
          bold(posted.authorName),
          plain(" replied to your comment on "),
          bold(posted.lessonTitle),
          plain(` (${posted.courseTitle})`),
        ],
        excerpt: commentExcerpt(posted.body),
        link: `${lessonPath}#${commentAnchorId(posted.parentId)}`,
      },
      now
    );
    return;
  }

  if (byStaff) return;

  writeNotification(
    db,
    {
      recipientUserId: posted.instructorId,
      kind: NotificationKinds.InstructorComments,
      sentence: [
        bold(posted.authorName),
        plain(" commented on "),
        bold(posted.lessonTitle),
        plain(` (${posted.courseTitle})`),
      ],
      excerpt: commentExcerpt(posted.body),
      link: `${lessonPath}#${commentAnchorId(commentId)}`,
    },
    now
  );
}

// ─── The bell ───

export function countUnseenNotifications(
  db: Queryable,
  userId: number
): number {
  const row = db
    .select({ unseen: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.seenAt),
        isNull(notifications.archivedAt)
      )
    )
    .get();
  return row?.unseen ?? 0;
}

export function listNotifications(db: Queryable, userId: number) {
  return db
    .select({
      id: notifications.id,
      role: notifications.role,
      kind: notifications.kind,
      sentence: notifications.sentence,
      excerpt: notifications.excerpt,
      link: notifications.link,
      createdAt: notifications.createdAt,
      seenAt: notifications.seenAt,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.archivedAt)
      )
    )
    .orderBy(
      // Unread first, then newest first within each group.
      sql`${notifications.readAt} is not null`,
      desc(notifications.createdAt),
      desc(notifications.id)
    )
    .all();
}

export type ListedNotification = ReturnType<typeof listNotifications>[number];

function ownedBy(userId: number, notificationId: number) {
  return and(
    eq(notifications.recipientUserId, userId),
    eq(notifications.id, notificationId)
  );
}

/**
 * Marks the Notifications the bell just listed as Seen. Takes the ids that
 * were listed, so one that arrived since stays unseen. Ids that aren't the
 * person's own are ignored.
 */
export function markNotificationsSeen(
  db: Queryable,
  userId: number,
  notificationIds: number[],
  now: Date
) {
  if (notificationIds.length === 0) return;

  db.update(notifications)
    .set({ seenAt: now.toISOString() })
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        inArray(notifications.id, notificationIds),
        isNull(notifications.seenAt)
      )
    )
    .run();
}

/** Marks one of the person's Notifications Read. False if it isn't theirs. */
export function markNotificationRead(
  db: Queryable,
  userId: number,
  notificationId: number,
  now: Date
): boolean {
  const notification = db
    .select({ readAt: notifications.readAt })
    .from(notifications)
    .where(ownedBy(userId, notificationId))
    .get();

  if (!notification) return false;
  if (notification.readAt !== null) return true;

  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(ownedBy(userId, notificationId))
    .run();
  return true;
}

/** Marks one of the person's Notifications unread. False if it isn't theirs. */
export function markNotificationUnread(
  db: Queryable,
  userId: number,
  notificationId: number
): boolean {
  const updated = db
    .update(notifications)
    .set({ readAt: null })
    .where(ownedBy(userId, notificationId))
    .returning({ id: notifications.id })
    .all();
  return updated.length > 0;
}

/** Marks every one of the person's non-Archived Notifications Read. */
export function markAllNotificationsRead(
  db: Queryable,
  userId: number,
  now: Date
) {
  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt)
      )
    )
    .run();
}

/**
 * Archives one of the person's Notifications: it leaves the list and is
 * marked Read. Never deletes it. False if it isn't theirs.
 */
export function archiveNotification(
  db: Queryable,
  userId: number,
  notificationId: number,
  now: Date
): boolean {
  const updated = db
    .update(notifications)
    .set({
      archivedAt: now.toISOString(),
      readAt: sql`coalesce(${notifications.readAt}, ${now.toISOString()})`,
    })
    .where(ownedBy(userId, notificationId))
    .returning({ id: notifications.id })
    .all();
  return updated.length > 0;
}

/**
 * Moves one of the person's Archived Notifications back into the list. It
 * stays Read. False if it isn't theirs.
 */
export function unarchiveNotification(
  db: Queryable,
  userId: number,
  notificationId: number
): boolean {
  const updated = db
    .update(notifications)
    .set({ archivedAt: null })
    .where(ownedBy(userId, notificationId))
    .returning({ id: notifications.id })
    .all();
  return updated.length > 0;
}

/** The person's Archived Notifications, newest first. */
export function listArchivedNotifications(db: Queryable, userId: number) {
  return db
    .select({
      id: notifications.id,
      role: notifications.role,
      kind: notifications.kind,
      sentence: notifications.sentence,
      excerpt: notifications.excerpt,
      link: notifications.link,
      createdAt: notifications.createdAt,
      seenAt: notifications.seenAt,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNotNull(notifications.archivedAt)
      )
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .all();
}

/**
 * The person clicked a Notification: marks it Read and returns where it
 * leads. Null if it isn't theirs.
 */
export function openNotification(
  db: Queryable,
  userId: number,
  notificationId: number,
  now: Date
): string | null {
  const notification = db
    .select({ link: notifications.link })
    .from(notifications)
    .where(ownedBy(userId, notificationId))
    .get();

  if (!notification) return null;

  markNotificationRead(db, userId, notificationId, now);
  return notification.link;
}

// ─── Settings ───
// Only explicit choices are stored; a missing setting means on.

const ROLE_FROM_USER_ROLE: Record<UserRole, NotificationRole> = {
  [UserRole.Student]: NotificationRole.Student,
  [UserRole.Instructor]: NotificationRole.Instructor,
  [UserRole.Admin]: NotificationRole.PlatformAdmin,
};

/**
 * The roles a person currently holds: one from their user role, plus Team
 * Admin if they are an admin on any team.
 */
function rolesHeld(db: Queryable, userId: number): NotificationRole[] {
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return [];

  const roles = [ROLE_FROM_USER_ROLE[user.role]];

  const teamAdmin = db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();
  if (teamAdmin) roles.push(NotificationRole.TeamAdmin);

  return roles;
}

export type NotificationRoleSettings = {
  role: NotificationRole;
  enabled: boolean;
  kinds: { kind: NotificationKindName; enabled: boolean }[];
};

/**
 * Each role the person currently holds with its toggle, and that role's
 * Notification Kinds with their own toggles.
 */
export function getNotificationSettings(
  db: Queryable,
  userId: number
): NotificationRoleSettings[] {
  return rolesHeld(db, userId).map((role) => ({
    role,
    enabled: storedSetting(db, userId, role, null) !== false,
    kinds: ALL_NOTIFICATION_KINDS.filter((kind) => kind.role === role).map(
      (kind) => ({
        kind: kind.kind,
        enabled: storedSetting(db, userId, role, kind.kind) !== false,
      })
    ),
  }));
}

/** The stored choice for a role toggle (kind null) or a kind toggle. */
function storedSetting(
  db: Queryable,
  userId: number,
  role: NotificationRole,
  kind: NotificationKindName | null
): boolean | undefined {
  return db
    .select({ enabled: notificationSettings.enabled })
    .from(notificationSettings)
    .where(
      and(
        eq(notificationSettings.userId, userId),
        eq(notificationSettings.role, role),
        kind === null
          ? isNull(notificationSettings.kind)
          : eq(notificationSettings.kind, kind)
      )
    )
    .get()?.enabled;
}

function storeSetting(
  db: Queryable,
  userId: number,
  role: NotificationRole,
  kind: NotificationKindName | null,
  enabled: boolean
) {
  // Done by hand rather than with an upsert: SQLite treats null kinds as
  // distinct, so the unique index can't catch a second role toggle row.
  if (storedSetting(db, userId, role, kind) === undefined) {
    db.insert(notificationSettings)
      .values({ userId, role, kind, enabled })
      .run();
    return;
  }

  db.update(notificationSettings)
    .set({ enabled })
    .where(
      and(
        eq(notificationSettings.userId, userId),
        eq(notificationSettings.role, role),
        kind === null
          ? isNull(notificationSettings.kind)
          : eq(notificationSettings.kind, kind)
      )
    )
    .run();
}

/**
 * Turns a role's toggle on or off. Each kind under it keeps its own setting,
 * which applies again once the role is back on.
 */
export function setNotificationRoleEnabled(
  db: Queryable,
  userId: number,
  role: NotificationRole,
  enabled: boolean
) {
  storeSetting(db, userId, role, null, enabled);
}

/** Turns one Notification Kind on or off. Only affects later Notifications. */
export function setNotificationKindEnabled(
  db: Queryable,
  userId: number,
  kind: NotificationKind,
  enabled: boolean
) {
  storeSetting(db, userId, kind.role, kind.kind, enabled);
}

/**
 * A kind is on only if both its role toggle and its own toggle are on, where
 * a missing setting counts as on.
 */
export function isNotificationKindEnabled(
  db: Queryable,
  userId: number,
  kind: NotificationKind
): boolean {
  return (
    storedSetting(db, userId, kind.role, kind.kind) !== false &&
    storedSetting(db, userId, kind.role, null) !== false
  );
}
