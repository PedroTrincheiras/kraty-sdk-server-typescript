import type { KratyServerClient } from './client.js';
import type {
  AckGrantInput,
  AdjustItemInput,
  AdjustItemResult,
  AdjustWalletInput,
  AdjustWalletResult,
  BanPlayerInput,
  BanPlayerResult,
  CreateGrantInput,
  MergePlayerResult,
  DeletePlayerInput,
  DeletePlayerResult,
  Grant,
  Lobby,
  MigrateInventoryRow,
  MigrateOutcome,
  MigratePlayerRow,
  MigrateWalletRow,
  PingResponse,
  PlayerExport,
  PlayerSnapshot,
  PushLobbyInput,
  ReportProgressInput,
  ReportProgressResult,
  SubmitScoreInput,
  SubmitScoreResult,
  UnbanPlayerResult,
} from './types.js';

interface DataEnvelope<T> { data: T; }

/**
 * `/server/v1/players/:externalId/grants` — manual grant minting.
 * Used for IAP fulfilment, make-goods, manual operator rewards, and
 * any other server-issued payout.
 */
export class GrantsClient {
  constructor(private readonly client: KratyServerClient) {}

  /**
   * POST `/server/v1/players/:externalId/grants` — mint a new grant
   * for the player.
   *
   * <b>Idempotency:</b> always supply `idempotencyKey` — the SDK
   * also generates one if you don't, but for server-side fulfilment
   * the IAP receipt id is almost always what you want. Replaying the
   * same key with the same body returns the original grant. Replaying
   * with a DIFFERENT body returns 409 `idempotency_conflict` so a
   * misconfigured retry can't silently mint duplicates.
   *
   * Reward grants land in the player's `pending-grants` queue,
   * waiting for the client SDK's `claim` (or for your server-side
   * `ack` call). Crate grants need `open` first to roll their
   * contents.
   */
  async create(externalPlayerId: string, input: CreateGrantInput): Promise<Grant> {
    const env = await this.client.request<DataEnvelope<Grant>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/grants`,
      input,
    );
    return env.data;
  }

  /**
   * POST `/server/v1/players/:externalId/grants/:grantId/ack` —
   * server-side claim. Use this when your backend wants to flip a
   * grant to `claimed` without the player's client SDK having to
   * round-trip (e.g. consumable that's already applied server-side).
   * Records `ackedBy='server_api'` on the audit row.
   *
   * Idempotent on `grantId` — re-acking returns the same row.
   */
  async ack(
    externalPlayerId: string,
    grantId: string,
    input: AckGrantInput = {},
  ): Promise<Grant> {
    const env = await this.client.request<DataEnvelope<Grant>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/grants/${encodeURIComponent(grantId)}/ack`,
      input,
    );
    return env.data;
  }
}

/**
 * `/server/v1/players/:p/inventory(/...)` — server-side mint + revoke
 * for items in the platform-managed inventory. Only meaningful when
 * the game has `settings.inventoryManagement === 'platform'`.
 */
export class InventoryClient {
  constructor(private readonly client: KratyServerClient) {}

  /**
   * POST `/server/v1/players/:p/inventory/:itemKey/grant` —
   * platform-managed inventory increment. Used for IAP item delivery,
   * make-goods, or operator-issued items.
   *
   * Idempotency key is required for correctness — use the IAP
   * receipt id. The SDK auto-stamps one if omitted but you almost
   * always want to override.
   */
  async grant(
    externalPlayerId: string,
    itemKey: string,
    input: AdjustItemInput,
  ): Promise<AdjustItemResult> {
    const env = await this.client.request<DataEnvelope<AdjustItemResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/inventory/${encodeURIComponent(itemKey)}/grant`,
      input,
    );
    return env.data;
  }

  /**
   * POST `/server/v1/players/:p/inventory/:itemKey/revoke` —
   * platform-managed inventory decrement. Used for chargebacks,
   * refunds, or admin corrections.
   *
   * 409 on insufficient quantity — the audit ledger never goes
   * negative.
   */
  async revoke(
    externalPlayerId: string,
    itemKey: string,
    input: AdjustItemInput,
  ): Promise<AdjustItemResult> {
    const env = await this.client.request<DataEnvelope<AdjustItemResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/inventory/${encodeURIComponent(itemKey)}/revoke`,
      input,
    );
    return env.data;
  }
}

/**
 * `/server/v1/players/:p/wallet(/...)` — server-side currency mint +
 * burn. Counterpart to client SDK's `wallet.debit`: only the server
 * surface can credit balance (mint money), which is why this SDK ships
 * as a separate package from the client SDK.
 */
