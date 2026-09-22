# Organizations, Members & Role-Based Planning — Design Doc

Status: **Phase 1 implemented** (org.js, index.html, style.css, firestore.rules,
firestore.indexes.json, firebase.json). Phases 2–7 still to build.
Owner: TBD
Related version: WorkTracker v6.3.0

## Phase 1 implementation notes
- The public lookup collection is `userProfiles/{uid}`, **not** `users/{uid}` —
  the existing `users/{uid}` collection already stores each person's entire
  private app data (tasks, sessions, projects, versions, plannerTasks), so it
  could not be made readable for the Gmail-lookup flow without leaking that
  data. `userProfiles` holds only email/displayName/photoURL.
- `firestore.rules` / `firestore.indexes.json` / `firebase.json` are drafted
  but **not deployed** — this repo has no Firebase CLI setup. Run
  `firebase login`, `firebase use worktracker-29228`, then
  `firebase deploy --only firestore` once, from the project root.
- Sole-admin protection (§9's `adminCount` mechanic) is implemented via a
  client-side Firestore transaction plus a Security Rule backstop; see the
  comments at the top of `firestore.rules`.

---

## 1. Goal

Turn Planner from a single-user tool into a shared, multi-user workspace, with
live real-time updates (plan changes, membership changes, everything) pushed
to everyone who has the org/plan open — like a lightweight GitHub-collaborators
model, not an invite/email system.

- Users can create an **Organization** and add **Employees** to it by their
  exact Gmail address (must already have a WorkTracker account — no invite
  emails; add/remove only, like adding a GitHub collaborator).
- A **Plan** (Project, in current code) can be shared by attaching a whole
  Organization to it, **and/or** by adding individual users to it directly —
  both at once are supported on the same plan.
- Every person has a **role**, scoped per Organization and per Plan:

  | Role | Permissions |
  |---|---|
  | **Admin** (Creator) | Full access. Manage members and their roles, manage the Organization/Plan itself (including Active/Inactive, see §9), plus everything a Planner can do. Cannot change their own role (must be changed by another Admin, if one exists). |
  | **Planner** | Edit the Plan: add/remove/edit tasks and versions. Reviews and resolves Developer change requests (per-item, see §6). Can view Inactive plans (Admin only can toggle them). Cannot manage members/roles. |
  | **Developer** | Full read access, can start working (track time). Cannot edit the plan directly — instead submits a **Change Request**, optionally batching several related changes into one submission. Max **10 pending requests** at a time, batches count as one (see §6.1). Loses visibility entirely if the plan goes Inactive. |
  | **Visitor** | Read-only. No editing, no requests, no time tracking. Loses visibility entirely if the plan goes Inactive. Default role for every newly added member — an Admin promotes them from here. |

This doc defines the target data model, the permission model, the missing
infrastructure, and a phased build plan. **Nothing here is implemented yet.**

---

## 2. Current State (why this is a bigger change than it looks)

Read directly from the codebase:

- **Auth**: Firebase Auth only. Google sign-in via system browser + a local
  `http://localhost:42831/auth` redirect (`main.js`), or Firebase email/password.
  There is exactly one `currentUser` in the whole app (`app.js`).
- **Data storage**: One JSON blob per user.
  - Offline: `%AppData%\worktracker\data.json` (via `main.js` `loadData`/`saveData`).
  - Signed in: the *entire* local state (`tasks`, `sessions`, `projects`, `versions`,
    `plannerTasks`) is written to a **single Firestore document** for that user
    (`saveData` in `app.js`) and read back with one listener (`initFirebase`).
  - There is **no per-record ownership, no sharing, no concept of "another user's
    data" anywhere.**
- **Planner data model** (`plannerState` in `app.js`):
  - `projects: []`, `versions: []` (each with `projectId`), `plannerTasks: []`
    (each with `versionId`, `priority`, `done`).
  - No `ownerId`, no `orgId`, no `members`, no `role` field on anything.
  - **Tasks/versions are hard-deleted today** (`deleteTask` in `app.js` splices
    the array) — no soft-delete, no history, no restore.
- **No backend beyond Firebase.** No `functions/` directory, no `firebase.json`,
  no Firestore Security Rules file in this repo.
- **No way to look up another user by email**, no presence system, no activity
  log, no request-counting mechanism, no archive/restore concept — all new
  infrastructure.

**Conclusion:** this needs a real backend restructure (new collections, Security
Rules, live listeners), not just new UI and local state.

---

## 3. Data Model

```
users/{uid}                              // public lookup doc, written at first sign-in
  email, displayName, photoURL

organizations/{orgId}
  name, color, createdAt
  createdBy: uid                          // the founding Admin

organizations/{orgId}/members/{uid}
  role: "admin" | "planner" | "developer" | "visitor"   // default "visitor" when added
  email, displayName, photoURL, addedBy, addedAt

organizations/{orgId}/activity/{activityId}            // org-level log
  type: "member_added" | "member_removed" | "member_left" | "role_changed" |
        "org_created"
  actorUid, actorDisplayName, targetSummary, createdAt

plans/{planId}                           // formerly "project" in Planner
  name, desc, color, createdAt
  createdBy: uid                          // becomes plan Admin automatically
  orgId: string | null                    // set if an Organization is attached
  directMembers: { [uid]: role }          // individually-added people; can
                                           // coexist with an attached orgId
  status: "active" | "inactive"           // NEW — default "active"; toggled
                                           // by Admin only, see §9

plans/{planId}/versions/{versionId}
  name, dueDate, pending, order, ...
  deleted: boolean, deletedAt, deletedBy  // NEW — soft delete, see §9

plans/{planId}/versions/{versionId}/tasks/{taskId}
  name, notes, priority, done, order, createdBy, ...
  deleted: boolean, deletedAt, deletedBy  // NEW — soft delete, see §9

plans/{planId}/changeRequests/{requestId}               // NEW shape — supports batches
  requestedBy: uid, requestedAt
  items: [
    {
      itemId, type: "add_task" | "edit_task" | "remove_task" | "update_due_date",
      targetTaskId / targetVersionId,                    // if targeting something existing
      proposedChange: { ...fields... },
      status: "pending" | "withdrawn" | "accepted" | "edited_and_accepted" | "rejected",
      resolvedBy, resolvedAt, resolutionNote
    },
    ...                                                   // 1+ items; a single-item
                                                            // request is just a batch of 1
  ]
  // The whole request counts as ONE toward the Developer's pending cap
  // (§6.1), no matter how many items it holds. Each item is resolved
  // independently by a Planner/Admin.

plans/{planId}/requestCounters/{uid}
  pendingCount: number                    // number of BATCHES (not items) with
                                           // at least one item still "pending";
                                           // Security Rules reject a new batch
                                           // if this is already 10

plans/{planId}/activity/{activityId}                    // plan-level log
  type: "member_added" | "member_removed" | "member_left" | "role_changed" |
        "task_added" | "task_edited" | "task_removed" | "task_restored" |
        "version_edited" | "version_removed" | "version_restored" |
        "request_submitted" | "request_item_resolved" |
        "plan_activated" | "plan_deactivated"
  actorUid, actorDisplayName, targetSummary, targetTaskId?, targetVersionId?,
  createdAt
  // targetTaskId/targetVersionId let the UI jump straight to the relevant
  // task (§7) or open the History panel if it's since been soft-deleted.

plans/{planId}/presence/{uid}
  displayName, photoURL, lastSeen: serverTimestamp()
```

**Effective role resolution for a user on a given plan:**
`plan.directMembers[uid]` (if individually added to this plan) — **overrides** —
`organizations/{plan.orgId}/members[uid].role` (if the plan has an attached org
and the user is a member of it) — else no access.

**Org role → plan role:** when an Organization is attached to a plan, each
member's org role is used as their assigned plan role by default (copied into
`directMembers` at add-time per §5's UX, not live-linked — see the note left
in §9 of the previous revision, now resolved: going with the simple
explicit-copy approach).

