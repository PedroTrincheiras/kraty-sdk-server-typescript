import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Kraty webhook signature.
 *
 * The platform stamps every outgoing webhook with an `X-Signature`
 * header in the form `t=<unixSeconds>,v1=<hex>`, where the v1 hex is
 * `HMAC_SHA256(secret, "<t>.<rawBody>")`. Receivers MUST:
 *
 * 1. Capture the **raw** request body (not the parsed JSON; even a
 *    re-stringification can change byte ordering or whitespace, and
 *    that's enough to break the HMAC).
 * 2. Read `X-Signature` from the request headers.
 * 3. Look up the webhook's secret from your portal config.
 * 4. Call this function. Reject the request with 401 if it returns
 *    `false`.
 *
 * The function also rejects signatures whose timestamp is more than
 * `toleranceSeconds` (default 300s) in the past (that defeats
 * replay attacks even if an attacker captures a real header) and
 * more than 60s in the future, which catches forged headers with
 * tampered clocks.
 *
 * Constant-time compare under the hood (`crypto.timingSafeEqual`),
 * so signature-recovery via timing leaks isn't viable.
 *
 * @example Express receiver:
 * ```ts
 * import express from 'express';
 * import { verifyWebhook } from '@kraty/server-sdk';
 *
 * const app = express();
 * // IMPORTANT: capture the raw body before any JSON parser runs.
 * app.use('/kraty', express.raw({ type: 'application/json' }));
 *
 * app.post('/kraty/webhook', (req, res) => {
 *   const sig = req.header('x-signature') ?? '';
 *   const ok = verifyWebhook({
 *     rawBody: req.body,
 *     signatureHeader: sig,
 *     secret: process.env.KRATY_WEBHOOK_SECRET!,
 *   });
 *   if (!ok) return res.status(401).send('bad signature');
 *
 *   const event = JSON.parse(req.body.toString('utf8'));
 *   // … handle the event …
 *   res.json({ ok: true });
 * });
 * ```
 */
export function verifyWebhook(args: {
  /** The raw request body as received on the wire. */
  rawBody: string | Buffer | Uint8Array;
  /** Verbatim value of the `X-Signature` header. */
  signatureHeader: string;
  /** The webhook's signing secret from your portal config. */
  secret: string;
  /** Replay-window cap in seconds. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Override for tests; defaults to `new Date()`. */
  now?: Date;
}): boolean {
  const parsed = parseHeader(args.signatureHeader);
  if (!parsed) return false;

  const tolerance = args.toleranceSeconds ?? 300;
  const now = args.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const skew = nowSeconds - parsed.t;
  if (skew > tolerance) return false;     // too old → replay
  if (skew < -60) return false;            // > 60s in the future → forged / bad clock

  const bodyBuf = toBuffer(args.rawBody);
  const macInput = Buffer.concat([
    Buffer.from(`${parsed.t}.`, 'utf8'),
    bodyBuf,
  ]);
  const expectedHex = createHmac('sha256', args.secret).update(macInput).digest('hex');
  const a = Buffer.from(expectedHex, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(parsed.v1, 'hex');
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseHeader(header: string): { t: number; v1: string } | null {
  if (!header) return null;
  const parts = header.split(',').map((s) => s.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (!k || !v) continue;
    if (k === 't') {
      const n = Number(v);
      if (Number.isFinite(n)) t = n;
    } else if (k === 'v1') {
      v1 = v;
    }
  }
  if (t === null || v1 === null || v1.length === 0) return null;
  return { t, v1 };
}

function toBuffer(body: string | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(body);
}
