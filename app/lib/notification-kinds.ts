import { NotificationKindName, NotificationRole } from "~/db/schema";

// ─── Notification Kinds ───
// The fixed set of seven Notification Kinds, each a role plus a short name.
// Safe to import on the client: the bell and the Settings page use the labels.

export type NotificationKind = {
  role: NotificationRole;
  kind: NotificationKindName;
};

export const NotificationKinds = {
  StudentRefunds: {
    role: NotificationRole.Student,
    kind: NotificationKindName.Refunds,
  },
  StudentComments: {
    role: NotificationRole.Student,
    kind: NotificationKindName.Comments,
  },
  InstructorComments: {
    role: NotificationRole.Instructor,
    kind: NotificationKindName.Comments,
  },
  InstructorEnrollments: {
    role: NotificationRole.Instructor,
    kind: NotificationKindName.Enrollments,
  },
  PlatformAdminRefunds: {
    role: NotificationRole.PlatformAdmin,
    kind: NotificationKindName.Refunds,
  },
  TeamAdminSeats: {
    role: NotificationRole.TeamAdmin,
    kind: NotificationKindName.Seats,
  },
  TeamAdminRefunds: {
    role: NotificationRole.TeamAdmin,
    kind: NotificationKindName.Refunds,
  },
} as const satisfies Record<string, NotificationKind>;

/** Every Notification Kind, in the order the Settings page lists them. */
export const ALL_NOTIFICATION_KINDS: readonly NotificationKind[] =
  Object.values(NotificationKinds);

export const ROLE_LABELS: Record<NotificationRole, string> = {
  [NotificationRole.Student]: "Student",
  [NotificationRole.Instructor]: "Instructor",
  [NotificationRole.PlatformAdmin]: "Platform Admin",
  [NotificationRole.TeamAdmin]: "Team Admin",
};

/** The short name shown under its role on the Settings page. */
export const KIND_LABELS: Record<NotificationKindName, string> = {
  [NotificationKindName.Refunds]: "Refunds",
  [NotificationKindName.Comments]: "Comments",
  [NotificationKindName.Enrollments]: "Enrollments",
  [NotificationKindName.Seats]: "Seats",
};

/** "role · kind", as the bell shows it, e.g. "Platform Admin · Refunds". */
export function notificationKindLabel({
  role,
  kind,
}: NotificationKind): string {
  return `${ROLE_LABELS[role]} · ${KIND_LABELS[kind]}`;
}