**Removed members / self-leave:** removal (by Admin) or leaving (by the member
themself) deletes the membership record only — `sessions`, `tasks`, and
`changeRequests` they created keep their `uid` and render as read-only
history. **A sole Admin cannot leave or remove themselves** — they must
promote another Admin first.

---

## 4. Role Permission Matrix

| Action | Admin | Planner | Developer | Visitor |
|---|:---:|:---:|:---:|:---:|
| View an **Active** plan | ✅ | ✅ | ✅ | ✅ |
| View an **Inactive** plan | ✅ | ✅ | ❌ (hidden entirely) | ❌ (hidden entirely) |
| Toggle plan Active ⇄ Inactive | ✅ | ❌ | ❌ | ❌ |
| Start/track time on a task | ✅ | ✅ | ✅ | ❌ |
| Add/edit/remove(soft) tasks & versions | ✅ | ✅ | ❌ | ❌ |
| View History panel & restore a deleted task/version | ✅ | ✅ | ❌ | ❌ |
| Submit a Change Request batch (up to 10 pending batches) | ✅ | ✅ | ✅ | ❌ |
| Edit/withdraw own batch while items are still pending | ✅ | ✅ | ✅ | ❌ |
| Accept / Edit & Accept / Reject an individual request item | ✅ | ✅ | ❌ | ❌ |
| Add/remove org or plan members | ✅ | ❌ | ❌ | ❌ |
| Change a member's role | ✅ | ❌ | ❌ | ❌ |
| Change **own** role | ❌ (needs another Admin) | ❌ | ❌ | ❌ |
| **Leave** the org/plan themselves | ✅ (unless sole Admin) | ✅ | ✅ | ✅ |
| Rename/delete the Organization or Plan | ✅ | ❌ | ❌ | ❌ |
| View Activity Feed (org & plan) | ✅ | ✅ | ✅ (plan only, own-relevant) | ✅ (plan only, own-relevant) |
| Export plan PDF/txt | ✅ | ✅ | ✅ | ✅ |

