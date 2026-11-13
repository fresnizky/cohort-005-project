import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  NotificationKindName,
  NotificationRole,
  RefundStatus,
  TeamMemberRole,
  UserRole,
} from "~/db/schema";
import { NotificationKinds } from "~/lib/notification-kinds";
import {
  archiveNotification,
  countUnseenNotifications,
  getNotificationSettings,
  isNotificationKindEnabled,
  listArchivedNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
  markNotificationsSeen,
  notifyRefundRequestDecided,
  notifyEnrollmentCreated,
  notifyRefundRequestRaised,
  notifySeatClaimed,
  openNotification,
  setNotificationKindEnabled,
  setNotificationRoleEnabled,
  unarchiveNotification,
} from "./notifications.server";
import { approveRefundRequest } from "./refunds.server";

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
    const before = [listNotifications(db, pat.id), listNotifications(db, sam.id)];

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

// ─── Enrollments and Seats (#17) ───

function enroll(userId: number) {
  const enrollment = db
    .insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .returning()
    .get();
  notifyEnrollmentCreated(db, enrollment.id, NOW);
  return enrollment;
}

describe("a Student gets an Enrollment", () => {
  it("notifies the course's Instructor with Instructor · Enrollments", () => {
    buyForSelf(base.user.id);
    enroll(base.user.id);

    expect(listNotifications(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        role: NotificationRole.Instructor,
        kind: NotificationKindName.Enrollments,
        sentence: [
          { text: "Test User", emphasis: true },
          { text: " enrolled in ", emphasis: false },
          { text: "Test Course", emphasis: true },
        ],
        excerpt: null,
        link: `/instructor/${base.course.id}/students`,
        createdAt: NOW.toISOString(),
      }),
    ]);
    expect(listNotifications(db, base.user.id)).toEqual([]);
  });

  it("doesn't notify an Instructor who enrolls on their own course", () => {
    enroll(base.instructor.id);

    expect(listNotifications(db, base.instructor.id)).toEqual([]);
  });

  it("doesn't notify the Instructor when an Enrollment ends", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const purchase = buyForSelf(base.user.id);
    enroll(base.user.id);
    const refundRequest = raiseOn(purchase.id);
    const before = listNotifications(db, base.instructor.id);

    const result = approveRefundRequest(
      db,
      refundRequest.id,
      pat.id,
      null,
      NOW
    );

    expect(result.ok).toBe(true);
    expect(listNotifications(db, base.instructor.id)).toEqual(before);
  });
});

/** A Team Licence with one Seat, bought by the first Team Admin. */
function teamLicenceSeat(teamAdminIds: number[], memberIds: number[] = []) {
  const team = db.insert(schema.teams).values({}).returning().get();
  for (const userId of teamAdminIds) {
    db.insert(schema.teamMembers)
      .values({ teamId: team.id, userId, role: schema.TeamMemberRole.Admin })
      .run();
  }
  for (const userId of memberIds) {
    db.insert(schema.teamMembers)
      .values({ teamId: team.id, userId, role: schema.TeamMemberRole.Member })
      .run();
  }
  const purchase = buyForSelf(teamAdminIds[0]);
  return db
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: base.course.id,
      code: `SEAT-${purchase.id}`,
      purchaseId: purchase.id,
    })
    .returning()
    .get();
}

/** Claims a Seat the way the redeem route does. */
function claimSeat(couponId: number, userId: number) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: NOW.toISOString() })
    .where(eq(schema.coupons.id, couponId))
    .run();
  enroll(userId);
  notifySeatClaimed(db, couponId, NOW);
}

