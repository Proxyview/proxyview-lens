# Proxyview Lens

Retrospective portfolio assurance, client-facing.

## What to deploy

These five files are the site:

    .gitignore
    index.html          the whole page — complete document, nothing generated
    netlify.toml        publish dir and headers
    package.json
    README.md

**There is no build step.** `index.html` carries its own doctype, head,
encoding, viewport and favicon, and its styles and script are inline. Netlify
publishes the repository root as it stands, so what is committed is exactly
what a browser receives. Push those five and the site is live.

Five more files buy sign-in, roles, the audit log and the enforced limit:

    netlify/functions/verify.mjs          the six-digit code and the session
    netlify/functions/org.mjs             members, roles, allowlist, retention, log
    netlify/functions/quota.mjs           the five-case limit
    netlify/functions/lib/identity.mjs    tokens, keys and code hashing
    netlify/functions/lib/org.mjs         the organisation record and the log

Without them the page still works and the gate falls back to the unverified
form, but the free allowance cannot be enforced and the two defects above stay
open. Push all three together; `quota.mjs` without `verify.mjs` refuses every
request, which is the correct behaviour and not a useful state to deploy.

A 404 there is silent to the client on purpose. It means the function was never
deployed, which is a configuration state rather than an outage, and nothing a
client can act on — showing them a server error on their first screen would be
false. A function that is deployed and failing is different, and the page does
say so. To tell which you have, open the console and run `LENS.diag()`:

    quota.endpoint === 'live'                        counting, limit enforced
    quota.endpoint === 'not deployed'                the file is not pushed
    quota.endpoint === 'deployed but not counting'   reachable, Blobs is not
    quota.enforced                                   the only thing that matters

The function resolves `@netlify/blobs` at call time rather than importing it at
the top. A static import that cannot resolve takes the whole function down
before any code runs, and the endpoint then answers 404 — indistinguishable
from never having been deployed. This way a missing dependency names itself in
the response.

### What went wrong before

`netlify.toml` used to declare `command = "node tools/build-site.mjs"` and
publish a generated `dist/`. The deploys pushed `index.html` but not the
script, so the build errored every time. Netlify's behaviour on a failed build
is to keep serving the last deploy that succeeded — so the site stayed on a
months-old page while every push looked like it had worked, and the product
name never changed.

The build step is gone. `tests/smoke.mjs` now fails if a build command
reappears in `netlify.toml`, and fails if anything in `index.html` points at a
file sitting beside it.

## Refreshing the build stamp

    npm run stamp

Rewrites the date and time in the top-right chip of `index.html`, in place.
That chip is how you tell which build is live: load the site, read the corner.
If it has not changed, the deploy did not take.

## Test

    npm install          # only the test tools; the site itself has no deps
    npx playwright install chromium
    npm test

Four suites — lint, structure, and the client journey in two browsers. They
load the built document, so what is tested is what gets served. The Selenium
suite skips itself when `tests/bin/chromedriver` is absent, which it is on a
fresh clone; Playwright covers the same journey.

`npm install` is needed for the tests and for nothing else. Netlify never runs
it: the build uses Node builtins only, so a deploy installs nothing.

## Industries

A construction lender and a property underwriter do not recognise each other's
evidence, so a sample drawn from the wrong book teaches nothing. The gate asks
which industry the client is in, and from then on they see that industry and no
other: their own two closed accounts, their own file names, their own words for
the thing being assured, and their own units.

| Industry | Sample pair | The account is a | Quantity |
|---|---|---|---|
| Construction finance | CF-1001, CF-1002 | construction draw | money |
| Insurance — pre-bind and property | PB-2001, PB-2002 | pre-bind property survey | money |
| Insurance — claims and parametric | CM-3001, CM-3002 | property damage claim | money |
| Real-world assets | RW-4001, RW-4002 | collateral attestation | money |
| Carbon and environmental | CB-5001, CB-5002 | MRV monitoring period | tCO2e |
| Supply chain and EUDR | SC-6001, SC-6002 | due-diligence statement | tonnes |
| Industrial and field operations | IN-7001, IN-7002 | field work order | money |

Each pair is one account that holds and one that does not. A client shown only
clean results learns nothing about what a finding looks like, and the second of
each pair fails for a reason that industry actually meets — an ungoverned
channel on a draw, a survey stale at binding, photographs eleven kilometres from
the insured location, reused evidence on an attestation, a monitoring period
resting on the operator's own meter readings, a consignment whose invoice does
not reconcile to the declared quantity, a work order with no prior baseline.

