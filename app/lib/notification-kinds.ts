import { NotificationKindName, NotificationRole } from "~/db/schema";

// ─── Notification Kinds ───
// The fixed set of seven Notification Kinds, each a role plus a short name.
// Safe to import on the client: the bell and the Settings page use the labels.

export type NotificationKind = {
  role: NotificationRole;
  name: NotificationKindName;
};

export const NotificationKinds = {
  StudentRefunds: {
    role: NotificationRole.Student,
    name: NotificationKindName.Refunds,
  },
  StudentComments: {
    role: NotificationRole.Student,
    name: NotificationKindName.Comments,
  },
  InstructorComments: {
    role: NotificationRole.Instructor,
    name: NotificationKindName.Comments,
  },
  InstructorEnrollments: {
    role: NotificationRole.Instructor,
    name: NotificationKindName.Enrollments,
  },
  PlatformAdminRefunds: {
    role: NotificationRole.PlatformAdmin,
    name: NotificationKindName.Refunds,
  },
  TeamAdminSeats: {
    role: NotificationRole.TeamAdmin,
    name: NotificationKindName.Seats,
  },
  TeamAdminRefunds: {
    role: NotificationRole.TeamAdmin,
    name: NotificationKindName.Refunds,
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

/**
 * The Notification Kind with this role and name, or undefined when the role
 * has no such kind (e.g. Instructor · Seats).
 */
export function findNotificationKind(
  role: NotificationRole,
  name: NotificationKindName
): NotificationKind | undefined {
  return ALL_NOTIFICATION_KINDS.find(
    (kind) => kind.role === role && kind.name === name
  );
}

/** "role · kind", as the bell shows it, e.g. "Platform Admin · Refunds". */
export function notificationKindLabel(
  role: NotificationRole,
  name: NotificationKindName
): string {
  return `${ROLE_LABELS[role]} · ${KIND_LABELS[name]}`;
}
