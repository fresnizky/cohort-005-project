// PROTOTYPE — throwaway, never merge to main.
// Question (wayfinder ticket "In-app Notification experience"): how should
// Notifications look and behave in Cadence?
// Three layout variants of the bell + list, switchable via `?variant=A|B|C`,
// mounted in the real app layout. Lifecycle rules are separate knobs
// (`?badge=`, `?term=`, `?stale=`) so any layout can be tried with any rule.
// All state is in memory and resets on reload. The mock person holds all four
// roles so every Notification Kind shows up.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  Archive,
  Bell,
  Check,
  CheckCheck,
  ExternalLink,
  RotateCcw,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { PrototypeSwitcher } from "~/components/prototype-switcher";

// ---------------------------------------------------------------- model

type Role = "Student" | "Instructor" | "Platform Admin" | "Team Admin";

type Notification = {
  id: number;
  role: Role;
  kind: string; // Notification Kind short name, e.g. "Refunds"
  text: string;
  href: string;
  minutesAgo: number;
  seen: boolean;
  read: boolean;
  archived: boolean;
  staleNote?: string; // Platform Admin Refunds: decided by another Admin
  refundRequestId?: number;
};

type BadgeRule = "unread" | "unseen";
type StaleRule = "keep" | "mark" | "clear";

const TERMS = ["Archive", "Done", "Dismiss", "Clear"] as const;
type Term = (typeof TERMS)[number];

const SEED: Notification[] = [
  { id: 1, role: "Platform Admin", kind: "Refunds", text: "Maya Chen requested a refund for “React Foundations”.", href: "/admin/refunds", minutesAgo: 3, seen: false, read: false, archived: false, refundRequestId: 41 },
  { id: 2, role: "Instructor", kind: "Comments", text: "Leo Park commented on “Hooks in depth” in React Foundations.", href: "/courses/react-foundations/lessons/7", minutesAgo: 12, seen: false, read: false, archived: false },
  { id: 3, role: "Team Admin", kind: "Seats", text: "Priya Nair claimed a Seat on your Team Licence for “TypeScript Pro”.", href: "/team", minutesAgo: 45, seen: false, read: false, archived: false },
  { id: 4, role: "Student", kind: "Comments", text: "Your Instructor replied to your comment on “useEffect pitfalls”.", href: "/courses/react-foundations/lessons/9", minutesAgo: 90, seen: true, read: false, archived: false },
  { id: 5, role: "Instructor", kind: "Enrollments", text: "Sam Ortiz enrolled in React Foundations.", href: "/instructor/1/students", minutesAgo: 180, seen: true, read: true, archived: false },
  { id: 6, role: "Platform Admin", kind: "Refunds", text: "Acme Corp requested a refund for a Team Licence on “TypeScript Pro”.", href: "/admin/refunds", minutesAgo: 300, seen: true, read: false, archived: false, refundRequestId: 42 },
  { id: 7, role: "Student", kind: "Refunds", text: "Your refund for “CSS Mastery” was approved.", href: "/dashboard", minutesAgo: 1500, seen: true, read: true, archived: false },
  { id: 8, role: "Team Admin", kind: "Refunds", text: "Your refund for 5 Seats on “TypeScript Pro” was declined.", href: "/team", minutesAgo: 2900, seen: true, read: true, archived: true },
];

const INCOMING: Omit<Notification, "id" | "minutesAgo" | "seen" | "read" | "archived">[] = [
  { role: "Instructor", kind: "Enrollments", text: "Ana Silva enrolled in React Foundations (Claimed Seat)." , href: "/instructor/1/students" },
  { role: "Platform Admin", kind: "Refunds", text: "Tom Becker requested a refund for “Node APIs”.", href: "/admin/refunds", refundRequestId: 43 },
  { role: "Instructor", kind: "Comments", text: "Jo Kim commented on “Server actions” in Node APIs.", href: "/courses/node-apis/lessons/3" },
  { role: "Student", kind: "Comments", text: "A Platform Admin replied to your comment on “Routing basics”.", href: "/courses/react-foundations/lessons/2" },
  { role: "Team Admin", kind: "Seats", text: "Lee Wong claimed a Seat on your Team Licence for “Node APIs”.", href: "/team" },
];

