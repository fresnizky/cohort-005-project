import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  NotificationKindName,
  NotificationRole,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import {
  archiveNotification,
  countUnseenNotifications,
  listArchivedNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
  markNotificationsSeen,
  notifyCommentPosted,
  notifyRefundRequestDecided,
  notifyRefundRequestRaised,
  openNotification,
  unarchiveNotification,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function addPerson(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function buyForSelf(userId: number) {
  return db
    .insert(schema.purchases)
    .values({ userId, courseId: base.course.id, amountPaid: 7900 })
    .returning()
    .get();
}

function buySeats(userId: number, seats: number) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = buyForSelf(userId);
  for (let i = 0; i < seats; i++) {
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .run();
  }
  return purchase;
}

function minutesAfterNow(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

function raiseOn(purchaseId: number, at = NOW) {
  const refundRequest = db
    .insert(schema.refunds)
    .values({
      purchaseId,
      reason: "Not for me.",
      requestedAt: at.toISOString(),
    })
    .returning()
    .get();
  notifyRefundRequestRaised(db, refundRequest.id, at);
  return refundRequest;
}

describe("a Refund Request is raised", () => {
  it("notifies every Platform Admin with Platform Admin · Refunds", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);

    raiseOn(buyForSelf(base.user.id).id);

    for (const admin of [pat, sam]) {
      expect(listNotifications(db, admin.id)).toEqual([
        expect.objectContaining({
          role: NotificationRole.PlatformAdmin,
          kind: NotificationKindName.Refunds,
          sentence: [
            { text: "Test User", emphasis: true },
            { text: " requested a refund for ", emphasis: false },
            { text: "Test Course", emphasis: true },
          ],
          excerpt: null,
          link: "/admin/refunds",
          createdAt: NOW.toISOString(),
          readAt: null,
        }),
      ]);
      expect(countUnseenNotifications(db, admin.id)).toBe(1);
    }
  });

  it("notifies nobody who isn't a Platform Admin", () => {
    addPerson("Pat", UserRole.Admin);

    raiseOn(buyForSelf(base.user.id).id);

    expect(listNotifications(db, base.user.id)).toEqual([]);
    expect(listNotifications(db, base.instructor.id)).toEqual([]);
  });

  it("doesn't notify a Platform Admin about their own Refund Request", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);

    raiseOn(buyForSelf(pat.id).id);

    expect(listNotifications(db, pat.id)).toEqual([]);
    expect(listNotifications(db, sam.id)).toHaveLength(1);
  });

  it("adds (Team Licence) when the Refund Request is for a Team Licence", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const priya = addPerson("Priya", UserRole.Student);

    raiseOn(buySeats(priya.id, 3).id);

    expect(listNotifications(db, pat.id)[0].sentence).toEqual([
      { text: "Priya", emphasis: true },
      { text: " requested a refund for ", emphasis: false },
      { text: "Test Course", emphasis: true },
      { text: " (Team Licence)", emphasis: false },
    ]);
  });

  it("keeps the sentence it was written with after the course is renamed", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    raiseOn(buyForSelf(base.user.id).id);

    db.update(schema.courses).set({ title: "Renamed Course" }).run();

    expect(listNotifications(db, pat.id)[0].sentence).toContainEqual({
      text: "Test Course",
      emphasis: true,
    });
  });
});

function decide(
  refundRequestId: number,
  status: RefundStatus.Approved | RefundStatus.Declined,
  platformAdminId: number
) {
  db.update(schema.refunds)
    .set({
      status,
      resolvedAt: NOW.toISOString(),
      resolvedByUserId: platformAdminId,
    })
    .where(eq(schema.refunds.id, refundRequestId))
    .run();
  notifyRefundRequestDecided(db, refundRequestId, platformAdminId, NOW);
}

