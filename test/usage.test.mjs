// The quota magpie shows comes from DescribeUserBillingStatus's usageStats,
// where only hunyuan_ai is the AI-answer allowance. The other rows there
// (session sharing, secrets, space) are unrelated, and reporting one of
// them as the AI window would show a number that never moves.
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { OrcaTermAuthPlugin } from "../index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"


const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const usage = async (reply) => {
  globalThis.fetch = async () => reply()
  const hooks = await OrcaTermAuthPlugin({ client: { app: { log: () => {} } } })
  return hooks.auth.usage(async () => ({ type: "api", key: "uin=o1234567890; skey=deadbeef" }))
}

const billing = (usageStats) =>
  new Response(JSON.stringify({ data: { Response: { roleType: "basic", usageStats } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

test("the AI allowance is reported as used out of its limit", async () => {
  const u = await usage(() =>
    billing([
      { feature: "session_share", quotaLimit: -1, quotaUsed: 0 },
      { feature: "hunyuan_ai", quotaLimit: 1000, quotaUsed: 370 },
    ]),
  )
  assert.equal((u.windows).length, 1)
  assert.equal(u.windows[0].name, "AI Q&A")
  assert.equal(u.windows[0].amount, 370)
  assert.equal(u.windows[0].limit, 1000)
  assert.equal(u.windows[0].used, 37)
  assert.ok((u.plan).includes("basic"))
})

// The unrelated rows must not be shown: session sharing's -1 limit would
// read as an exhausted account.
test("rows that are not the AI allowance are left out", async () => {
  const u = await usage(() =>
    billing([
      { feature: "session_share", quotaLimit: -1, quotaUsed: 0 },
      { feature: "secret", quotaLimit: 5, quotaUsed: 1 },
    ]),
  )
  assert.equal((u.windows).length, 0)
  assert.ok(u.error)
})

// A refusal here is the sign-in's, and magpie should mark the account
// rather than keep asking it for quota.
test("a refused quota read marks the sign-in", async () => {
  const u = await usage(
    () =>
      new Response(JSON.stringify({ data: { Response: { Error: { Code: "VERIFY_SKEY_UIN_FAILED" } } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  assert.equal(u.signIn, "expired")
  assert.deepEqual(u.windows, [])
})

// Reading quota must never throw: a broken answer would take down the
// account card instead of just leaving the number out.
test("an unreadable answer becomes an error string, not a throw", async () => {
  const u = await usage(() => new Response("not json", { status: 200 }))
  assert.equal(typeof u.error, "string")
  assert.deepEqual(u.windows, [])
})

const oauthToken = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"userId":"test-user","providerUsername":"QR tester"}').toString("base64url")}.FAKE_SIGNATURE_ONLY`

test("QR accounts read quota using ot_session only on orcaterm.com", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    const action = JSON.parse(init.body).action
    if (action === "GetUserInfo") return new Response(JSON.stringify({ data: { Response: { nickName: "QR tester" } } }))
    return billing([{ feature: "hunyuan_ai", quotaLimit: 1000, quotaUsed: 0, quotaEndDate: "2026-11-21T16:00:00.000Z" }])
  }
  const hooks = await OrcaTermAuthPlugin()
  const u = await hooks.auth.usage(async () => ({ type: "oauth", access: oauthToken }))
  assert.equal((u.windows).length, 1)
  assert.equal(u.windows[0].amount, 0)
  assert.equal(u.windows[0].limit, 1000)
  assert.equal(u.windows[0].resetsAt, "2026-11-21T16:00:00.000Z")
  assert.equal(u.user, "QR tester")
  assert.equal((seen).length, 2)
  for (const { url, init } of seen) {
    assert.equal(new URL(url).origin, "https://orcaterm.com")
    assert.equal(new URL(url).pathname, "/cgi/api")
    assert.equal(url.includes(oauthToken), false)
    const h = new Headers(init.headers)
    assert.equal(h.get("cookie"), `ot_session=${oauthToken}`)
    assert.equal(h.get("authorization"), null)
    assert.equal(h.get("x-csrfcode"), null)
    assert.equal(init.redirect, "error")
  }
})

test("an explicitly refused OAuth quota read marks that account expired", async () => {
  const seen = []
  globalThis.fetch = async url => {
    seen.push(new URL(url).origin)
    return new Response(JSON.stringify({ data: { Response: { Error: { Code: "VERIFY_USER_FAILED" } } } }))
  }
  const hooks = await OrcaTermAuthPlugin()
  const u = await hooks.auth.usage(async () => ({ type: "oauth", access: oauthToken }))
  assert.equal(u.signIn, "expired")
  assert.deepEqual(u.windows, [])
  assert.deepEqual(seen, ["https://orcaterm.com"])
})

test("OAuth identity lookup failure preserves the token's display name", async () => {
  globalThis.fetch = async (url, init) => {
    if (JSON.parse(init.body).action === "GetUserInfo") throw new Error("identity unavailable")
    return billing([{ feature: "hunyuan_ai", quotaLimit: 1000, quotaUsed: 10 }])
  }
  const hooks = await OrcaTermAuthPlugin()
  const u = await hooks.auth.usage(async () => ({ type: "oauth", access: oauthToken }))
  assert.equal(u.user, "QR tester")
  assert.equal(u.windows[0].amount, 10)
})
