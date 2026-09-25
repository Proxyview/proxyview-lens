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
 * Runs on Netlify Blobs, which needs no provisioning and no database.
 *
 * Endpoints (all POST, JSON):
 *   { action: "check",   email, company, phone }  -> { used, limit, allowed }
 *   { action: "consume", email, company, phone }  -> { used, limit, allowed }
 */
/* Loaded at call time rather than imported at the top.
 *
 * A static import that cannot resolve takes the whole function down before
 * any code runs, and the endpoint then answers 404 — indistinguishable from
 * never having been deployed. Resolving it here means a missing dependency
 * reports itself in the response instead of disappearing. */
let storeFactory;
async function blobs() {
  if (storeFactory !== undefined) return storeFactory;
  try {
    ({ getStore: storeFactory } = await import('@netlify/blobs'));
  } catch {
    storeFactory = null;
  }
  return storeFactory;
}

const LIMIT = 5;

/* Consumer mailboxes have no company behind them, so they are keyed on the
   whole address. Everything else is keyed on the domain. */
const CONSUMER = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
  'yandex.com', 'zoho.com', 'qq.com', '163.com',
]);

function normalise(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain.includes('.')) return null;
  /* A plus-tag is the cheapest way to look like a new person, so it is
     stripped before the address is used as a key. */
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  return { email: `${local}@${domain}`, domain, consumer: CONSUMER.has(domain) };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'expected JSON' }); }

  const id = normalise(body.email);
  if (!id) return json(400, { error: 'a valid work email is required' });

  const key = id.consumer ? `person:${id.email}` : `company:${id.domain}`;

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

  let rec;
  try {
    rec = (await store.get(key, { type: 'json' })) || null;
  } catch {
    /* Reaching the store failed. Refusing the client here would punish them
       for our outage, so the run is allowed and the failure is reported for
       the page to record. */
    return json(200, { used: 0, limit: LIMIT, allowed: true, degraded: true });
  }

  rec = rec || { used: 0, firstSeen: new Date().toISOString(), people: [] };

  if (body.action === 'consume') {
    if (rec.used >= LIMIT) {
      return json(200, { used: rec.used, limit: LIMIT, allowed: false });
    }
    rec.used += 1;
  }

  /* Every identity that has touched this organisation's allowance is kept, so
     a second person from the same firm is visible rather than invisible. */
  if (!rec.people.some((p) => p.email === id.email)) {
    rec.people.push({
      email: id.email,
      company: String(body.company || '').slice(0, 120),
      phone: String(body.phone || '').slice(0, 40),
      at: new Date().toISOString(),
    });
  }
  rec.lastSeen = new Date().toISOString();

  try {
    await store.setJSON(key, rec);
  } catch {
    return json(200, { used: rec.used, limit: LIMIT, allowed: rec.used <= LIMIT, degraded: true });
  }

  return json(200, {
    used: rec.used,
    limit: LIMIT,
    allowed: rec.used < LIMIT || body.action === 'consume',
    scope: id.consumer ? 'person' : 'company',
  });
};

export const config = { path: '/api/quota' };
