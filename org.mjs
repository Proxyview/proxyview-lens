/* Members, roles, the domain allowlist, retention and the audit log.
 *
 * Everything an administrator does to a workspace happens here, and every one
 * of those actions is recorded. Two rules hold throughout:
 *
 *   the actor comes from the token, never from the request body, so a caller
 *   cannot act as somebody else or on another organisation;
 *
 *   authority is checked on the server for every action, because the page is
 *   decoration and this is the control. A read-only member who edits the page
 *   in their browser still cannot change a role.
 *
 * Endpoints (all POST, JSON, all requiring `token`):
 *   { action: "state" }                          -> the workspace as this member sees it
 *   { action: "audit" }                          -> the log            (admin)
 *   { action: "setRole", email, role }           -> change a role      (admin)
 *   { action: "removeMember", email }            -> remove a member    (admin)
 *   { action: "setAllow", domains: [] }          -> domain allowlist   (admin)
 *   { action: "setRetention", days }             -> retention window   (admin)
 *   { action: "log", event, detail }             -> record a client-side action
 */
import { normalise, json, verifyToken, secret } from './lib/identity.mjs';
import {
  blobs, readOrg, joinOrg, roleOf, can, record, readAudit, policy,
  ROLES, ROLE_LABEL, CAN, FREE_LIMIT, DEFAULT_RETENTION_DAYS,
} from './lib/org.mjs';

/* Actions the browser is allowed to report. A client-reported event is
   recorded as such: the log says `client` beside it, because an upload
   happens in a browser and the server did not witness it. Saying which
   entries were observed and which were reported is the same discipline the
   product applies to a client's own evidence. */
const CLIENT_EVENTS = new Set(['case.uploaded', 'case.dispositioned',
  'report.exported', 'report.opened']);

