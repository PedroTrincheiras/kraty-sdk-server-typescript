/**
 * Wire types for the `/server/v1` surface, mirroring the OpenAPI
 * spec at `apps/backend/openapi.server.json`. Server-side admin
 * operations: manual grants, IAP fulfilment, inventory grant/revoke,
 * wallet credit/debit, lobby push, player snapshot lookups.
 */

// ─── Grants ────────────────────────────────────────────────────────

/**
 * One reward entry inside a manual grant. Discriminated by `type`.
 */
export type GrantEntry =
  | { type: 'currency'; currencyKey: string; amount: number }
  | { type: 'item'; itemKey: string; quantity: number; parameters?: Record<string, unknown> }
  | { type: 'crate'; crateItemKey: string; quantity: number };

export interface CreateGrantInput {
  /**
   * Required — your idempotency token. Reusing the same key with the
   * same body returns the original grant; reusing it with a DIFFERENT
   * body returns 409 `idempotency_conflict`. Usually the IAP receipt
   * id or your internal fulfilment id.
   */
  idempotencyKey: string;
  /** Defaults to `'reward'`. Crate grants must be `/open`-ed by the player to roll their contents. */
  kind?: 'reward' | 'crate';
  /** At least one entry. Mix of currencies, items, and crates is allowed. */
  entries: GrantEntry[];
  /** Optional ISO datetime — grant expires (unclaimable) after this. */
  expiresAt?: string;
  /** Defaults to `'api'`. Use `'admin'` for portal-operator overrides. */
  sourceKind?: 'api' | 'admin';
  /** Free-form tracing id (e.g. IAP receipt id). Surfaces in audit + webhooks. */
  sourceRefId?: string;
  /** Free-form metadata blob — store receipt body, attribution, etc. */
  metadata?: Record<string, unknown>;
}

export type GrantKind = 'reward' | 'crate';
export type GrantStatus = 'pending' | 'claimed' | 'expired';