describe("a Refund Request is decided", () => {
  it("tells the buyer of an Individual Purchase it was approved, as Student · Refunds", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = raiseOn(buyForSelf(base.user.id).id);

    decide(refundRequest.id, RefundStatus.Approved, pat.id);

    expect(listNotifications(db, base.user.id)).toEqual([
      expect.objectContaining({
        role: NotificationRole.Student,
        kind: NotificationKindName.Refunds,
        sentence: [
          { text: "Your Refund Request for ", emphasis: false },
          { text: "Test Course", emphasis: true },
          { text: " was approved", emphasis: false },
        ],
        excerpt: null,
        link: "/courses/test-course",
        createdAt: NOW.toISOString(),
        readAt: null,
      }),
    ]);
    expect(countUnseenNotifications(db, base.user.id)).toBe(1);
  });

  it("tells the buyer of an Individual Purchase it was declined", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = raiseOn(buyForSelf(base.user.id).id);

    decide(refundRequest.id, RefundStatus.Declined, pat.id);

    expect(listNotifications(db, base.user.id)).toEqual([
      expect.objectContaining({
        role: NotificationRole.Student,
        kind: NotificationKindName.Refunds,
        sentence: [
          { text: "Your Refund Request for ", emphasis: false },
          { text: "Test Course", emphasis: true },
          { text: " was declined", emphasis: false },
        ],
        link: "/courses/test-course",
      }),
    ]);
  });

  it("tells the buyer of a Team Licence the outcome as Team Admin · Refunds, linking to the team page", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const priya = addPerson("Priya", UserRole.Student);
    const approved = raiseOn(buySeats(priya.id, 3).id);
    const declined = raiseOn(buySeats(priya.id, 2).id);

    decide(approved.id, RefundStatus.Approved, pat.id);
    decide(declined.id, RefundStatus.Declined, pat.id);

    expect(listNotifications(db, priya.id)).toEqual([
      expect.objectContaining({
        role: NotificationRole.TeamAdmin,
        kind: NotificationKindName.Refunds,
        sentence: [
          { text: "Your Refund Request for your ", emphasis: false },
          { text: "Test Course", emphasis: true },
          { text: " Team Licence was declined", emphasis: false },
        ],
        excerpt: null,
        link: "/team",
      }),
      expect.objectContaining({
        role: NotificationRole.TeamAdmin,
        kind: NotificationKindName.Refunds,
        sentence: [
          { text: "Your Refund Request for your ", emphasis: false },
          { text: "Test Course", emphasis: true },
          { text: " Team Licence was approved", emphasis: false },
        ],
        link: "/team",
      }),
    ]);
  });

  it("doesn't tell a Platform Admin about deciding their own Refund Request", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = raiseOn(buyForSelf(pat.id).id);

    decide(refundRequest.id, RefundStatus.Approved, pat.id);

    expect(listNotifications(db, pat.id)).toEqual([]);
  });

  it("leaves the Platform Admins' Refunds Notifications as they were", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    const refundRequest = raiseOn(buyForSelf(base.user.id).id);
    const before = [
      listNotifications(db, pat.id),
      listNotifications(db, sam.id),
    ];

    decide(refundRequest.id, RefundStatus.Declined, pat.id);

    expect([
      listNotifications(db, pat.id),
      listNotifications(db, sam.id),
    ]).toEqual(before);
    expect(countUnseenNotifications(db, sam.id)).toBe(1);
  });
});

