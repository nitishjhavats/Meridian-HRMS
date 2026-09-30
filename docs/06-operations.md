# Operations

Everything you need to run a Meridian HRMS deployment without reading the source. Where a fact was
measured rather than assumed, the measurement is here too. Examples assume a container platform
(Coolify, Docker Compose, Kubernetes, anything that runs the `Dockerfile`); adapt the names.

---

## 1. What a deployment looks like

| | |
|---|---|
| **Application** | One container built from the `Dockerfile` (multi-stage, `node:22.16-bookworm-slim`) |
| **Port** | 3000, behind your reverse proxy / TLS terminator |
| **Memory** | 1 GB is enough to run; the *build* peaks higher (see the `Dockerfile`) |
| **Health check** | `GET /api/health` every 30 s, 5 s timeout, 3 retries — answers without touching the database, deliberately |
| **Database** | PostgreSQL 15+ (plain Postgres, or a Supabase instance), its own database or schema |
| **File storage** | `STORAGE_DRIVER=database` (default), `local` (a volume), or `supabase` (a private bucket) |
| **Migrations** | `prisma migrate deploy` from the container entrypoint, on every deploy |

The container also carries `curl`, which is not decoration: platform-generated healthchecks often
shell out to it *inside* the container, and `node:slim` ships neither `curl` nor `wget`. Without it
the container is permanently unhealthy, the proxy never routes to it, and the deploy rolls back
with a misleading error.

`TZ=Asia/Kolkata` is set on the container on purpose. Attendance day boundaries and payroll
periods derive from `new Date()`, and a UTC container renders every evening timestamp as the
previous day.

---

## 2. Deploying

Push to `main`; your platform builds and deploys.

Before every push, locally:

```bash
npm run verify
```

That is types, tests and a real `next build` — `tsc` alone does not catch a route file exporting
a non-handler, which reached a deploy once.

The service worker's cache is stamped with the build id at build time (`scripts/build-sw.mjs`,
wired as npm's `prebuild`), so an already-open tab is offered the update. If that ever stops
working, check that `SOURCE_COMMIT` is still reaching the Docker build — without it the stamp
falls back to a timestamp, which still changes but tells you nothing.

---

## 3. Scheduled work

One scheduled task (cron / your platform's scheduler) that calls the app from inside its network:

| | |
|---|---|
| Name | `maintenance` |
| Schedule | `0 3 * * *` |
| Command | `curl -fsS -m 300 -X POST -H "Authorization: Bearer $JOBS_SECRET" http://127.0.0.1:3000/api/jobs/run` |

It runs, and its last execution returned a real summary. What it does, from `src/lib/jobs.ts`:

- deletes attendance selfies past the retention window (default 60 days, set by the platform owner)
- clears each old attendance record's **coordinates, IP address and device details** on the same
  schedule — the attendance fact itself is kept, because that is payroll evidence
- deletes sign-in attempt records older than 90 days
- clears the IP and user agent from audit rows older than 180 days, keeping the row
- removes orphaned file rows and expired data exports
- prunes spent rate-limit rows

- flags whoever is due off probation this week, and purges chat messages past 30 days
- **closes the day** (round 14): for every ACTIVE organisation, for today and the seven days
  before it, each date whose marking window has passed in the organisation's own timezone (shift
  end + the close window, night shifts included) is closed: it writes an `ABSENT` row
  (`source: SYSTEM`, remark *No check-in recorded*) for every person on the roll with no row on a
  working day, and settles every `CHECKED_IN` row that never got a check-out through the
  organisation's *Missing check-out* rule (remark *No check-out recorded*) — for everybody,
  including people since resigned or deactivated, because the open row is theirs. Overridden
  rows, leave, rest days and anything already scored are never touched. Two blanks are left blank
  on purpose and counted in the summary: a working day covered by an **approved leave request
  with no row of its own** (payroll's leave net reads it as leave; an absent row would have
  docked a day already deducted), and a working day for somebody who **could not have marked by
  any path** (no work location where one is required, or self-marking off with no kiosk). Both
  writes are conditional, so a second run is a no-op. One audit line per organisation per night,
  only when something was written (`attendance.day_closed`). The schedule is `0 3 * * *` on the
  **container clock, which is IST** — the health check reports `lastRunAt` at 21:30Z, which is
  03:00 IST — so it closes yesterday for any shift whose window ends by 03:00 IST, and the
  following night otherwise. On its own the close never reaches before **18 September 2026**
  (`DAY_CLOSE_EPOCH`, the day it shipped): the blank working days before that stay blank unless
  an operator back-fills them with `close-attendance-days --from` after reading the dry run.
