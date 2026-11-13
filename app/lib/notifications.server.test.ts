import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKindName, NotificationRole, UserRole } from "~/db/schema";
import {
  countUnseenNotifications,
  listNotifications,
  markNotificationRead,
  markNotificationsSeen,
  notifyRefundRequestRaised,
  openNotification,
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