The carbon case is deliberate: Proxyview authenticates the site, not the meter,
so a period standing on meter readings alone is exactly the gap that product
should report rather than pass.

To add an industry, add an entry to `VERT` and two `mk()` rows in `SAMPLES`.
Everything else follows — the gate option, the preview, the vocabulary, the
upload prompt, the contact placeholder. The suites read the config rather than
restating it, so a new vertical is checked without editing a test.

The chosen industry is stored with the workspace, sent with every form
submission, and survives a return visit.

## Sign-in

A six-digit code to the work address. No password.

**Why a code and not a magic link.** Enterprise mail security opens links in
incoming mail before the recipient does — Microsoft Defender Safe Links,
Mimecast and Proofpoint all fetch and follow URLs to check them — so a magic
link is routinely spent by a scanner and the person who clicks it a minute
later finds it already used. Reading a message does not consume a number, so a
code survives that. A code also works when the mail lands on a phone while the
workspace is open on a desktop, and it needs no callback URL, which matters
wherever Lens is embedded inside another platform.

### What it closed

The allowance endpoint used to act on whatever address a caller typed. Two
things followed, both real rather than theoretical:

- anyone could post a consume for another organisation's domain five times and
  exhaust their allowance, so a prospect met a paywall on their first visit;
- anyone could post a check for a named domain and read how many cases that
  organisation had run.

Both existed because the address was asserted and never verified. Every quota
request now carries a token issued by `/api/verify`, and the organisation acted
on comes from inside the token rather than from the request body — so a
well-formed request naming somebody else's domain still reaches its own record.

### Environment variables

Set these in Netlify under Site configuration → Environment variables:

    LENS_SECRET        a long random string; signs the session tokens
    RESEND_API_KEY     or POSTMARK_TOKEN — whichever mail provider you use
    LENS_FROM          optional, e.g. "Proxyview Lens <no-reply@getproxyview.com>"

Generate the secret with `openssl rand -base64 48`. Changing it signs everyone
out, which is the intended way to revoke every session at once.

**A deploy missing either the secret or a mail provider cannot verify anybody.**
The page asks `/api/verify` on load and falls back to the old unverified gate
rather than walking a client into a step that cannot finish. That state is
reported in `LENS.diag().verify`, never to the client.

### Properties worth keeping

The code is never returned in any response. It is stored as an HMAC, not in
the clear, so a reader of the store cannot sign in as anybody. It is good once
and for ten minutes, five wrong attempts burn it, and three requests per
address per fifteen minutes is the ceiling on sending. Signatures are compared
without leaking through timing. Sessions last twelve hours, so a client who
comes back the same day is not asked again.

### What it does not do

This is email verification and a single factor. It is not multi-factor, and it
should never be described as though it were. Enterprise SSO, roles and
per-tenant isolation are a separate tier — see the security posture note.

## Roles, the audit log and the workspace

Three roles, because three is what a platform review asks for and a fourth is
a support conversation without a job.

| Role | Can | Cannot |
|---|---|---|
| Admin | Run cases, manage members and roles, set the domain allowlist and retention, read and export the audit log | — |
| Reviewer | Run cases, read reports, export a report | Change members, roles or settings; read the log |
| Read-only | Read reports | Upload, run or export |

The first person to verify an address at an organisation becomes its Admin.
Everyone after them joins as a Reviewer until the Admin says otherwise. A
workspace cannot be left without an Admin, and an Admin cannot remove
themselves.

**Authority is checked on the server for every action.** The page renders what
the session says the member may do, but a read-only member who edits the page
in their browser still cannot spend the allowance or change a role: the
functions refuse it and record the attempt.

### Domain allowlist

An organisation decides which mail domains may join it. The founding domain is
always on the list and cannot be removed, which is what stops an Admin locking
their own group out in one click. Free mailboxes are refused outright — no
organisation is ever founded on one — in the page and again in the function,
because the page can be skipped.

### Rate limits and lockouts

Three codes per address per fifteen minutes. Five wrong attempts burn a code.
Three burnt codes lock the address for thirty minutes. The send limit bounds
how much mail an attacker can cause; the lockout bounds how many codes they
can grind through.

### Audit log

