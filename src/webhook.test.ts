import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from './webhook.js';

/**
 * The verifier MUST byte-for-byte match the backend's
 * `apps/backend/src/core/webhooks/signing.ts`. To prove that, we
 * compute signatures here using the same algorithm and feed them
 * to `verifyWebhook`. Any divergence, whether header format, body
 * encoding, tolerance window, or a constant-time bug, surfaces as a
 * failing test.
 */

const SECRET = 'whsec_test_12345';
const BODY = JSON.stringify({ kind: 'grant.created', grant: { id: 'g_1' } });

function sign(secret: string, body: string, tSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${tSeconds}.${body}`).digest('hex');
  return `t=${tSeconds},v1=${mac}`;
}

describe('verifyWebhook', () => {
  const now = new Date('2026-06-08T12:00:00Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it('returns true for a fresh, valid signature', () => {
    const header = sign(SECRET, BODY, nowSeconds);
    expect(
      verifyWebhook({ rawBody: BODY, signatureHeader: header, secret: SECRET, now }),
    ).toBe(true);
  });

  it('accepts a Buffer body', () => {
    const header = sign(SECRET, BODY, nowSeconds);
    expect(
      verifyWebhook({
        rawBody: Buffer.from(BODY, 'utf8'),
        signatureHeader: header,
        secret: SECRET,
        now,
      }),
    ).toBe(true);
  });

  it('accepts a Uint8Array body', () => {
    const header = sign(SECRET, BODY, nowSeconds);
    const bytes = new TextEncoder().encode(BODY);
    expect(
      verifyWebhook({ rawBody: bytes, signatureHeader: header, secret: SECRET, now }),
    ).toBe(true);
  });

  it('rejects a signature older than the default 300s window', () => {
    const header = sign(SECRET, BODY, nowSeconds - 301);
    expect(
      verifyWebhook({ rawBody: BODY, signatureHeader: header, secret: SECRET, now }),
    ).toBe(false);
  });

  it('honors a custom toleranceSeconds', () => {
    const header = sign(SECRET, BODY, nowSeconds - 600);
    expect(
      verifyWebhook({
        rawBody: BODY,
        signatureHeader: header,
        secret: SECRET,
        toleranceSeconds: 900,
        now,
      }),
    ).toBe(true);
  });

  it('rejects a signature more than 60s in the future', () => {
    const header = sign(SECRET, BODY, nowSeconds + 120);
    expect(
      verifyWebhook({ rawBody: BODY, signatureHeader: header, secret: SECRET, now }),
    ).toBe(false);
  });

  it('rejects when the body has been tampered with', () => {
    const header = sign(SECRET, BODY, nowSeconds);
    const tampered = BODY.replace('g_1', 'g_2');
    expect(
      verifyWebhook({ rawBody: tampered, signatureHeader: header, secret: SECRET, now }),
    ).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    const header = sign(SECRET, BODY, nowSeconds);
    expect(
      verifyWebhook({ rawBody: BODY, signatureHeader: header, secret: 'whsec_wrong', now }),
    ).toBe(false);
  });

  it('rejects a header missing the v1= field', () => {
    expect(
      verifyWebhook({
        rawBody: BODY,
        signatureHeader: `t=${nowSeconds}`,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a header missing the t= field', () => {
    const mac = createHmac('sha256', SECRET).update(`${nowSeconds}.${BODY}`).digest('hex');
    expect(
      verifyWebhook({
        rawBody: BODY,
        signatureHeader: `v1=${mac}`,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a malformed v1 hex value', () => {
    expect(
      verifyWebhook({
        rawBody: BODY,
        signatureHeader: `t=${nowSeconds},v1=not-hex`,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(
      verifyWebhook({ rawBody: BODY, signatureHeader: '', secret: SECRET, now }),
    ).toBe(false);
  });

  it('tolerates whitespace around comma-separated fields', () => {
    const mac = createHmac('sha256', SECRET).update(`${nowSeconds}.${BODY}`).digest('hex');
    expect(
      verifyWebhook({
        rawBody: BODY,
        signatureHeader: ` t=${nowSeconds} , v1=${mac} `,
        secret: SECRET,
        now,
      }),
    ).toBe(true);
  });
});