export class WalletClient {
  constructor(private readonly client: KratyServerClient) {}

  /**
   * POST `/server/v1/players/:p/wallet/:economyKey/credit` — atomic
   * increment. Used for IAP currency fulfilment, support reissues,
   * and tournament prize distribution.
   *
   * Idempotent on `idempotencyKey` (e.g. the IAP receipt). Replay
   * with same body = no-op; replay with different body = 409.
   */
  async credit(
    externalPlayerId: string,
    economyKey: string,
    input: AdjustWalletInput,
  ): Promise<AdjustWalletResult> {
    const env = await this.client.request<DataEnvelope<AdjustWalletResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/wallet/${encodeURIComponent(economyKey)}/credit`,
      input,
    );
    return env.data;
  }

  /**
   * POST `/server/v1/players/:p/wallet/:economyKey/debit` — atomic
   * decrement. Used for refunds and admin corrections. 409 on
   * insufficient balance.
   *
   * The client SDK can ALSO debit — this method exists for server-
   * authoritative spends (your backend deducts before granting an
   * item or unlocking content).
   */
  async debit(
    externalPlayerId: string,
    economyKey: string,
    input: AdjustWalletInput,
  ): Promise<AdjustWalletResult> {
    const env = await this.client.request<DataEnvelope<AdjustWalletResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/wallet/${encodeURIComponent(economyKey)}/debit`,
      input,
    );
    return env.data;
  }
}

/**
 * `/server/v1/games/:gameId/...lobbies` — push externally-matched
 * lobbies into Kraty. Use when your studio's own matchmaker (e.g.
 * Steam, GameLift, Photon) already chose a roster of players and
 * you want Kraty to host the event window + scoring for them.
 */
export class LobbiesClient {
  constructor(private readonly client: KratyServerClient) {}

  /**
   * POST `/server/v1/games/:gameId/events/:eventKey/lobbies` —
   * create a lobby with a pre-matched roster. Idempotent on `key`.
   *
   * Requires the event's `leaderboardMode` to be `'lobby_matched'`.
   * Returns 409 on mode mismatch.
   */
  async push(
    gameId: string,
    eventKey: string,
    input: PushLobbyInput,
  ): Promise<Lobby> {
    const env = await this.client.request<DataEnvelope<Lobby>>(
      'POST',
      `/server/v1/games/${encodeURIComponent(gameId)}/events/${encodeURIComponent(eventKey)}/lobbies`,
      input,
    );
    return env.data;
  }

  /**
   * GET `/server/v1/games/:gameId/lobbies/:lobbyId` — server-side
   * lobby read. Wider field set than the client-side `lobbies.read`:
   * exposes audit-relevant fields needed for support tooling.
   */
  async read(gameId: string, lobbyId: string): Promise<Lobby> {
    const env = await this.client.request<DataEnvelope<Lobby>>(
      'GET',
      `/server/v1/games/${encodeURIComponent(gameId)}/lobbies/${encodeURIComponent(lobbyId)}`,
    );
    return env.data;
  }
}

/**
 * `/server/v1/leaderboards/:key/score` — server-authoritative score
 * submission. Unlike the client SDK's score path, this surface is NOT
 * subject to the game's `acceptClientScores` gate: the `server_integration`
 * key is trusted, so studios that keep scoring server-side (anti-cheat,
 * simulation results) write here.
 */
export class LeaderboardsClient {
  constructor(private readonly client: KratyServerClient) {}

  /**
   * POST `/server/v1/leaderboards/:key/score` — submit a score for a
   * player on a score-ranked board.
   *
   * <b>Segmentation:</b> on `context` boards pass `opts.segment` as the
   * bucket value; on `progression` boards omit it (the server derives
   * the bucket from the player's progression state); on unsegmented
   * boards it's ignored.
   *
   * Returns 404 (`KratyServerError` with `isNotFound`) for an unknown
   * player or board, and 400 `score_not_supported` for progression-ranked
   * boards (which don't accept raw scores — adjust the progression item
   * instead).
   */
  async submitScore(
    externalPlayerId: string,
    key: string,
    value: number,
    opts: SubmitScoreInput = {},
  ): Promise<SubmitScoreResult> {
    const body: { externalPlayerId: string; value: number; segment?: string; idempotencyKey?: string } = {
      externalPlayerId,
      value,
    };
    if (opts.segment !== undefined) body.segment = opts.segment;
    if (opts.idempotencyKey !== undefined) body.idempotencyKey = opts.idempotencyKey;
    const env = await this.client.request<DataEnvelope<SubmitScoreResult>>(
      'POST',
      `/server/v1/leaderboards/${encodeURIComponent(key)}/score`,
      body,
    );
    return env.data;
  }
}

