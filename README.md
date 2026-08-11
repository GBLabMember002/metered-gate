# Metered entitlement gate

Per-user, per-tier usage ceilings for AI products whose cost drivers don't
share a unit.

```bash
node gate.test.js    # 16 tests, no dependencies, no infrastructure
```

This bounds cost *per user*. Its companion,
**[two-tier-router](https://github.com/GBLabMember002/two-tier-router)**, bounds it *per
turn* - route each request with a cheap model so only the ones that need it reach an
expensive one.

## The problem

You sell an AI product in tiers. Your costs look like this:

| Feature | What it burns | Unit |
|---|---|---|
| Assistant | model tokens | tokens |
| Translation | one vendor transcription + one model call | requests |
| Always-on listening | a streaming pipeline that bills by time | seconds |

That's three meters in three different units under one subscription. You need ceilings on all
of them, per tier, enforced **before** the spend rather than discovered on the invoice.

The naive version, a request counter, under-bills the user who sends novels
and over-bills the one sending one-word commands. Per-meter accounting is the
only version that tracks actual cost.

## Usage

```js
const { createGate, MemoryStore } = require('./gate.js');

const gate = createGate({
  limits: {
    tokens:   { free: 1_000_000, pro: 100_000_000 },
    requests: { free: 5_000,     pro: 100_000 },
    seconds:  { free: 0,         pro: 72_000 },   // pro-only feature
  },
  verifyIdentity:     async (req) => uidFromBearerToken(req),
  resolveEntitlement: async (uid) => tierFromBillingProvider(uid),
  store:              new MemoryStore(),          // swap for a real adapter
});

// before the billable call
const { uid, tier, limit, used } = await gate.check(req, 'tokens');

// after it, with the real cost
const total = await gate.charge(uid, response.usage.total_tokens, 'tokens');
```

`check` throws `GateError` with `401` (bad identity) or `402` (over quota) and a
body you can relay straight to the client.

Three seams keep it vendor-neutral: identity (Firebase Auth, Auth0, your own
JWTs), entitlement (RevenueCat, Stripe, a column in your database), and the
store. The in-memory store ships with it so the tests (and you) can run it
against nothing.

## Four decisions worth stealing

### 1. Rewrite every meter on charge, never increment one

The bug that a bare `increment` ships, and the reason `charge()` does a
read-modify-write inside a transaction:

If the week rolls over between two charges, an increment carries last week's
total into the new week. Worse, each meter then only resets when it *happens to
be charged*, so a user who stops translating keeps a stale translation total
forever while their token count resets on schedule. The meters drift apart and
nothing looks obviously broken.

Rewriting all meters together means the first charge of a new week zeroes
everything and grows only the one being billed. Their weekly boundary stays in
lockstep by construction.

### 2. Cache paid and free tiers for different durations

The least obvious line in the file, and the one users feel.

A chatty feature gates once per utterance, so the tier lookup needs a cache or
every line hits your billing provider. But the two results are not
symmetrically stale:

- **Paid** is stable. Cache it for minutes; re-checking a subscriber buys nothing.
- **Free** is the state a user leaves the instant they pay. Cache it as long as
  a paid result and someone who just subscribed keeps hitting free limits for
  five minutes, which reads as a broken purchase, right after the moment they
  gave you money.

So free results get a short TTL and paid ones a long one. The server catches up in seconds,
with no cross-instance invalidation to build.

### 3. A billing outage must not be an outage

Every failure path in tier resolution (unknown customer, non-2xx, timeout, parse
error) degrades to the default tier instead of throwing.

That is a real trade, not an oversight: during a billing-provider incident, a
paying customer gets capped at free limits. The alternative is that your
provider's incident becomes your incident and the product stops working for
everyone. Better to cap a handful of paying users than to take the product down for all of
them. Worth alerting on, so a silent degradation doesn't become permanent.

### 4. Cap the cheapest sufficient meter

When two costs are coupled, say an always-on pipeline where speech recognition and
model inference both run for the duration of a session, you don't need a ceiling on
each. Capping the *session by time* bounds both exactly, and one of
the token meters can stay as a loose backstop.

Fewer meaningful limits are easier to explain on a pricing page, and easier for
the client to mirror in its own usage display.

## What's soft about this

**A client-reported meter is an honest-effort meter, not an enforced one.** If
the app streams to a vendor directly and reports elapsed time back, a modified
client can under-report. In the system this came from, that was accepted
deliberately: the token meter was the hard backstop, and the real fix, per-user auth
on the vendor key rather than a shared hand-out, was a larger change than the
exposure justified at that stage.

Worth stating plainly rather than implying every meter is equally trustworthy.
Know which of your limits are enforced and which are polite.

**`store.transact` must be genuinely atomic.** Two concurrent charges that each
read-then-write will lose one. Firestore's `runTransaction`, a Postgres
`SERIALIZABLE` transaction, or a Redis Lua script all qualify. A read followed
by a write does not. The in-memory reference store is single-threaded and
sidesteps this; your adapter can't.

## What I'd do differently

Emit the meters as structured events from day one, not just as counters. The hot
document answers "can this request proceed," and the weekly archive answers
"what did this user spend". Neither answers "which feature is actually
driving cost," which is the question you have the moment the bill is surprising. It's the same
write with one more field on it.

## Use it

No licence, no attribution needed. Copy anything that's useful.
