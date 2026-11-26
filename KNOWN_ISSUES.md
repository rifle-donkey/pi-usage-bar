# Known issues

Open problems and external assumptions that offline tests cannot verify.

## What goes in this file

- **A. Lint findings:** Findings deferred from the change that introduced them.
- **B. Open issues:** Verified defects outside the current scope or deferred by the user.
- **C. Verification needed:** Implemented, tested code that depends on unverified external behavior.

Add or update an entry with its table row. Remove both when fixed or confirmed. If verification disproves an assumption, fix the code or record an open defect. Never reuse an entry ID.

| # | Priority | Location | Summary |
|---|---|---|---|
| C1 | High | `extensions/usage-bar.ts`, `src/usage.ts` | Cursor endpoint and pool labels need live verification |

## C. Verification needed

### C1. Cursor endpoint and pool labels need live verification (High)

- **Location:** `fetchCursor` in `extensions/usage-bar.ts` and `parseCursorUsage` in `src/usage.ts`.
- **Impact:** A failed request shows `usage unavailable` or stale usage. A field mapped to the wrong pool shows a valid number under the wrong label.
- **What is assumed:** Cursor accepts the Pi OAuth token for `GetCurrentPeriodUsage`. The fields `autoPercentUsed` and `apiPercentUsed` match Cursor Models and Other Models, respectively. `billingCycleEnd` is the reset in Unix milliseconds. Some plans may report only one pool.
- **Action:** After an authorized install, select a Cursor OAuth model. Confirm that the request succeeds and compare the border percentages and countdown to the “Included in subscription” section of the Cursor spending page. Check a plan that displays both pools. If they differ, confirm the response format without saving credentials or raw responses, then update the request or mapping and the offline tests.
