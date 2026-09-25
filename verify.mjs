/* Work-address verification: a six-digit code, and the session token it buys.
 *
 * Why a code and not a magic link. Enterprise mail security opens links in
 * incoming mail before the recipient does — Microsoft Defender Safe Links,
 * Mimecast, Proofpoint all fetch and follow URLs to check them. A magic link
 * is therefore routinely spent by a scanner, and the human who clicks it a
 * minute later finds it already used. A code survives that, because reading a
 * message does not consume a number. A code also works when the mail arrives
 * on a phone and the workspace is open on a desktop, and it needs no callback
 * URL, which matters when Lens is embedded inside somebody else's platform.
 *
 * What this closes. The allowance previously acted on any email address a
 * caller typed, so anyone could spend a named organisation's five free cases,
 * and anyone could read how many any organisation had used. Both existed
 * because the address was asserted and never verified. After this, neither
 * endpoint acts without a token that only the holder of that mailbox can get.
 *
 * Endpoints:
 *   GET                                  -> { configured }
 *   POST { action: "start", email, ... } -> { sent: true, expiresInSec }
 *   POST { action: "check", email, code }-> { token, email, expiresAt }
 */
import {
  normalise, json, configured, mailProvider, issue, hashCode, codesEqual, TOKEN_TTL_MS,
} from './lib/identity.mjs';
import {
  blobs, readOrg, joinOrg, roleOf, domainAllowed,
  lockState, noteFailure, clearFailures, record, policy, ROLE_LABEL, CAN,
} from './lib/org.mjs';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/* Requesting codes is the one thing an unauthenticated caller can still do,
   so it is the one thing that has to be bounded: this stops the endpoint
   being used to send repeated mail to somebody else's address. */
const MAX_SENDS = 3;
const SEND_WINDOW_MS = 15 * 60 * 1000;

/* A free mailbox is not a work address. The page says so at the gate, but the
   page can be skipped, so the rule lives here as well. Duck Creek asked for
   domain allowlisting and this is its floor: no organisation is ever founded
   on a consumer mailbox. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
  'yandex.com', 'zoho.com', 'qq.com', '163.com',
]);

/* Six digits from the system random source. Math.random is not a source of
   secrets and would make the code guessable from earlier ones. */
function code6() {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(b[0] % 1000000).padStart(6, '0');
}

function body_(code) {
  return `Your Proxyview Lens verification code is ${code}.

It is valid for ten minutes and can be used once.

If you did not ask to open a Lens workspace, you can ignore this message —
nothing has been created and nobody has access to anything of yours.

Proxyview · lens.getproxyview.com`;
}

async function send(to, code) {
  const from = process.env.LENS_FROM || 'Proxyview Lens <no-reply@getproxyview.com>';
  const subject = `${code} is your Lens verification code`;
  const provider = mailProvider();

  if (provider === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text: body_(code) }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return;
  }
  if (provider === 'postmark') {
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': process.env.POSTMARK_TOKEN,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: body_(code) }),
    });
    if (!r.ok) throw new Error(`postmark ${r.status}`);
    return;
  }
  throw new Error('no mail provider configured');
}

