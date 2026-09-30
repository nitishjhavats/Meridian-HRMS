# Security policy

Meridian HRMS handles payroll, Aadhaar/PAN, bank details, location and face data.
We take vulnerability reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.**

- Preferred: use GitHub's private
  [vulnerability reporting](https://github.com/nitishjhavats/meridian-hrms/security/advisories/new)
  ("Report a vulnerability" on the Security tab).
- Or email **support@broadmate.org** with the subject `SECURITY`.

Include what you found, how to reproduce it, and the version/commit. We will
acknowledge your report, keep you updated, and credit you in the fix if you
wish. Please give us reasonable time to release a fix before disclosing.

## Scope

In scope: authentication and sessions, tenant isolation (one organisation
reading or writing another's data), RBAC/permission bypass, the encryption of
sensitive fields, file access, the jobs endpoint, and the attendance/face
checks.

Out of scope: findings that need a compromised server or database, missing
best-practice headers without a demonstrated impact, and denial of service by
volume.

## Running your own deployment

* Generate `AUTH_SECRET`, `PLATFORM_ENCRYPTION_KEY` and `JOBS_SECRET` fresh and
  keep them out of version control.
* Escrow `PLATFORM_ENCRYPTION_KEY`: losing it permanently loses encrypted data.
* Never run `db:seed` against a production database.
* Keep the database off the public internet.
