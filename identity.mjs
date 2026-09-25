/* Identity, shared by the verify and quota functions.
 *
 * One copy of the normalisation rule and one copy of the token format, so the
 * endpoint that issues a token and the endpoint that trusts it cannot drift
 * apart. A mismatch between them would not fail loudly; it would quietly stop
 * enforcing the allowance, which is the failure this whole change exists to
 * remove.
 */

/* Consumer mailboxes have no company behind them, so they are keyed on the
   whole address. Everything else is keyed on the domain, which is what makes
   the allowance belong to the organisation rather than the person. */
const CONSUMER = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
  'yandex.com', 'zoho.com', 'qq.com', '163.com',
]);

export function normalise(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.endsWith('.')) return null;
  /* A plus-tag is the cheapest way to look like a new person, so it is
     stripped before the address is used as a key. */
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  const consumer = CONSUMER.has(domain);
  return {
    email: `${local}@${domain}`,
    domain,
    consumer,
    key: consumer ? `person:${local}@${domain}` : `company:${domain}`,
  };
}

export const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

/* ── the signing secret ──────────────────────────────────────────────────
   No secret means no tokens, and no tokens means the allowance cannot be
   enforced. The functions report that state rather than falling back to
   trusting whatever the caller claims, because a silent fallback to the
   insecure behaviour is exactly the defect being closed. */
export const secret = () => process.env.LENS_SECRET || '';
export const configured = () => Boolean(secret()) && Boolean(mailProvider());

export function mailProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.POSTMARK_TOKEN) return 'postmark';
  return null;
}

/* ── token format ────────────────────────────────────────────────────────
   <base64url payload>.<base64url HMAC-SHA256>. The payload is readable, which
   is fine: it carries no secret, only who this is and when it stops being
   true. The signature is what makes it unforgeable. */
const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (s) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function key() {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

async function sign(data) {
  return b64url(await crypto.subtle.sign('HMAC', await key(), enc.encode(data)));
}

/* Compares two strings without leaking, through timing, how much of the
   signature was right. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export async function issue(id, ttl = TOKEN_TTL_MS) {
  const payload = b64url(enc.encode(JSON.stringify({
    k: id.key, e: id.email, x: Date.now() + ttl,
  })));
  return `${payload}.${await sign(payload)}`;
}

/* Returns the payload when the token is genuine and current, and null in
   every other case. Callers treat null as unauthenticated. */
export async function verifyToken(token) {
  if (!secret() || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected;
  try { expected = await sign(payload); } catch { return null; }
  if (!same(sig, expected)) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(unb64url(payload))); } catch { return null; }
  if (!claims || typeof claims.x !== 'number' || Date.now() > claims.x) return null;
  return claims;
}

/* ── code hashing ────────────────────────────────────────────────────────
   The code is never stored. What is stored is an HMAC of it, so a reader of
   the store cannot sign in as anybody. */
export async function hashCode(code, email) {
  return sign(`code:${email}:${code}`);
}

export const codesEqual = same;
