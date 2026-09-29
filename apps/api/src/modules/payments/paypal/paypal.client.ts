import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { paypalConfig } from '../../../config/configuration';

/**
 * The PayPal Orders, Payments and Notifications APIs, as much of them as this
 * application needs.
 *
 * Hand-rolled over `fetch`, for the same reason the Revolut client is: the six
 * calls used here are a dozen lines each, and PayPal's own server SDK would add
 * a dependency — and its own OAuth cache, its own retry policy — to the one code
 * path where surprises are expensive.
 *
 * Reference: https://developer.paypal.com/docs/api/orders/v2/
 */

/**
 * https://developer.paypal.com/docs/api/orders/v2/#orders_get
 *
 * Only `COMPLETED` means money has actually moved. `APPROVED` means the buyer
 * said yes and nothing more — the capture is still this server's to make.
 */
export type PayPalOrderStatus =
  'CREATED' | 'SAVED' | 'APPROVED' | 'PAYER_ACTION_REQUIRED' | 'VOIDED' | 'COMPLETED';

export interface PayPalMoney {
  currency_code: string;
  /** A decimal string — `"45.00"`, never a number. See `toPayPalAmount`. */
  value: string;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount?: PayPalMoney;
  /** PayPal's own duplicate guard: a replayed capture comes back flagged. */
  status_details?: { reason?: string };
}

export interface PayPalOrder {
  id: string;
  status: PayPalOrderStatus;
  purchase_units?: {
    amount?: PayPalMoney;
    custom_id?: string;
    payments?: { captures?: PayPalCapture[] };
  }[];
}

export interface PayPalRefund {
  id: string;
  status: string;
  amount?: PayPalMoney;
  links?: { rel?: string; href?: string }[];
}

export interface CreatePayPalOrderInput {
  /** Minor units, as everything in this codebase is. */
  amount: number;
  currency: string;
  description: string;
  /** Our own reference, so a PayPal dashboard row can be traced back here. */
  merchantOrderReference: string;
  /**
   * Shown above the buttons in PayPal's own window, and — trimmed to 22
   * characters — on a card-funded buyer's statement.
   *
   * It does not reach the buyer's PayPal activity row: that one carries the
   * business name on the receiving account, which is set in PayPal's own
   * settings and cannot be overridden per order.
   */
  brandName: string;
}

/**
 * Minor units to the decimal string PayPal insists on.
 *
 * Both currencies this application prices in have two decimal places, so the
 * conversion is exact; `toFixed` on an integer division cannot drift the way
 * formatting a float would.
 */
export function toPayPalAmount(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * And back again, for checking what PayPal says it took against what the
 * booking is owed.
 *
 * Rounded rather than truncated: `"45.00"` is 4500 either way, but a value
 * PayPal expressed as `"44.999999"` must not silently become 4499.
 */
export function fromPayPalAmount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/** A non-2xx from PayPal, carried so the caller can decide what to surface. */
export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`PayPal responded ${status}`);
    this.name = 'PayPalApiError';
  }

  /** Whether PayPal named a particular issue, e.g. `ORDER_ALREADY_CAPTURED`. */
  hasIssue(issue: string): boolean {
    return this.body.includes(issue);
  }
}

@Injectable()
export class PayPalClient {
  private readonly logger = new Logger(PayPalClient.name);

  /**
   * The OAuth token, cached until shortly before it expires.
   *
   * The promise itself is cached rather than the token, so ten checkouts
   * landing at once mint one token between them instead of ten.
   */
  private token: { value: Promise<string>; expiresAt: number } | null = null;

  /**
   * Which mint attempt the cache belongs to.
   *
   * A slow attempt that fails must not clear a cache entry a later one has
   * already filled, and must not extend one either. Comparing epochs is how
   * each attempt tells "still mine" from "overtaken".
   */
  private tokenEpoch = 0;

  constructor(@Inject(paypalConfig.KEY) private readonly config: ConfigType<typeof paypalConfig>) {
    if (!config.enabled) {
      this.logger.warn(
        'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set — PayPal endpoints will answer 503.',
      );
    } else if (!config.webhookId) {
      // Without it, signatures cannot be verified, and an unverified webhook is
      // an unauthenticated endpoint that marks bookings as paid.
      this.logger.warn('PAYPAL_WEBHOOK_ID is not set — the webhook will reject every event.');
    }

    if (config.mode === 'live') {
      this.logger.log('PayPal is in LIVE mode — payments taken here move real money.');
    }
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get clientId(): string | undefined {
    return this.config.clientId;
  }

  get mode(): 'sandbox' | 'live' {
    return this.config.mode;
  }

  get webhookId(): string | undefined {
    return this.config.webhookId;
  }

  private credentials(): { id: string; secret: string } {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new ServiceUnavailableException(
        'Online payment is not configured on this environment yet.',
      );
    }
    return { id: this.config.clientId, secret: this.config.clientSecret };
  }

