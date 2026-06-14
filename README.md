# @kraty/server-sdk

Server-side Node.js SDK for the Kraty game-events platform. Targets
the `/server/v1` server surface — manual grants, IAP fulfilment,
inventory grant / revoke, wallet credit / debit, push-lobbies, and
unified player snapshots.

> **Server-side only.** Authenticated with a `server_integration`
> API key that can mint currency and items. Embedding this SDK or
> its key in a web/mobile bundle is a security incident — use
> [`@kraty/sdk`](../sdk-typescript/) (web/JS) or
> [`@kraty/sdk-flutter`](../sdk-flutter/) / [`@kraty/sdk-unity`](../sdk-unity/)
> for game clients instead.

## Install

```bash
pnpm add @kraty/server-sdk
# or
npm install @kraty/server-sdk
```

## Quickstart

```ts
import { KratyServer } from '@kraty/server-sdk';

const kraty = new KratyServer({
  apiKey: process.env.KRATY_SERVER_KEY!,   // server_integration key
});

// ── IAP fulfilment ──────────────────────────────────────────────
// Idempotency: pass the receipt id as the key — replays return the
// SAME grant without a duplicate mint.
await kraty.wallet.credit('player_42', 'gold', {
  amount: 500,
  reason: 'iap',
  sourceRefId: 'apple_receipt_abc',
  idempotencyKey: 'apple_receipt_abc',
});

await kraty.inventory.grant('player_42', 'starter_chest', {
  quantity: 1,
  reason: 'iap',
  idempotencyKey: 'apple_receipt_abc',
});

// Or a single mixed grant — items + currency in one atomic row:
await kraty.grants.create('player_42', {
  idempotencyKey: 'apple_receipt_abc',
  entries: [
    { type: 'currency', currencyKey: 'gold', amount: 500 },
    { type: 'item',     itemKey: 'starter_chest', quantity: 1 },
  ],
  sourceKind: 'api',
  sourceRefId: 'apple_receipt_abc',
});
```

## Resource clients

```ts
kraty.grants      // create (manual mint) / ack
kraty.inventory   // grant / revoke
kraty.wallet      // credit / debit
kraty.lobbies     // push (pre-matched) / read
kraty.players     // get (unified snapshot)
kraty.health      // ping
```

## Idempotency

Every POST is auto-stamped with an `idempotencyKey` if you don't
supply one — but for server-side fulfilment you almost always want
to **provide your own** key (typically the IAP receipt id or your
internal fulfilment record id). That way:

- Replays of the same fulfilment (network retries, crash recovery,
  webhook redelivery) return the **original** grant.
- A misconfigured retry that ships a different body returns
  `KratyServerError` with `isIdempotencyConflict === true` — so
  duplicate mints can't sneak through silently.

```ts
try {
  await kraty.wallet.credit('p', 'gold', {
    amount: 500,
    idempotencyKey: receiptId,
  });
} catch (err) {
  if (err instanceof KratyServerError && err.isIdempotencyConflict) {
    // Same receipt, different payload — investigate before retrying.
    alertOps({ receiptId });
  } else {
    throw err;
  }
}
```

## Retries

Every transient failure (`408` / `425` / `429` / `5xx` + network
crash) is retried with exponential backoff + jitter, preserving the
same `idempotencyKey` across attempts so the server's idempotency
check dedupes the replay.

```ts
new KratyServer({
  apiKey: '...',
  retry: {
    attempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    jitter: 0.25,
  },
});
```

`Retry-After` headers (used by 429 responses) are honored.

## Error handling

```ts
import { KratyServerError, KratyNetworkError } from '@kraty/server-sdk';

try {
  await kraty.grants.create('player_42', { ... });
} catch (err) {
  if (err instanceof KratyServerError) {
    if (err.isIdempotencyConflict) {
      // duplicate fulfilment with different body
    } else if (err.isNotFound) {
      // player or item doesn't exist in this game
    } else if (err.isForbidden) {
      // wrong key for this game/studio
    } else if (err.isRateLimited) {
      // burst limit — retry budget already exhausted
    }
  } else if (err instanceof KratyNetworkError) {
    // backend unreachable
  }
}
```

## Telemetry

```ts
new KratyServer({
  apiKey: '...',
  onRequest: (info) => {
    metrics.timing(`kraty_server.${info.url}`, info.durationMs);
    if (!info.ok) metrics.increment(`kraty_server.error.${info.status}`);
  },
});
```

Fires once per HTTP attempt, including retries.

## Resource reference

| Client | Methods |
|---|---|
| `kraty.grants` | `create(externalId, input)`, `ack(externalId, grantId, input?)` |
| `kraty.inventory` | `grant(externalId, itemKey, input)`, `revoke(externalId, itemKey, input)` |
| `kraty.wallet` | `credit(externalId, economyKey, input)`, `debit(externalId, economyKey, input)` |
| `kraty.lobbies` | `push(gameId, eventKey, input)`, `read(gameId, lobbyId)` |
| `kraty.players` | `get(externalId)` |
| `kraty.health` | `ping()` |

## Development

```bash
pnpm -F @kraty/server-sdk build
pnpm -F @kraty/server-sdk test
```

Tests use a fake `fetch` (no real network IO) — useful as a worked
example when you're writing tests for your own fulfilment pipeline.