function ago(m: number) {
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

const roleColor: Record<Role, string> = {
  Student: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  Instructor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "Platform Admin": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "Team Admin": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

function useNotificationsModel() {
  const [params, setParams] = useSearchParams();
  const badgeRule = (params.get("badge") as BadgeRule) ?? "unread";
  const staleRule = (params.get("stale") as StaleRule) ?? "mark";
  const term = (params.get("term") as Term) ?? "Archive";
  const [items, setItems] = useState<Notification[]>(SEED);
  const [log, setLog] = useState<string[]>([]);
  const nextIncoming = useRef(0);

  function setParam(k: string, v: string) {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set(k, v);
        return p;
      },
      { replace: true, preventScrollReset: true }
    );
  }

  function record(msg: string) {
    setLog((l) => [msg, ...l].slice(0, 6));
  }

  function patch(pred: (n: Notification) => boolean, p: Partial<Notification>) {
    setItems((xs) => xs.map((n) => (pred(n) ? { ...n, ...p } : n)));
  }

  const inbox = items.filter((n) => !n.archived);
  const badge =
    badgeRule === "unread"
      ? inbox.filter((n) => !n.read).length
      : inbox.filter((n) => !n.seen).length;

  return {
    items,
    inbox,
    archived: items.filter((n) => n.archived),
    badge,
    badgeRule,
    staleRule,
    term,
    log,
    setParam,
    // Bell/list was shown: everything visible counts as seen.
    markAllSeen() {
      if (inbox.some((n) => !n.seen)) record("list opened → all seen");
      patch((n) => !n.archived, { seen: true });
    },
    open(n: Notification) {
      patch((x) => x.id === n.id, { seen: true, read: true });
      record(`opened #${n.id} → read`);
      toast(`Would navigate to ${n.href}`);
    },
    toggleRead(n: Notification) {
      patch((x) => x.id === n.id, { read: !n.read, seen: true });
      record(`#${n.id} → ${n.read ? "unread" : "read"}`);
    },
    markAllRead() {
      patch((n) => !n.archived, { read: true, seen: true });
      record("mark all as read");
    },
    archive(n: Notification) {
      patch((x) => x.id === n.id, { archived: true, seen: true, read: true });
      record(`${term.toLowerCase()} #${n.id}`);
    },
    archiveAllRead() {
      patch((n) => n.read, { archived: true });
      record(`${term.toLowerCase()} all read`);
    },
    unarchive(n: Notification) {
      patch((x) => x.id === n.id, { archived: false });
      record(`restored #${n.id} to inbox`);
    },
    simulateIncoming() {
      const src = INCOMING[nextIncoming.current % INCOMING.length];
      nextIncoming.current++;
      setItems((xs) => [
        {
          ...src,
          id: Math.max(...xs.map((x) => x.id)) + 1,
          minutesAgo: 0,
          seen: false,
          read: false,
          archived: false,
          refundRequestId: src.refundRequestId
            ? src.refundRequestId + nextIncoming.current * 10
            : undefined,
        },
        ...xs,
      ]);
      record(`poll: new ${src.role} · ${src.kind}`);
    },
    // Another Platform Admin decided the oldest open Refund Request.
    simulateOtherAdminDecides() {
      const target = items.find(
        (n) => n.role === "Platform Admin" && n.kind === "Refunds" && !n.staleNote
      );
      if (!target) return toast("No undecided Refunds Notification left");
      const note = "Approved by Rui Costa";
      if (staleRule === "keep") record(`#${target.id} decided elsewhere → unchanged`);
      if (staleRule === "mark") {
        patch((x) => x.id === target.id, { staleNote: note, read: true, seen: true });
        record(`#${target.id} decided elsewhere → marked + read`);
      }
      if (staleRule === "clear") {
        patch((x) => x.id === target.id, { staleNote: note, read: true, seen: true, archived: true });
        record(`#${target.id} decided elsewhere → auto-${term.toLowerCase()}d`);
      }
    },
    reset() {
      setItems(SEED);
      nextIncoming.current = 0;
      setLog([]);
    },
  };
}

type Model = ReturnType<typeof useNotificationsModel>;

// ---------------------------------------------------------------- shared bits