export default async (request) => {
  /* The page asks this on load so it can present the right gate rather than
     walking someone into a step that cannot complete. */
  if (request.method === 'GET') {
    /* The page reads this on load to decide which gate to present and what to
       tell a client about how their material is handled. */
    return json(200, {
      configured: configured(),
      provider: mailProvider() || null,
      policy: policy(),
      roles: ROLE_LABEL,
      can: CAN,
    });
  }
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  if (!configured()) {
    return json(503, {
      error: 'verification is not configured',
      needs: [
        process.env.LENS_SECRET ? null : 'LENS_SECRET',
        mailProvider() ? null : 'RESEND_API_KEY or POSTMARK_TOKEN',
      ].filter(Boolean),
    });
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'expected JSON' }); }

  const id = normalise(body.email);
  if (!id) return json(400, { error: 'a valid work email is required' });

  if (FREE_MAIL.has(id.domain)) {
    return json(400, {
      error: `use your work address; ${id.domain} is a personal mailbox`,
      consumer: true,
    });
  }

  const getStore = await blobs();
  if (!getStore) return json(503, { error: 'storage is not available to this function' });
  const s = getStore({ name: 'lens-verify', consistency: 'strong' });
  const orgs = getStore({ name: 'lens-quota', consistency: 'strong' });
  const audit = getStore({ name: 'lens-audit', consistency: 'strong' });
  const orgKey = id.key;
  const slot = `code:${id.email}`;

  const org = await readOrg(orgs, orgKey, id);
  if (!org) return json(503, { error: 'storage is not available to this function' });

  /* An organisation decides which mail domains may reach it. The founding
     domain is always allowed; an admin adds the rest. */
  if (!domainAllowed(org, id.domain)) {
    await record(audit, orgKey, {
      action: 'signin.blocked.domain', actor: id.email, detail: id.domain,
    }, org.retentionDays);
    return json(403, { error: 'that domain is not allowed to join this workspace' });
  }

  const lock = lockState(org, id.email);
  if (lock.locked) {
    return json(429, {
      error: 'too many failed codes for this address',
      lockedOut: true,
      retryInSec: lock.retryInSec,
    });
  }

  /* ── send a code ─────────────────────────────────────────────────── */
  if (body.action === 'start') {
    let rec = null;
    try { rec = await s.get(slot, { type: 'json' }); } catch { /* treated as absent */ }

    const now = Date.now();
    const sends = (rec && rec.sends ? rec.sends : []).filter((t) => now - t < SEND_WINDOW_MS);
    if (sends.length >= MAX_SENDS) {
      return json(429, {
        error: 'too many codes requested for this address',
        retryInSec: Math.ceil((SEND_WINDOW_MS - (now - sends[0])) / 1000),
      });
    }

    const code = code6();
    const next = {
      hash: await hashCode(code, id.email),
      exp: now + CODE_TTL_MS,
      attempts: 0,
      sends: [...sends, now],
      company: String(body.company || '').slice(0, 120),
      phone: String(body.phone || '').slice(0, 40),
      industry: String(body.industry || '').slice(0, 80),
    };

    try {
      await s.setJSON(slot, next);
    } catch {
      return json(503, { error: 'could not store the code; try again' });
    }

    try {
      await send(id.email, code);
    } catch (e) {
      return json(502, { error: 'could not send the code', detail: String(e.message || e) });
    }
    await record(audit, orgKey, { action: 'signin.code.sent', actor: id.email },
      org.retentionDays);
    /* The code is never in the response. Returning it would hand the whole
       mechanism to exactly the caller it exists to stop. */
    return json(200, { sent: true, expiresInSec: Math.round(CODE_TTL_MS / 1000) });
  }

  /* ── check a code ────────────────────────────────────────────────── */
  if (body.action === 'check') {
    let rec = null;
    try { rec = await s.get(slot, { type: 'json' }); } catch { /* treated as absent */ }
    if (!rec) return json(400, { error: 'ask for a code first' });
    if (Date.now() > rec.exp) {
      try { await s.delete(slot); } catch { /* best effort */ }
      return json(400, { error: 'that code has expired', expired: true });
    }
    if (rec.attempts >= MAX_ATTEMPTS) {
      try { await s.delete(slot); } catch { /* best effort */ }
      return json(429, { error: 'too many attempts; ask for a new code' });
    }

    const given = String(body.code || '').replace(/\D/g, '');
    const ok = given.length === 6 && codesEqual(await hashCode(given, id.email), rec.hash);

    if (!ok) {
      rec.attempts += 1;
      try { await s.setJSON(slot, rec); } catch { /* best effort */ }
      const left = Math.max(0, MAX_ATTEMPTS - rec.attempts);
      if (left === 0) {
        /* A burnt code counts against the address. Enough of them and it is
           locked, which is what stops six digits being ground down. */
        const locked = noteFailure(org, id.email);
        try { await orgs.setJSON(orgKey, org); } catch { /* best effort */ }
        await record(audit, orgKey, {
          action: locked ? 'signin.locked' : 'signin.failed', actor: id.email,
        }, org.retentionDays);
        if (locked) {
          return json(429, {
            error: 'too many failed codes for this address', lockedOut: true,
            retryInSec: Math.ceil(30 * 60),
          });
        }
      }
      return json(400, { error: 'that code is not right', attemptsLeft: left });
    }

    /* A code is good once. Removing it here is what stops a code read out of
       somebody's mailbox being replayed later. */
    try { await s.delete(slot); } catch { /* best effort */ }

    clearFailures(org, id.email);
    const member = joinOrg(org, id, {
      company: rec.company, phone: rec.phone, industry: rec.industry,
    });
    org.lastSeen = new Date().toISOString();
    try { await orgs.setJSON(orgKey, org); } catch { /* best effort */ }
    await record(audit, orgKey, {
      action: 'signin.verified', actor: id.email, detail: member.role,
    }, org.retentionDays);

    return json(200, {
      token: await issue(id),
      email: id.email,
      role: member.role,
      can: CAN[member.role],
      scope: id.consumer ? 'person' : 'company',
      org: { domain: org.domain, used: org.used, plan: org.plan,
        retentionDays: org.retentionDays, members: Object.keys(org.members).length },
      policy: policy(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
  }

  return json(400, { error: 'action must be start or check' });
};

export const config = { path: '/api/verify' };
