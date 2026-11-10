# Web Push on mobile: limits and requirements

Research for [#5](https://github.com/fresnizky/cohort-005-project/issues/5), a child of the map [#3 "Notifications for every role"](https://github.com/fresnizky/cohort-005-project/issues/3). Researched 2026-11-10.

**Question.** What does Cadence need before it can send a Notification as Web Push to a phone? Cadence is a React Router web app backed by one SQLite file through Drizzle, and today it has no service worker and no manifest. This doc covers:

- Android and iOS support, and their limits
- the minimal PWA pieces
- VAPID keys and the subscription lifecycle
- payload limits
- what happens when a subscription expires

A native app is out of scope.

## TL;DR

- **Android:** a Student, Instructor, Platform Admin or Team Admin can subscribe from an ordinary browser tab in Chrome (42+), Firefox (48+) or Samsung Internet (4+). Installing the app is not required. [BCD]
- **iOS/iPadOS 16.4+:** push works only after the person adds Cadence to the Home Screen as a web app whose manifest sets `display` to `standalone` or `fullscreen`. In a Safari tab, `Notification` is not even defined. [WebKit-16.4-push] [BCD] Since 16.4, third-party iOS browsers can also offer "Add to Home Screen". [WebKit-16.4]
- **The phone needs to be prompted first.** On iOS, Cadence has to persuade each person to install the app before it can ask for permission. Expect low opt-in there and keep email or in-app as the baseline channel.
- **Minimum build:**
  - a Web App Manifest (`display: standalone`, icons, `id`)
  - a service worker with `push` and `notificationclick` handlers
  - a subscribe button, since permission requires a user gesture
  - a VAPID P-256 key pair kept on the server
  - a table of subscriptions (endpoint plus `p256dh` and `auth` keys) per person, with many devices per person
  - a server-side sender that encrypts payloads (RFC 8291) and signs a VAPID JWT (RFC 8292)
- **No vendor account is needed.** Neither Apple nor Google requires a developer account or API key. The push services (FCM, Mozilla autopush, `*.push.apple.com`) are free. [Apple-docs] [WebKit-meet]
- **Payload:** guarantee no more than 4 KB (4096 bytes is the spec minimum, and Apple's limit is 4 KB). [web.dev-protocol] [Apple-docs]
- **Every push must show a visible notification** (`userVisibleOnly: true`):
  - Safari revokes the subscription if it doesn't. [WebKit-meet] [Apple-docs]
  - Chrome shows a generic "This site has been updated in the background" notification instead. [web.dev-handling]
  - So Cadence can't use push for silent background sync.
- **Subscriptions die silently.** The push service returns **404 or 410** when a subscription has expired or been revoked, and Cadence must delete it. The client-side `pushsubscriptionchange` event is **not supported on Safari iOS**, so the server's 404/410 handling is the only reliable cleanup. [web.dev-protocol] [Apple-docs] [BCD]

## 1. Platform support

| Platform | Push supported? | Install required? | Source |
| --- | --- | --- | --- |
| Chrome Android | 42+ (`applicationServerKey` required) | No, works in a tab | [BCD] |
| Firefox Android | 48+ (79+ requires a user gesture to subscribe) | No | [BCD] |
| Samsung Internet | 4.0+ (no notifications in incognito, from 5.0) | No | [BCD] |
| Safari iOS / iPadOS | 16.4+ | **Yes.** Home Screen web app with a non-default `display` | [WebKit-16.4-push] [BCD] |
| Other iOS browsers | Through "Add to Home Screen" from their Share menu (16.4+). The installed web app runs on WebKit. | Yes | [WebKit-16.4] |

iOS details from WebKit:

- "A web app that has been added to the Home Screen can request permission to receive push notifications as long as that request is in response to direct user interaction." [WebKit-16.4-push]
- If a site has no manifest with `display: standalone` or `fullscreen`, Add to Home Screen creates a bookmark that opens in the browser, and that bookmark gets no push. [WebKit-16.4-push]
- MDN compat data for `Notification` on Safari iOS says the interface "is undefined, unless the page is a web app saved to the home screen. The app's manifest must have a non-default `display` value." [BCD] Feature-detect on the client. Don't sniff the user agent. [WebKit-16.4-push]
- Notifications appear on the Lock Screen, in Notification Center and on a paired Apple Watch, and they respect Focus modes. [WebKit-16.4-push]
- Each install is identified by its name plus the manifest `id`, so one device can hold several installs. [WebKit-16.4-push]
- The Badging API (`navigator.setAppBadge` / `clearAppBadge`) works for Home Screen web apps. [WebKit-16.4-push] [Apple-docs]

**Declarative Web Push (iOS/iPadOS 18.4+, Home Screen web apps):**

- The server sends JSON containing `"web_push": 8030`, a `notification` object (with a required `title`) and a required `navigate` URL, and the OS shows it without running a service worker.
- `window.pushManager` lets a page subscribe without a service worker.
- Because every message is visible, the silent-push penalty doesn't apply.
- An optional service worker can still change the notification.

[WebKit-declarative] [WebKit-18.4] It is still limited to Home Screen web apps on iOS, and other browsers use the classic format. Plan for the classic service-worker path. A declarative payload is an optional improvement for iOS.

## 2. Minimal PWA pieces Cadence would add

`public/` currently has only `favicon.svg` and images.

1. **Web App Manifest** (e.g. `public/manifest.webmanifest`, linked from the root layout). It needs:
   - `display: "standalone"`, which iOS requires [WebKit-16.4-push]
   - `id`, `name`, `start_url` and icons
2. **Service worker** (e.g. `public/sw.js`, registered at scope `/`). It needs these handlers:
   - **`push`:** parse the payload, then call `self.registration.showNotification(...)` inside `event.waitUntil(...)`. The notification must be shown before that promise settles. [web.dev-handling]
   - **`notificationclick`:** focus or open the relevant Cadence URL. MDN compat data lists `notificationclick` as unsupported on Safari iOS, so verify on a device. If it really doesn't fire, a declarative `navigate` URL is the fallback on iOS. [BCD]
   - **`pushsubscriptionchange`** (optional): re-subscribe and POST the new subscription. It is supported on Chrome Android 138+, Firefox Android (without the `oldSubscription`/`newSubscription` properties) and Samsung 30+, but **not Safari iOS**. [BCD]
3. **Secure context:** `PushManager` and `PushSubscription` are `[SecureContext]`, and `subscribe()` rejects unless the scope is `https`. Localhost counts as secure for dev. [Push-spec]
4. **Subscribe flow:**
   - Call `subscribe()` from a click handler, because a user gesture is required on Safari [Apple-docs] [WebKit-meet] and on Firefox Android 79+. [BCD]
   - Pass `{ userVisibleOnly: true, applicationServerKey: <VAPID public key> }`.
   - POST the resulting `PushSubscription` JSON to a Cadence action.

## 3. VAPID keys and server-side sending

- **Keys:** one P-256 key pair per application server.
  - Pass the public key to `subscribe()` as `applicationServerKey`: 65 bytes, uncompressed, starting `0x04`, base64url when given as a string. [Push-spec]
  - The private key signs JWTs. It must stay secret and stay stable.
  - Subscription options can't change after creation [Push-spec], so rotating the key forces every device to re-subscribe.
- **JWT** (`Authorization: vapid t=<jwt>, k=<public key>`):
  - `aud` = origin of the push service the endpoint points to
  - `exp` ≤ 24 h ahead (Apple rejects anything more than one day out)
  - `sub` = `mailto:` or an `https:` URL
  - Apple also says: "Don't refresh your JWT more frequently than once per hour."

  [web.dev-protocol] [Apple-docs]
- **Encryption:** each payload is encrypted with the subscription's `p256dh` and `auth` keys, using the Message Encryption spec (RFC 8291 `aes128gcm`; web.dev still describes the older `aesgcm` draft). The push service can't read it. [web.dev-protocol]
- **Headers:**

  | Header | What it does |
  | --- | --- |
  | `TTL` (required) | Seconds the push service may hold the message. Apple holds it for 30 days at most, with a limited count per offline device. |
  | `Urgency` | `very-low`, `low`, `normal` or `high` |
  | `Topic` | ≤ 32 base64url characters. Replaces an undelivered message with the same topic. |

  [web.dev-protocol] [Apple-docs]
- **Network:** an egress allowlist must allow `https://*.push.apple.com`. Apple requires TLS with SNI and accepts HTTP/1.1 (≤ 100 unacknowledged pipelined requests) or HTTP/2. [Apple-docs]
- **Library:** a Node library such as `web-push` handles both the encryption and the VAPID signing. Choosing one is the build-or-buy question, but either option needs everything in section 2.

## 4. Payload limits

- 4096 bytes is the minimum payload size a push service must support. [web.dev-protocol] Apple returns `413 PayloadTooLarge` above 4 KB. [Apple-docs]
- So keep the payload small: a title, a short body, a URL and an ID, and let the app fetch details after the click.
- Firefox puts a quota on pushes that don't show a notification. Pushes that do show one are exempt. Chrome has no such quota. [MDN-push]

## 5. Subscription lifecycle and expiry

- **Storage:** store each subscription against the person who made it (`endpoint`, `p256dh`, `auth` and `expirationTime`).
  - One person can have many subscriptions: a phone, an installed iPad app, a desktop browser.
  - Each iOS install is separate, keyed by name plus manifest `id`. [WebKit-16.4-push]
- **Expiry and refresh:** a subscription MAY have an `expirationTime` (ms since epoch, or `null`), and the browser SHOULD refresh it before expiry. When it refreshes, it fires `pushsubscriptionchange` with old and new subscriptions. When it can't (expired, permission revoked), it fires the event with `newSubscription: null`. [Push-spec]
- **Revoked permission:** the browser MUST deactivate the subscription. Firing `pushsubscriptionchange` is only a MAY. [Push-spec] After deactivation the endpoint is dead and is never reused, and both browser and push service delete their copies. [Push-spec]
- **What Cadence observes:**

  | Response | Meaning | Cadence action |
  | --- | --- | --- |
  | 404 | Expired | Delete the row |
  | 410 | No longer valid (Apple: "The device token has expired") | Delete the row |
  | 413 | Payload too large | Shrink the payload |
  | 429 | Rate limited | Honour `Retry-After` |
  | 400 / 403 | Bad request / bad JWT or VAPID key | Fix the request or keys |

  [web.dev-protocol] [Apple-docs]
- **Safari-specific:** a push that doesn't display a notification revokes the subscription. [WebKit-meet] [Apple-docs] Declarative pushes are exempt. [WebKit-declarative]
- **Uninstall:** a subscription without a window-accessible scope is deactivated when its service worker registration is unregistered. [Push-spec] Deleting the Home Screen app on iOS therefore kills the subscription, and the next send gets 404/410.
- **Re-sync:** on each app load, call `pushManager.getSubscription()` and re-POST it to the server. Safari iOS doesn't fire `pushsubscriptionchange`, so this is the cheap way to catch rotated endpoints there.

## Implications for the map

- iOS reach depends on getting people to install Cadence to the Home Screen. Any "push to phone" promise for Students on iPhone needs an install-prompt UX and is opt-in by nature. Treat push as an additional channel, not the only one.
- Cadence needs a new table for subscriptions (many per person) and a send path that deletes them on 404/410. That means a schema change and a migration.
- A third-party push vendor (OneSignal and similar) still needs the same manifest, service worker and Home Screen install on iOS. A vendor would save Cadence the VAPID, encryption and cleanup code, but not the PWA work.

## Sources

- [Push-spec] W3C Push API, Working Draft 9 Nov 2026 — https://www.w3.org/TR/push-api/
- [MDN-push] MDN, Push API — https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- [BCD] MDN browser-compat-data 8.1.8 (`api.PushManager`, `api.PushSubscription.expirationTime`, `api.ServiceWorkerGlobalScope.*_event`, `api.Notification`) — https://github.com/mdn/browser-compat-data
- [WebKit-meet] WebKit, "Meet Web Push" — https://webkit.org/blog/12945/meet-web-push/
- [WebKit-16.4-push] WebKit, "Web Push for Web Apps on iOS and iPadOS" — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- [WebKit-16.4] WebKit, "WebKit Features in Safari 16.4" — https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- [WebKit-declarative] WebKit, "Meet Declarative Web Push" — https://webkit.org/blog/16535/meet-declarative-web-push/
- [WebKit-18.4] WebKit, "WebKit Features in Safari 18.4" — https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- [Apple-docs] Apple Developer, "Sending web push notifications in web apps and browsers" — https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- [web.dev-protocol] web.dev, "The Web Push Protocol" — https://web.dev/articles/push-notifications-web-push-protocol
- [web.dev-handling] web.dev, "Push events" — https://web.dev/articles/push-notifications-handling-messages
