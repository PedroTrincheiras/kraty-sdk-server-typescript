import { KratyServerClient, type KratyServerOptions } from './client.js';
import {
  EventsClient,
  GrantsClient,
  HealthClient,
  InventoryClient,
  LeaderboardsClient,
  LobbiesClient,
  MigrateClient,
  PlayersClient,
  WalletClient,
} from './resources.js';

export { KratyServerClient } from './client.js';
export type { KratyServerOptions, RetryConfig, RequestInfo } from './client.js';
export {
  EventsClient,
  GrantsClient,
  HealthClient,
  InventoryClient,
  LeaderboardsClient,
  LobbiesClient,
  MigrateClient,
  PlayersClient,
  WalletClient,
} from './resources.js';
export {
  KratyServerError,
  KratyNetworkError,
} from './errors.js';
export { verifyWebhook } from './webhook.js';
export type {
  KratyServerErrorCode,
  KratyServerErrorPayload,
} from './errors.js';
export type {
  AckGrantInput,
  AdjustItemInput,
  AdjustItemResult,
  AdjustWalletInput,
  AdjustWalletResult,
  ApiKeyInfo,
  Attempt,
  AttemptStatus,
  BanPlayerInput,
  BanPlayerResult,
  CreateGrantInput,
  DeletePlayerInput,
  DeletePlayerResult,
  DeletePlayerStatus,
  ErasureReason,
  Grant,
  GrantEntry,
  GrantKind,
  GrantStatus,
  Lobby,
  LobbyStatus,
  MigrateFailure,
  MergePlayerResult,
  MigrateInventoryRow,
  MigrateOutcome,
  MigratePlayerRow,
  MigrateWalletRow,
  MilestoneFired,
  PingResponse,
  PlayerExport,
  PlayerSnapshot,
  PushLobbyInput,
  ReportProgressInput,
  FinishAttemptResult,
  ReportProgressResult,
  SubmitScoreInput,
  SubmitScoreResult,
  UnbanPlayerResult,
} from './types.js';

/**
 * Convenience facade for the `/server/v1` server surface. Instantiate
 * one `KratyServer` per studio/game backend service; all resource
 * clients share the same underlying HTTP client (connection pool,
 * retry config, telemetry hook).
 *
 * Use this from your studio's BACKEND only. Never embed in a web
 * bundle, mobile app, or Unity build, because the `server_integration`
 * API key can mint currency and items.
 *
 * @example
 * ```ts
 * const kraty = new KratyServer({ apiKey: process.env.KRATY_SERVER_KEY! });
 *
 * // IAP fulfilment, idempotent on the receipt id:
 * await kraty.wallet.credit('player_42', 'gold', {
 *   amount: 500,
 *   reason: 'iap',
 *   sourceRefId: 'apple_receipt_abc',
 *   idempotencyKey: 'apple_receipt_abc',
 * });
 * await kraty.inventory.grant('player_42', 'starter_chest', {
 *   quantity: 1,
 *   reason: 'iap',
 *   idempotencyKey: 'apple_receipt_abc',
 * });
 *
 * // Onboarding: bulk-import players from another platform:
 * await kraty.migrate.players([
 *   { externalPlayerId: 'p_1', idempotencyKey: 'p_1' },
 *   { externalPlayerId: 'p_2', idempotencyKey: 'p_2', contextSnapshot: { country: 'PT' } },
 * ]);
 * ```
 */
export class KratyServer {
  readonly client: KratyServerClient;
  readonly grants: GrantsClient;
  readonly inventory: InventoryClient;
  readonly wallet: WalletClient;
  readonly lobbies: LobbiesClient;
  readonly leaderboards: LeaderboardsClient;
  readonly events: EventsClient;
  readonly players: PlayersClient;
  readonly health: HealthClient;
  readonly migrate: MigrateClient;

  constructor(opts: KratyServerOptions) {
    this.client = new KratyServerClient(opts);
    this.grants = new GrantsClient(this.client);
    this.inventory = new InventoryClient(this.client);
    this.wallet = new WalletClient(this.client);
    this.lobbies = new LobbiesClient(this.client);
    this.leaderboards = new LeaderboardsClient(this.client);
    this.events = new EventsClient(this.client);
    this.players = new PlayersClient(this.client);
    this.health = new HealthClient(this.client);
    this.migrate = new MigrateClient(this.client);
  }
}
