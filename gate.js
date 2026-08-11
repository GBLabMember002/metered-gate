'use strict';

/**
 * Metered entitlement gate: reference implementation
 *
 * The problem: you sell an AI product in tiers, and your cost drivers are
 * heterogeneous. One feature burns tokens. Another burns requests against a
 * per-call vendor. A third burns wall-clock seconds of an always-on pipeline.
 * You need per-user, per-tier ceilings on all three, and you need to enforce
 * them *before* you spend money, not after.
 *
 * This is that gate, extracted from a production XR assistant where it sat in
 * front of every billable backend. It deliberately carries no product logic,
 * which is what let the same file drop into multiple services unchanged.
 *
 * Three pluggable seams, so it isn't married to any vendor:
 *   verifyIdentity(req)  -> uid          (Firebase Auth, Auth0, your JWTs...)
 *   resolveEntitlement(uid) -> tier      (RevenueCat, Stripe, your own table)
 *   store                                (Firestore, Postgres, Redis...)
 *
 * An in-memory store is included so the tests (and you) can run it with no
 * infrastructure at all.
 *
 *   const gate = createGate({ ... });
 *   const { uid, tier, limit, used } = await gate.check(req, 'tokens');  // before
 *   const total = await gate.charge(uid, tokensSpent, 'tokens');         // after
 */

/** Error carrying the HTTP status and body the caller should relay. */
class GateError extends Error {
  constructor(status, body) {
    super((body && body.error) || 'gate_error');
    this.name = 'GateError';
    this.status = status;
    this.body = body;
  }
}

// ── Week boundary ─────────────────────────────────────────────────────────
// Monday 00:00 UTC, as "YYYY-MM-DD". Every meter resets together when this
// rolls over. UTC on purpose: a local-time boundary means the reset moves
// under daylight saving, and users notice a quota that resets an hour late.
function weekStartUtc(now = Date.now()) {
  const d = new Date(now);
  const dow = d.getUTCDay();                    // 0=Sun ... 6=Sat
  const sinceMonday = dow === 0 ? 6 : dow - 1;
  return new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday,
  )).toISOString().slice(0, 10);
}

/** Shape the client mirrors in its own usage display. */
function usageBody(used, limit, tier) {
  return { used, limit, tier, remaining: Math.max(0, limit - used) };
}

/**
 * @param {object}   opts
 * @param {object}   opts.limits              { meter: { tier: number } }, weekly ceilings
 * @param {function} opts.verifyIdentity      async (req) => uid
 * @param {function} opts.resolveEntitlement  async (uid) => tier
 * @param {object}   opts.store               see MemoryStore below
 * @param {string}   [opts.defaultTier]       fallback when entitlements are unreachable
 * @param {function} [opts.now]               injectable clock (tests, week rollover)
 */