/**
 * `/server/v1/players/:externalId/events/...` — server-authoritative
 * event progress. Same shape as the client SDK's progress endpoint, but
 * driven from your backend (trusted simulation, server-side match
 * results) rather than the game client.
 */
export class EventsClient {
  constructor(private readonly client: KratyServerClient) {}

  /**
   * POST
   * `/server/v1/players/:externalId/events/:eventKey/attempts/:attemptId/progress`
   * — push a metric update onto an in-flight attempt.
   *
   * `mode: 'set'` writes the value as the new metric; `'increment'`
   * adds to the current. Returns the updated attempt plus any
   * milestones that fired (and the grants they wrote) this call.
   */
  async reportProgress(
    externalPlayerId: string,
    eventKey: string,
    attemptId: string,
    input: ReportProgressInput,
  ): Promise<ReportProgressResult> {
    const env = await this.client.request<DataEnvelope<ReportProgressResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/events/${encodeURIComponent(eventKey)}/attempts/${encodeURIComponent(attemptId)}/progress`,
      input,
    );
    return env.data;
  }
}

/**
 * `/server/v1/players/:externalId` — unified player snapshot for
 * support / admin tooling. Returns the player row plus their
 * inventory, wallet, and recent grants in one call.
 */
export class PlayersClient {
  constructor(private readonly client: KratyServerClient) {}

  async get(externalPlayerId: string): Promise<PlayerSnapshot> {
    const env = await this.client.request<DataEnvelope<PlayerSnapshot>>(
      'GET',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}`,
    );
    return env.data;
  }

  /**
   * POST `/server/v1/players/:externalId/delete` — GDPR Article 17
   * right of erasure. Anonymizes the player row in place and
   * cascades through attempts, lobbies, and the Redis leaderboard
   * meta. The financial ledger (grants, item / wallet ledgers) is
   * retained per audit requirements but its FK now points at an
   * anonymized row.
   *
   * Emits one final `player.deleted` webhook with the original
   * external id so your backend can mirror the deletion. Idempotent
   * — replays return `status: 'no_op_*'`, and erasure for a
   * never-existed player succeeds with `status: 'no_op_never_existed'`
   * (GDPR semantics — there was no data to erase).
   */
  async delete(
    externalPlayerId: string,
    input: DeletePlayerInput = {},
  ): Promise<DeletePlayerResult> {
    const env = await this.client.request<DataEnvelope<DeletePlayerResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/delete`,
      input,
    );
    return env.data;
  }

  /**
   * GET `/server/v1/players/:externalId/export` — GDPR Article 15
   * right of access. Returns the full machine-readable bundle of
   * everything Kraty stores about the player (profile, attempts,
   * grants, inventory, wallet, lobbies). Each list is hard-capped
   * at 1,000 rows.
   *
   * Returns 404 (`KratyServerError` with `isNotFound`) when the
   * player is unknown to Kraty.
   */
  async export(externalPlayerId: string): Promise<PlayerExport> {
    const env = await this.client.request<DataEnvelope<PlayerExport>>(
      'GET',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/export`,
    );
    return env.data;
  }

  /**
   * POST `/server/v1/players/:externalId/ban` — soft-ban a player.
   * Gates future SDK writes (events.start / progress / claim /
   * open / debit / consume / register all return 403
   * `player_banned`) without touching existing scores or grants.
   *
   * Typical use case: studio's own anti-cheat pipeline detects an
   * anomaly and bans the player automatically. The actor is
   * recorded as `api_key:<prefix>` on the audit row.
   *
   * Idempotent — re-banning refreshes the reason and updates the
   * audit but doesn't re-fire the webhook.
   */
  async ban(
    externalPlayerId: string,
    input: BanPlayerInput,
  ): Promise<BanPlayerResult> {
    const env = await this.client.request<DataEnvelope<BanPlayerResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/ban`,
      input,
    );
    return env.data;
  }

  /**
   * POST `/server/v1/players/:fromExternalId/merge-into/:toExternalId`
   * — fold the source player's record into the target. Reassigns
   * attempts, grants, item + wallet ledgers; sums balances on key
   * collision (the target's quantity + the source's quantity);
   * dedupes lobby memberships; rewrites the source row to a
   * `__merged_<uuid>__` placeholder so the original external id is
   * available for re-registration.
   *
   * Typical use: guest player on a fresh device finishes onboarding,
   * signs in via OAuth, and the studio backend folds the guest
   * record into the authenticated player.
   *
   * Idempotent — replaying with the same `fromExternalPlayerId`
   * after the merge returns `{ status: 'no_op_already_merged' }`
   * with the existing target. Throws `KratyServerError` with
   * `code='not_found'` on missing players and `code='conflict'`
   * (422) on invalid merges (same player, or the target is banned
   * / deleted).
   */
  async merge(
    fromExternalPlayerId: string,
    toExternalPlayerId: string,
  ): Promise<MergePlayerResult> {
    const env = await this.client.request<DataEnvelope<MergePlayerResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(fromExternalPlayerId)}/merge-into/${encodeURIComponent(toExternalPlayerId)}`,
    );
    return env.data;
  }

  /**
   * POST `/server/v1/players/:externalId/unban` — lift a soft-ban.
   * Symmetric to {@link ban}. The player can resume SDK writes
   * immediately. Idempotent — unbanning a non-banned player is a
   * no-op with `applied: false`.
   */
  async unban(externalPlayerId: string): Promise<UnbanPlayerResult> {
    const env = await this.client.request<DataEnvelope<UnbanPlayerResult>>(
      'POST',
      `/server/v1/players/${encodeURIComponent(externalPlayerId)}/unban`,
    );
    return env.data;
  }
}

