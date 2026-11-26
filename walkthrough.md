# Security Summary

**Reviewed Files**: 11 (`server.ts`, `server/auth.ts`, `server/db.ts`, `server/routes.ts`, `server/schema.mysql.sql`, `src/lib/api.ts`, `src/lib/useRealtimeSync.ts`, `src/App.tsx`, `src/components/AdminAuditView.tsx`, `src/components/HrPayrollView.tsx`, `src/types.ts`)
**Issues Resolved**: 16

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Broken Break-Glass & Diagnostic Ownership | `server/routes.ts` | 4630 | Lab/imaging reports and attachments rejected requests with `!access.allowed \|\| !access.breakGlassActive`, blocking assigned doctors and ignoring `doctor_assignments`. | High | Fixed | Checked primary `visits.doctor_id`, active `doctor_assignments`, and `!access.allowed` so assigned doctors and valid Break-Glass holders work cleanly while unassigned doctors receive `403`. |
| Missing Doctor Assignment & Ownership Gates | `server/routes.ts` | 4019, 4194, 4520, 5900, 6210, 6265, 6492 | Nursing procedure creation, order cancellation, lab critical acknowledgement, IPD overview/statement/medication/rounds/discharge, and lab turnaround reports lacked doctor-patient scoping. | High | Fixed | Applied `authorize(..., { checkDoctorAssignment: true })` and `isDoctorOnly` / `assertPatientAccess` ownership guards across these clinical, diagnostic, IPD, and reporting endpoints. |
| Stored SVG Upload Script Execution | `server/routes.ts` | 4682 | Imaging attachment uploads permitted `image/svg+xml` data URLs, allowing active scripts to be stored inside uploaded attachments. | High | Fixed | Removed `image/svg+xml` from the allowed MIME whitelist and restricted uploads to verified raster images (`png`, `jpeg`, `webp`, `gif`) and PDFs (`application/pdf`). |
| Client Session Token Persistence | `src/lib/api.ts` | 1 | Session JWTs were stored in browser `localStorage`, exposing tokens to any client-side script read and bypassing cookie lifecycle controls. | High | Fixed | Replaced `localStorage` persistence with `HttpOnly` session cookies (`clinic360_session`), in-memory-only fallback, `credentials: 'include'`, and `Origin`/`Host` validation on cookie-authenticated mutations. |
| HR Offboarding & Re-Hire Access Gaps | `server/routes.ts` | 11252 | `resigned` status was missing from HR offboarding schema/logic, HR re-hire risked bypassing admin approval, and admin activation did not check HR employment status. | High | Fixed | Expanded `hr_employees.status` to include `'resigned'`, enforced real-time HR status verification in `loadUserContext` and `/auth/login`, revoked sessions immediately on offboarding, kept linked users inactive on re-hire pending explicit admin activation (`access_review_required = 1`), and blocked admin activation (`409`) if HR status is offboarded. |
| Duplicate Non-Exception Account Race | `server/db.ts` | 1529 | One-account-per-employee rule was checked in application code without a database uniqueness constraint. | Medium | Fixed | Added partial unique index `idx_users_emp_one_account` on `users(employee_id) WHERE employee_id IS NOT NULL AND exception_approved = 0`. |
| Unbounded State Transitions (Closed Visit / Discharged IPD / Cancelled Rx / Finalized Imaging) | `server/routes.ts` | 3898, 4132, 4696, 5050, 5250, 6023 | Vitals, vitals corrections, nursing procedure completion, attachments on `reported_final` imaging, cancelled prescription billing/dispensing, and post-discharge IPD actions could execute on terminal records. | Medium | Fixed | Added `409 Conflict` terminal-state guards for closed visits, discharged admissions, duplicate MAR administration, cancelled prescriptions, and finalized/cancelled imaging orders. |
| Missing 2FA & Password Reset Rate Limits | `server/routes.ts` | 964, 1031 | `/auth/verify-2fa` and `/auth/forgot-password` lacked per-IP/per-account rate throttling, and password reset/change left prior sessions active. | Medium | Fixed | Added sliding-window `429` rate limiters on `/auth/verify-2fa`, `/auth/forgot-password`, and `/auth/reset-password`, and called `revokeAllUserSessions` on password reset and change. |
| Weak Password Policy & Low Bcrypt Cost | `server/auth.ts` | 160 | User creation, admin password resets, and password changes did not enforce `settings.security` length/mixed-case policies and used bcrypt cost 10. | Medium | Fixed | Added `validatePasswordPolicy()` enforcing minimum length and mixed-case rules from clinic security settings and standardized password hashing on `bcrypt.hash(..., 12)`. |
| Unvalidated Negative Billing & Approval Amounts | `server/routes.ts` | 6822, 7279 | Invoice line items and discount/refund approval requests could accept negative or non-finite quantities/prices or target already voided/refunded invoices. | Medium | Fixed | Validated finite positive quantities, non-negative unit prices, positive discount/refund amounts, and active invoice state on creation and approval decisions. |
| Interpolated Audit Pagination & Unvalidated Report Dates | `server/routes.ts` | 8635, 9210 | `GET /audit-logs` interpolated `LIMIT`/`OFFSET` into SQL and `GET /reports/:type` accepted arbitrary date strings without format checks. | Low | Fixed | Switched audit log pagination to bound SQL parameters (`LIMIT ? OFFSET ?`) and enforced `YYYY-MM-DD` validation on report `from`/`to` parameters. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Dependency Audit | `bun.lock` | `bun audit` checked 325 packages with zero reported vulnerabilities. |
| Session & Cookie Lifecycle | `server/auth.ts` | Signs JWTs with unique `jti`, records rows in `user_sessions`, checks `revoked_tokens`/`user_sessions.revoked_at` on every request, sets `HttpOnly` cookies, and clears them on logout. |
| Cross-Origin Mutation Defense | `server/auth.ts` | Cookie-authenticated state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) without a `Bearer` header require `Origin`/`Referer` host to match `Host`/`X-Forwarded-Host`. |
| Tamper-Evident Audit Chain | `server/auth.ts` | Appends SHA-256 hash-chained records to `audit_logs` on every auth, HR offboarding, admin, clinical, and financial action (`verifyAuditChain` passes cleanly). |
| Parameterized Database Access | `server/db.ts` | All SQLite and MySQL queries execute through parameterized `?` bindings via `query`, `queryOne`, and `execute`. |