function createGate({
  limits,
  verifyIdentity,
  resolveEntitlement,
  store,
  defaultTier = 'free',
  now = Date.now,
  paidCacheTtlMs = 5 * 60 * 1000,
  freeCacheTtlMs = 60 * 1000,
}) {
  const METERS = Object.keys(limits);
  if (METERS.length === 0) throw new Error('limits must define at least one meter');

  // ── Tier cache ──────────────────────────────────────────────────────────
  // A chatty feature can gate once per utterance, so without a cache every
  // line makes an external billing call.
  //
  // The TTLs are deliberately asymmetric, and this is the least obvious
  // decision in the file. A PAID result is cached for minutes, since
  // entitlements are stable and re-checking a subscriber buys nothing. A FREE result is
  // cached for seconds, because "free" is the state a user leaves the instant
  // they pay. Cache it as long as a paid result and someone who just
  // subscribed keeps hitting free limits for five minutes, which reads as a
  // broken purchase. Short free TTL is what lets the server catch up in
  // seconds without any cross-instance invalidation.
  const tierCache = new Map(); // uid -> { tier, at }

  async function tierFor(uid) {
    const hit = tierCache.get(uid);
    if (hit) {
      const ttl = hit.tier === defaultTier ? freeCacheTtlMs : paidCacheTtlMs;
      if (now() - hit.at < ttl) return hit.tier;
    }

    // Degrade, never hard-fail. If the billing provider 404s, 500s, or times
    // out, the user drops to the default tier rather than getting an error.
    // That is a deliberate trade: a billing outage caps a paying customer at
    // free limits, which is bad. The alternative is a billing outage taking down
    // the product entirely, which is worse. Log it and move on.
    let tier;
    try {
      tier = (await resolveEntitlement(uid)) || defaultTier;
    } catch {
      tier = defaultTier;
    }
    if (!(tier in (limits[METERS[0]] || {}))) tier = defaultTier;

    tierCache.set(uid, { tier, at: now() });
    return tier;
  }

  const meterOr = (meter) => (METERS.includes(meter) ? meter : METERS[0]);

  /**
   * Pre-call gate. Run this BEFORE the billable work.
   * Throws GateError 401 (identity) or 402 (over quota).
   */
  async function check(req, meter) {
    const m = meterOr(meter);
    const uid = await verifyIdentity(req);           // never trust a uid from the body
    if (!uid) throw new GateError(401, { error: 'unauthenticated' });

    const tier = await tierFor(uid);
    const limit = limits[m][tier] ?? 0;

    const record = await store.read(uid);
    const used = record && record.week === weekStartUtc(now()) ? (record[m] || 0) : 0;

    if (used >= limit) {
      throw new GateError(402, {
        error: 'quota_exceeded',
        meter: m,
        usage: usageBody(used, limit, tier),
      });
    }
    return { uid, tier, limit, used };
  }

  /**
   * Post-call charge. Run this AFTER, with the real cost.
   *
   * The subtlety: this rewrites EVERY meter rather than incrementing one.
   *
   * A bare increment is wrong at the week boundary. If the week rolls over
   * between check() and charge(), or between any two charges, an increment
   * carries last week's total forward into the new week, and the meters drift
   * apart because each one only resets when it happens to be charged. Reading
   * the record and rewriting all meters inside a transaction keeps their weekly
   * boundary in lockstep: the first charge of a new week zeroes everything and
   * grows only the charged meter.
   *
   * @returns {number} the new weekly total for that meter
   */
  async function charge(uid, amount, meter) {
    const m = meterOr(meter);
    const week = weekStartUtc(now());
    const add = Math.max(0, Math.floor(Number(amount) || 0)); // never charge negative

    return store.transact(uid, (record) => {
      const sameWeek = record && record.week === week;
      const next = { week };
      for (const name of METERS) {
        const current = sameWeek ? (record[name] || 0) : 0;
        next[name] = name === m ? current + add : current;
      }
      // Archive under the week's own id. Because the id IS the Monday date,
      // history needs no rollover handling and survives the hot-counter reset.
      return { record: next, archive: { week, meter: m, amount: add } };
    });
  }

  /** Test seam / manual invalidation after a known upgrade. */
  function invalidateTier(uid) {
    if (uid === undefined) tierCache.clear();
    else tierCache.delete(uid);
  }

  return { check, charge, usageBody, invalidateTier, GateError, METERS };
}

// ── Reference store ───────────────────────────────────────────────────────
/**
 * In-memory store, so this runs with no infrastructure.
 *
 * A real adapter needs exactly two operations:
 *   read(uid)              -> record | null
 *   transact(uid, mutate)  -> new total, applying mutate() atomically
 *
 * `transact` must be genuinely atomic - two concurrent charges that both
 * read-then-write will lose one of them. Firestore's runTransaction, a
 * Postgres SERIALIZABLE txn, or a Redis Lua script all satisfy this. A plain
 * read followed by a write does not.
 */
class MemoryStore {
  constructor() {
    this.records = new Map();
    this.archive = [];
  }

  async read(uid) {
    return this.records.get(uid) || null;
  }

  async transact(uid, mutate) {
    const { record, archive } = mutate(this.records.get(uid) || null);
    this.records.set(uid, record);
    if (archive && archive.amount > 0) {
      const key = `${uid}:${archive.week}`;
      const row = this.archive.find((r) => r.key === key)
        || (this.archive.push({ key, uid, week: archive.week, totals: {}, charges: {} }),
            this.archive[this.archive.length - 1]);
      row.totals[archive.meter] = (row.totals[archive.meter] || 0) + archive.amount;
      row.charges[archive.meter] = (row.charges[archive.meter] || 0) + 1;
    }
    return record[archive.meter];
  }
}

module.exports = { createGate, MemoryStore, GateError, weekStartUtc, usageBody };