/**
 * `/server/v1/migrate/*` — bulk-import endpoints for studios moving
 * existing players, wallets, and inventory into Kraty from another
 * platform.
 *
 * Each method accepts up to 1,000 rows per call. Every row carries
 * its own `idempotencyKey` (typically the studio's stable id for
 * that player / wallet entry / inventory holding) so retries are
 * safe at the row level. Bad rows are captured in
 * `MigrateOutcome.failures` — the rest of the batch still applies.
 *
 * Studios with larger datasets loop client-side:
 *
 * ```ts
 * for (const chunk of chunked(allPlayers, 1000)) {
 *   const out = await kraty.migrate.players(chunk);
 *   if (out.failed > 0) collectForRetry(out.failures);
 * }
 * ```
 *
 * Webhooks are NOT emitted during migration — a 100k-player import
 * would otherwise flood the studio's own backend with
 * `player.registered` / `inventory.changed` / `wallet.changed`
 * deliveries. Studios that want onboarding-side-effects can run them
 * via the regular routes after migration completes.
 */
export class MigrateClient {
  constructor(private readonly client: KratyServerClient) {}

  /**
   * POST `/server/v1/migrate/players` — bulk-import players from
   * another platform. Each row's `idempotencyKey` is typically the
   * studio's stable player id; replays return the same player
   * without applying twice.
   */
  async players(rows: MigratePlayerRow[]): Promise<MigrateOutcome> {
    const env = await this.client.request<DataEnvelope<MigrateOutcome>>(
      'POST',
      '/server/v1/migrate/players',
      { rows },
    );
    return env.data;
  }

  /**
   * POST `/server/v1/migrate/wallet` — bulk-credit wallet balances.
   * Players are auto-upserted on first contact so the wallet import
   * doesn't need the players import to have run first.
   */
  async wallet(rows: MigrateWalletRow[]): Promise<MigrateOutcome> {
    const env = await this.client.request<DataEnvelope<MigrateOutcome>>(
      'POST',
      '/server/v1/migrate/wallet',
      { rows },
    );
    return env.data;
  }

  /**
   * POST `/server/v1/migrate/inventory` — bulk-grant inventory rows.
   * `parameters` lets you carry forward per-instance attributes from
   * the source platform (e.g. a granted potion's roll stats).
   */
  async inventory(rows: MigrateInventoryRow[]): Promise<MigrateOutcome> {
    const env = await this.client.request<DataEnvelope<MigrateOutcome>>(
      'POST',
      '/server/v1/migrate/inventory',
      { rows },
    );
    return env.data;
  }
}

/**
 * `/server/v1/ping` — connectivity + key-info echo. Useful for
 * deploy-time smoke tests ("is the env var wired to the right key?").
 */
export class HealthClient {
  constructor(private readonly client: KratyServerClient) {}

  async ping(): Promise<PingResponse> {
    return await this.client.request<PingResponse>('GET', '/server/v1/ping');
  }
}
