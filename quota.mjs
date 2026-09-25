/* The free allowance, enforced where the client cannot reach it.
 *
 * A page alone cannot hold a usage limit. Whatever it stores, the person
 * reading it can clear, and an incognito window starts clean every time. The
 * only place a limit can actually live is a server, which is what this is.
 *
 * The unit is the COMPANY, taken from the work-email domain, not the person.
 * Five free cases per organisation. Changing name, phone or mailbox inside the
 * same company reaches the same record and the same remaining count, which is
 * the evasion worth closing: one firm should not get five free cases per
 * employee.
 *
 * WHAT CHANGED, AND WHY IT MATTERED
 * This endpoint used to act on whatever address the caller typed. Two things
 * followed, and both were real rather than theoretical:
 *   - anyone could POST a consume for someone else's domain five times and
 *     exhaust that organisation's allowance before Proxyview ever reached
 *     them, so the prospect met a paywall on their first visit;
 *   - anyone could POST a check for a named domain and read how many cases
 *     that organisation had run, which disclosed the pipeline to whoever
 *     thought to ask.
 * Both existed because the address was asserted and never verified. Every
 * request now carries a token issued by /api/verify, which is only obtainable
 * by someone who received a code at that address, and the token's own key has
 * to match the organisation being acted on. A caller cannot spend or read an
 * allowance that is not theirs.
 *
 * Runs on Netlify Blobs, which needs no provisioning and no database.
 *
 * Endpoints (all POST, JSON, all requiring `token`):
 *   { action: "check",   token }  -> { used, limit, allowed }
 *   { action: "consume", token }  -> { used, limit, allowed }
 */
import { normalise, json, verifyToken, secret } from './lib/identity.mjs';
import {
  blobs, readOrg, joinOrg, roleOf, can, record, CAN, FREE_LIMIT,
} from './lib/org.mjs';

const LIMIT = FREE_LIMIT;

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'expected JSON' }); }

  if (!secret()) {
    /* Without a signing secret no token can be checked, so nothing here can
       be trusted. Saying so is the honest answer; quietly reverting to the
       old behaviour would reopen both defects while looking healthy. */
    return json(503, {
      error: 'verification is not configured',
      needs: ['LENS_SECRET'],
      enforced: false,
    });
  }

  const claims = await verifyToken(body.token);
  if (!claims) {
    return json(401, { error: 'a verified session is required', verify: '/api/verify' });
  }

  /* The key comes from the token, never from the request body. This one line
     is what stops a caller acting on an organisation that is not theirs: even
     a well-formed request naming another domain reaches the record its own
     token names. */
  const key = claims.k;
  const id = normalise(claims.e);
  if (!key || !id) return json(401, { error: 'that session is not usable' });

  const getStore = await blobs();
  if (!getStore) {
    /* The function is deployed but cannot reach Blobs, so it can hold no
       count. The run is allowed and the reason is named, which is what the
       page records and what LENS.diag() shows. */
    return json(200, {
      used: 0, limit: LIMIT, allowed: true, degraded: true,
      reason: '@netlify/blobs is not available to this function',
    });
  }
  const store = getStore({ name: 'lens-quota', consistency: 'strong' });
  const audit = getStore({ name: 'lens-audit', consistency: 'strong' });

  const rec = await readOrg(store, key, id);
  if (!rec) {
    /* Reaching the store failed. Refusing the client here would punish them
       for our outage, so the run is allowed and the failure is reported for
       the page to record. */
    return json(200, { used: 0, limit: LIMIT, allowed: true, degraded: true });
  }

  const member = joinOrg(rec, id, body);
  const role = roleOf(rec, id.email);

  /* A read-only member may read what the organisation has already run and may
     not spend the allowance. Enforced here rather than only in the page,
     because a page is decoration and this is the control. */
  if (body.action === 'consume' && !can(role, 'run')) {
    await record(audit, key, {
      action: 'case.run', actor: id.email, detail: 'refused: read-only',
    }, rec.retentionDays);
    return json(403, {
      error: 'a read-only member cannot run a case',
      role, can: CAN[role], used: rec.used, limit: LIMIT, allowed: false,
    });
  }

  if (body.action === 'consume') {
    if (rec.used >= LIMIT) {
      return json(200, { used: rec.used, limit: LIMIT, allowed: false, role, can: CAN[role] });
    }
    rec.used += 1;
  }

  rec.lastSeen = new Date().toISOString();

  try {
    await store.setJSON(key, rec);
  } catch {
    return json(200, { used: rec.used, limit: LIMIT, allowed: rec.used <= LIMIT, degraded: true });
  }

  if (body.action === 'consume') {
    await record(audit, key, {
      action: 'case.run', actor: id.email, detail: `${rec.used} of ${LIMIT}`,
    }, rec.retentionDays);
  }

  return json(200, {
    used: rec.used,
    limit: LIMIT,
    allowed: rec.used < LIMIT || body.action === 'consume',
    scope: key.startsWith('person:') ? 'person' : 'company',
    verified: id.email,
    role,
    can: CAN[role],
    plan: rec.plan,
    members: Object.keys(rec.members).length,
    retentionDays: rec.retentionDays,
    since: member.firstSeen,
  });
};

export const config = { path: '/api/quota' };