describe("a Student claims a Seat", () => {
  it("notifies the Team Admin with Team Admin · Seats and the Instructor with Instructor · Enrollments", () => {
    const tara = addPerson("Tara", UserRole.Student);
    const seat = teamLicenceSeat([tara.id]);

    claimSeat(seat.id, base.user.id);

    expect(listNotifications(db, tara.id)).toEqual([
      expect.objectContaining({
        role: NotificationRole.TeamAdmin,
        kind: NotificationKindName.Seats,
        sentence: [
          { text: "Test User", emphasis: true },
          { text: " claimed a Seat on your ", emphasis: false },
          { text: "Test Course", emphasis: true },
          { text: " Team Licence", emphasis: false },
        ],
        excerpt: null,
        link: "/team",
        createdAt: NOW.toISOString(),
      }),
    ]);
    expect(listNotifications(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        role: NotificationRole.Instructor,
        kind: NotificationKindName.Enrollments,
      }),
    ]);
    expect(listNotifications(db, base.user.id)).toEqual([]);
  });

  it("notifies every Team Admin of the team but not its other members", () => {
    const tara = addPerson("Tara", UserRole.Student);
    const theo = addPerson("Theo", UserRole.Student);
    const mia = addPerson("Mia", UserRole.Student);
    const seat = teamLicenceSeat([tara.id, theo.id], [mia.id]);

    claimSeat(seat.id, base.user.id);

    expect(listNotifications(db, tara.id)).toHaveLength(1);
    expect(listNotifications(db, theo.id)).toHaveLength(1);
    expect(listNotifications(db, mia.id)).toEqual([]);
  });

  it("doesn't notify a Team Admin who claims their own Seat", () => {
    const tara = addPerson("Tara", UserRole.Student);
    const theo = addPerson("Theo", UserRole.Student);
    const seat = teamLicenceSeat([tara.id, theo.id]);

    claimSeat(seat.id, tara.id);

    expect(listNotifications(db, tara.id)).toEqual([]);
    expect(listNotifications(db, theo.id)).toEqual([
      expect.objectContaining({
        sentence: [
          { text: "Tara", emphasis: true },
          { text: " claimed a Seat on your ", emphasis: false },
          { text: "Test Course", emphasis: true },
          { text: " Team Licence", emphasis: false },
        ],
      }),
    ]);
  });
});

