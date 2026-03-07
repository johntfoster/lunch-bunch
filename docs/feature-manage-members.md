# Feature: In-App Member Management

## Overview

Replace the email-based member approval flow with an in-app "Manage Members" screen accessible to group managers (paid subscribers). Managers can approve pending requests, view current members, and remove members — all from within the app.

## Motivation

The current flow sends approval emails via SendGrid when someone requests to join a group. This has several problems:
- Emails from `johntfosterjr@gmail.com` land in spam (no custom domain)
- SendGrid free trial expires Apr 18, 2026
- Manager must leave the app to approve members
- No way to remove existing members
- No visibility into who's in the group

In-app management is simpler, faster, and eliminates the SendGrid dependency for approvals.

## Current State

### Joining Flow
1. User selects a group from the dropdown
2. If not a member, a `pendingMembers/{uid}` doc is created
3. `onPendingMemberCreated` Cloud Function fires → sends email to all managers via SendGrid
4. Manager clicks approve/deny link in email → `approveMember` HTTP Cloud Function processes it
5. Alternatively, managers already see a "Pending Member Requests" banner on the voting screen with Approve/Deny buttons

### Data Model
- `groups/{groupId}/members/{userId}` — approved members (`email`, `displayName`, `joinedAt`)
- `groups/{groupId}/pendingMembers/{userId}` — pending requests (`email`, `displayName`)
- `groups/{groupId}` → `managers: [email1, email2, ...]` — array of manager emails

## Proposed Design

### UI: "Manage Members" Section in Settings

Add a new section in the Settings modal, visible only to managers, below the existing restaurant management section.

```
┌─────────────────────────────────┐
│  ← Settings                     │
│                                 │
│  Voting closes at: [11:50]      │
│                                 │
│  Restaurants                    │
│  [restaurant list...]           │
│                                 │
│  ─────────────────────────────  │
│                                 │
│  Members (6)                    │
│                                 │
│  ⏳ PENDING (2)                 │
│  ┌─────────────────────────┐   │
│  │ Jane Doe                │   │
│  │ jane@utexas.edu         │   │
│  │ [Approve]  [Deny]       │   │
│  ├─────────────────────────┤   │
│  │ Bob Smith               │   │
│  │ bob@utexas.edu          │   │
│  │ [Approve]  [Deny]       │   │
│  └─────────────────────────┘   │
│                                 │
│  ✅ ACTIVE (4)                  │
│  ┌─────────────────────────┐   │
│  │ John Foster ⭐ Manager  │   │
│  │ johntfosterjr@gmail.com │   │
│  ├─────────────────────────┤   │
│  │ Alice Johnson           │   │
│  │ alice@utexas.edu        │   │
│  │                [Remove] │   │
│  ├─────────────────────────┤   │
│  │ Charlie Brown           │   │
│  │ charlie@utexas.edu      │   │
│  │                [Remove] │   │
│  └─────────────────────────┘   │
│                                 │
│  Share invite link: [Copy]      │
│                                 │
│  ─────────────────────────────  │
│  Push Notifications             │
│  ...                            │
└─────────────────────────────────┘
```

### Section Details

#### Pending Members
- Show count badge: "⏳ PENDING (2)"
- Each row: name, email, Approve + Deny buttons
- Same functionality as the current voting screen banner
- **Remove the voting screen pending banner** — consolidate here
- Push notification to manager when new request arrives (optional, future)

#### Active Members
- Show count: "✅ ACTIVE (4)"
- Each row: name, email
- Managers get a "⭐ Manager" badge — **cannot be removed**
- Non-manager members get a "Remove" button
- Remove = delete from `members` subcollection, show confirmation toast
- Sort: managers first, then alphabetical by name

#### Invite Link (Optional / Future)
- Deep link or group code that new users can use to request membership
- Copy to clipboard button
- Not required for v1

### Behavioral Changes

#### What stays the same
- `approveMember` HTTP Cloud Function — keep it for backward compatibility with existing email links
- `onPendingMemberCreated` Cloud Function — keep sending emails for now (can be disabled later when custom domain isn't needed)
- Pending members can still be approved from the voting screen banner OR Settings (both update the same Firestore docs)

#### What changes
- **Voting screen**: Remove the pending members banner (move to Settings)
- **Settings**: Add "Members" section (manager-only)
- **New**: Ability to remove active members from a group
- **New**: View all group members in one place

### Edge Cases

1. **Manager removes themselves** — prevent this; managers can't remove themselves
2. **Last member removed** — allowed; group can be empty
3. **Removing a member who's currently viewing the group** — their next Firestore read will fail the membership check, redirecting them to group selection. Show them a toast: "You've been removed from [group name]"
4. **Concurrent approve/deny** — Firestore transactions aren't needed; worst case is a "not found" toast
5. **Offline** — standard Firestore offline behavior; operations queue and sync

## Implementation Plan

### Phase 1: Core Member Management (implement now)

| # | Task | File | Effort |
|---|---|---|---|
| 1 | Add "Members" section HTML in Settings (manager-only) | `src/index.html` | Medium |
| 2 | Add CSS for member list, member rows, badges, remove button | `src/index.html` | Small |
| 3 | `loadGroupMembers()` — fetch members + pending, render lists | `src/index.html` | Medium |
| 4 | `removeMember(userId)` — delete from members subcollection, confirmation | `src/index.html` | Small |
| 5 | Move approve/deny from voting screen banner to Settings section | `src/index.html` | Small |
| 6 | Call `loadGroupMembers()` when Settings opens (if manager) | `src/index.html` | Small |
| 7 | Update Firestore rules: allow manager to delete members | `firestore.rules` | Small |
| 8 | Add tests for member removal | `functions/__tests__/` | Small |

**Estimated total: 2-3 hours**

### Phase 2: Polish (future)

| # | Task | Effort |
|---|---|---|
| 9 | Push notification to manager on new join request | Medium |
| 10 | Invite link / group code for easy sharing | Medium |
| 11 | Remove SendGrid dependency (disable email notifications) | Small |
| 12 | "Transfer ownership" — allow manager to make another member a manager | Small |

### Phase 3: Advanced (future)

| # | Task | Effort |
|---|---|---|
| 13 | Multiple managers per group | Medium |
| 14 | Member roles (manager, member, viewer) | Large |
| 15 | Block list — prevent specific users from re-requesting | Small |

## Firestore Rules Changes

Current rules on `members`:
```
allow read: if request.auth != null;
allow create: if request.auth != null;
allow delete: only member themselves or manager
```

Need to ensure manager can delete any member:
```
allow delete: if request.auth.uid == memberId 
  || request.auth.token.email in get(/databases/$(database)/documents/groups/$(groupId)).data.managers;
```

This should already be covered by the security fixes on the dev branch. Verify before implementing.

## SendGrid Impact

- **Keep emails for now** — they're a backup notification channel
- **Future**: Once in-app management is solid, disable `onPendingMemberCreated` email sending
- **SendGrid trial expires**: Apr 18, 2026 — plan to have in-app management fully live before then

## Success Criteria

- [ ] Manager can see all members and pending requests in Settings
- [ ] Manager can approve/deny pending requests from Settings
- [ ] Manager can remove active members
- [ ] Manager cannot remove themselves or other managers
- [ ] Removed member is redirected on next app load
- [ ] Works on both web and iOS native
- [ ] No regression in existing join/approve flow
