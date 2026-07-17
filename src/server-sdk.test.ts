import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KratyNetworkError,
  KratyServer,
  KratyServerClient,
  KratyServerError,
} from './index.js';

/**
 * Tests for the Node server SDK. Mirrors the test surface of the
 * client SDK but targets the `/server/v1` shape: idempotent mints
 * (grants / credit / item-grant), revoke / debit, lobby push, and
 * the player snapshot read.
 */

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const factory = responses[i++];
    if (!factory) throw new Error(`fake fetch exhausted; got call ${i}`);
    return await factory();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let keyCounter = 0;
const deterministicKey = (): string => `idem-${++keyCounter}`;

beforeEach(() => { keyCounter = 0; });
afterEach(() => { vi.restoreAllMocks(); });

const baseOpts = (fetchImpl: typeof fetch) => ({
  apiKey: 'sUUVdrM8.djr4-0Iv9h1JvVNSMZNDmSsSN7lSVq2F9dG6DG4A5uQ',
  baseUrl: 'https://api.test.kraty.io',
  fetch: fetchImpl,
  generateIdempotencyKey: deterministicKey,
  retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 5, jitter: 0 },
  timeoutMs: 1_000,
});

describe('KratyServerClient: request layer', () => {
  it('sends Authorization: Bearer <key>', async () => {
    const { fetch, calls } = makeFetch([() => jsonRes(200, { ok: true })]);
    const c = new KratyServerClient(baseOpts(fetch));
    await c.request<{ ok: boolean }>('GET', '/server/v1/ping');
    expect(calls[0]?.headers['authorization']).toBe(
      'Bearer sUUVdrM8.djr4-0Iv9h1JvVNSMZNDmSsSN7lSVq2F9dG6DG4A5uQ',
    );
  });

  it('throws KratyServerError on non-2xx with envelope', async () => {
    const { fetch } = makeFetch([
      () => jsonRes(404, { error: { code: 'not_found', message: 'no player' } }),
    ]);
    const c = new KratyServerClient(baseOpts(fetch));
    try {
      await c.request('GET', '/server/v1/players/missing');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KratyServerError);
      const apiErr = err as KratyServerError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe('not_found');
      expect(apiErr.isNotFound).toBe(true);
    }
  });

  it('preserves the same idempotencyKey across retries', async () => {
    const { fetch, calls } = makeFetch([
      () => new Response('', { status: 503 }),
      () => new Response('', { status: 503 }),
      () => jsonRes(201, { data: {} }),
    ]);
    const c = new KratyServerClient(baseOpts(fetch));
    await c.request('POST', '/server/v1/foo', { x: 1 });
    expect(calls.length).toBe(3);
    expect(calls.every((c) => (c.body as { idempotencyKey: string }).idempotencyKey === 'idem-1')).toBe(true);
    expect(keyCounter).toBe(1);
  });

  it('preserves a caller-supplied idempotencyKey (the IAP receipt)', async () => {
    const { fetch, calls } = makeFetch([() => jsonRes(201, { data: {} })]);
    const c = new KratyServerClient(baseOpts(fetch));
    await c.request('POST', '/server/v1/foo', { idempotencyKey: 'apple_receipt_abc', x: 1 });
    expect((calls[0]?.body as { idempotencyKey: string }).idempotencyKey).toBe('apple_receipt_abc');
    expect(keyCounter).toBe(0);
  });

  it('wraps fetch crash as KratyNetworkError after retries are exhausted', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const c = new KratyServerClient({
      ...baseOpts(fetchImpl),
      retry: { attempts: 2, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
    });
    await expect(c.request('POST', '/server/v1/foo', { x: 1 })).rejects.toBeInstanceOf(KratyNetworkError);
  });
});

