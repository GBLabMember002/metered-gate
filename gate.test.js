'use strict';
/**
 * The cases worth testing are the ones that only fail in production:
 * the week boundary, the billing-provider outage, and the cache TTLs.
 *
 *   node gate.test.js
 */
const assert = require('node:assert');
const test = require('node:test');
const { createGate, MemoryStore, weekStartUtc } = require('./gate.js');

const LIMITS = {
  tokens:   { free: 1_000, pro: 100_000 },
  requests: { free: 10,    pro: 1_000 },
  seconds:  { free: 0,     pro: 3_600 },   // a pro-only feature
};

// 2026-08-12 is a Wednesday; 2026-08-17 the following Monday.
const WED = Date.UTC(2026, 7, 12, 12, 0, 0);
const NEXT_MON = Date.UTC(2026, 7, 17, 0, 30, 0);

function harness({ tier = 'free', entitlementThrows = false, at = WED } = {}) {
  const store = new MemoryStore();
  let clock = at;
  const gate = createGate({
    limits: LIMITS,
    store,
    now: () => clock,
    verifyIdentity: async (req) => (req.token ? `uid-${req.token}` : null),
    resolveEntitlement: async () => {
      if (entitlementThrows) throw new Error('billing provider down');
      return tier;
    },
  });
  return { gate, store, setClock: (t) => { clock = t; }, req: { token: 'a' } };
}

test('week boundary is Monday 00:00 UTC', () => {
  assert.equal(weekStartUtc(WED), '2026-08-10');        // Wed -> that Monday
  assert.equal(weekStartUtc(NEXT_MON), '2026-08-17');   // Monday is its own week start
  // Sunday belongs to the week that started the previous Monday, not the next.
  assert.equal(weekStartUtc(Date.UTC(2026, 7, 16, 23, 59)), '2026-08-10');
});

test('rejects a request with no credential', async () => {
  const { gate } = harness();
  await assert.rejects(() => gate.check({}, 'tokens'), (e) => e.status === 401);
});

test('allows under the limit and reports remaining', async () => {
  const { gate, req } = harness();
  const out = await gate.check(req, 'tokens');
  assert.equal(out.tier, 'free');
  assert.equal(out.limit, 1_000);
  assert.equal(out.used, 0);
});

test('blocks with 402 once the meter is at its ceiling', async () => {
  const { gate, req } = harness();
  await gate.charge('uid-a', 1_000, 'tokens');
  await assert.rejects(() => gate.check(req, 'tokens'), (e) => {
    assert.equal(e.status, 402);
    assert.equal(e.body.error, 'quota_exceeded');
    assert.equal(e.body.usage.remaining, 0);
    return true;
  });
});

test('meters are independent - exhausting one leaves the others open', async () => {
  const { gate, req } = harness();
  await gate.charge('uid-a', 10, 'requests');           // requests now full
  await assert.rejects(() => gate.check(req, 'requests'), (e) => e.status === 402);
  const out = await gate.check(req, 'tokens');           // tokens unaffected
  assert.equal(out.used, 0);
});

test('a tier with a zero ceiling is blocked outright', async () => {
  // Models a pro-only feature: free users hard-stop at 0 rather than getting
  // one free call through the >= comparison.
  const { gate, req } = harness({ tier: 'free' });
  await assert.rejects(() => gate.check(req, 'seconds'), (e) => e.status === 402);
});

test('charge accumulates and returns the new weekly total', async () => {
  const { gate } = harness();
  assert.equal(await gate.charge('uid-a', 100, 'tokens'), 100);
  assert.equal(await gate.charge('uid-a', 250, 'tokens'), 350);
});

test('charge clamps negative and non-numeric amounts to zero', async () => {
  const { gate } = harness();
  await gate.charge('uid-a', -500, 'tokens');
  await gate.charge('uid-a', 'abc', 'tokens');
  assert.equal(await gate.charge('uid-a', 0, 'tokens'), 0);
});