- stamps `PlatformSetting.lastMaintenanceAt`, **last**, so it means every step above finished

### Noticing when it stops

A container can be up and healthy for weeks while the cron quietly stops firing, and from outside
the two look identical — selfies stop ageing out, chat stops being purged at thirty days, and
nobody finds out until somebody asks why a deleted message is still there.

`GET /api/health?deep=1` answers it. It returns the database check as before plus:

```json
{"ok":true,"database":"up",
 "maintenance":{"lastRunAt":"2026-09-08T09:52:12.078Z","ageHours":0,"maxAgeHours":26,"stale":false},
 "faceMatching":{"state":"running","switchedOff":false,"modelsLoaded":true,"reason":null}}
```

and **503 when the last successful run is older than 26 hours** — one skipped night, not two — or
when it has never run at all, which is the honest answer on a fresh deployment.

`faceMatching.state` is the other thing that fails silently. If the ONNX models do not load,
`evaluateFaceMatch` treats it as the system's fault and lets attendance through — which is right,
because refusing everybody at the door over a missing file is worse — so the check that stops one
person marking another's attendance can simply be absent, with nothing to show for it but a line
in a boot log the next deploy throws away. `"broken"` is a **503**. `"off"` is not: that means
`FACE_MATCHING=off` is set, which is somebody's decision, and it is reported rather than alerted
on.

**Point an uptime check (UptimeRobot, Better Stack, a separate scheduled probe)
at `https://YOUR-DOMAIN/api/health?deep=1` and alert on non-200.** That is the whole
setup; nothing else is needed.

The endpoint is unauthenticated on purpose and says nothing about versions, hostnames or row
counts — only up/down and how long ago the last night ran.

**Do not point the container healthcheck at `?deep=1`.** the container healthcheck should probe the shallow
`/api/health` every thirty seconds, and that form is unchanged and always 200 while the process
is alive. A missed maintenance night must not restart a container that is serving people
correctly.

---

## 4. Backups — set these up before real payroll data goes in

**A payroll system without a tested restore is not deployed, it is gambling.** The application does
not back itself up; that belongs to the database and the platform underneath it.

Two decisions are yours:

**a) Where the dump is written.** The application container has no persistent volume, so anything
written inside it disappears on the next deploy — which is worse than no backup, because it looks
like one. Write from the Postgres side, onto a mounted volume.

**b) Where it goes off the box.** A dump on the same disk protects against the *common* failure — a
bad migration, an accidental delete, a mistaken bulk update — and not at all against losing the
disk. Off-site needs a destination and a credential: S3, Backblaze B2, or anything `rclone` speaks.

### A nightly dump

Run on the database host/container (which already carries `pg_dump`), with a volume mounted at
`/backups`:

```sh
sh -lc 'set -eu;
  mountpoint -q /backups || { echo "FATAL: /backups is not a mounted volume"; exit 1; };
  OUT=/backups/hrms-$(date +%Y%m%d-%H%M).sql.gz;
  pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$OUT";
  test -s "$OUT";
  gzip -t "$OUT";
  find /backups -name "hrms-*.sql.gz" -mtime +14 -delete;
  ls -lh "$OUT"'
```

The `mountpoint` line matters most: without it, a job that runs before the volume exists writes into
the container's own filesystem, reports success, and loses the file on the next deploy. The
`test -s` and `gzip -t` lines are the second guard: a `pg_dump` that dies part-way still leaves a
file, and a backup nobody verified is a backup that is not there.

### The restore drill — the part that makes it real

Do this once now, and once a quarter. A backup that has never been restored is an assumption.