Sign-in, blocked sign-in, lockouts, case runs, uploads, exports and every
administrative change, kept for the retention window and downloadable as CSV
by an Admin.

Every entry records **whether it was observed or reported**. Sign-in, role
changes and the allowance are seen by the server and marked `OBSERVED`. An
upload or an export happens in a browser and is reported by it, so those are
marked `REPORTED`. Saying which is which is the same discipline this product
applies to a client's own evidence, and a log that blurred the two would be
worth less than one that admits the difference.

A read-only member who reports an upload or an export is recorded as refused
rather than ignored.

## Disposition

A client records what they make of a result, at two levels, and one rule
governs both: **a disposition never changes an assessed outcome.** The engine
reports what the evidence established. The client reports what they make of
it. The report carries both and says which is which. A product that let a
client mark a failed control as passed would be worth nothing to the committee
reading the report, and the only value the record has is that it cannot be
argued into a different shape.

### At the control level

Every row in Appendix B takes a disposition and a note:

| Disposition | What the client is asserting |
|---|---|
| Accepted | The result stands and needs no further action |
| Evidence exists, not supplied | The evidence is in our records and was not in the pack sent |
| Compensating control | A different control in our process covers this, and we can name it |
| Remediated since | The gap was real at the time and the process has changed |
| Accepted as a known risk | The gap is real, we know, and we have decided to carry it |
| Contested | We disagree with this result and will say why |

The vocabulary describes a position a reviewer can defend in a meeting rather
than a re-grading of the evidence.

**Evidence exists, not supplied is the one that earns its place.** In the
assessment, a control that could not be tested because the evidence was
missing from the pack looks identical to one that could not be tested because
the evidence does not exist. Those are completely different problems and only
the client can tell them apart. The portfolio counts that disposition on its
own line, because the number decides whether the next conversation is about
process or about the evidence pack.

### At the case level

Accepted · Accepted with exceptions · Evidence to follow · Remediated ·
Contested · Referred for second review, with a note.

The assessed outcome and the client's position sit in adjacent pills on the
report and never in the same one.

### Clearing the low-severity rows

Forty-eight controls is a lot to walk through to reach the three that matter,
so one button marks the low-severity ones reviewed. Four rules keep it from
damaging the record.

**It applies the weakest claim available.** Reviewed, no action, which says a
person read it and nothing needs doing. A bulk action is never allowed to make
a stronger assertion than that.

**It never touches a control whose evidence was missing from the pack.** This
is the rule worth understanding. A control that could not be evaluated has two
quite different reasons behind it, and until now they were indistinguishable:

- the client's pack was short, and **only the client knows** whether the
  evidence exists elsewhere — the most useful thing they can tell us, and
  sweeping it away would destroy the signal at the moment it is cheapest to
  collect;
- **Lens implements no test** for that control, which is our gap and nothing
  the client can act on.

The engine now records which, as a field rather than in prose. Only the second
is swept. In the seed corpus that is about three rows a case, against seven
that stay for the client to answer.

**It never overwrites a disposition written by hand**, and a swept row is
marked `IN BULK` on screen and `[applied in bulk]` in the export, so a
committee can tell a considered disposition from one applied in a sweep. The
portfolio counts the two separately.

**It can be undone in one move.** The sweep is applied as a batch and the undo
removes exactly that batch, leaving hand-written dispositions alone.

Nothing about a sweep changes an assessed outcome or a control result. There
are tests for both.

### A correction this exposed

The executive conclusion used to say that *n* controls "could not be evaluated
on the evidence supplied" and counted both reasons in that number. For a
control Lens implements no test for, that sentence blamed the client's evidence
for our gap — inaccurate, and in the direction that flatters us. The conclusion
now reports the two separately and says plainly that the second is a limit of
the assessment rather than of the evidence.

### Where a disposition lives

With the case, in the client's browser. That is the same decision as the
assessments themselves: Proxyview holds no case data, and a note a reviewer
writes about their own book is case data.

What reaches the server is the **fact** of a disposition — who, which case,
which control, which value — so the audit log is complete without the note
travelling with it. Those entries are marked `REPORTED` rather than
`OBSERVED`, because a browser reported them.

Sharing dispositions between colleagues needs per-tenant storage and belongs
with it, in the enterprise tier.

On restore the assessment is always recomputed from the evidence, so a library
change is picked up; the disposition is the client's and is restored exactly
as written.

A sample carries no disposition, because a sample is ours. A read-only member
can read a disposition and cannot set one.