describe("the bell", () => {
  let pat: typeof schema.users.$inferSelect;

  beforeEach(() => {
    pat = addPerson("Pat", UserRole.Admin);
  });

  function buyerNameOf(notification: { sentence: schema.SentenceSegment[] }) {
    return notification.sentence[0].text;
  }

  it("counts Notifications that haven't been Seen", () => {
    raiseOn(buyForSelf(addPerson("Ana", UserRole.Student).id).id);
    raiseOn(buyForSelf(addPerson("Ben", UserRole.Student).id).id);

    expect(countUnseenNotifications(db, pat.id)).toBe(2);
  });

  it("marking the listed Notifications Seen clears the count but leaves them unread", () => {
    raiseOn(buyForSelf(addPerson("Ana", UserRole.Student).id).id);
    raiseOn(buyForSelf(addPerson("Ben", UserRole.Student).id).id);
    const listed = listNotifications(db, pat.id);

    markNotificationsSeen(
      db,
      pat.id,
      listed.map((n) => n.id),
      NOW
    );

    expect(countUnseenNotifications(db, pat.id)).toBe(0);
    expect(listNotifications(db, pat.id).map((n) => n.readAt)).toEqual([
      null,
      null,
    ]);
  });

  it("leaves a Notification that arrived after the list was shown unseen", () => {
    raiseOn(buyForSelf(addPerson("Ana", UserRole.Student).id).id);
    const listed = listNotifications(db, pat.id);
    raiseOn(
      buyForSelf(addPerson("Ben", UserRole.Student).id).id,
      minutesAfterNow(1)
    );

    markNotificationsSeen(
      db,
      pat.id,
      listed.map((n) => n.id),
      NOW
    );

    expect(countUnseenNotifications(db, pat.id)).toBe(1);
  });

  it("lists unread Notifications above Read ones, newest first in each group", () => {
    raiseOn(
      buyForSelf(addPerson("Ana", UserRole.Student).id).id,
      minutesAfterNow(1)
    );
    raiseOn(
      buyForSelf(addPerson("Ben", UserRole.Student).id).id,
      minutesAfterNow(2)
    );
    raiseOn(
      buyForSelf(addPerson("Cy", UserRole.Student).id).id,
      minutesAfterNow(3)
    );
    raiseOn(
      buyForSelf(addPerson("Di", UserRole.Student).id).id,
      minutesAfterNow(4)
    );
    const byBuyer = new Map(
      listNotifications(db, pat.id).map((n) => [buyerNameOf(n), n.id])
    );

    markNotificationRead(db, pat.id, byBuyer.get("Di") ?? 0, NOW);
    markNotificationRead(db, pat.id, byBuyer.get("Cy") ?? 0, NOW);

    expect(listNotifications(db, pat.id).map(buyerNameOf)).toEqual([
      "Ben",
      "Ana",
      "Di",
      "Cy",
    ]);
  });

  it("marks a Notification Read", () => {
    raiseOn(buyForSelf(base.user.id).id);
    const [notification] = listNotifications(db, pat.id);

    expect(markNotificationRead(db, pat.id, notification.id, NOW)).toBe(true);

    expect(listNotifications(db, pat.id)[0].readAt).toBe(NOW.toISOString());
  });

  it("opening a Notification marks it Read and gives its link", () => {
    raiseOn(buyForSelf(base.user.id).id);
    const [notification] = listNotifications(db, pat.id);

    expect(openNotification(db, pat.id, notification.id, NOW)).toBe(
      "/admin/refunds"
    );
    expect(listNotifications(db, pat.id)[0].readAt).toBe(NOW.toISOString());
  });

  it("doesn't let anyone open another person's Notification", () => {
    const sam = addPerson("Sam", UserRole.Admin);
    raiseOn(buyForSelf(base.user.id).id);
    const [patsNotification] = listNotifications(db, pat.id);

    expect(openNotification(db, sam.id, patsNotification.id, NOW)).toBeNull();
    expect(listNotifications(db, pat.id)[0].readAt).toBeNull();
  });

  it("doesn't let anyone see or change another person's Notifications", () => {
    const sam = addPerson("Sam", UserRole.Admin);
    raiseOn(buyForSelf(base.user.id).id);
    const [patsNotification] = listNotifications(db, pat.id);
    const samsIds = listNotifications(db, sam.id).map((n) => n.id);

    expect(samsIds).not.toContain(patsNotification.id);
    expect(markNotificationRead(db, sam.id, patsNotification.id, NOW)).toBe(
      false
    );
    markNotificationsSeen(db, sam.id, [patsNotification.id], NOW);

    expect(listNotifications(db, pat.id)[0]).toMatchObject({
      seenAt: null,
      readAt: null,
    });
    expect(countUnseenNotifications(db, pat.id)).toBe(1);
  });
});

