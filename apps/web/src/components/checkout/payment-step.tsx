'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';

import { Button, Card, CardContent, Skeleton } from '@pasta/ui';
import { isApiClientError, type PaymentIntentResult } from '@pasta/api-client';
import { formatMoney } from '@pasta/utils';
import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';

import { browserApi } from '@/lib/browser-api';

/**
 * The payment step, for whichever gateway this deployment is using.
 *
 * The branch is on `provider`, which the API decides — not on a build-time
 * flag. That matters for the same reason the keys come from the API: switching
 * `PAYMENT_PROVIDER` on the server must not need the front-end rebuilt, and a
 * booking that was started under one provider must not find a page hard-wired
 * to the other.
 *
 * All three paths share one rule: this page never decides that a booking is
 * paid. Stripe and Revolut hand off to the confirmation screen, which polls the
 * API and waits for the signed webhook. PayPal asks the API to capture and then
 * hands off to the same screen — the answer comes from the server's own call to
 * PayPal, never from anything the buttons reported.
 */

// --- Stripe ------------------------------------------------------------------

/**
 * Stripe.js is loaded once per publishable key and cached.
 *
 * The key arrives from the API rather than the build, so a deployment can be
 * repointed at a different Stripe account without rebuilding the front-end —
 * and so a missing key degrades to a clear message instead of a blank form.
 */
const stripeCache = new Map<string, Promise<Stripe | null>>();

function stripeFor(key: string): Promise<Stripe | null> {
  let promise = stripeCache.get(key);
  if (!promise) {
    promise = loadStripe(key);
    stripeCache.set(key, promise);
  }
  return promise;
}

/**
 * Card details go straight from this form to Stripe — they never reach the
 * application's own server, which is what keeps the deployment out of PCI
 * scope.
 */
function StripeCardForm({
  reference,
  amountMinor,
  currency,
}: {
  reference: string;
  amountMinor: number;
  currency: string;
}) {
  const router = useRouter();
  const stripe = useStripe();
  const elements = useElements();

  const [error, setError] = React.useState<string | null>(null);
  const [isPaying, setIsPaying] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setIsPaying(true);
    setError(null);

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/booking-confirmed?reference=${encodeURIComponent(reference)}`,
      },
      // Stay on the page when the card needs no redirect, so the traveller
      // sees the result immediately instead of a round trip.
      redirect: 'if_required',
    });

    if (result.error) {
      setError(result.error.message ?? 'That payment could not be completed. Please try again.');
      setIsPaying(false);
      return;
    }

    // Succeeded or still processing — either way the confirmation page is the
    // place that waits for the webhook.
    router.push(`/booking-confirmed?reference=${encodeURIComponent(reference)}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <PaymentElement options={{ layout: 'tabs' }} />

      <PaymentError message={error} />

      <Button
        type="submit"
        size="lg"
        block
        isLoading={isPaying}
        disabled={!stripe}
        leadingIcon={<Lock aria-hidden />}
      >
        Pay {formatMoney(amountMinor, currency as 'EUR' | 'USD')}
      </Button>

      <Assurance gateway="Stripe" />
    </form>
  );
}

function StripePanel({
  reference,
  intent,
}: {
  reference: string;
  intent: Extract<PaymentIntentResult, { provider: 'stripe' }> & { publishableKey: string };
}) {
  return (
    <Elements
      stripe={stripeFor(intent.publishableKey)}
      options={{
        clientSecret: intent.clientSecret,
        // Stripe renders inside an iframe, so it cannot read the site's
        // stylesheet; the brand is passed through explicitly.
        appearance: {
          theme: 'flat',
          variables: {
            colorPrimary: '#b5751f',
            colorText: '#2b2016',
            borderRadius: '10px',
            fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          },
        },
      }}
    >
      <StripeCardForm
        reference={reference}
        amountMinor={intent.amountMinor}
        currency={intent.currency}
      />
    </Elements>
  );
}

// --- Revolut -----------------------------------------------------------------

/**
 * Revolut's pop-up, mounted against the order token.
 *
 * The widget is imported on demand rather than at module scope: it pulls
 * Revolut's own script, and a traveller paying by cash — or paying with
 * Stripe — should not carry it. The token is the order's *public* id; the
 * private one it was minted from never leaves the API.
 */