---

## PoC Verification

### Unassigned Clinician Diagnostic Report Access & Break-Glass Override
#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Object-Level Authorization & Inverted Break-Glass Guard |
| Impact | High |
| Affected File | `server/routes.ts:4902` |
| Test Scenario | Primary doctor (`doc@clinic360.local`), co-assigned doctor via `doctor_assignments` (`offboard.staff@clinic360.local`), and unassigned doctor (`doc2@clinic360.local`) request `GET /api/lab/orders/:id/report`, `GET /api/imaging/orders/:id/report`, and `GET /api/imaging/orders/:id/attachments`. |

#### How It Was Fixed
Updated diagnostic report and attachment handlers to permit `visits.doctor_id` and active `doctor_assignments` entries directly, while rejecting unassigned clinicians whenever `!access.allowed` unless an active Break-Glass grant exists.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Co-assigned doctor requests `GET /api/lab/orders/:id/report` and `GET /api/imaging/orders/:id/attachments` | `doctor_assignments` query finds active assignment; returns `200` |
| 2 | Unassigned `doc2` requests the same lab/imaging report and attachment routes without Break-Glass | `doctor_id` and `doctor_assignments` do not match; `!access.allowed` triggers at `server/routes.ts:4646` / `4929` |
| 3 | `doc2` logs clinical reason via `POST /api/patients/:id/break-glass` and retries | `assertPatientAccess` resolves `allowed: true`; returns `200` |

#### Conclusion
**Fix Verified** — Assigned clinicians retain seamless access while unassigned clinicians are blocked (`403`) unless an audited Break-Glass grant is active.

---

### Cookie-Only Cross-Origin CSRF & Session Revocation
#### Summary
| Field | Value |
|---|---|
| Issue Type | Session Cookie CSRF & Token Storage Exposure |
| Impact | High |
| Affected File | `server/auth.ts:365`, `src/lib/api.ts:1` |
| Test Scenario | State-changing `POST /api/notifications/read-all` sent with `clinic360_session` cookie and `Origin: https://evil.example`, followed by `POST /api/auth/logout` and replay of the cookie. |

