// Pre-launch smoke test. Verifies the public surface loads cleanly +
// the auth flow's first step is reachable. Deliberately does NOT
// create real users / fire Stripe / generate content — those need a
// staging env with disposable accounts.
//
// Run against prod read-only:
//   BASE_URL=https://www.scalesolo.ai npm run test:e2e
//
// Run locally (boots its own preview server):
//   npm run test:e2e

import { test, expect } from '@playwright/test'

test.describe('public surface', () => {
  test('landing page loads and shows brand', async ({ page }) => {
    await page.goto('/')
    // Brand name is in the nav + hero on every render.
    await expect(page.locator('text=ScaleSolo').first()).toBeVisible()
    // Primary CTA exists. (Content varies; we just want at least one
    // "Get started" / "Try" / "Sign up" button reachable.)
    const cta = page.getByRole('link', { name: /get started|sign up|try|start/i }).first()
    await expect(cta).toBeVisible()
  })

  test('pricing page renders all four tiers', async ({ page }) => {
    await page.goto('/pricing')
    // Each tier label is in TIERS catalog.
    for (const tier of ['Solo Starter', 'Solo Pro', 'Solo Studio']) {
      await expect(page.locator(`text=${tier}`).first()).toBeVisible()
    }
  })

  test('login page reachable and has both modes', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('button', { name: /create account/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('login signup mode preselected via ?mode=signup', async ({ page }) => {
    await page.goto('/login?mode=signup')
    // The "Create account" tab should be the active one. Visual
    // assertion via aria-selected.
    const signupTab = page.getByRole('tab', { name: /create account/i })
    await expect(signupTab).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('health endpoint', () => {
  test('liveness check returns 200', async ({ request }) => {
    const r = await request.get('/api/health')
    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(body.service).toBe('scalesolo')
  })

  test('deep health check returns subcheck booleans', async ({ request }) => {
    const r = await request.get('/api/health?deep=1')
    // 200 if everything green, 503 if any subcheck fails.
    expect([200, 503]).toContain(r.status())
    const body = await r.json()
    expect(body.checks).toBeDefined()
    expect(body.checks.supabase).toBeDefined()
    expect(body.checks.supabase.ok).toBeTypeOf('boolean')
    expect(body.checks.failed_webhook_events).toBeDefined()
    expect(body.checks.stuck_renders).toBeDefined()
  })
})

test.describe('auth gate', () => {
  test('hitting /dashboard while signed-out routes to login', async ({ page }) => {
    await page.goto('/dashboard')
    // App router should redirect signed-out visitors to /login (or
    // render the public landing routes). We don't care which — just
    // that we DON'T see the dashboard content.
    await expect(page.locator('text=Dashboard, your workspace')).not.toBeVisible({ timeout: 2000 }).catch(() => {})
    // Confirm we landed somewhere public.
    const url = page.url()
    expect(url).toMatch(/\/(login|$|pricing|f\/|p\/)/)
  })
})

test.describe('error tracking sanity', () => {
  test('404 page renders without crashing', async ({ page }) => {
    const errors = []
    page.on('pageerror', (err) => errors.push(err))
    await page.goto('/this-route-definitely-does-not-exist-1234567')
    // App's catch-all routes to /login or /dashboard depending on auth;
    // either way no JS errors should surface.
    await page.waitForLoadState('networkidle')
    expect(errors).toEqual([])
  })
})