function RevolutPanel({
  reference,
  intent,
}: {
  reference: string;
  intent: Extract<PaymentIntentResult, { provider: 'revolut' }>;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [isPaying, setIsPaying] = React.useState(false);

  const confirmed = React.useCallback(() => {
    router.push(`/booking-confirmed?reference=${encodeURIComponent(reference)}`);
  }, [reference, router]);

  async function pay() {
    setIsPaying(true);
    setError(null);

    try {
      const { default: RevolutCheckout } = await import('@revolut/checkout');
      const instance = await RevolutCheckout(intent.token, intent.environment);

      instance.payWithPopup({
        // Succeeded as far as the browser can tell. The confirmation page is
        // the place that waits for the webhook to say so for certain.
        onSuccess: confirmed,
        onError: (caught) => {
          setError(caught.message || 'That payment could not be completed. Please try again.');
          setIsPaying(false);
        },
        // Closing the pop-up is not a failure — the booking is still held, and
        // the button goes back to being pressable.
        onCancel: () => setIsPaying(false),
      });
    } catch {
      setError('We could not open the payment window. Please try again.');
      setIsPaying(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-sm">
        You&apos;ll be asked for your card details in a secure Revolut window. Nothing is charged
        until you confirm.
      </p>

      <PaymentError message={error} />

      <Button
        type="button"
        size="lg"
        block
        isLoading={isPaying}
        onClick={() => void pay()}
        leadingIcon={<Lock aria-hidden />}
      >
        Pay {formatMoney(intent.amountMinor, intent.currency)}
      </Button>

      <Assurance gateway="Revolut" />
    </div>
  );
}

// --- PayPal ------------------------------------------------------------------

/**
 * PayPal's buttons, mounted against the order the API opened.
 *
 * `createOrder` hands back an id this server already minted rather than
 * minting one here, which is the whole point: the amount is decided by the
 * booking, on the server, and the browser never gets to name a figure.
 *
 * `onApprove` does not mark anything paid. It asks the API to capture, and the
 * API calls PayPal itself and believes only what comes back — so a tampered
 * browser can trigger a capture it was going to trigger anyway and nothing
 * else.
 */
function PayPalPanel({
  reference,
  intent,
}: {
  reference: string;
  intent: Extract<PaymentIntentResult, { provider: 'paypal' }> & { clientId: string };
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const confirmed = React.useCallback(() => {
    router.push(`/booking-confirmed?reference=${encodeURIComponent(reference)}`);
  }, [reference, router]);

  return (
    <PayPalScriptProvider
      options={{
        clientId: intent.clientId,
        currency: intent.currency,
        // The buttons only; the card fields are a separate onboarding and are
        // not enabled on this account.
        components: 'buttons',
        intent: 'capture',
        // No "Debit or Credit Card" button. That route is PayPal's guest
        // checkout, which is onboarded separately from the wallet and is not
        // enabled here — offering it only to have it fail at the last step is
        // worse than not offering it. Paying with a card *through* a PayPal
        // account is unaffected; this hides the card-without-an-account tile.
        disableFunding: 'card',
      }}
    >
      <div className="flex flex-col gap-5">
        <p className="text-muted-foreground text-sm">
          You&apos;ll confirm the payment in a secure PayPal window. Nothing is charged until you
          approve it there.
        </p>

        <PaymentError message={error} />

        <PayPalButtons
          // Remounts the buttons when the figure changes, so a repriced booking
          // can never leave the old amount on screen.
          forceReRender={[intent.orderId, intent.amountMinor, intent.currency]}
          style={{ layout: 'vertical', shape: 'rect', label: 'pay', height: 48 }}
          createOrder={() => Promise.resolve(intent.orderId)}
          onApprove={async () => {
            setError(null);

            try {
              await browserApi.checkout.capturePayPalOrder(reference, intent.orderId);
            } catch (caught) {
              setError(
                isApiClientError(caught)
                  ? caught.message
                  : 'That payment could not be completed. Please try again.',
              );
              return;
            }

            // Captured, or captured and held for review. Either way the
            // confirmation page is the place that reports which.
            confirmed();
          }}
          onError={() => {
            setError('That payment could not be completed. Please try again.');
          }}
          // Closing the PayPal window is not a failure — the booking is still
          // held and the buttons stay pressable.
          onCancel={() => setError(null)}
        />

        <Assurance gateway="PayPal" />
      </div>
    </PayPalScriptProvider>
  );
}

// --- shared chrome -----------------------------------------------------------

function PaymentError({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <p
      role="alert"
      className="border-danger/30 bg-danger-soft text-danger-foreground rounded-card flex items-start gap-2.5 border px-4 py-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

function Assurance({ gateway }: { gateway: string }) {
  return (
    <p className="text-muted-foreground inline-flex items-center justify-center gap-1.5 text-xs">
      <ShieldCheck className="size-4" aria-hidden />
      Payments are handled by {gateway}. Your card details never reach our servers.
    </p>
  );
}

export function PaymentStep({ reference }: { reference: string }) {
  const [intent, setIntent] = React.useState<PaymentIntentResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    void browserApi.checkout
      .paymentIntent(reference)
      .then((result) => {
        if (cancelled) return;

        /**
         * Stripe cannot render without its publishable key and PayPal cannot
         * load its SDK without a client id. Revolut's widget only needs the
         * order token, so a missing public key is not fatal there and must not
         * be treated as one.
         */
        const missingKey =
          (result.provider === 'stripe' && !result.publishableKey) ||
          (result.provider === 'paypal' && !result.clientId);

        if (missingKey) {
          setError('Online payment is not configured on this environment yet.');
          return;
        }

        setIntent(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          isApiClientError(caught)
            ? caught.message
            : 'We could not start the payment. Please try again.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reference]);

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <p role="alert" className="text-danger-foreground text-sm">
            {error}
          </p>
          <p className="text-muted-foreground text-sm">
            Your booking <strong>{reference}</strong> is held. Contact us and we will take payment
            another way.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!intent) {
    return <Skeleton className="h-72 w-full" />;
  }

  return (
    <Card>
      <CardContent className="p-6">
        {intent.provider === 'revolut' && <RevolutPanel reference={reference} intent={intent} />}

        {intent.provider === 'paypal' && (
          <PayPalPanel
            reference={reference}
            // The guard above is what makes this safe: an intent with no client
            // id never reaches here.
            intent={{ ...intent, clientId: intent.clientId as string }}
          />
        )}

        {intent.provider === 'stripe' && (
          <StripePanel
            reference={reference}
            // Likewise: an intent with no publishable key never reaches here.
            intent={{ ...intent, publishableKey: intent.publishableKey as string }}
          />
        )}
      </CardContent>
    </Card>
  );
}
