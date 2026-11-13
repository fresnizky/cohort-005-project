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
  countUnseenNotifications,
  getNotificationSettings,
  isNotificationKindEnabled,
  listNotifications,
  markNotificationRead,
  markNotificationsSeen,
  notifyRefundRequestDecided,
  notifyRefundRequestRaised,
  openNotification,
  setNotificationKindEnabled,
  setNotificationRoleEnabled,
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
