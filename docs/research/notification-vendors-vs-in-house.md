# Notification vendors vs. building in-house

Research for [#6](https://github.com/fresnizky/cohort-005-project/issues/6), a child of the map [#3 "Notifications for every role"](https://github.com/fresnizky/cohort-005-project/issues/3). Sources were checked on 2026-11-10. Vendor pricing pages change often, so check again before deciding.

This note sets out facts and trade-offs. It does **not** make the build-or-buy decision.

## Cadence's needs (from #3)

- Notifications go to Students, Instructors, Platform Admins and Team Admins. One person can hold several roles.
- **In-app feed** with a bell that refreshes in the background. Polling is fine.
- **Web Push**, including mobile browsers and an installed PWA. The iOS limits are accepted.
- **Settings:** one toggle per role the person holds. Each role toggle reveals that role's Notification kinds, and each kind has its own toggle. There is no global toggle.
- Email is not a channel here. The existing Postmark receipts stay as they are.
- Small scale. The stack is Node, React Router (`react-router` **8.3.0** in `package.json`), and one SQLite file through Drizzle with `better-sqlite3`.

## The finding that shapes everything else

**None of the three orchestration vendors (Knock, Novu, Courier) sends standard Web Push itself.** Each one sends browser push through another push provider, usually Firebase Cloud Messaging (FCM) or OneSignal:

- Knock: "Knock does not have a first-party web push channel." Its web push tutorial uses FCM, a Firebase project, the `firebase` npm package and a `firebase-messaging-sw.js` service worker. ([Knock: web push with FCM](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm), [Knock push integrations](https://docs.knock.app/integrations/push))
- Novu's push providers are FCM, Expo, APNS, OneSignal, Push Webhook, Pusher Beams and Pushpad. No VAPID/Web Push provider of its own is documented, and FCM is the only documented web example. ([Novu push integrations](https://docs.novu.co/platform/integrations/push))
- Courier's push providers are APNs, FCM, Expo, OneSignal, Airship, SNS, Pusher Beams and others. FCM is the only one it describes as covering web. ([Courier push overview](https://www.courier.com/docs/integrations/push/overview))
- OneSignal does send web push itself, but it has **no in-app feed for the web**. "In-app messages are only available for mobile apps with the OneSignal mobile SDK installed." ([OneSignal in-app setup](https://documentation.onesignal.com/docs/in-app-messages-setup))

So for these two channels, "buying" means **two vendors**: an orchestrator for the feed, preferences and workflows, plus FCM or OneSignal for the push transport. No single vendor here covers both channels by itself.

The service worker and web app manifest are needed **whichever path is chosen**. iOS/iPadOS 16.4+ allows Web Push only for a Home Screen web app whose manifest has `display` set to `standalone` or `fullscreen`, and the permission request must follow a direct user action. No Apple Developer Program membership is needed. ([WebKit: Web Push for web apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) Cadence has no manifest or service worker today (`public/` holds only `favicon.svg` and `images/`).

## Comparison

| | Build in-house | Knock | Novu (cloud) | Courier | OneSignal |
|---|---|---|---|---|---|
| **In-app feed + bell** | Build it: a Notifications table in Drizzle plus a bell component | Yes. React `NotificationIconButton`, `NotificationFeedPopover`, `NotificationFeed` ([docs](https://docs.knock.app/in-app-ui/react/feed)) | Yes. `<Inbox />` with Bell and Preferences parts ([docs](https://docs.novu.co/platform/inbox/overview)) | Yes. `CourierInbox` from `@trycourier/courier-react`, plus toasts ([docs](https://www.courier.com/docs/platform/inbox/inbox-overview)) | **No** web in-app feed (mobile SDK only) |
| **Web Push** | `web-push` npm library (VAPID + encryption) sending straight to the browser's push service | Through FCM or OneSignal, no first-party channel | Through FCM (or OneSignal, Pushpad and others) | Through FCM (or OneSignal) | Yes, first-party. Needs `OneSignalSDKWorker.js` at the site root ([docs](https://documentation.onesignal.com/docs/web-push-quickstart)) |
| **Bell refresh in background** | Polling with React Router's `useRevalidator` ("polling on an interval") ([docs](https://reactrouter.com/api/hooks/useRevalidator)), or SSE built by us | Realtime socket built into the feed, with cross-tab sync ([docs](https://docs.knock.app/in-app-ui/react/feed)) | "real-time unread count displayed on the bell icon" ([docs](https://docs.novu.co/platform/inbox/overview)) | "Messages arrive in real time on web and mobile" ([docs](https://www.courier.com/docs/platform/inbox/inbox-overview)) | n/a |
| **Per-person preferences** | Our own tables, shaped exactly like role toggle > kind toggles | `PreferenceSet` with `categories`, `channels`, `channel_types`, `workflows`. Per-tenant sets exist ([docs](https://docs.knock.app/preferences/overview)), but per-tenant preferences are **Enterprise-only** ([pricing](https://knock.app/pricing)). No prebuilt React preferences component, only a hosted page or a custom UI on the API | Global, per-workflow and per-channel layers ([docs](https://docs.novu.co/platform/concepts/preferences)). Inbox `preferenceGroups` by workflow tags, where a person "can toggle the entire group in one click" ([changelog](https://novu.co/changelog/preference-grouping-smarter-control-less-clutter/)) | Topics grouped into **sections**, with a hosted page or embedded component ([docs](https://www.courier.com/docs/recipients/preferences/preferences-editor)). Opting out of a whole section is not documented | Segments and tags. No preference center for a feed |
| **Price at small scale** | No vendor fee. FCM is not needed. The browser push services are free to send to | Free: 10,000 messages/month, where one message is "a single message delivered to a single user on a single channel" (so in-app + push = 2). Starter: $250/mo for 50,000 then $0.005 each ([pricing](https://knock.app/pricing)) | Free: 10,000 workflow runs/month. Pro from $30/mo for 30,000+, then $1.20 per 1K runs ([pricing](https://novu.co/pricing)) | Developer: free for 10,000 sends/month. Business: $0.005 per send ([pricing](https://www.courier.com/pricing)) | Free: web push "max 10,000 subscribers per send". Growth from $19/mo, $0.004 per web push subscriber ([pricing](https://onesignal.com/pricing)) |
| **Push transport cost if bought** | n/a | + FCM: "No-cost" on Spark ([Firebase pricing](https://firebase.google.com/pricing)) | + FCM, same | + FCM, same | Included |
| **Data residency** | Data stays in Cadence's SQLite file. Push payloads go through the browser vendors' push services, as they do on every path | Not documented on Knock's pricing page or docs (checked [pricing](https://knock.app/pricing) and [data retention](https://docs.knock.app/manage-your-account/data-retention)). Ask sales | US + EU on Free. More regions on Enterprise ([pricing](https://novu.co/pricing)) | EU Data Residency on Business ([pricing](https://www.courier.com/pricing)) | Not stated. Pricing page lists only GDPR "Compliant" / "Compliant w/ DPA" ([pricing](https://onesignal.com/pricing)) |
| **Retention** | We choose | Feed: unlimited and configurable. Logs: 30 days ([pricing](https://knock.app/pricing)) | Activity feed: 24h on Free, 7d on Pro ([pricing](https://novu.co/pricing)) | Not stated on the pages checked | n/a |
| **Lock-in** | None. `web-push` is MPL-2.0 and speaks the W3C/IETF standard | Feed data, preferences and workflows live in Knock. Push tokens are FCM tokens | Open core: MIT core plus a commercially licensed `/enterprise` folder ([repo](https://github.com/novuhq/novu)). Self-hosting is offered as an Enterprise option on pricing. Self-hosting needs MongoDB, Redis and S3, and some Inbox features are cloud-only ([docs](https://docs.novu.co/community/self-hosting-novu/overview)) | Feed, preferences and templates live in Courier | Subscribers live in OneSignal |
| **Production auth** | Existing session | Feeds are open to anyone with the feed ID until "enhanced security mode" plus a signed `userToken` is turned on ([docs](https://docs.knock.app/in-app-ui/react/feed)) | HMAC `subscriberHash` ([docs](https://docs.novu.co/platform/inbox/overview)) | Backend-signed JWT passed to `signIn({ userId, jwt })` ([docs](https://www.courier.com/docs/platform/inbox/inbox-overview)) | External ID via `login` ([docs](https://documentation.onesignal.com/docs/web-push-quickstart)) |

## Integration effort, item by item

### Needed on every path

- A web app manifest and a service worker. On iOS, Web Push only works from the installed Home Screen app.
- A UI to ask for push permission, triggered by a direct user action.
- A mapping from Cadence events to Notification kinds and recipients. This includes fanning out to everyone who holds a role, such as all Platform Admins.
- A settings page showing one toggle per role the person holds, with that role's kinds under it. **No vendor stores the person's roles.** Cadence would compute which role sections to show either way.

### Build in-house adds

- Tables, for example `notifications` (recipient, kind, payload/link, `readAt`, `createdAt`), `push_subscriptions` (person, `endpoint`, `p256dh`, `auth`), and preference rows per (person, role) and (person, kind).
- A bell component with an unread count, and polling through `useRevalidator` or a resource-route fetcher.
- Sending with `web-push`: generate the VAPID keys once, then call `setVapidDetails` and `sendNotification(subscription, payload, { TTL, urgency, topic })`. Payload encryption is handled for you ([web-push README](https://github.com/web-push-libs/web-push)). Version 4.0.0 on npm is MPL-2.0 with four dependencies.
- Cleaning up subscriptions. A push service "MUST return a 404 (Not Found) status code" for an expired subscription ([RFC 8030 §7.3](https://www.rfc-editor.org/rfc/rfc8030.html)). `web-push` exposes `statusCode` on the rejected error, so we delete the row on 404. RFC 8030 uses 410 only for delivery receipts, but in practice push services may also return it for a dead subscription, so treat both as "gone". That last point is unverified against a primary source. The service worker should handle `pushsubscriptionchange` to re-subscribe ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)).
- No retries or delivery logs unless we build them.

### Buying (Knock, Novu or Courier) adds

- Two vendor accounts: the orchestrator plus a Firebase project for FCM. FCM web push uses Google's SDK and its own `firebase-messaging-sw.js`. Its tokens are FCM tokens, not standard `PushSubscription`s.
- Syncing Cadence people to vendor recipients or subscribers, plus signing a per-person token (JWT/HMAC) on the server.
- Fitting role > kind settings onto the vendor's model:
  - **Knock:** categories (one per role) plus per-workflow opt-outs, or per-tenant sets, which are Enterprise-only.
  - **Novu:** workflow tags per role, shown as `preferenceGroups` with a group toggle.
  - **Courier:** a section per role with topics per kind. A section-level opt-out isn't documented.
- Bell UI: a prebuilt component styled to fit the shadcn/Tailwind UI, or a headless hook.
- The realtime feed comes with it. This settles "How the bell refreshes" on #3 if a vendor is chosen.

## Trade-offs in short

- **Build:** one vendor fewer, actually zero, and no per-message cost. Data stays in SQLite, and the role/kind settings shape fits exactly. The cost is writing the feed, the bell, polling, subscription cleanup and any retries ourselves. The standards-based push path works directly on iOS Home Screen apps, Android and desktop browsers.
- **Buy an orchestrator:** you get a ready feed, a realtime bell, a preference model with a hosted or prebuilt UI, and delivery logs. But you still need FCM for push and still write the service worker and manifest. You add per-message billing, recipient syncing and token signing. Each vendor's preference model needs a mapping onto role > kind.
  - Knock counts every channel delivery as a message.
  - Novu counts workflow runs.
  - Courier counts "sends", which its pricing page doesn't define.
- **OneSignal alone** covers Web Push but not the in-app feed, so it would only replace the `web-push` part of the in-house build.

## Repo facts that differ from the ticket's assumptions

- `react-router` in `package.json` is **8.3.0**, not v7.
- No `GLOSSARY.md` and no `docs/adr/0006-one-sqlite-file-through-drizzle.md` exist on `main` at commit `1e4f3db`.
- No Postmark code turned up in `app/` or `scripts/` on `main`.
