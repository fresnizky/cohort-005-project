# Build Notifications in-house rather than on a hosted service

Cadence keeps its Notifications and each person's Notification settings in its own SQLite tables and draws the bell and inbox with its own components. Notifications are in-app only, and with Web Push out of scope, a vendor would mostly give us a ready-made inbox and a realtime bell. In return we would copy every person and their roles to the vendor, sign tokens for its inbox, pay per message, and bend our settings (one toggle per role held, each listing its Notification Kinds) into the vendor's preference model.

## Considered Options

- **Novu.** The best fit among the vendors: `preferenceGroups` can express a per-role toggle, and its core is open source. Rejected: per-run billing above the free tier, a second copy of who holds which role, and Notification data leaving SQLite. Self-hosting it needs MongoDB, Redis and S3.
- **Knock / Courier.** Rejected: they fit the per-role settings worse (Knock's per-tenant preference sets are Enterprise-only; Courier doesn't document opting out of a whole section).
- **OneSignal.** Rejected: it has no in-app inbox on the web.

## Consequences

We write and maintain the inbox, the bell and its background refresh ourselves. The bell has no vendor realtime socket, so it refreshes from our own server.
