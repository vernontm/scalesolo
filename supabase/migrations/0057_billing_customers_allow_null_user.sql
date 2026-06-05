-- The Stripe webhook handler intentionally creates billing_customers
-- rows with user_id=null for anonymous Stripe checkouts (the
-- ensureCustomerRowForStripe path in api/stripe-webhook.js). When a
-- user pays via Stripe Checkout before completing scalesolo.ai signup,
-- this row holds the subscription until /api/stripe-link-session
-- backfills user_id post-signup.
--
-- The original schema had NOT NULL on user_id, which silently broke
-- this path: every customer.subscription.* event for a pre-signup
-- Stripe customer errored with 23502 and the subscription never landed
-- in our DB. We discovered this when a customer's $49 charge attempt
-- and trial-conversion events all errored, leaving her with no record
-- in billing_customers / billing_subscriptions despite valid Stripe
-- activity.

ALTER TABLE billing_customers
  ALTER COLUMN user_id DROP NOT NULL;

COMMENT ON COLUMN billing_customers.user_id IS
  'auth.users id. Nullable to support anonymous Stripe checkouts — webhook creates the row with user_id=null on customer.subscription.created when no user exists yet; /api/stripe-link-session backfills the id once signup completes.';