---

## 5. Attaching an Organization / Adding Members — Confirmed UX

1. **"Share this plan"** shows your Organizations as a list.
2. Clicking one opens a popup listing that org's members — avatar, name, and
   org-assigned role shown as the default. **A search/filter box** at the top
   of this popup (and of the plain org member-management list) lets you
   narrow by name/email once the list gets long.
3. **Select individually**, or **Select all** / **Deselect all**.
4. Per selected person, the Admin can change their role right in the popup
   before confirming, or leave it at their org-default — and can still change
   it later from the plan's member list.
5. Confirm → each selected person is added as a `directMembers[uid]` entry
   (explicit copy of their role at add-time, per §3).

---

## 6. Change Request Workflow (Batched)

1. A newly added member starts as **Visitor**; an Admin promotes them to
   **Developer** (or higher) from the members list.
2. A Developer's **"Request"** form lets them add **one or more items** in a
   single submission — e.g. "add task X" + "change due date on version Y" +
   "remove task Z" all bundled together — instead of filing three separate
   requests. This whole bundle is **one `changeRequests` doc**.
3. **While any item in the batch is still pending**, the Developer can edit or
   withdraw *individual items* or the whole batch. Once an item is resolved,
   that item is locked; other still-pending items in the same batch remain
   editable/withdrawable until they're resolved too.
4. A Planner/Admin reviews the batch **item by item** — each item gets its own
   **Accept / Edit & Accept / Reject**, independent of the others in the same
   batch. Nothing forces an all-or-nothing decision on a bundle.
5. The Developer is notified per item as each is resolved.

### 6.1 Soft Cap — 10 Pending Batches per Developer per Plan

- The cap is on **batches, not items** — bundling 5 related changes into one
  submission still only costs 1 of the Developer's 10 slots, so closely
  related edits don't eat the cap one at a time.
- A batch still counts against the cap as long as **at least one item** in it
  is unresolved; it frees up once every item has been accepted / edited &
  accepted / rejected / withdrawn.
- Enforced via `plans/{planId}/requestCounters/{uid}.pendingCount`,
  incremented on new-batch submit, decremented when a batch's last pending
  item is resolved — Security Rules reject a new batch if the count is
  already 10. UI shows "7 / 10 pending" and disables the button at the cap.

---

## 7. Activity Feed — Org & Plan

- Two feeds: `organizations/{orgId}/activity` (membership/role events at the
  org level) and `plans/{planId}/activity` (everything happening on a plan —
  membership, roles, task/version edits, soft-deletes/restores, requests,
  Active/Inactive toggles).
- Newest-first, live-updating list — reuses the Report page's card/list
  styling.
- **Clicking an activity entry jumps straight to the relevant task/version**
  when it still exists on the board; if the entry refers to something that's
  since been soft-deleted, clicking it opens the **History panel** (§9)
  scrolled to that item instead, so the entry is never a dead link.