describe("managing Notifications", () => {
  let pat: typeof schema.users.$inferSelect;

  beforeEach(() => {
    pat = addPerson("Pat", UserRole.Admin);
  });

  function buyerNamesIn(list: { sentence: schema.SentenceSegment[] }[]) {
    return list.map((notification) => notification.sentence[0].text);
  }

  function raiseFrom(name: string, at = NOW) {
    raiseOn(buyForSelf(addPerson(name, UserRole.Student).id).id, at);
  }

  function idOf(buyerName: string, userId = pat.id) {
    const notification = listNotifications(db, userId).find(
      (n) => n.sentence[0].text === buyerName
    );
    if (!notification) throw new Error(`No Notification about ${buyerName}`);
    return notification.id;
  }

  it("marking a Read Notification unread puts it back with the unread group", () => {
    raiseFrom("Ana", minutesAfterNow(1));
    raiseFrom("Ben", minutesAfterNow(2));
    markNotificationRead(db, pat.id, idOf("Ben"), NOW);
    markNotificationRead(db, pat.id, idOf("Ana"), NOW);

    expect(markNotificationUnread(db, pat.id, idOf("Ana"))).toBe(true);

    const listed = listNotifications(db, pat.id);
    expect(buyerNamesIn(listed)).toEqual(["Ana", "Ben"]);
    expect(listed.map((n) => n.readAt)).toEqual([null, NOW.toISOString()]);
  });

  it("doesn't let anyone mark another person's Notification unread", () => {
    const sam = addPerson("Sam", UserRole.Admin);
    raiseFrom("Ana");
    markNotificationRead(db, pat.id, idOf("Ana"), NOW);

    expect(markNotificationUnread(db, sam.id, idOf("Ana"))).toBe(false);

    expect(listNotifications(db, pat.id)[0].readAt).toBe(NOW.toISOString());
  });

  it("marks all of the person's Notifications Read, and nobody else's", () => {
    const sam = addPerson("Sam", UserRole.Admin);
    raiseFrom("Ana", minutesAfterNow(1));
    raiseFrom("Ben", minutesAfterNow(2));

    markAllNotificationsRead(db, pat.id, NOW);

    expect(listNotifications(db, pat.id).map((n) => n.readAt)).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
    ]);
    expect(listNotifications(db, sam.id).map((n) => n.readAt)).toEqual([
      null,
      null,
    ]);
  });

  it("archiving removes a Notification from the list, marks it Read and lists it under Archived", () => {
    raiseFrom("Ana", minutesAfterNow(1));
    raiseFrom("Ben", minutesAfterNow(2));
    const ana = idOf("Ana");

    expect(archiveNotification(db, pat.id, ana, NOW)).toBe(true);

    expect(buyerNamesIn(listNotifications(db, pat.id))).toEqual(["Ben"]);
    const archived = listArchivedNotifications(db, pat.id);
    expect(buyerNamesIn(archived)).toEqual(["Ana"]);
    expect(archived[0]).toMatchObject({
      id: ana,
      readAt: NOW.toISOString(),
      link: "/admin/refunds",
    });
  });

  it("archived Notifications don't count as unseen", () => {
    raiseFrom("Ana");

    archiveNotification(db, pat.id, idOf("Ana"), NOW);

    expect(countUnseenNotifications(db, pat.id)).toBe(0);
  });

  it("lists Archived Notifications newest first", () => {
    raiseFrom("Ana", minutesAfterNow(1));
    raiseFrom("Ben", minutesAfterNow(2));
    const ana = idOf("Ana");
    const ben = idOf("Ben");

    archiveNotification(db, pat.id, ana, minutesAfterNow(4));
    archiveNotification(db, pat.id, ben, minutesAfterNow(3));

    expect(buyerNamesIn(listArchivedNotifications(db, pat.id))).toEqual([
      "Ben",
      "Ana",
    ]);
  });

  it("mark all as Read leaves Archived Notifications alone", () => {
    raiseFrom("Ana");
    const ana = idOf("Ana");
    archiveNotification(db, pat.id, ana, NOW);
    markNotificationUnread(db, pat.id, ana);

    markAllNotificationsRead(db, pat.id, minutesAfterNow(5));

    expect(listArchivedNotifications(db, pat.id)[0].readAt).toBeNull();
  });

  it("unarchiving returns a Notification to the list and it stays Read", () => {
    raiseFrom("Ana");
    const ana = idOf("Ana");
    archiveNotification(db, pat.id, ana, NOW);

    expect(unarchiveNotification(db, pat.id, ana)).toBe(true);

    expect(listArchivedNotifications(db, pat.id)).toEqual([]);
    expect(listNotifications(db, pat.id)).toEqual([
      expect.objectContaining({ id: ana, readAt: NOW.toISOString() }),
    ]);
  });

  it("doesn't let anyone archive, unarchive or list another person's Notifications", () => {
    const sam = addPerson("Sam", UserRole.Admin);
    raiseFrom("Ana");
    raiseFrom("Ben");
    const ana = idOf("Ana");
    const ben = idOf("Ben");
    archiveNotification(db, pat.id, ben, NOW);

    expect(archiveNotification(db, sam.id, ana, NOW)).toBe(false);
    expect(unarchiveNotification(db, sam.id, ben)).toBe(false);

    expect(listArchivedNotifications(db, sam.id)).toEqual([]);
    expect(buyerNamesIn(listNotifications(db, pat.id))).toEqual(["Ana"]);
    expect(buyerNamesIn(listArchivedNotifications(db, pat.id))).toEqual([
      "Ben",
    ]);
  });
});