```bash
createdb hrms_restore_test
gunzip -c hrms-YYYYMMDD-HHMM.sql.gz | psql hrms_restore_test
psql hrms_restore_test -c 'select count(*) from "Employee"'
psql hrms_restore_test -c 'select "periodYear","periodMonth","netPaise" from "PayrollItem" limit 5'
dropdb hrms_restore_test
```

The test is not "did it import" — it is **does a locked payroll run read back with the same
figures**. That is the only question a restore has to answer.

**Files are a separate problem.** The dump covers the database. If you use `STORAGE_DRIVER=local`
or `supabase`, uploaded documents, selfies and logos live outside it and need their own sync.

---

## 5. Secrets, and what breaks without them

| Variable | What it holds | If it is lost |
|---|---|---|
| `PLATFORM_ENCRYPTION_KEY` | AES-256-GCM key for PAN, Aadhaar, bank details, UAN, PF, TOTP secrets, AI keys, **face templates** | **The data is gone. Permanently.** Nothing can decrypt those columns without it. This needs a documented escrow — written down, held somewhere other than this server, by more than one person. |
| `AUTH_SECRET` | Signs session and impersonation tokens | Everybody is signed out. Recoverable — rotate and move on. |
| `DATABASE_URL` | Postgres connection | Nothing runs. |
| `JOBS_SECRET` | Bearer token for `POST /api/jobs/run` (≥32 chars; the route 404s without it rather than 401ing, so it does not advertise itself) | Retention stops running. No longer silently: `/api/health?deep=1` goes 503 once the last successful run is over 26 hours old. |
| `SUPABASE_SERVICE_ROLE_KEY` | Storage access | Uploads and downloads fail. |
| `OPENROUTER_API_KEY` | Platform fallback AI key | AI features fall back to each organisation's own key, or say they are unavailable. |
| `APP_URL` | The public origin, e.g. `https://hrms.example.com` | Sign-in links in credential handovers point at localhost; OG metadata resolves wrongly. |

Generate every secret fresh for each deployment. Never reuse the demo seed credentials in production.

---

## 6. Common tasks

**Set up an office device (kiosk).** Settings → Attendance rules → office devices. Creates a
`KIOSK` role account bound to one work location; the password shows once. It holds exactly two
permissions and no employee record, so it consumes no seat and can reach nothing but `/kiosk`.
Face matching is forced to `REQUIRED` there whatever the organisation's policy says — on a shared
device left unattended, an advisory check means anyone can tap anyone's name.

**Import employees.** Employees → Import. The dialog lists every column with what it accepts,
including the organisation's own departments, designations, locations, shifts and week-off
patterns — a cell has to name one that already exists. The downloadable template carries two
complete example rows filled with those same names, so it can be uploaded exactly as it arrives;
the second reports to the first, which is how the file shows that a manager may appear below the
person reporting to them. Annual CTC, Permanent From, Reports To, Login Role and Marks Own
Attendance are columns, so a bulk import produces people payroll can actually pay. Preview shows every row's errors
before anything is written; the commit rebuilds its decision from the file rather than trusting
what the browser sends back. Turn on "give them logins" to get a CSV of one-time passwords — and
delete that file once the credentials are handed over.

**Somebody is locked out.**
- An ordinary employee: their own administrator resets them from the employee profile.
- An organisation's owner or administrator: they request a code at `/forgot-password`, and the
  platform owner releases it from `/platform/password-resets`. There is no email in this product;
  the code is handed over directly, which is why the reset page says so.

**Support a customer.** Platform → Organisations → the organisation → *Sign in as* on a person.
Thirty minutes, a stated reason, and every action written to **that organisation's** audit log
naming the platform operator as well as the account. Optionally read-only.

**When payroll looks wrong.** The run page shows the trace for every figure — each line names the
rule that produced it. `npm run verify:money` drives calculate → approve → lock over HTTP and
checks the write-backs: advance recovery, adjustments, and reimbursements. If a figure disagrees
with a payslip, recalculate the run first — an adjustment or a reimbursement is an *input*, and
the numbers do not move until the engine reads it again.