- Visible to Admin/Planner in full; Developers/Visitors see a feed limited to
  entries relevant to them (their own requests, tasks they're tracking, etc.)
  — full member/role-management history is Admin/Planner-only, matching §4.

---

## 8. Presence — Live Viewer Avatars

- **Avatars only, no text**, stacked top-right of the plan board, each a small
  circular profile photo; hovering shows the name as a tooltip.
- Each client writes a heartbeat to `plans/{planId}/presence/{uid}` every
  ~20s while that plan is open, deletes it on clean close; a live listener
  filters out anything stale beyond ~60s (covers crashes without a server-side
  cleanup job, since Firestore has no `onDisconnect()` the way Realtime
  Database does).

---

## 9. Plan Archiving (Active/Inactive) & Soft-Delete History

Confirmed design, replacing all hard deletes in the shared-plan world:

- **Plans are never hard-deleted.** Every plan has `status: "active" |
  "inactive"`. **Only an Admin** can flip it (Planner cannot).
- **Inactive plans disappear entirely for Developers and Visitors** — not
  shown in their plan list, not reachable by direct link. **Admin and
  Planner can still open and view** an Inactive plan (read/manage access
  stays for them, so nothing is ever truly locked away from the people
  responsible for it).
- **Tasks and versions are soft-deleted, never hard-deleted**, within a plan:
  removing one sets `deleted: true` (+ who/when) instead of erasing the doc.
  It disappears from the normal board for everyone, but:
  - **Admin and Planner** have a **History panel** on the plan showing every
    soft-deleted task/version, with a **Restore** button that clears the
    `deleted` flag and logs a `task_restored`/`version_restored` activity
    entry.
  - Developers/Visitors never see the History panel — for them, a removed
    task is simply gone from the board, same as today's behavior.
- This, combined with §7's Activity Feed, means Admin/Planner always have a
  full log of **what happened** in a plan (and in the org) — who added/removed
  whom, who changed what role, every task/version add/edit/delete/restore,
  every request and its resolution, and every Active/Inactive toggle — nothing
  is silently lost.

---

## 10. Phase System

### Phase 1 — Organization Foundation
- `users/{uid}` public lookup doc, written at first sign-in.
- Security Rules skeleton (deny-by-default, then per-collection rules added
  as each phase needs them).
- Create Organization (creator = Admin automatically).
- Add member by exact Gmail → profile-card confirm → add as Visitor.
  "No account found" when there's no match.
- Remove member / change role (Admin only; Admin can't change their own).
- **Leave organization** (self-removal) for non-Admins; blocked for a sole
  Admin.
- **Search/filter box** on the org member list.
- Live member list (Firestore listener).
- Org-level Activity Feed (`organizations/{orgId}/activity`) — logs
  add/remove/leave/role-change events from this phase onward.

### Phase 2 — Plan Sharing
- Attach an Organization to a Plan via the popup flow in §5 (search/filter,
  select individually / select all / deselect all, per-person role override).
- Add individual (non-org) members directly to a Plan, coexisting with an
  attached org.
- Role resolution (`directMembers` per §3) enforced in both UI and Security
  Rules.
- Live plan/version/task sync.
- **Leave plan** (self-removal) for non-Admins.

### Phase 3 — Change Requests (Batched)
- Batch request form (1+ items per submission: Add/Change/Remove task, Update
  due date).
- Per-item edit/withdraw while pending; per-item Accept / Edit & Accept /
  Reject by Planner/Admin.
- **Soft cap**: 10 pending batches per Developer per plan (§6.1), with live
  "x / 10" counter UI.
- Notifications per resolved item, reusing the existing bell pattern.

### Phase 4 — Activity Feed (Full)
- `plans/{planId}/activity` populated by every action from Phases 1–3 plus
  Phase 6's archive/soft-delete events once that phase lands.
- Activity panel/tab on the plan page and org page, newest-first, live.
- **Click-to-jump**: entry → relevant task/version, or → History panel if
  soft-deleted (wired fully once Phase 6 exists; task/version links work
  immediately, History-panel linking completes in Phase 6).

### Phase 5 — Presence
- Heartbeat-based `presence` subcollection (§8).
- Stacked live-viewer avatars on the plan board, name-on-hover tooltip.

### Phase 6 — Plan Archiving & Soft-Delete History
- `status: active/inactive` on plans, Admin-only toggle, visibility rules
  enforced for Developer/Visitor (hidden entirely) vs Admin/Planner (still
  visible) in both UI and Security Rules.
- Soft-delete (`deleted` flag) on tasks/versions, replacing today's hard
  delete (`deleteTask` in `app.js` and the equivalent Planner task/version
  removal).
- **History panel** (Admin/Planner only) listing soft-deleted items with
  Restore.
- Wire up Activity Feed's click-to-jump for soft-deleted targets (§7).

### Phase 7 — Polish
- PDF export attribution ("requested by", "resolved by").
- Offline story for org/shared plans (online-only in v1, per earlier decision).
- Any follow-up items picked from §11 below.

---

## 11. More Suggestions

- **Confirm-to-delete / confirm-to-deactivate** on destructive-feeling actions
  (remove member, deactivate a plan) — reuse the existing `showConfirm` modal
  pattern already in `app.js`.
- **Role change also logs old → new role** in the activity entry text, so
  "why can I suddenly not edit this" is always answerable by scrolling the feed.
- **History panel filter** (by task name, by who deleted it, by date range)
  once a long-lived plan accumulates a lot of soft-deleted items.
- **Bulk restore** from the History panel, mirroring the org-popup's
  select-all pattern from §5.
- **Auto-suggest reactivating** — if an Admin opens an Inactive plan and
  starts editing it, a small prompt: "This plan is Inactive — reactivate it?"
  rather than requiring a separate trip to a settings toggle.

None of these are required — flag any you want folded into the phases above,
otherwise they can wait.

---

**Next step:** this design is now fully confirmed end-to-end. Say the word and
I'll start **Phase 1**.