test('WEEK ROLLOVER: every meter resets together, not just the charged one', async () => {
  // The bug a bare increment would ship. Spend on two meters, roll the clock
  // into next week, then charge ONE of them - the untouched meter must also
  // have reset, or the meters drift apart and each only resets when it
  // happens to be billed.
  const { gate, store, setClock } = harness();
  await gate.charge('uid-a', 900, 'tokens');
  await gate.charge('uid-a', 9, 'requests');

  setClock(NEXT_MON);
  assert.equal(await gate.charge('uid-a', 5, 'tokens'), 5); // not 905

  const record = await store.read('uid-a');
  assert.equal(record.week, '2026-08-17');
  assert.equal(record.tokens, 5);
  assert.equal(record.requests, 0, 'untouched meter must reset with the week');
});

test('WEEK ROLLOVER: a stale record reads as zero without being rewritten', async () => {
  const { gate, req, setClock } = harness();
  await gate.charge('uid-a', 1_000, 'tokens');   // at the ceiling
  setClock(NEXT_MON);
  const out = await gate.check(req, 'tokens');   // must not be blocked
  assert.equal(out.used, 0);
});

test('history survives the weekly reset', async () => {
  const { gate, store, setClock } = harness();
  await gate.charge('uid-a', 400, 'tokens');
  setClock(NEXT_MON);
  await gate.charge('uid-a', 700, 'tokens');

  const weeks = store.archive.filter((r) => r.uid === 'uid-a');
  assert.equal(weeks.length, 2, 'one archive row per week');
  assert.equal(weeks.find((w) => w.week === '2026-08-10').totals.tokens, 400);
  assert.equal(weeks.find((w) => w.week === '2026-08-17').totals.tokens, 700);
});

test('OUTAGE: an entitlement provider failure degrades to free, it does not throw', async () => {
  // The availability trade, made explicit. A billing outage must cap a paid
  // user at free limits - not take the product down.
  const { gate, req } = harness({ tier: 'pro', entitlementThrows: true });
  const out = await gate.check(req, 'tokens');
  assert.equal(out.tier, 'free');
  assert.equal(out.limit, 1_000);
});

test('an unrecognised tier falls back rather than yielding an undefined limit', async () => {
  const { gate, req } = harness({ tier: 'enterprise' }); // not in LIMITS
  const out = await gate.check(req, 'tokens');
  assert.equal(out.tier, 'free');
});

test('an unknown meter falls back to the first defined meter', async () => {
  const { gate, req } = harness();
  const out = await gate.check(req, 'not-a-meter');
  assert.equal(out.limit, LIMITS.tokens.free);
});

test('CACHE TTL: a free result expires fast so a new subscriber is seen quickly', async () => {
  // The asymmetry that makes upgrades feel instant. Free is cached ~60s, so a
  // user who just paid is recognised in seconds - not after the paid TTL.
  const store = new MemoryStore();
  let clock = WED;
  let tier = 'free';
  let calls = 0;
  const gate = createGate({
    limits: LIMITS, store, now: () => clock,
    verifyIdentity: async () => 'uid-a',
    resolveEntitlement: async () => { calls++; return tier; },
  });

  assert.equal((await gate.check({}, 'tokens')).tier, 'free');
  assert.equal(calls, 1);

  clock += 30_000;                                        // inside the free TTL
  assert.equal((await gate.check({}, 'tokens')).tier, 'free');
  assert.equal(calls, 1, 'served from cache');

  tier = 'pro';                                           // user subscribes
  clock += 40_000;                                        // now past the 60s free TTL
  assert.equal((await gate.check({}, 'tokens')).tier, 'pro');
  assert.equal(calls, 2, 're-resolved promptly after upgrade');
});

test('CACHE TTL: a paid result is held longer, sparing the billing provider', async () => {
  const store = new MemoryStore();
  let clock = WED;
  let calls = 0;
  const gate = createGate({
    limits: LIMITS, store, now: () => clock,
    verifyIdentity: async () => 'uid-a',
    resolveEntitlement: async () => { calls++; return 'pro'; },
  });

  await gate.check({}, 'tokens');
  clock += 90_000;                       // would have expired a free result
  await gate.check({}, 'tokens');
  assert.equal(calls, 1, 'paid tier still cached');

  clock += 5 * 60_000;                   // past the paid TTL
  await gate.check({}, 'tokens');
  assert.equal(calls, 2);
});