---

## 7. One-off scripts, and where they have to run

Seven scripts change data rather than read it. They are written as `.mts` and run with `tsx`, which
works on a developer's machine and nowhere else — **this image ships neither TypeScript nor
`tsx`** (the build prunes the sources deliberately; see the comment in the `Dockerfile`), and the
database is reachable from inside the application container and essentially nowhere else.

So each one is bundled at build time with esbuild into `dist/`, exactly the way `prisma/seed.ts`
already is, and run with plain `node` inside the container.

**Every one of them is a dry run by default.** Without `--apply` they read, print what they
*would* change, and write nothing. Run the dry form first, read it, then run it again with
`--apply`. All six are safe to run twice.

The simplest way in is your platform's **terminal / exec into the application container**, which drops you inside
the running container with the working directory already at `/app`. There, drop the `docker exec
$C` prefix from every command below and run `node dist/<name>.mjs` directly.

From a shell on the server instead, find the container rather than hard-coding its name.

```bash
C=$(docker ps --filter name=YOUR-APP-NAME --format '{{.Names}}' | head -1)
```

| what it does | dry run | apply |
|---|---|---|
| Mask stored Aadhaar down to its last four digits | `docker exec $C node dist/mask-aadhaar.mjs` | `... --apply` |
| Encrypt blood group into its new column | `docker exec $C node dist/migrate-blood-group.mjs` | `... --apply` |
| Suggest a manager for anybody who has none | `docker exec $C node dist/backfill-reporting.mjs` | `... --apply` |
| Let frozen letter rows follow the shipped text again | `docker exec $C node dist/unfreeze-letters.mjs` | `... --apply` |
| Switch on every module an admin never switched off | `docker exec $C node dist/enable-modules.mjs` | `... --apply` |
| Widen old work locations to 150 m and enforce the fence | `docker exec $C node dist/set-attendance-fence.mjs` | `... --apply` |
| Close attendance days from a chosen date (a back-fill the owner asked for; the organisation must be ACTIVE) | `docker exec $C node dist/close-attendance-days.mjs --org=<slug> --from=YYYY-MM-DD` | `... --apply` |

`backfill-reporting`, `enable-modules` and `set-attendance-fence` also take `--org=<slug>` to do
one organisation at a time, which is the right way to try any of them the first time.
`close-attendance-days` *requires* it (or `--all`), and refuses with a message when that
organisation is not ACTIVE rather than reporting "nothing old enough to close": the dry run
prints every row it would write, person by person, and some of those absences will turn out to
be leave nobody recorded — that is a conversation to have with the owner before the rows exist.
It also lists, and counts, the working days it leaves blank on purpose: approved leave with no
row of its own, and people who could not have marked. The nightly job does the same for today
and the seven days before it on its own, never reaching before 18 September 2026; this script
exists for the days before that.

**Two of these cannot be undone.** `mask-aadhaar` throws away the digits it masks, and it is the
only copy — there is no backup inside the database. `migrate-blood-group` encrypts in place.
Neither should be run against production until a backup has been taken **and restored from**, so
that the restore is known to work rather than assumed to.

**`set-attendance-fence` refuses rather than locking anybody out.** It will not enforce the
geofence for an organisation where an active employee has no work location, and it names them
instead. `--force` overrides that, and the reason to have it is a deliberate decision, not a
convenience — an employee with no work location cannot mark attendance once the fence is on.

Locally, against a `.env` database, the same scripts keep their npm names and are unchanged:
`npm run mask:aadhaar`, `migrate:bloodgroup`, `backfill:reporting`, `unfreeze:letters`,
`modules:enable`, `fence:default`, `holidays:national`, `attendance:close`.

### What has already been applied, and to which organisations

Applied on 9 September 2026, after the round-6 deploy. Recorded here because the next person to
read this will want to know what state they are inheriting rather than what the scripts *would*
do.

