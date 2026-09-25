/* The organisation record, the roles on it, and the audit log beside it.
 *
 * One record per organisation, keyed the same way the allowance is keyed, so
 * membership, roles, the domain allowlist, retention and the usage count are
 * all the same object and cannot disagree with one another.
 *
 * Every field is optional on read. A record written before roles existed is
 * upgraded in place rather than replaced, because a client who signed in last
 * week should not lose their count to a schema change.
 */

/* Loaded at call time. A static import that cannot resolve takes the whole
   function down before any code runs, and the endpoint then answers 404 —
   indistinguishable from never having been deployed. */
let storeFactory;
export async function blobs() {
  if (storeFactory !== undefined) return storeFactory;
  try {
    ({ getStore: storeFactory } = await import('@netlify/blobs'));
  } catch {
    storeFactory = null;
  }
  return storeFactory;
}

export const ROLES = ['admin', 'reviewer', 'readonly'];
export const ROLE_LABEL = {
  admin: 'Admin',
  reviewer: 'Reviewer',
  readonly: 'Read-only',
};

/* What each role may do. Read by the server on every request; the page reads
   the same shape so the two cannot describe different products, but the page
   is decoration and this is the control. */
export const CAN = {
  admin: { run: true, upload: true, export: true, manage: true, audit: true },
  reviewer: { run: true, upload: true, export: true, manage: false, audit: false },
  readonly: { run: false, upload: false, export: false, manage: false, audit: false },
};

export const DEFAULT_RETENTION_DAYS = 30;
export const FREE_LIMIT = 5;

export const emptyOrg = (id) => ({
  domain: id.domain,
  createdAt: new Date().toISOString(),
  used: 0,
  plan: 'free',
  /* The founding domain only. An admin widens this when a group has more than
     one mail domain, which is the common case for a carrier with subsidiaries
     and the reason a plain domain match is not enough on its own. */
  allow: [id.domain],
  retentionDays: DEFAULT_RETENTION_DAYS,
  members: {},
  locks: {},
});

/* Reads and upgrades in one step, so no caller ever sees a half-shaped
   record. Returns null only when the store itself could not be reached. */
export async function readOrg(store, key, id) {
  let rec;
  try {
    rec = await store.get(key, { type: 'json' });
  } catch {
    return null;
  }
  if (!rec) return emptyOrg(id);

  rec.domain = rec.domain || id.domain;
  rec.used = typeof rec.used === 'number' ? rec.used : 0;
  rec.plan = rec.plan || 'free';
  rec.allow = Array.isArray(rec.allow) && rec.allow.length ? rec.allow : [id.domain];
  rec.retentionDays = typeof rec.retentionDays === 'number'
    ? rec.retentionDays : DEFAULT_RETENTION_DAYS;
  rec.members = rec.members || {};
  rec.locks = rec.locks || {};

  /* Records written before roles existed carry a flat people list. Those
     people are members; the earliest is the admin, because somebody has to be
     able to manage the organisation and it should be whoever started it. */
  if (Array.isArray(rec.people) && rec.people.length && !Object.keys(rec.members).length) {
    rec.people.forEach((p, i) => {
      if (!p || !p.email) return;
      rec.members[p.email] = {
        role: i === 0 ? 'admin' : 'reviewer',
        company: p.company || '',
        phone: p.phone || '',
        industry: p.industry || '',
        firstSeen: p.verifiedAt || p.at || rec.createdAt,
        lastSeen: p.verifiedAt || p.at || rec.createdAt,
      };
    });
    delete rec.people;
  }
  return rec;
}

/* The first verified person at an organisation becomes its admin. Everyone
   after them is a reviewer until the admin says otherwise, which is the only
   arrangement that works without a separate provisioning step. */
export function joinOrg(rec, id, details = {}) {
  const existing = rec.members[id.email];
  const first = Object.keys(rec.members).length === 0;
  const member = existing || {
    role: first ? 'admin' : 'reviewer',
    firstSeen: new Date().toISOString(),
  };
  member.lastSeen = new Date().toISOString();
  if (details.company) member.company = String(details.company).slice(0, 120);
  if (details.phone) member.phone = String(details.phone).slice(0, 40);
  if (details.industry) member.industry = String(details.industry).slice(0, 80);
  rec.members[id.email] = member;
  return member;
}