describe("a comment is posted", () => {
  let lesson: typeof schema.lessons.$inferSelect;

  beforeEach(() => {
    const courseModule = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Basics", position: 1 })
      .returning()
      .get();
    lesson = db
      .insert(schema.lessons)
      .values({ moduleId: courseModule.id, title: "Hooks", position: 1 })
      .returning()
      .get();
  });

  function enroll(userId: number) {
    return db
      .insert(schema.enrollments)
      .values({ userId, courseId: base.course.id })
      .returning()
      .get();
  }

  function postComment(
    userId: number,
    body: string,
    parentId: number | null = null,
    at = NOW
  ) {
    const comment = db
      .insert(schema.comments)
      .values({ userId, lessonId: lesson.id, parentId, body })
      .returning()
      .get();
    notifyCommentPosted(db, comment.id, at);
    return comment;
  }

  function markAllListedSeen(userId: number) {
    markNotificationsSeen(
      db,
      userId,
      listNotifications(db, userId).map((n) => n.id),
      NOW
    );
  }

  describe("top-level", () => {
    it("by a Student notifies the course's Instructor with Instructor · Comments", () => {
      enroll(base.user.id);

      const comment = postComment(base.user.id, "How does useEffect work?");

      expect(listNotifications(db, base.instructor.id)).toEqual([
        expect.objectContaining({
          role: NotificationRole.Instructor,
          kind: NotificationKindName.Comments,
          sentence: [
            { text: "Test User", emphasis: true },
            { text: " commented on ", emphasis: false },
            { text: "Hooks", emphasis: true },
            { text: " (Test Course)", emphasis: false },
          ],
          excerpt: "How does useEffect work?",
          link: `/courses/test-course/lessons/${lesson.id}#comment-${comment.id}`,
          createdAt: NOW.toISOString(),
        }),
      ]);
      expect(listNotifications(db, base.user.id)).toEqual([]);
    });

    it("by the course's Instructor notifies nobody", () => {
      const pat = addPerson("Pat", UserRole.Admin);

      postComment(base.instructor.id, "Welcome to the lesson!");

      expect(listNotifications(db, base.instructor.id)).toEqual([]);
      expect(listNotifications(db, pat.id)).toEqual([]);
    });

    it("by a Platform Admin notifies nobody", () => {
      const pat = addPerson("Pat", UserRole.Admin);

      postComment(pat.id, "Heads up: the video was re-recorded.");

      expect(listNotifications(db, base.instructor.id)).toEqual([]);
      expect(listNotifications(db, pat.id)).toEqual([]);
    });
  });

  describe("excerpt", () => {
    it("is the comment as plain text", () => {
      enroll(base.user.id);

      postComment(
        base.user.id,
        "## Help\n\nWhy does **`useEffect`** run *twice*? See [the docs](https://react.dev).\n\n- one\n- two"
      );

      expect(listNotifications(db, base.instructor.id)[0].excerpt).toBe(
        "Help Why does useEffect run twice? See the docs. one two"
      );
    });

    it("leaves out raw HTML tags", () => {
      enroll(base.user.id);

      postComment(base.user.id, "Is <b>this</b> & `a<b` right?");

      expect(listNotifications(db, base.instructor.id)[0].excerpt).toBe(
        "Is this & a<b right?"
      );
    });

    it("is cut to about 100 characters", () => {
      enroll(base.user.id);
      const body = "word ".repeat(60).trim();

      postComment(base.user.id, body);

      const excerpt = listNotifications(db, base.instructor.id)[0].excerpt;
      expect(excerpt).toBe(`${"word ".repeat(20).trim()}…`);
    });

    it("doesn't change when the comment is edited or deleted", () => {
      enroll(base.user.id);
      const comment = postComment(base.user.id, "Original question");

      db.update(schema.comments)
        .set({ body: "Edited question", editedAt: NOW.toISOString() })
        .where(eq(schema.comments.id, comment.id))
        .run();
      expect(listNotifications(db, base.instructor.id)[0].excerpt).toBe(
        "Original question"
      );

      db.update(schema.comments)
        .set({ deletedAt: NOW.toISOString() })
        .where(eq(schema.comments.id, comment.id))
        .run();
      expect(listNotifications(db, base.instructor.id)[0].excerpt).toBe(
        "Original question"
      );
    });
  });

  describe("reply", () => {
    it("never notifies the Instructor", () => {
      enroll(base.user.id);
      const ana = addPerson("Ana", UserRole.Student);
      enroll(ana.id);
      const question = postComment(base.user.id, "A question");
      markAllListedSeen(base.instructor.id);

      postComment(ana.id, "Same question here", question.id);

      expect(countUnseenNotifications(db, base.instructor.id)).toBe(0);
    });

    it("by the course's Instructor notifies the question's author with Student · Comments", () => {
      enroll(base.user.id);
      const question = postComment(base.user.id, "A question");

      postComment(base.instructor.id, "Here is the answer.", question.id);

      expect(listNotifications(db, base.user.id)).toEqual([
        expect.objectContaining({
          role: NotificationRole.Student,
          kind: NotificationKindName.Comments,
          sentence: [
            { text: "Test Instructor", emphasis: true },
            { text: " replied to your comment on ", emphasis: false },
            { text: "Hooks", emphasis: true },
            { text: " (Test Course)", emphasis: false },
          ],
          excerpt: "Here is the answer.",
          link: `/courses/test-course/lessons/${lesson.id}#comment-${question.id}`,
          createdAt: NOW.toISOString(),
        }),
      ]);
    });

    it("by a Platform Admin notifies the question's author", () => {
      const pat = addPerson("Pat", UserRole.Admin);
      enroll(base.user.id);
      const question = postComment(base.user.id, "A question");

      postComment(pat.id, "Answered by the platform team.", question.id);

      expect(listNotifications(db, base.user.id)).toEqual([
        expect.objectContaining({
          kind: NotificationKindName.Comments,
          sentence: expect.arrayContaining([{ text: "Pat", emphasis: true }]),
        }),
      ]);
    });

    it("by another Student notifies nobody", () => {
      enroll(base.user.id);
      const ana = addPerson("Ana", UserRole.Student);
      enroll(ana.id);
      const question = postComment(base.user.id, "A question");

      postComment(ana.id, "I think it's this.", question.id);

      expect(listNotifications(db, base.user.id)).toEqual([]);
      expect(listNotifications(db, ana.id)).toEqual([]);
    });

    it("by staff to their own comment notifies nobody", () => {
      const pat = addPerson("Pat", UserRole.Admin);
      enroll(base.instructor.id);
      enroll(pat.id);
      const instructorsNote = postComment(base.instructor.id, "A note");
      const patsNote = postComment(pat.id, "Another note");

      postComment(base.instructor.id, "A follow-up", instructorsNote.id);
      postComment(pat.id, "A follow-up", patsNote.id);

      expect(listNotifications(db, base.instructor.id)).toEqual([]);
      expect(listNotifications(db, pat.id)).toEqual([]);
    });

    it("skips a Lapsed author, who keeps what they received before", () => {
      const enrollment = enroll(base.user.id);
      const question = postComment(base.user.id, "A question");
      postComment(base.instructor.id, "First answer", question.id);

      db.delete(schema.enrollments)
        .where(eq(schema.enrollments.id, enrollment.id))
        .run();
      postComment(base.instructor.id, "Second answer", question.id);

      expect(listNotifications(db, base.user.id).map((n) => n.excerpt)).toEqual(
        ["First answer"]
      );
    });
  });
});