const RETENTION_CHOICES = [7, 30, 90, 180, 365];

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'expected JSON' }); }

  if (!secret()) {
    return json(503, { error: 'verification is not configured', needs: ['LENS_SECRET'] });
  }

  const claims = await verifyToken(body.token);
  if (!claims) return json(401, { error: 'a verified session is required' });

  const key = claims.k;
  const id = normalise(claims.e);
  if (!key || !id) return json(401, { error: 'that session is not usable' });

  const getStore = await blobs();
  if (!getStore) return json(503, { error: 'storage is not available to this function' });
  const orgs = getStore({ name: 'lens-quota', consistency: 'strong' });
  const audit = getStore({ name: 'lens-audit', consistency: 'strong' });

  const rec = await readOrg(orgs, key, id);
  if (!rec) return json(503, { error: 'storage is not available to this function' });
  joinOrg(rec, id);
  const role = roleOf(rec, id.email);

  const save = async () => {
    try { await orgs.setJSON(key, rec); return true; } catch { return false; }
  };

  const view = () => ({
    domain: rec.domain,
    plan: rec.plan,
    used: rec.used,
    limit: FREE_LIMIT,
    retentionDays: rec.retentionDays,
    allow: rec.allow,
    policy: policy(),
    you: { email: id.email, role, can: CAN[role] },
    roles: ROLE_LABEL,
    /* Everyone sees who is in their workspace. Only an admin can change it.
       Hiding the membership from a reviewer would make the log unreadable to
       the people most likely to need it. */
    members: Object.entries(rec.members).map(([email, m]) => ({
      email,
      role: m.role,
      company: m.company || '',
      firstSeen: m.firstSeen,
      lastSeen: m.lastSeen,
      you: email === id.email,
    })).sort((a, b) => a.email.localeCompare(b.email)),
  });

  /* ── everybody ───────────────────────────────────────────────────── */
  if (body.action === 'state') return json(200, view());

  if (body.action === 'log') {
    if (!CLIENT_EVENTS.has(body.event)) return json(400, { error: 'unknown event' });
    /* Read-only members cannot upload or export, so a report of either from
       one is itself worth recording rather than discarding silently. */
    const permitted = body.event === 'report.opened'
      || (body.event === 'case.uploaded' && can(role, 'upload'))
      || (body.event === 'case.dispositioned' && can(role, 'run'))
      || (body.event === 'report.exported' && can(role, 'export'));
    await record(audit, key, {
      action: body.event,
      actor: id.email,
      detail: permitted
        ? String(body.detail || '').slice(0, 200)
        : `refused: ${role}`,
      src: 'client',
    }, rec.retentionDays);
    return json(200, { recorded: true, permitted });
  }

  /* ── admin only ──────────────────────────────────────────────────── */
  if (!can(role, 'manage') && body.action !== 'audit') {
    return json(403, { error: 'that action needs an admin', role });
  }
  if (body.action === 'audit' && !can(role, 'audit')) {
    return json(403, { error: 'the audit log is visible to an admin', role });
  }

  if (body.action === 'audit') {
    const events = await readAudit(audit, key, rec.retentionDays);
    await record(audit, key, { action: 'admin.audit.exported', actor: id.email },
      rec.retentionDays);
    return json(200, { events, retentionDays: rec.retentionDays });
  }

  if (body.action === 'setRole') {
    const target = normalise(body.email);
    if (!target || !rec.members[target.email]) return json(400, { error: 'no such member' });
    if (!ROLES.includes(body.role)) return json(400, { error: 'unknown role' });
    /* An organisation must keep someone who can administer it. Removing the
       last admin would leave a workspace nobody can manage and no route back
       except asking us, which is a support ticket waiting to happen. */
    const admins = Object.entries(rec.members).filter(([, m]) => m.role === 'admin');
    if (admins.length === 1 && admins[0][0] === target.email && body.role !== 'admin') {
      return json(400, { error: 'a workspace must keep at least one admin' });
    }
    const was = rec.members[target.email].role;
    rec.members[target.email].role = body.role;
    if (!(await save())) return json(503, { error: 'could not save' });
    await record(audit, key, {
      action: 'admin.role.changed', actor: id.email,
      detail: `${target.email}: ${was} to ${body.role}`,
    }, rec.retentionDays);
    return json(200, view());
  }

  if (body.action === 'removeMember') {
    const target = normalise(body.email);
    if (!target || !rec.members[target.email]) return json(400, { error: 'no such member' });
    if (target.email === id.email) return json(400, { error: 'you cannot remove yourself' });
    const admins = Object.entries(rec.members).filter(([, m]) => m.role === 'admin');
    if (admins.length === 1 && admins[0][0] === target.email) {
      return json(400, { error: 'a workspace must keep at least one admin' });
    }
    delete rec.members[target.email];
    if (!(await save())) return json(503, { error: 'could not save' });
    await record(audit, key, {
      action: 'admin.member.removed', actor: id.email, detail: target.email,
    }, rec.retentionDays);
    return json(200, view());
  }

  if (body.action === 'setAllow') {
    const list = (Array.isArray(body.domains) ? body.domains : [])
      .map((d) => String(d || '').trim().toLowerCase())
      .filter((d) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d))
      .slice(0, 25);
    /* The founding domain cannot be removed. Without this an admin could lock
       their own organisation out of its own workspace in one click. */
    if (!list.includes(rec.domain)) list.unshift(rec.domain);
    const was = rec.allow.join(', ');
    rec.allow = [...new Set(list)];
    if (!(await save())) return json(503, { error: 'could not save' });
    await record(audit, key, {
      action: 'admin.allowlist.changed', actor: id.email,
      detail: `${was} to ${rec.allow.join(', ')}`,
    }, rec.retentionDays);
    return json(200, view());
  }

  if (body.action === 'setRetention') {
    const days = Number(body.days);
    if (!RETENTION_CHOICES.includes(days)) {
      return json(400, { error: 'retention must be one of ' + RETENTION_CHOICES.join(', ') });
    }
    const was = rec.retentionDays;
    rec.retentionDays = days;
    if (!(await save())) return json(503, { error: 'could not save' });
    await record(audit, key, {
      action: 'admin.retention.changed', actor: id.email, detail: `${was} to ${days} days`,
    }, days);
    return json(200, view());
  }

  return json(400, { error: 'unknown action' });
};

export const config = { path: '/api/org' };
export { RETENTION_CHOICES, DEFAULT_RETENTION_DAYS };