export const roleOf = (rec, email) =>
  (rec.members[email] && rec.members[email].role) || 'reviewer';
export const can = (role, what) => Boolean((CAN[role] || CAN.readonly)[what]);

/* An address may sign in to an organisation when its domain is on that
   organisation's allowlist. The founding domain is always on it. */
export const domainAllowed = (rec, domain) =>
  !rec.allow || !rec.allow.length || rec.allow.includes(domain);

/* ── lockouts ───────────────────────────────────────────────────────────
   The send rate limit bounds how much mail an attacker can cause. This bounds
   how many codes they can burn through: repeated failures stop the address
   being usable for a while, so a six-digit code cannot be ground down by
   volume. It is per address rather than per IP because the address is the
   thing being attacked and an IP is cheap to change. */
export const LOCK_AFTER = 3;
export const LOCK_MS = 30 * 60 * 1000;

export function lockState(rec, email) {
  const l = rec.locks[email];
  if (!l) return { locked: false, fails: 0 };
  if (l.until && Date.now() < l.until) {
    return { locked: true, fails: l.fails, retryInSec: Math.ceil((l.until - Date.now()) / 1000) };
  }
  return { locked: false, fails: l.fails || 0 };
}

export function noteFailure(rec, email) {
  const l = rec.locks[email] || { fails: 0, until: 0 };
  l.fails = (l.fails || 0) + 1;
  if (l.fails >= LOCK_AFTER) {
    l.until = Date.now() + LOCK_MS;
    l.fails = 0;
    rec.locks[email] = l;
    return true;
  }
  rec.locks[email] = l;
  return false;
}

export function clearFailures(rec, email) {
  delete rec.locks[email];
}

/* ── audit ──────────────────────────────────────────────────────────────
   Append-only from the caller's point of view: nothing in the product edits
   or removes an entry, and the only thing that takes entries out is the
   retention window.

   Every entry records where it came from. Sign-in, role changes and the
   allowance are observed by the server and are `server`. An upload or an
   export happens in the browser and is reported by it, so those are `client`.
   Saying which is which is the honest thing to do in a log that a reviewer
   may one day rely on, and it is the distinction this whole product exists
   to make. */
export const AUDIT_ACTIONS = new Set([
  'signin.code.sent', 'signin.verified', 'signin.failed', 'signin.locked',
  'signin.blocked.domain', 'signin.blocked.consumer',
  'case.uploaded', 'case.run', 'case.dispositioned', 'report.exported', 'report.opened',
  'admin.role.changed', 'admin.member.removed', 'admin.allowlist.changed',
  'admin.retention.changed', 'admin.audit.exported',
]);

const CAP = 2000;

export async function record(auditStore, key, entry, retentionDays = DEFAULT_RETENTION_DAYS) {
  if (!AUDIT_ACTIONS.has(entry.action)) return;
  let log;
  try {
    log = (await auditStore.get(key, { type: 'json' })) || { events: [] };
  } catch {
    return; /* the log is best effort; it never blocks the action it records */
  }
  log.events = Array.isArray(log.events) ? log.events : [];
  log.events.push({
    t: new Date().toISOString(),
    actor: entry.actor || null,
    action: entry.action,
    detail: entry.detail || null,
    src: entry.src || 'server',
  });
  const cutoff = Date.now() - retentionDays * 864e5;
  log.events = log.events
    .filter((e) => Date.parse(e.t) >= cutoff)
    .slice(-CAP);
  try { await auditStore.setJSON(key, log); } catch { /* best effort */ }
}

export async function readAudit(auditStore, key, retentionDays = DEFAULT_RETENTION_DAYS) {
  let log;
  try {
    log = (await auditStore.get(key, { type: 'json' })) || { events: [] };
  } catch {
    return [];
  }
  const cutoff = Date.now() - retentionDays * 864e5;
  return (log.events || []).filter((e) => Date.parse(e.t) >= cutoff);
}

/* What the deployment tells clients about how their material is handled.
   Read from the environment so a platform deployment can promise something
   the public one cannot, without a separate build. */
export function policy() {
  const evidence = process.env.LENS_EVIDENCE === 'none' ? 'none' : 'email';
  const retentionDays = Number(process.env.LENS_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
  return { evidence, retentionDays, freeLimit: FREE_LIMIT };
}