export interface Grant {
  id: string;
  kind: GrantKind;
  contents: Record<string, unknown>;
  sourceKind: string;
  sourceRefId: string | null;
  parentGrantId: string | null;
  status: GrantStatus;
  rolledAt: string | null;
  claimedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface AckGrantInput {
  idempotencyKey?: string;
}

// ─── Inventory + wallet (server-side mints + revokes) ──────────────

export interface AdjustItemInput {
  /** Positive integer. The server validates and returns 400 on zero / negative. */
  quantity: number;
  /** Free-form ledger tag (e.g. `'iap_fulfillment'`, `'chargeback'`). */
  reason?: string;
  /** Tracing id — usually the IAP receipt or refund id. */
  sourceRefId?: string;
  /** Auto-stamped by the SDK if omitted. */
  idempotencyKey?: string;
}

export interface AdjustWalletInput {
  amount: number;
  reason?: string;
  sourceRefId?: string;
  idempotencyKey?: string;
}

export interface AdjustItemResult {
  itemKey: string;
  quantity: number;
  applied: boolean;
}

export interface AdjustWalletResult {
  economyKey: string;
  balance: number;
  applied: boolean;
}

// ─── Push lobbies ──────────────────────────────────────────────────

export interface PushLobbyInput {
  /** Studio-owned lobby id — used as the idempotency token. */
  key: string;
  /** External player ids. Upserted as players if they don't exist yet. */
  externalPlayerIds: string[];
  /** Override capacity. Defaults to the event's `leaderboard.capacity`. */
  capacity?: number;
  /** Override bot fill. Defaults to the event's `leaderboard.fillBots`. */
  fillBots?: boolean;
  /** Free-form metadata stored on the lobby row. */
  metadata?: Record<string, unknown>;
}

export type LobbyStatus = 'forming' | 'active' | 'closed';

export interface Lobby {
  id: string;
  eventId: string;
  eventWindowId: string;
  leaderboardId: string | null;
  mode: string;
  status: LobbyStatus | string;
  capacity: number;
  fillBy: string | null;
  participantCount: number;
  botSlots?: number;
  startedAt: string | null;
  endsAt: string | null;
}

// ─── Player snapshot ───────────────────────────────────────────────

/**
 * Server-side player view — unified snapshot returned by
 * `GET /server/v1/players/:externalId`. Wider than the client-side
 * shape: includes the audit-relevant fields a studio backend needs
 * for support tooling.
 */
export interface PlayerSnapshot {
  player: {
    id: string;
    externalPlayerId: string;
    studioId: string;
    gameId: string;
    createdAt: string;
    updatedAt: string;
  };
  inventory: Array<{
    itemKey: string;
    quantity: number;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>;
  wallet: Array<{
    economyKey: string;
    balance: number;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>;
  recentGrants: Grant[];
}

// ─── GDPR (Right of Erasure + Right of Access) ─────────────────────

export type ErasureReason = 'gdpr_erasure' | 'studio_request' | 'test';

export interface DeletePlayerInput {
  /**
   * Legal basis recorded on the audit row. Defaults server-side to
   * `'gdpr_erasure'` — pass `'studio_request'` for account-closure
   * deletions that aren't regulatory, or `'test'` for dev cleanups.
   */
  reason?: ErasureReason;
}

export type DeletePlayerStatus =
  | 'erased'
  | 'no_op_already_erased'
  | 'no_op_never_existed';

export interface DeletePlayerResult {
  /** Internal player UUID; null when the player never existed in Kraty. */
  playerId: string | null;
  /** The original external id you requested erasure for. */
  externalPlayerId: string;
  /** `__deleted_<uuid>__` placeholder the row carries post-erasure. */
  anonymizedExternalId: string | null;
  deletedAt: string;
  attemptsAnonymized: number;
  lobbiesAnonymized: number;
  leaderboardsScrubbed: number;
  status: DeletePlayerStatus;
}

export interface PlayerExport {
  schemaVersion: 1;
  exportedAt: string;
  player: {
    id: string;
    externalPlayerId: string;
    studioId: string;
    gameId: string;
    firstSeenAt: string;
    lastSeenAt: string;
    lastContextSnapshot: Record<string, unknown> | null;
    registeredAt: string | null;
    secretRotatedAt: string | null;
    deletedAt: string | null;
  };
  attempts: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
  inventory: Array<Record<string, unknown>>;
  wallet: Array<Record<string, unknown>>;
  lobbies: Array<{
    id: string;
    eventId: string;
    status: string;
    createdAt: string;
  }>;
}

// ─── Ban / unban ───────────────────────────────────────────────────

export interface BanPlayerInput {
  /**
   * Operator-supplied free-form reason. Recorded on the audit row
   * and on the `player.banned` webhook payload.
   */
  reason: string;
}

export interface BanPlayerResult {
  playerId: string;
  externalPlayerId: string;
  bannedAt: string;
  reason: string;
  /** `true` on first-time ban; `false` on a re-ban that just refreshed the reason. */
  applied: boolean;
}

export interface UnbanPlayerResult {
  playerId: string;
  externalPlayerId: string;
  unbannedAt: string;
  /** `true` on first-time unban; `false` when the player wasn't banned to begin with. */
  applied: boolean;
}

export interface MergePlayerResult {
  fromPlayerId: string;
  fromExternalPlayerId: string;
  toPlayerId: string;
  toExternalPlayerId: string;
  /** `__merged_<uuid>__` placeholder the source row now carries. */
  anonymizedExternalPlayerId: string | null;
  counts: {
    attemptsReassigned: number;
    grantsReassigned: number;
    itemsMerged: number;
    itemLedgerRowsMoved: number;
    walletsMerged: number;
    walletLedgerRowsMoved: number;
    lobbiesTouched: number;
    leaderboardsScrubbed: number;
  };
  mergedAt: string;
  /** `'merged'` on first call; `'no_op_already_merged'` on idempotent replay. */
  status: 'merged' | 'no_op_already_merged';
}

// ─── Migration (bulk import) ───────────────────────────────────────

/**
 * One row in a `/server/v1/migrate/players` batch. `idempotencyKey`
 * is typically the studio's stable player id so retries are safe.
 */
export interface MigratePlayerRow {
  externalPlayerId: string;
  /** Optional initial player-context snapshot (country, level, etc). */
  contextSnapshot?: Record<string, unknown>;
  idempotencyKey: string;
}

/** One row in a `/server/v1/migrate/wallet` batch. Positive amounts only. */
export interface MigrateWalletRow {
  externalPlayerId: string;
  economyKey: string;
  amount: number;
  reason?: string;
  idempotencyKey: string;
}

/** One row in a `/server/v1/migrate/inventory` batch. */
export interface MigrateInventoryRow {
  externalPlayerId: string;
  itemKey: string;
  quantity: number;
  /** Free-form per-instance attributes carried over from the source platform. */
  parameters?: Record<string, unknown>;
  reason?: string;
  idempotencyKey: string;
}

/** One row that didn't apply during a migration batch. */
export interface MigrateFailure {
  rowIndex: number;
  externalPlayerId?: string;
  error: { code: string; message: string };
}

/**
 * Result of any `migrate.*` call. `applied` + `skipped` + `failed`
 * sum to the batch size; `skipped` counts rows that were
 * idempotent-replays (no double-apply).
 */
export interface MigrateOutcome {
  applied: number;
  skipped: number;
  failed: number;
  failures: MigrateFailure[];
}

// ─── Leaderboards (server-authoritative scoring) ───────────────────

export interface SubmitScoreInput {
  /**
   * Segment / bucket selector. Semantics depend on the board's
   * segmentation:
   *
   * - `context` boards: the bucket value to score into.
   * - `progression` boards: omit — the server derives the bucket from
   *   the player's progression state.
   * - unsegmented boards: ignored.
   */
  segment?: string;
  /**
   * Optional idempotency token. Replaying the same key with the same
   * body is a no-op; a different body returns 409.
   */
  idempotencyKey?: string;
}

export interface SubmitScoreResult {
  leaderboardId: string;
  score: number;
  /** `null` when the board can't rank this player (e.g. just-joined). */
  rank: number | null;
}

// ─── Event progress (server-authoritative) ─────────────────────────

export type AttemptStatus =
  | 'in_progress'
  | 'completed'
  | 'expired'
  | 'force_completed';

/**
 * One attempt row — mirrors the client SDK's `Attempt` shape so the
 * same rendering code works against either surface.
 */
export interface Attempt {
  id: string;
  eventId: string;
  eventWindowId: string;
  leaderboardId: string;
  playerId: string;
  startedAt: string;
  endsAt: string;
  completedAt: string | null;
  metrics: Record<string, number>;
  metricsRaw: Record<string, number>;
  score: number;
  status: AttemptStatus;
}

export interface ReportProgressInput {
  /** `'set'` writes the value as the new metric; `'increment'` adds to the current. */
  mode: 'set' | 'increment';
  metricValue?: number;
  metrics?: Record<string, number>;
  /** Override server-side timestamp for replay scenarios. */
  occurredAt?: string;
  /** Auto-stamped by the SDK if omitted. */
  idempotencyKey?: string;
}

/**
 * Milestone payouts that fired during a single `reportProgress` call.
 * `key` identifies which milestone tripped; `grants` carries the
 * concrete rewards the engine wrote (same shape `grants.create` returns).
 */
export interface MilestoneFired {
  key: string;
  grants: Grant[];
}

export interface ReportProgressResult {
  attempt: Attempt;
  /** Empty when nothing fired this update — never null. */
  milestonesFired: MilestoneFired[];
}

// ─── Ping ──────────────────────────────────────────────────────────

export interface ApiKeyInfo {
  id: string;
  prefix: string;
  permissionSet: string;
  environment: 'live' | 'test' | string;
  studioId: string;
  gameId: string | null;
}

export interface PingResponse {
  ok: boolean;
  apiKey: ApiKeyInfo;
}
