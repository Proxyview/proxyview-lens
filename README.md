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

A sixth file buys one thing more:

    netlify/functions/quota.mjs    the five-case limit

Without it the page still works, but the free allowance cannot be enforced —
`/api/quota` returns 404, the page falls back to its own count, and anyone can
clear their browser and start again. Push it when you want the limit real.

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