describe('KratyServer: GrantsClient', () => {
  it('grants.create posts to the right URL and returns the grant', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(201, { data: { id: 'g1', kind: 'reward', contents: {}, sourceKind: 'api', sourceRefId: 'rcpt', parentGrantId: null, status: 'pending', rolledAt: null, claimedAt: null, expiresAt: null, createdAt: '2026-01-01' } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const g = await k.grants.create('player_42', {
      idempotencyKey: 'apple_receipt_abc',
      entries: [{ type: 'currency', currencyKey: 'gold', amount: 500 }],
      sourceRefId: 'rcpt',
    });
    expect(g.id).toBe('g1');
    expect(calls[0]?.url).toContain('/server/v1/players/player_42/grants');
    expect(calls[0]?.body).toMatchObject({
      idempotencyKey: 'apple_receipt_abc',
      entries: [{ type: 'currency', currencyKey: 'gold', amount: 500 }],
      sourceRefId: 'rcpt',
    });
  });

  it('grants.create surfaces idempotency_conflict as a typed error', async () => {
    const { fetch } = makeFetch([
      () => jsonRes(409, { error: { code: 'idempotency_conflict', message: 'same key, different body' } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    try {
      await k.grants.create('player_42', {
        idempotencyKey: 'rcpt',
        entries: [{ type: 'currency', currencyKey: 'gold', amount: 100 }],
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KratyServerError);
      expect((err as KratyServerError).isIdempotencyConflict).toBe(true);
    }
  });

  it('grants.ack posts to the right URL', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { id: 'g1', kind: 'reward', contents: {}, sourceKind: 'api', sourceRefId: null, parentGrantId: null, status: 'claimed', rolledAt: null, claimedAt: '2026-01-01T00:00:00Z', expiresAt: null, createdAt: '2026-01-01' } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const g = await k.grants.ack('player_42', 'g1');
    expect(g.status).toBe('claimed');
    expect(calls[0]?.url).toContain('/server/v1/players/player_42/grants/g1/ack');
  });
});

describe('KratyServer: InventoryClient', () => {
  it('inventory.grant POSTs to /inventory/:itemKey/grant', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { itemKey: 'starter_chest', quantity: 1, applied: true } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const res = await k.inventory.grant('player_42', 'starter_chest', {
      quantity: 1,
      reason: 'iap',
      idempotencyKey: 'rcpt',
    });
    expect(res.applied).toBe(true);
    expect(res.quantity).toBe(1);
    expect(calls[0]?.url).toContain('/server/v1/players/player_42/inventory/starter_chest/grant');
    expect(calls[0]?.body).toMatchObject({ quantity: 1, reason: 'iap', idempotencyKey: 'rcpt' });
  });

  it('inventory.revoke POSTs to /inventory/:itemKey/revoke', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { itemKey: 'starter_chest', quantity: 0, applied: true } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    await k.inventory.revoke('player_42', 'starter_chest', { quantity: 1, reason: 'chargeback' });
    expect(calls[0]?.url).toContain('/inventory/starter_chest/revoke');
    // Auto-stamps idempotency key when caller doesn't supply one.
    expect((calls[0]?.body as { idempotencyKey: string }).idempotencyKey).toBe('idem-1');
  });
});

describe('KratyServer: WalletClient', () => {
  it('wallet.credit posts amount + key to /credit', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { economyKey: 'gold', balance: 600, applied: true } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const res = await k.wallet.credit('player_42', 'gold', {
      amount: 500,
      reason: 'iap',
      idempotencyKey: 'rcpt_xyz',
    });
    expect(res.balance).toBe(600);
    expect(calls[0]?.url).toContain('/server/v1/players/player_42/wallet/gold/credit');
    expect(calls[0]?.body).toMatchObject({ amount: 500, reason: 'iap', idempotencyKey: 'rcpt_xyz' });
  });

  it('wallet.debit posts amount + key to /debit', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { economyKey: 'gold', balance: 400, applied: true } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    await k.wallet.debit('player_42', 'gold', { amount: 100, reason: 'refund' });
    expect(calls[0]?.url).toContain('/wallet/gold/debit');
  });
});

describe('KratyServer: LobbiesClient', () => {
  it('push creates a lobby with the supplied roster + idempotency key', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(201, { data: { id: 'lob1', eventId: 'e1', eventWindowId: 'w1', leaderboardId: 'lb1', mode: 'lobby_matched', status: 'active', capacity: 4, fillBy: null, participantCount: 2, botSlots: 0, startedAt: null, endsAt: null } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const lobby = await k.lobbies.push('game_1', 'quick_brawl', {
      key: 'matchmaker_lobby_123',
      externalPlayerIds: ['alice', 'bob'],
      capacity: 4,
    });
    expect(lobby.id).toBe('lob1');
    expect(calls[0]?.url).toContain('/server/v1/games/game_1/events/quick_brawl/lobbies');
    expect(calls[0]?.body).toMatchObject({
      key: 'matchmaker_lobby_123',
      externalPlayerIds: ['alice', 'bob'],
      capacity: 4,
    });
  });

  it('read GETs from /games/:gameId/lobbies/:lobbyId', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { id: 'lob1', eventId: 'e1', eventWindowId: 'w1', leaderboardId: 'lb1', mode: 'lobby_matched', status: 'active', capacity: 4, fillBy: null, participantCount: 2, botSlots: 0, startedAt: null, endsAt: null } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    await k.lobbies.read('game_1', 'lob1');
    expect(calls[0]?.url).toContain('/server/v1/games/game_1/lobbies/lob1');
    expect(calls[0]?.method).toBe('GET');
  });
});

describe('KratyServer: PlayersClient', () => {
  it('get returns the unified snapshot', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, {
        data: {
          player: { id: 'p1', externalPlayerId: 'alice', studioId: 's1', gameId: 'g1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
          inventory: [{ itemKey: 'potion', quantity: 3, metadata: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
          wallet: [{ economyKey: 'gold', balance: 100, metadata: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
          recentGrants: [],
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const snap = await k.players.get('alice');
    expect(snap.player.externalPlayerId).toBe('alice');
    expect(snap.inventory).toHaveLength(1);
    expect(snap.wallet[0]?.balance).toBe(100);
    expect(calls[0]?.url).toContain('/server/v1/players/alice');
  });
});

describe('KratyServer: PlayersClient GDPR', () => {
  it('delete POSTs to /players/:id/delete with reason and returns the outcome', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, {
        data: {
          playerId: 'p1',
          externalPlayerId: 'alice',
          anonymizedExternalId: '__deleted_abc-123__',
          deletedAt: '2026-06-11T10:00:00.000Z',
          attemptsAnonymized: 12,
          lobbiesAnonymized: 3,
          leaderboardsScrubbed: 4,
          status: 'erased',
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const out = await k.players.delete('alice', { reason: 'gdpr_erasure' });
    expect(out.status).toBe('erased');
    expect(out.anonymizedExternalId).toMatch(/^__deleted_/);
    expect(calls[0]?.url).toContain('/server/v1/players/alice/delete');
    expect((calls[0]?.body as { reason: string }).reason).toBe('gdpr_erasure');
  });

  it('delete for a never-existed player returns no_op_never_existed', async () => {
    const { fetch } = makeFetch([
      () => jsonRes(200, {
        data: {
          playerId: null,
          externalPlayerId: 'ghost',
          anonymizedExternalId: null,
          deletedAt: '2026-06-11T10:00:00.000Z',
          attemptsAnonymized: 0,
          lobbiesAnonymized: 0,
          leaderboardsScrubbed: 0,
          status: 'no_op_never_existed',
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const out = await k.players.delete('ghost');
    expect(out.status).toBe('no_op_never_existed');
    expect(out.playerId).toBeNull();
  });

  it('export GETs /players/:id/export and returns the bundle', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, {
        data: {
          schemaVersion: 1,
          exportedAt: '2026-06-11T10:00:00.000Z',
          player: {
            id: 'p1',
            externalPlayerId: 'alice',
            studioId: 's1',
            gameId: 'g1',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-06-10T12:00:00.000Z',
            lastContextSnapshot: { country: 'PT' },
            registeredAt: '2026-01-01T00:00:00.000Z',
            secretRotatedAt: null,
            deletedAt: null,
          },
          attempts: [{ id: 'att1', status: 'completed' }],
          grants: [],
          inventory: [{ itemKey: 'potion', quantity: 3 }],
          wallet: [{ economyKey: 'gold', balance: 500 }],
          lobbies: [],
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const exp = await k.players.export('alice');
    expect(exp.schemaVersion).toBe(1);
    expect(exp.player.externalPlayerId).toBe('alice');
    expect(exp.attempts).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/server/v1/players/alice/export');
  });

  it('export surfaces 404 as a typed not-found error', async () => {
    const { fetch } = makeFetch([
      () => jsonRes(404, { error: { code: 'not_found', message: "Player 'ghost' not found" } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    let caught: unknown = null;
    try {
      await k.players.export('ghost');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KratyServerError);
    expect((caught as KratyServerError).isNotFound).toBe(true);
  });
});

describe('KratyServer: PlayersClient friends (read-only)', () => {
  it('friends GETs /players/:id/friends and unwraps data.friends', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, {
        data: {
          friends: [
            {
              externalPlayerId: 'bob',
              displayIdentity: { name: 'Bob', avatar: null, country: 'PT' },
              friendsSince: '2026-01-01T00:00:00.000Z',
              online: true,
              lastActiveAt: '2026-06-10T12:00:00.000Z',
              status: 'in_match',
            },
          ],
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const friends = await k.players.friends('alice');
    expect(friends).toHaveLength(1);
    expect(friends[0]?.externalPlayerId).toBe('bob');
    expect(friends[0]?.online).toBe(true);
    expect(friends[0]?.displayIdentity?.name).toBe('Bob');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/server/v1/players/alice/friends');
  });

  it('friendRequests GETs /friends/requests and returns incoming + outgoing', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, {
        data: {
          incoming: [
            {
              requestId: 'r1',
              direction: 'incoming',
              player: { externalPlayerId: 'carol', displayIdentity: { name: 'Carol' } },
              createdAt: '2026-06-01T00:00:00.000Z',
            },
          ],
          outgoing: [],
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const reqs = await k.players.friendRequests('alice');
    expect(reqs.incoming).toHaveLength(1);
    expect(reqs.incoming[0]?.direction).toBe('incoming');
    expect(reqs.outgoing).toHaveLength(0);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/server/v1/players/alice/friends/requests');
  });

  it('blocks GETs /players/:id/blocks and unwraps data.blocked', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, {
        data: {
          blocked: [
            {
              externalPlayerId: 'mallory',
              displayIdentity: null,
              blockedAt: '2026-05-01T00:00:00.000Z',
            },
          ],
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const blocked = await k.players.blocks('alice');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.externalPlayerId).toBe('mallory');
    expect(blocked[0]?.displayIdentity).toBeNull();
    expect(calls[0]?.url).toContain('/server/v1/players/alice/blocks');
  });

  it('friends surfaces 404 as a typed not-found error', async () => {
    const { fetch } = makeFetch([
      () => jsonRes(404, { error: { code: 'not_found', message: "Player 'ghost' not found" } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    let caught: unknown = null;
    try {
      await k.players.friends('ghost');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KratyServerError);
    expect((caught as KratyServerError).isNotFound).toBe(true);
  });
});

describe('KratyServer: MigrateClient', () => {
  it('migrate.players POSTs to /migrate/players with the rows envelope', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { applied: 2, skipped: 0, failed: 0, failures: [] } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const rows = [
      { externalPlayerId: 'p_1', idempotencyKey: 'p_1' },
      { externalPlayerId: 'p_2', idempotencyKey: 'p_2', contextSnapshot: { country: 'PT' } },
    ];
    const out = await k.migrate.players(rows);
    expect(out.applied).toBe(2);
    expect(calls[0]?.url).toContain('/server/v1/migrate/players');
    expect((calls[0]?.body as { rows: unknown }).rows).toEqual(rows);
  });

  it('migrate.wallet POSTs to /migrate/wallet', async () => {
    const { fetch, calls } = makeFetch([
      () => jsonRes(200, { data: { applied: 1, skipped: 0, failed: 0, failures: [] } }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const out = await k.migrate.wallet([
      { externalPlayerId: 'p_1', economyKey: 'gold', amount: 500, idempotencyKey: 'p_1:gold' },
    ]);
    expect(out.applied).toBe(1);
    expect(calls[0]?.url).toContain('/server/v1/migrate/wallet');
  });

  it('migrate.inventory surfaces per-row failures', async () => {
    const { fetch } = makeFetch([
      () => jsonRes(200, {
        data: {
          applied: 1,
          skipped: 0,
          failed: 1,
          failures: [
            { rowIndex: 1, externalPlayerId: 'p_2', error: { code: 'unknown_item', message: 'item not found' } },
          ],
        },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const out = await k.migrate.inventory([
      { externalPlayerId: 'p_1', itemKey: 'potion', quantity: 3, idempotencyKey: 'p_1:potion' },
      { externalPlayerId: 'p_2', itemKey: 'gone', quantity: 1, idempotencyKey: 'p_2:gone' },
    ]);
    expect(out.failed).toBe(1);
    expect(out.failures[0]?.error.code).toBe('unknown_item');
  });
});

describe('KratyServer: HealthClient', () => {
  it('ping returns ok + api key info', async () => {
    const { fetch } = makeFetch([
      () => jsonRes(200, {
        ok: true,
        apiKey: { id: 'k1', prefix: 'sUUVdrM8', permissionSet: 'server_integration', environment: 'live', studioId: 's1', gameId: 'g1' },
      }),
    ]);
    const k = new KratyServer(baseOpts(fetch));
    const p = await k.health.ping();
    expect(p.ok).toBe(true);
    expect(p.apiKey.permissionSet).toBe('server_integration');
  });
});
