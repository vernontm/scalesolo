// Authenticated fetch helper. Adds the bearer token + a default JSON
// Content-Type, and auto-stringifies plain-object bodies so callers
// don't pay the "Invalid JSON" footgun where fetch() turns
// { foo: 'bar' } into "[object Object]" silently.
//
// Pulled out of src/pages/Studio.jsx so other components (modals,
// settings panels, etc.) can reuse the exact same behavior without
// re-importing Studio.
export async function authedFetch(path, token, init = {}) {
  let body = init.body
  if (body && typeof body === 'object'
      && !(body instanceof FormData)
      && !(body instanceof Blob)
      && !(body instanceof ArrayBuffer)
      && !(body instanceof URLSearchParams)) {
    body = JSON.stringify(body)
  }
  return fetch(path, {
    ...init,
    body,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token || ''}`,
      ...(init.headers || {}),
    },
  })
}
