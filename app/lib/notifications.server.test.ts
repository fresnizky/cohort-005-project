import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKindName, NotificationRole, UserRole } from "~/db/schema";
import {
  countUnseenNotifications,
  listNotifications,
  markNotificationRead,
  markNotificationsSeen,
  notifyEnrollmentCreated,
  notifyRefundRequestRaised,
  notifySeatClaimed,
  openNotification,
} from "./notifications.server";
import { approveRefundRequest } from "./refunds.server";
import { eq } from "drizzle-orm";

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