| change | applied to |
|---|---|
| Duplicate active policy versions retired | one row, Jivonik's `ATTENDANCE` v1 — publishing never used to deactivate its predecessor |
| Modules switched on | every module that was written `false` at provisioning and never touched by an administrator. **Chat was one of them**, which is why its icon was dark on an organisation that predated the default |
| Check-in window 180 / 300 minutes | every organisation |
| Default radius 150 m | every organisation and every work location still on the old 100 m |
| Work locations assigned | Jivonik's three people onto *Nx one*; *Test* switched off, not deleted |
| Geofence enforced, face matching strict | **Jivonik only** |

**Two organisations were deliberately left permissive, and this is the interesting part.**
*KamaWell Ayurveda* and *Test* each have one active employee, no reference photo, and **no work
location at all**. Strict face matching there would refuse the face path — and the PIN path too,
because nobody may issue themselves a PIN. That is a locked door with nobody on the other side
of it. They get the window and the radius; the fence and the face wait until each has a branch
and an enrolled photo.

The two seeded demonstration organisations, `acme` and `bright-retail`, were deleted the same
day. They came from `prisma/seed.ts` and can be recreated with `ALLOW_DESTRUCTIVE_SEED=1`.

### The national holidays, applied the same day (round 7)

`seed-national-holidays` put Republic Day, Independence Day and Gandhi Jayanti on every calendar
for 2026 and 2027. Provisioning had seeded **no holidays at all** — right about festivals, whose
dates are regional and where a guess marks somebody absent on a day their office was shut, and
wrong about these three, which are the same date everywhere and close every establishment in the
country.

| organisation | before | after |
|---|---|---|
| jivonik | 1 — Independence Day 2026 | 6 |
| kamawell-ayurveda | none | 6 |
| test | none | 6 |

Seventeen rows created, one already there, nothing skipped: no date clash and no month with an
approved or locked payroll run. The script is additive by construction — a test asserts it
contains no delete or update — and it skips a closed payroll month for the same reason
`deleteHoliday` protects one.

**They can be switched off, and they come back every year.** Round 7 made them un-switchable and
that was one step too far — a plant running a shift on Republic Day is a real thing. Corrected in
the same round: they arrive on, they can be turned off, and they arrive again every January.

Those three only coexist because of `Organization.holidaysSeededThrough`. The maintenance job
seeds forward from that mark and moves it, so it never revisits a year — which is what makes a
holiday somebody deleted stay deleted rather than reappearing on the next run. The job adds and
never corrects: a holiday an administrator made unpaid or optional keeps whatever they set. An
organisation predating the column starts at the current year rather than at the beginning of
time, because filling 2019 would put holidays into months whose payroll closed years ago.

`seed-national-holidays` stays for the one-off case — an organisation restored from a backup, or
a year the job never covered.

### The geofence radius

The shipped default is **150 m**. It was tried at 100 and put back: measured on
the live instance, real marks land 8-65 m from the office, and 100 leaves a 65 m
arrival with 35 m of room, which is enough on paper and not enough for a car
park, a gate and a lift lobby.

**The GPS accuracy gate is a per-organisation switch, off by default.** It used
to be a constant, a third of the radius and never more than 35 m, applied to
every check-in with no way to turn it off, and it refused nothing but old phones:
on one live organisation the people it turned away were standing at the counter
with a phone that could not do better than ±50 m, and the refusal recorded
nothing. The distance to the fence is the fact that matters. The accuracy is
still stored with every mark and shown beside it in the review queue and the
grid, so a reviewer can see when a reading was rough, and an organisation that
wants the gate back turns it on under Settings → Attendance → *Require an
accurate GPS fix*, with its own limit.

Placing a branch's centre is the one place the budget still applies unasked:
that reading becomes the fence everybody else is measured against, so it has to
be a real fix, a third of the radius and between 15 and 35 m.

Only the column default moved. **No existing fence was changed by the deploy** —
tightening a live one refuses people who were accepted the day before, and that
belongs to the organisation rather than to a release. Change one on the branch
under Settings → Organisation.

### Reachability — `npm run verify:reachability`

Part of `npm run verify` since round 7. It reports things the product has built and nobody can
reach: an exported service function with no caller, an API route nothing fetches, a permission
that gates nothing, a schema column never read.

