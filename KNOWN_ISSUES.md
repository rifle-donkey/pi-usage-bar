# Known issues

Open problems and external assumptions that offline tests cannot verify.

## What goes in this file

- **A. Lint findings:** Findings deferred from the change that introduced them.
- **B. Open issues:** Verified defects outside the current scope or deferred by the user.
- **C. Verification needed:** Implemented, tested code that depends on unverified external behavior.

Add or update an entry with its table row. Remove both when fixed or confirmed. If verification disproves an assumption, fix the code or record an open defect. Never reuse an entry ID.

| # | Priority | Location | Summary |
|---|---|---|---|
| B1 | Low | `extensions/usage-bar.ts` | A pending forced Cursor refresh can carry into the next session |
| B2 | Low | `extensions/usage-bar.ts` | A failed login lookup during a due tick can cause one extra Cursor request |
| C1 | High | `extensions/usage-bar.ts`, `src/usage.ts` | Cursor endpoint and pool labels need live verification |
| C2 | Low | `extensions/usage-bar.ts` | Cursor token refresh is assumed to keep the account `sub` claim |

## B. Open issues

### B1. A pending forced Cursor refresh can carry into the next session (Low)

- **Location:** the failed-lookup branch of `checkCursor` in `extensions/usage-bar.ts`, with the `session_start` handler.
- **Impact:** A forced Cursor check whose login lookup failed keeps its force after the session ends. If the next session first activates Cursor within 60 s, it sends one extra request, only after the account is confirmed. No wrong value is shown.
- **Recommendation:** In `session_start`, clear the Cursor entry's `discarded` mark when the new provider is not `cursor`, and add a test. Deferred by the user (2026-11-26).

### B2. A failed login lookup during a due tick can cause one extra Cursor request (Low)

- **Location:** the failed-lookup branch of `checkCursor` in `extensions/usage-bar.ts`.
- **Impact:** If a due tick's lookup fails while an activation request is still in flight, the force stays pending. After recovery, one extra request is sent about 60 s after the successful refresh.
- **Recommendation:** Keep the force only when no request is in flight (`check.force && !entry.inFlight`), and add a test. Deferred by the user (2026-11-26).

## C. Verification needed

### C1. Cursor endpoint and pool labels need live verification (High)

- **Location:** `fetchCursor` in `extensions/usage-bar.ts` and `parseCursorUsage` in `src/usage.ts`.
- **Impact:** A failed request shows `usage unavailable` or stale usage. A field mapped to the wrong pool shows a valid number under the wrong label.
- **What is assumed:** Cursor accepts the Pi OAuth token for `GetCurrentPeriodUsage`. The fields `autoPercentUsed` and `apiPercentUsed` match Cursor Models and Other Models, respectively. `billingCycleEnd` is the reset in Unix milliseconds. Some plans may report only one pool.
- **Action:** After an authorized install, select a Cursor OAuth model. Confirm that the request succeeds and compare the border percentages and countdown to the “Included in subscription” section of the Cursor spending page. Check a plan that displays both pools. If they differ, confirm the response format without saving credentials or raw responses, then update the request or mapping and the offline tests.

### C2. Cursor token refresh is assumed to keep the account `sub` claim (Low)

- **Location:** the Cursor account digest in `extensions/usage-bar.ts`.
- **Impact:** If a token refresh changes the `sub` claim, each refresh clears the Cursor value and forces a new request, as before this check existed. A failed request then shows `usage unavailable` instead of stale usage.
- **What is assumed:** A Pi token refresh for the same Cursor account returns an access token with the same `sub` claim.
- **Action:** After an authorized install, keep a Cursor OAuth model active across a token refresh. Confirm that the border keeps its value without an extra request. Do not save tokens or claims.