function BadgeDot({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white",
        className
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function RoleChip({ role, kind }: { role: Role; kind: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", roleColor[role])}>
      {role} · {kind}
    </span>
  );
}

function StaleLine({ n }: { n: Notification }) {
  if (!n.staleNote) return null;
  return (
    <div className="mt-1 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <Check className="size-3" /> {n.staleNote}
    </div>
  );
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [active, onOut, ref]);
}

// ---------------------------------------------------------------- Variant A
// Bell in the sidebar header; a compact dropdown; no separate page.

function VariantA({ m }: { m: Model }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"unread" | "all" | "archived">("unread");
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), open);

  const list =
    tab === "unread" ? m.inbox.filter((n) => !n.read) : tab === "all" ? m.inbox : m.archived;

  return (
    <div ref={ref} className="fixed left-[10.5rem] top-3.5 z-50">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) m.markAllSeen();
        }}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
      >
        <Bell className="size-5" />
        <BadgeDot count={m.badge} className="absolute -right-1 -top-1" />
      </button>
      {open && (
        <div className="absolute left-0 top-10 w-96 rounded-lg border bg-popover text-popover-foreground shadow-2xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <button onClick={m.markAllRead} className="flex items-center gap-1 text-xs text-primary hover:underline">
              <CheckCheck className="size-3.5" /> Mark all as read
            </button>
          </div>
          <div className="flex gap-1 border-b px-2 py-1.5 text-xs">
            {(["unread", "all", "archived"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn("rounded px-2 py-1 capitalize", tab === t ? "bg-muted font-semibold" : "text-muted-foreground")}
              >
                {t === "archived" ? m.term : t}
              </button>
            ))}
          </div>
          <ul className="max-h-[26rem] overflow-y-auto">
            {list.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">Nothing here.</li>}
            {list.map((n) => (
              <li key={n.id} className="group relative border-b last:border-0">
                <button onClick={() => m.open(n)} className={cn("flex w-full gap-2 px-3 py-2.5 text-left hover:bg-muted/60", !n.read && "bg-primary/5")}>
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <RoleChip role={n.role} kind={n.kind} />
                      <span className="text-[11px] text-muted-foreground">{ago(n.minutesAgo)}</span>
                    </span>
                    <span className={cn("mt-1 block text-sm", !n.read && "font-medium")}>{n.text}</span>
                    <StaleLine n={n} />
                  </span>
                </button>
                <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
                  {n.archived ? (
                    <button onClick={() => m.unarchive(n)} title="Move back to inbox" className="rounded bg-background p-1 shadow hover:bg-muted"><RotateCcw className="size-3.5" /></button>
                  ) : (
                    <>
                      <button onClick={() => m.toggleRead(n)} title={n.read ? "Mark as unread" : "Mark as read"} className="rounded bg-background p-1 shadow hover:bg-muted"><Check className="size-3.5" /></button>
                      <button onClick={() => m.archive(n)} title={m.term} className="rounded bg-background p-1 shadow hover:bg-muted"><X className="size-3.5" /></button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Variant B
// "Notifications" is a sidebar nav item that opens a full inbox page
// (rendered over the main area), filtered by role, with bulk actions.

function VariantB({ m }: { m: Model }) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<"inbox" | "archived">("inbox");
  const [role, setRole] = useState<Role | "All">("All");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (open) m.markAllSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, m.items.length]);

  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("prototype-nav-slot")), []);

  const roles: Role[] = ["Student", "Instructor", "Platform Admin", "Team Admin"];
  const source = box === "inbox" ? m.inbox : m.archived;
  const list = source.filter((n) => role === "All" || n.role === role);

  return (
    <>
      {slot && createPortal(<button
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
          open ? "bg-sidebar-accent text-sidebar-accent-foreground" : "bg-sidebar text-sidebar-foreground/70 hover:bg-sidebar-accent"
        )}
      >
        <Bell className="size-4" />
        Notifications
        <BadgeDot count={m.badge} className="ml-auto" />
      </button>, slot)}
      {open && (
        <div className="fixed inset-y-0 left-56 right-0 z-40 overflow-y-auto bg-background">
          <div className="mx-auto max-w-4xl p-8">
            <div className="mb-6 flex items-center justify-between">
              <h1 className="text-2xl font-bold">Notifications</h1>
              <button onClick={() => setOpen(false)} className="text-sm text-muted-foreground hover:underline">
                ← back to page
              </button>
            </div>
            <div className="flex gap-8">
              <nav className="w-44 shrink-0 space-y-1 text-sm">
                {(["inbox", "archived"] as const).map((b) => (
                  <button key={b} onClick={() => setBox(b)} className={cn("flex w-full justify-between rounded px-3 py-1.5", box === b ? "bg-muted font-semibold" : "text-muted-foreground")}>
                    {b === "inbox" ? "Inbox" : m.term}
                    <span>{b === "inbox" ? m.inbox.filter((n) => !n.read).length || "" : ""}</span>
                  </button>
                ))}
                <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase text-muted-foreground">Role</div>
                {(["All", ...roles] as const).map((r) => (
                  <button key={r} onClick={() => setRole(r)} className={cn("flex w-full justify-between rounded px-3 py-1.5", role === r ? "bg-muted font-semibold" : "text-muted-foreground")}>
                    {r}
                    <span>{source.filter((n) => (r === "All" || n.role === r) && !n.read).length || ""}</span>
                  </button>
                ))}
              </nav>
              <div className="flex-1">
                <div className="mb-2 flex items-center gap-3 border-b pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={list.length > 0 && list.every((n) => selected.has(n.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(list.map((n) => n.id)) : new Set())}
                  />
                  {selected.size > 0 ? (
                    <>
                      <span className="text-muted-foreground">{selected.size} selected</span>
                      {box === "inbox" && (
                        <>
                          <button className="hover:underline" onClick={() => { list.filter((n) => selected.has(n.id)).forEach((n) => !n.read && m.toggleRead(n)); setSelected(new Set()); }}>Mark as read</button>
                          <button className="hover:underline" onClick={() => { list.filter((n) => selected.has(n.id)).forEach(m.archive); setSelected(new Set()); }}>{m.term}</button>
                        </>
                      )}
                    </>
                  ) : (
                    box === "inbox" && (
                      <>
                        <button className="hover:underline" onClick={m.markAllRead}>Mark all as read</button>
                        <button className="hover:underline" onClick={m.archiveAllRead}>{m.term} all read</button>
                      </>
                    )
                  )}
                </div>
                {list.length === 0 && <p className="py-12 text-center text-muted-foreground">You're all caught up.</p>}
                <table className="w-full text-sm">
                  <tbody>
                    {list.map((n) => (
                      <tr key={n.id} className={cn("group border-b", !n.read && "font-semibold")}>
                        <td className="w-6 py-2.5 align-top">
                          <input type="checkbox" checked={selected.has(n.id)} onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(n.id) : s.delete(n.id); setSelected(s); }} />
                        </td>
                        <td className="w-36 py-2.5 align-top"><RoleChip role={n.role} kind={n.kind} /></td>
                        <td className="cursor-pointer py-2.5 hover:underline" onClick={() => m.open(n)}>
                          {n.text}
                          <div><StaleLine n={n} /></div>
                        </td>
                        <td className="w-24 py-2.5 text-right align-top">
                          <span className="text-xs font-normal text-muted-foreground group-hover:hidden">{ago(n.minutesAgo)}</span>
                          <span className="hidden justify-end gap-1 group-hover:flex">
                            {n.archived ? (
                              <button onClick={() => m.unarchive(n)} title="Move back to inbox"><RotateCcw className="size-4" /></button>
                            ) : (
                              <>
                                <button onClick={() => m.toggleRead(n)} title={n.read ? "Mark as unread" : "Mark as read"}><Check className="size-4" /></button>
                                <button onClick={() => m.archive(n)} title={m.term}><Archive className="size-4" /></button>
                              </>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Variant C
// Floating bell top-right of the page; a full-height drawer grouped by time.
// Clicking a Notification expands it in place with a "Go" link; a big
// per-item button does the archive.

function VariantC({ m }: { m: Model }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (open) m.markAllSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, m.items.length]);

  const list = showArchived ? m.archived : m.inbox;
  const groups = [
    { label: "New", items: list.filter((n) => !n.read) },
    { label: "Earlier", items: list.filter((n) => n.read) },
  ];

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed right-5 top-4 z-50 flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-md hover:bg-muted"
      >
        <Bell className="size-4" />
        {m.badge > 0 ? <span className="font-semibold">{m.badge} new</span> : <span className="text-muted-foreground">No new</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpen(false)} />
          <aside className="fixed inset-y-0 right-0 z-50 flex w-[26rem] flex-col border-l bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b p-4">
              <h2 className="text-lg font-semibold">{showArchived ? m.term : "Notifications"}</h2>
              <div className="flex items-center gap-3 text-xs">
                {!showArchived && <button onClick={m.markAllRead} className="text-primary hover:underline">Mark all as read</button>}
                <button onClick={() => setShowArchived((s) => !s)} className="text-muted-foreground hover:underline">
                  {showArchived ? "← Inbox" : `View ${m.term.toLowerCase()}`}
                </button>
                <button onClick={() => setOpen(false)}><X className="size-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {groups.map((g) =>
                g.items.length === 0 ? null : (
                  <section key={g.label}>
                    <h3 className="sticky top-0 bg-background/95 px-4 pb-1 pt-3 text-xs font-semibold uppercase text-muted-foreground">{g.label}</h3>
                    {g.items.map((n) => (
                      <div key={n.id} className={cn("mx-2 mb-1 rounded-lg border p-3", !n.read && "border-primary/40 bg-primary/5")}>
                        <button
                          className="w-full text-left"
                          onClick={() => {
                            setExpanded(expanded === n.id ? null : n.id);
                            if (!n.read) m.toggleRead(n);
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <RoleChip role={n.role} kind={n.kind} />
                            <span className="text-[11px] text-muted-foreground">{ago(n.minutesAgo)} ago</span>
                          </div>
                          <p className={cn("mt-1.5 text-sm", expanded !== n.id && "line-clamp-1")}>{n.text}</p>
                          <StaleLine n={n} />
                        </button>
                        {expanded === n.id && (
                          <div className="mt-3 flex gap-2">
                            <button onClick={() => m.open(n)} className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                              <ExternalLink className="size-3.5" /> Go to it
                            </button>
                            {n.archived ? (
                              <button onClick={() => m.unarchive(n)} className="rounded-md border px-3 py-1.5 text-xs">Move to inbox</button>
                            ) : (
                              <>
                                <button onClick={() => m.archive(n)} className="rounded-md border px-3 py-1.5 text-xs">{m.term}</button>
                                <button onClick={() => m.toggleRead(n)} className="rounded-md border px-3 py-1.5 text-xs">Mark as unread</button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                )
              )}
              {list.length === 0 && <p className="p-10 text-center text-sm text-muted-foreground">You're all caught up.</p>}
            </div>
          </aside>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- controls + state

function Controls({ m }: { m: Model }) {
  const [showState, setShowState] = useState(true);
  const select = "rounded bg-white/10 px-1 py-0.5 text-white [&>option]:text-black";
  return (
    <div className="w-[40rem] rounded-xl bg-black/90 p-3 text-xs text-white shadow-xl ring-2 ring-fuchsia-500">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label>Badge counts{" "}
          <select className={select} value={m.badgeRule} onChange={(e) => m.setParam("badge", e.target.value)}>
            <option value="unread">unread</option>
            <option value="unseen">unseen (clears on open)</option>
          </select>
        </label>
        <label>Archive term{" "}
          <select className={select} value={m.term} onChange={(e) => m.setParam("term", e.target.value)}>
            {TERMS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Other Admin decides{" "}
          <select className={select} value={m.staleRule} onChange={(e) => m.setParam("stale", e.target.value)}>
            <option value="keep">leave as is</option>
            <option value="mark">mark decided + read</option>
            <option value="clear">mark decided + auto-archive</option>
          </select>
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={m.simulateIncoming} className="rounded bg-fuchsia-600 px-2 py-1">+ New Notification (poll)</button>
        <button onClick={m.simulateOtherAdminDecides} className="rounded bg-fuchsia-600 px-2 py-1">Another Admin decides a Refund Request</button>
        <button onClick={m.reset} className="rounded bg-white/10 px-2 py-1">Reset</button>
        <button onClick={() => setShowState((s) => !s)} className="ml-auto rounded bg-white/10 px-2 py-1">{showState ? "Hide" : "Show"} state</button>
      </div>
      {showState && (
        <div className="mt-2 grid grid-cols-[1fr_12rem] gap-3 font-mono text-[10px]">
          <table className="w-full">
            <thead className="text-white/50"><tr><td>#</td><td>role · kind</td><td>seen</td><td>read</td><td>{m.term.toLowerCase()}d</td><td>stale</td></tr></thead>
            <tbody>
              {m.items.map((n) => (
                <tr key={n.id} className={n.archived ? "text-white/40" : ""}>
                  <td>{n.id}</td><td>{n.role} · {n.kind}</td><td>{n.seen ? "✓" : "·"}</td><td>{n.read ? "✓" : "·"}</td><td>{n.archived ? "✓" : "·"}</td><td>{n.staleNote ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <div className="text-white/50">badge = {m.badge} ({m.badgeRule})</div>
            {m.log.map((l, i) => <div key={i} className={i ? "text-white/50" : ""}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

const VARIANTS = [
  { key: "A", name: "Sidebar bell + dropdown" },
  { key: "B", name: "Inbox page" },
  { key: "C", name: "Floating bell + drawer" },
];

export function NotificationsPrototype() {
  const [params] = useSearchParams();
  const variant = params.get("variant") ?? "A";
  const m = useNotificationsModel();
  if (import.meta.env.PROD) return null;
  return (
    <>
      {variant === "A" && <VariantA m={m} />}
      {variant === "B" && <VariantB m={m} />}
      {variant === "C" && <VariantC m={m} />}
      <PrototypeSwitcher variants={VARIANTS}>
        <Controls m={m} />
      </PrototypeSwitcher>
    </>
  );
}