Its first run found thirty-eight. Six were duplicates and were deleted, two were real capability
and were wired up, eighteen were columns for features that were never built — **none of them
written either, so nothing was being stored and dropped**.

Each finding has three honest outcomes: wire it up, delete it, or write
`@unreachable-ok <reason>` in a comment **beside the declaration**. A waiver with no reason is
refused, because the script exists precisely because somebody could not tell whether a thing was
deliberate.

### The page sweep — `npm run verify:sweep`

Not part of `npm run verify` (it needs a running server); run it against the dev server before a
deploy that touches pages, or against production with `SWEEP_LOGINS`. Since round 13 it covers
every `(app)` page for six roles, the platform console as the superadmin, the kiosk as the device
account, and — the case no full-page load can show — **a dead session on a soft navigation**: the
owner is signed out server-side and every page is requested the way the client router requests it
(`RSC: 1`, the stale cookie); each must answer with a redirect to `/login`, never a rendered fault.

That last check exists because the layouts' login redirect does not run for a client-side
navigation, and sixty pages once threw straight into `error.tsx` when a session had lapsed —
"Something went wrong" every morning, in an installed app with no address bar to reload from.

### The visual pass — what `verify:layout` cannot measure

`npm run verify:layout` checks source patterns; it cannot see a label cut to "Active empl..." on
a phone. Round 13 measured that in a browser instead: sign in, load every page at 375px and at
1280px, and run one probe per page that reports horizontal overflow of the document, elements
whose right edge leaves the viewport (outside any `overflow-x-auto` container), text ending in an
ellipsis, and an error or empty screen. The probe is in `scripts/probe-layout.js`; paste it into
the console of any page, or drive it from a browser tool. It found one shape, repeated on nine
screens — a stat tile that truncated its own label and hint — and that shape became rule 8. Run it
again after a change to a shared component (`components/ui/*`), not after every page edit.

Two more rules landed with it: `ResponsiveList`'s `head` must be cells in a fragment, not a
`<tr>` (rule 9 — the advances list was a hydration error on every visit); and a client screen
whose mount-time effect calls `api()` must have a failure path — a `catch`, `useViewer` or
`LoadFailed` (rule 10 — ten screens spun for ever after a 403).

### Sessions

A person stays signed in for **30 days from their last use** (`SESSION_IDLE_DAYS`, sliding: the
row's `expiresAt` moves forward on every request; the cookie and token carry a far horizon and the
row is the authority). A shared office device stays signed in for a fixed 30 days. Account →
Security lists every session and revokes any of them at once. `SESSION_MAX_AGE_SECONDS` is no
longer read — if your platform still sets it, it is ignored.

### Read-only is read-only

When a trial ends or a payment lapses (`accessState` `TRIAL_EXPIRED` / `PAST_DUE`) the shell shows
a banner and `requireWritable` refuses writes. Reads must not: an exported service function named
`get*`/`list*` never calls `requireWrite` (pinned by `src/services/readOnly.test.ts`). Five pages
crashed under the banner before this was a rule.

---

## 8. Reading logs

Your platform's application logs. Errors carry a `correlationId`; the same id appears in
the response the user saw, which is what makes "it said something went wrong" answerable.

**The gap:** logs live only in the container and are lost on redeploy. A log drain is not
configured. That is the second thing to add after the backup.

---

## 9. Deliberate limitations — say these rather than treating them as bugs

- **No email is sent, at all.** Password resets are handed over by a person. This is a design
  decision, not an omission — but it does mean a self-service signup has no unattended recovery
  path, and the signup page says so.
- **Attendance is never queued offline.** The product refuses to mark a punch it cannot timestamp
  against the server, and `/offline` says why: a timestamp written by a phone is not evidence.
- **Tenant isolation is enforced in the application**, by `organizationId` on every query — not by
  Postgres row-level security. It holds, and the sweep tests it, but nobody should upgrade the
  marketing copy to "isolated at the database level", because that is a different claim.
- **A half-day weekly off cannot be expressed.** `WeeklyOffConfig` has no notion of one and a day
  is `WORKING | WEEK_OFF | HOLIDAY`. Adding it is a domain change, not a settings change.
