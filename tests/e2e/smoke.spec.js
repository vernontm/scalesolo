// Pre-launch smoke test. Deliberately liveness-only:
//   - does the page mount without throwing a JS error?
//   - does it eventually settle into a non-empty body?
// We don't assert specific copy / button labels — those change every
// week and brittle tests block deploys for cosmetic edits.
//
// API tests (gated on a remote BASE_URL) check the health endpoint
// shape against a real Vercel deployment.
//
// Run against prod read-only:
//   BASE_URL=https://www.scalesolo.ai npm run test:e2e
// Run locally (boots its own preview server):
//   npm run test:e2e

import { test, expect } from '@playwright/test'

// Helper: visit a route and confirm React mounted + no uncaught errors.
async function expectRenders(page, path) {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  // Wait for the SPA to render something visible inside #root.
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')
      return root && root.innerHTML.trim().length > 0
    },
    { timeout: 10_000 },
  )
  // Network idle so lazy chunks finish loading.
  await page.waitForLoadState('networkidle').catch(() => {})
  // No JS errors during mount.
  expect(errors, `JS errors on ${path}`).toEqual([])
}

test.describe('public surface (renders without error)', () => {
  test('/ landing renders', async ({ page }) => {
    await expectRenders(page, '/')
  })

  test('/pricing renders', async ({ page }) => {
    await expectRenders(page, '/pricing')
  })

  test('/login renders', async ({ page }) => {
    await expectRenders(page, '/login')
  })

  test('/login?mode=signup renders', async ({ page }) => {
    await expectRenders(page, '/login?mode=signup')
  })

  test('/dashboard while signed-out renders something (App router fallback)', async ({ page }) => {
    await expectRenders(page, '/dashboard')
  })

  test('unknown route renders fallback (no white-screen exception)', async ({ page }) => {
    await expectRenders(page, '/this-route-definitely-does-not-exist-1234567')
  })
})

// API endpoints are only reachable when running against a deployed
// Vercel host (npm run preview only serves the Vite static bundle —
// it does NOT run the api/ serverless functions). Gate these tests
// on a non-localhost BASE_URL so CI's local preview server doesn't
// fail them.
const isRemoteTarget = !(process.env.BASE_URL || '').startsWith('http://localhost')
test.describe('health endpoint (remote-only)', () => {
  test.skip(!isRemoteTarget, 'BASE_URL is local; api/ functions only run on Vercel.')

  test('liveness check returns 200', async ({ request }) => {
    const r = await request.get('/api/health')
    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(body.service).toBe('scalesolo')
  })

  test('deep health check returns subcheck booleans', async ({ request }) => {
    const r = await request.get('/api/health?deep=1')
    expect([200, 503]).toContain(r.status())
    const body = await r.json()
    expect(body.checks).toBeDefined()
    expect(body.checks.supabase).toBeDefined()
    expect(typeof body.checks.supabase.ok).toBe('boolean')
  })
})