#### How It Was Fixed
Moved session handling to `HttpOnly` cookies with `credentials: 'include'`, removed `localStorage` token storage from `src/lib/api.ts`, added Origin/Host verification in `requireAuth`, and revoked `jti` on logout.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Client signs in via `/api/auth/login` | `Set-Cookie: clinic360_session=...; HttpOnly` issued; `GET /api/auth/me` via cookie succeeds (`200`) |
| 2 | Forged `POST` arrives with `clinic360_session` cookie and `Origin: https://evil.example` | Host mismatch check at `server/auth.ts` blocks request before route logic (`403`) |
| 3 | User calls `POST /api/auth/logout` and replays cookie to `GET /api/auth/me` | `revokeToken` marks `user_sessions.revoked_at` and clears cookie; replay returns `401` |

#### Conclusion
**Fix Verified** — Cookie-based sessions are protected against cross-origin state changes and invalidated immediately upon sign-out.

---

### HR Offboarding Immediate Revocation & Re-Hire Safeguard
#### Summary
| Field | Value |
|---|---|
| Issue Type | Stale Access After Employment Offboarding or Premature Re-Hire Activation |
| Impact | High |
| Affected File | `server/routes.ts:11252`, `server/auth.ts:184` |
| Test Scenario | HR marks active linked employee `resigned` via `PATCH /api/hr/employees/:id/status`, active session and login/reset endpoints are tested, Admin tries premature activation, then HR marks employee `active` (re-hire). |

#### How It Was Fixed
Offboarding (`inactive`, `resigned`, `terminated`) immediately deactivates linked user accounts, revokes all `user_sessions`, blocks `loadUserContext` / `/auth/login` / `/auth/forgot-password` in real time, preserves historical visits/invoices/audit rows, and leaves linked accounts disabled (`access_review_required = 1`) on HR re-hire until explicit Admin activation.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | HR submits `PATCH /api/hr/employees/:id/status` with `{ status: 'resigned', reason: '...' }` | `users.active = 0`, `user_sessions` revoked, notification & immutable audit log created (`200`) |
| 2 | Offboarded clinician replays Bearer/cookie to `/api/auth/me` or attempts `/api/auth/login` | Session returns `401`; login returns `403`; `/api/auth/forgot-password` omits `devResetToken` |
| 3 | Admin attempts `PATCH /api/admin/users/:id/status` (`activate`) while HR record is `resigned` | Server returns `409 Conflict` blocking activation |
| 4 | HR marks employee `active` (re-hire), then Admin explicitly activates user | User remains `active = 0` after HR re-hire (`403` on login) until Admin activation (`200`), after which login succeeds while clinical/invoice history remains intact |

#### Conclusion
**Fix Verified** — Offboarding revokes active access immediately without deleting historical records, and re-hired accounts cannot authenticate until explicitly approved by System Administration.

---

### Diagnostic, Clinical, IPD, and Billing State-Machine Integrity
#### Summary
| Field | Value |
|---|---|
| Issue Type | Stored SVG XSS, Terminal Record Mutation, and Negative Amount Tampering |
| Impact | High |
| Affected File | `server/routes.ts:4682`, `server/routes.ts:5050`, `server/routes.ts:6265`, `server/routes.ts:6822` |
| Test Scenario | Upload `image/svg+xml` payload, upload PNG to `reported_final` imaging order, bill/dispense `cancelled` Rx, post vitals to `closed` visit, post rounds/notes/vitals/bed-accrual/clear to `discharged` admission, and submit negative `unit_price` invoice. |

#### How It Was Fixed
Restricted attachment uploads to validated raster/PDF signatures on non-terminal orders, enforced `409` state guards on terminal clinical/pharmacy/IPD records, and rejected negative or non-finite billing quantities/amounts with `400`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `POST /api/imaging/orders/:id/attachments` receives `image/svg+xml` or targets `reported_final` order | Rejected with `400` for disallowed MIME and `409` for finalized order |
| 2 | `POST /api/pharmacy/prescriptions/:id/bill` & `/dispense/:id` target `cancelled` Rx; vitals target `closed` visit; IPD actions target `discharged` admission | All terminal-state mutations return `409 Conflict` |
| 3 | `POST /api/billing/invoices` receives `unit_price: -50` | Validation guard returns `400 Bad Request` before any invoice or journal entry is created |

#### Conclusion
**Fix Verified** — Unsafe attachment payloads, post-closure clinical/IPD mutations, cancelled prescription workflows, and negative financial inputs are consistently blocked.