  // --- authentication --------------------------------------------------------

  /** https://developer.paypal.com/api/rest/authentication/ */
  private async mintToken(): Promise<{ access_token: string; expires_in?: number }> {
    const { id, secret } = this.credentials();

    const response = await fetch(`${this.config.apiUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });

    const text = await response.text();

    if (!response.ok) {
      // Logged, not returned: the body names the merchant account and is
      // written for us, not for the traveller looking at the page.
      this.logger.error(`PayPal token request failed (${response.status}): ${text}`);
      throw new PayPalApiError(response.status, text);
    }

    return JSON.parse(text) as { access_token: string; expires_in?: number };
  }

  /**
   * A token that is still good, minting one if it is not.
   *
   * PayPal's tokens last about nine hours. This one is dropped a minute early
   * so a request never sets off with a token that expires in flight, and a
   * failed mint clears the cache rather than leaving a rejected promise to be
   * handed to every later caller.
   */
  private accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const epoch = ++this.tokenEpoch;

    const value = this.mintToken().then(
      (minted) => {
        // `expires_in` is seconds. A minute of headroom, floored at a minute so
        // a surprisingly short token still caches rather than thrashing.
        const lifetime = Math.max((minted.expires_in ?? 32_400) - 60, 60);

        if (this.tokenEpoch === epoch && this.token) {
          this.token.expiresAt = Date.now() + lifetime * 1000;
        }

        return minted.access_token;
      },
      (error: unknown) => {
        if (this.tokenEpoch === epoch) this.token = null;
        throw error;
      },
    );

    // Cached with a provisional minute, so concurrent callers share this
    // attempt; the handler above replaces it with the real expiry on success.
    this.token = { value, expiresAt: Date.now() + 60_000 };

    return value;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    /** PayPal's idempotency key. A retry with the same one is not a second charge. */
    requestId?: string,
  ): Promise<T> {
    const token = await this.accessToken();

    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();

    if (!response.ok) {
      this.logger.error(`PayPal ${method} ${path} failed (${response.status}): ${text}`);
      throw new PayPalApiError(response.status, text);
    }

    return (text ? JSON.parse(text) : {}) as T;
  }

  // --- orders ----------------------------------------------------------------

  /** https://developer.paypal.com/docs/api/orders/v2/#orders_create */
  createOrder(input: CreatePayPalOrderInput): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(
      'POST',
      '/v2/checkout/orders',
      {
        // CAPTURE, not AUTHORIZE: the seats are committed the moment the
        // booking is made, so there is nothing to hold now and take later.
        intent: 'CAPTURE',
        purchase_units: [
          {
            // Both carry the booking reference. `custom_id` comes back on the
            // capture and on every webhook about it; `invoice_id` is what a
            // human sees in the PayPal dashboard.
            custom_id: input.merchantOrderReference,
            invoice_id: input.merchantOrderReference,
            description: input.description.slice(0, 127),
            // What a card-funded buyer's bank statement says. Without it the
            // statement falls back to whatever the account's own descriptor is,
            // which is the one place the brand name above does not reach.
            // PayPal rejects anything longer than 22 characters.
            soft_descriptor: input.brandName.slice(0, 22),
            amount: {
              currency_code: input.currency,
              value: toPayPalAmount(input.amount),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: input.brandName,
              // The buyer stays in PayPal's window and returns to the page that
              // opened it; this application has no redirect landing route.
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          },
        },
      },
      // Keyed on the booking, so a double-clicked payment page cannot leave two
      // orders open against one booking even before the reuse check runs.
      `booking-order-${input.merchantOrderReference}-${input.amount}-${input.currency}`,
    );
  }

  /** https://developer.paypal.com/docs/api/orders/v2/#orders_get */
  retrieveOrder(id: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }

  /**
   * https://developer.paypal.com/docs/api/orders/v2/#orders_patch
   *
   * Used when a booking was edited after its order was opened. Repricing the
   * existing order rather than opening a second one matters: a traveller who
   * left the buttons on screen would otherwise pay the stale amount into an
   * order this application had stopped listening for.
   */
  async updateOrderAmount(id: string, amount: number, currency: string): Promise<void> {
    await this.request<void>('PATCH', `/v2/checkout/orders/${encodeURIComponent(id)}`, [
      {
        op: 'replace',
        // The reference id PayPal assigns the single purchase unit when one is
        // not named on creation.
        path: "/purchase_units/@reference_id=='default'/amount",
        value: { currency_code: currency, value: toPayPalAmount(amount) },
      },
    ]);
  }

  /**
   * https://developer.paypal.com/docs/api/orders/v2/#orders_capture
   *
   * This is the call that moves the money, and its response — not anything the
   * browser said — is what this application treats as proof.
   */
  captureOrder(id: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      {},
      // The order id is the natural idempotency key: a retried capture returns
      // the original result instead of taking the money twice.
      `capture-${id}`,
    );
  }

  // --- payments --------------------------------------------------------------

  /** https://developer.paypal.com/docs/api/payments/v2/#captures_refund */
  refundCapture(
    captureId: string,
    amount: number,
    currency: string,
    invoiceReference: string,
  ): Promise<PayPalRefund> {
    return this.request<PayPalRefund>(
      'POST',
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        amount: { currency_code: currency, value: toPayPalAmount(amount) },
        invoice_id: invoiceReference,
      },
      // Covers the capture and the amount, so a retried request is the same
      // refund rather than a second one.
      `refund-${captureId}-${amount}`,
    );
  }

  // --- webhooks --------------------------------------------------------------

  /**
   * https://developer.paypal.com/api/rest/webhooks/rest/#link-verifywebhooksignature
   *
   * PayPal does not sign with a shared secret the way Stripe and Revolut do; it
   * signs with a certificate and verifies the transmission on its own side. So
   * the check is a round trip rather than an HMAC — and the raw body has to
   * survive it byte for byte.
   *
   * Hence the hand-built JSON: re-serialising the parsed event would reorder
   * keys and reformat numbers, and PayPal would then compute a different digest
   * and reject a genuine event. The header values are escaped through
   * `JSON.stringify` because they arrive from the request and a stray quote in
   * one of them must not be able to reshape this document.
   */
  async verifyWebhookSignature(
    rawBody: Buffer,
    headers: PayPalWebhookHeaders,
  ): Promise<WebhookVerification> {
    const webhookId = this.config.webhookId;
    if (!webhookId) return 'FAILURE';

    const document =
      '{' +
      [
        `"auth_algo":${JSON.stringify(headers.authAlgo)}`,
        `"cert_url":${JSON.stringify(headers.certUrl)}`,
        `"transmission_id":${JSON.stringify(headers.transmissionId)}`,
        `"transmission_sig":${JSON.stringify(headers.transmissionSig)}`,
        `"transmission_time":${JSON.stringify(headers.transmissionTime)}`,
        `"webhook_id":${JSON.stringify(webhookId)}`,
        `"webhook_event":${rawBody.toString('utf8')}`,
      ].join(',') +
      '}';

    let response: Response;
    let text: string;

    try {
      const token = await this.accessToken();

      response = await fetch(`${this.config.apiUrl}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: document,
      });

      text = await response.text();
    } catch (error: unknown) {
      /**
       * Could not ask. That is not the same fact as "PayPal said no", and
       * collapsing the two would be a lie in both directions: it would report a
       * genuine event as forged, and it would hide an outage behind a message
       * about signatures.
       */
      this.logger.error(
        `Could not reach PayPal to verify a webhook signature: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'UNAVAILABLE';
    }

    if (!response.ok) {
      this.logger.error(`PayPal signature verification failed (${response.status}): ${text}`);
      return 'UNAVAILABLE';
    }

    const parsed = JSON.parse(text) as { verification_status?: string };

    // Anything that is not an explicit SUCCESS is a refusal. There is no
    // third answer worth guessing at when money is on the other end.
    return parsed.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
  }
}

/**
 * The three answers a verification attempt can give.
 *
 * `UNAVAILABLE` is deliberately not folded into `FAILURE`: a forged event must
 * be refused for good, while an event this server merely could not check yet
 * must come back — and PayPal decides which to retry from the status code it
 * is given.
 */
export type WebhookVerification = 'SUCCESS' | 'FAILURE' | 'UNAVAILABLE';

/** The transmission headers PayPal signs a webhook with. */
export interface PayPalWebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}