describe("notification settings", () => {
  function makeTeamAdmin(userId: number) {
    const team = db.insert(schema.teams).values({}).returning().get();
    return db
      .insert(schema.teamMembers)
      .values({ teamId: team.id, userId, role: TeamMemberRole.Admin })
      .returning()
      .get();
  }

  it("lists the roles a person holds with every kind on when nothing is stored", () => {
    makeTeamAdmin(base.user.id);

    expect(getNotificationSettings(db, base.user.id)).toEqual([
      {
        role: NotificationRole.Student,
        enabled: true,
        kinds: [
          { kind: NotificationKindName.Refunds, enabled: true },
          { kind: NotificationKindName.Comments, enabled: true },
        ],
      },
      {
        role: NotificationRole.TeamAdmin,
        enabled: true,
        kinds: [
          { kind: NotificationKindName.Seats, enabled: true },
          { kind: NotificationKindName.Refunds, enabled: true },
        ],
      },
    ]);
  });

  it("lists only the roles a person currently holds", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    makeTeamAdmin(base.instructor.id);
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.teamMembers)
      .values({ teamId: team.id, userId: pat.id, role: TeamMemberRole.Member })
      .run();

    expect(
      getNotificationSettings(db, pat.id).map((setting) => setting.role)
    ).toEqual([NotificationRole.PlatformAdmin]);
    expect(
      getNotificationSettings(db, base.instructor.id).map(
        (setting) => setting.role
      )
    ).toEqual([NotificationRole.Instructor, NotificationRole.TeamAdmin]);
  });

  it("writes nothing for a kind that is turned off, and resumes fresh when it is turned back on", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);

    setNotificationKindEnabled(
      db,
      pat.id,
      NotificationKinds.PlatformAdminRefunds,
      false
    );
    raiseOn(buyForSelf(base.user.id).id);

    expect(listNotifications(db, pat.id)).toEqual([]);
    expect(countUnseenNotifications(db, pat.id)).toBe(0);
    expect(listNotifications(db, sam.id)).toHaveLength(1);

    setNotificationKindEnabled(
      db,
      pat.id,
      NotificationKinds.PlatformAdminRefunds,
      true
    );
    raiseOn(buyForSelf(base.user.id).id, minutesAfterNow(5));

    expect(listNotifications(db, pat.id)).toEqual([
      expect.objectContaining({ createdAt: minutesAfterNow(5).toISOString() }),
    ]);
    expect(listNotifications(db, sam.id)).toHaveLength(2);
  });

  it("writes nothing for any kind under a role that is turned off", () => {
    const pat = addPerson("Pat", UserRole.Admin);

    setNotificationRoleEnabled(db, pat.id, NotificationRole.PlatformAdmin, false);
    raiseOn(buyForSelf(base.user.id).id);

    expect(listNotifications(db, pat.id)).toEqual([]);
    expect(
      isNotificationKindEnabled(db, pat.id, NotificationKinds.PlatformAdminRefunds)
    ).toBe(false);
  });

  it("keeps each kind's own setting while its role is off, and applies it again when the role is turned back on", () => {
    makeTeamAdmin(base.user.id);
    setNotificationKindEnabled(db, base.user.id, NotificationKinds.TeamAdminSeats, false);

    setNotificationRoleEnabled(db, base.user.id, NotificationRole.TeamAdmin, false);

    expect(
      isNotificationKindEnabled(db, base.user.id, NotificationKinds.TeamAdminRefunds)
    ).toBe(false);
    expect(getNotificationSettings(db, base.user.id)).toContainEqual({
      role: NotificationRole.TeamAdmin,
      enabled: false,
      kinds: [
        { kind: NotificationKindName.Seats, enabled: false },
        { kind: NotificationKindName.Refunds, enabled: true },
      ],
    });

    setNotificationRoleEnabled(db, base.user.id, NotificationRole.TeamAdmin, true);

    expect(
      isNotificationKindEnabled(db, base.user.id, NotificationKinds.TeamAdminRefunds)
    ).toBe(true);
    expect(
      isNotificationKindEnabled(db, base.user.id, NotificationKinds.TeamAdminSeats)
    ).toBe(false);
  });

  it("counts a kind with no stored setting as on, even when every other kind in the role is off", () => {
    setNotificationKindEnabled(db, base.user.id, NotificationKinds.StudentRefunds, false);

    expect(
      isNotificationKindEnabled(db, base.user.id, NotificationKinds.StudentComments)
    ).toBe(true);
    expect(getNotificationSettings(db, base.user.id)).toEqual([
      {
        role: NotificationRole.Student,
        enabled: true,
        kinds: [
          { kind: NotificationKindName.Refunds, enabled: false },
          { kind: NotificationKindName.Comments, enabled: true },
        ],
      },
    ]);
  });

  it("keeps a role's settings through losing and regaining that role", () => {
    const membership = makeTeamAdmin(base.user.id);
    setNotificationRoleEnabled(db, base.user.id, NotificationRole.TeamAdmin, false);
    setNotificationKindEnabled(db, base.user.id, NotificationKinds.TeamAdminSeats, false);

    db.update(schema.teamMembers)
      .set({ role: TeamMemberRole.Member })
      .where(eq(schema.teamMembers.id, membership.id))
      .run();
    expect(
      getNotificationSettings(db, base.user.id).map((setting) => setting.role)
    ).toEqual([NotificationRole.Student]);

    db.update(schema.teamMembers)
      .set({ role: TeamMemberRole.Admin })
      .where(eq(schema.teamMembers.id, membership.id))
      .run();
    expect(getNotificationSettings(db, base.user.id)).toContainEqual({
      role: NotificationRole.TeamAdmin,
      enabled: false,
      kinds: [
        { kind: NotificationKindName.Seats, enabled: false },
        { kind: NotificationKindName.Refunds, enabled: true },
      ],
    });
  });

  it("keeps the Notifications a person received after they lose the role", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    raiseOn(buyForSelf(base.user.id).id);

    db.update(schema.users)
      .set({ role: UserRole.Student })
      .where(eq(schema.users.id, pat.id))
      .run();

    expect(listNotifications(db, pat.id)).toEqual([
      expect.objectContaining({ role: NotificationRole.PlatformAdmin }),
    ]);
  });
});