## Data rules

**What must not be uploaded**, stated rather than implied: identity documents,
medical records, payment or bank details, payroll information, or any list of
named individuals. A file whose name matches one of these is refused at the
drop — before it is read, before it is classified, and before anything leaves
the browser. Name matching cannot see inside a file, so it is a guard rather
than a guarantee, and the page says so.

**Retention** defaults to 30 days and an Admin can set 7, 30, 90, 180 or 365.
It governs the audit log and the workspace record. Entries past the window are
removed and are not recoverable.

**Evidence handling** is a deployment choice:

    LENS_EVIDENCE=email   (default)  files are transmitted and emailed to the
                                     assurance team, kept for the retention window
    LENS_EVIDENCE=none               files never leave the browser; only case
                                     metadata reaches Proxyview

Set `none` for a platform deployment. It is a stronger statement than any
retention period, and the privacy panel changes to say so.

**Tenant isolation.** Assessments run in the client's browser and case data is
never transmitted. What is held server-side is one record per organisation —
the usage count, the members and their roles, the allowlist and the retention
setting — plus that organisation's audit log, each under a key derived from
the verified mail domain. A request reaches only the record its own token
names; the organisation is never taken from the request body.

## Packaging

Five closed accounts free, for the whole organisation rather than each person.
No card and no expiry. After the fifth the workspace stays open and reports
stay readable and exportable; running more needs a cycle. Stated on the meter,
on the paywall and in the workspace, so a buyer does not have to infer it.

## The free allowance

Five cases per **organisation**, taken from the work-email domain rather than
the person, so a second colleague does not get another five.

A page cannot enforce this on its own. Whatever it stores, the reader can
clear, and an incognito window starts clean. The count that decides anything
lives in `netlify/functions/quota.mjs`, on Netlify Blobs, which needs no
provisioning. The page keeps a mirror so the meter renders instantly; when the
server answers, the server wins.

When the function cannot be reached the client is not locked out — that would
punish them for our outage — and the page says the count is unconfirmed.

## Where submissions go

Netlify Forms, which is **off by default** for sites created since April 2023.
Enable it at Forms → Enable form detection, then deploy again, then add an
email notification at Forms → Submission notifications. Three forms should
appear: `lens-signup`, `lens-case` and `lens-contact`.

To bypass Netlify Forms entirely, set `ENDPOINT` near the top of the script in
`index.html` to a hosted form endpoint. Nothing else changes.

## The address

`www.lens.getproxyview.com`. It appears in `index.html` in the canonical,
`og:url` and Twitter tags, and in `SITE_URL` in `tools/stamp.mjs`, which the
smoke suite checks agree.

**As at 24 September, `lens.getproxyview.com` resolves and
`www.lens.getproxyview.com` does not.** Add the second record so the address in
`SITE.url` works:

    Type: CNAME   Host: lens       Value: <the name Netlify shows>
    Type: CNAME   Host: www.lens   Value: <the name Netlify shows>

Then attach both in Netlify under Domain management and set one as the primary
domain. Netlify redirects every other attached alias to the primary, so a
shared link, a search result and an analytics row agree on a single address.

Canonicalisation is deliberately not done with a redirect rule in
`netlify.toml`. A rule there fires whether or not its destination exists, so a
bare-to-www redirect written before the `www.lens` record was added would send
the only working address to one that does not resolve and take the site down.
Netlify's primary-domain setting can only point at a domain attached to the
site, so it cannot do that.

Worth knowing: `www.` on a subdomain is redundant, and `lens.getproxyview.com`
is the conventional form. To drop it, change `SITE.url` — one line.

## Devices

Three treatments, not one breakpoint.

| Width | Treatment |
|---|---|
| up to 834 px | phone and iPad portrait: the rail collapses behind a control carrying the case count |
| 835 to 1120 px | tablet: two columns, narrower rail |
| 1121 px and up | desktop: as drawn |

Tested at nine sizes from iPhone SE to a 1680 px desktop: the gate, the report,
the upload screen, the paywall and the contact form each checked for
horizontal overflow, touch-target height and the rail behaving as that width
calls for. Inputs are 16 px on a phone, which is what stops iOS zooming the
whole page when a field takes focus.

## Telling which build is live

Every build stamps a date and time into the top-right of the page. Open the
console and run `LENS.diag()` for what was posted, where, and what came back.
