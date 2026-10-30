import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { OrcaTermAuthPlugin } from "../index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const json = data => Response.json({ code: 0, data })
const token = (userId, nonce) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ userId, nonce })).toString("base64url")}.test`

async function scan(data) {
  globalThis.fetch = async url => {
    if (String(url).endsWith("/oauth/wechat/config")) return json({
      appid: "identity-test", redirect_uri: "https://orcaterm.com/oauth/wechat/bridge",
      state: "identity-state", scope: "snsapi_login",
    })
    assert.ok(String(url).endsWith("/oauth/wechat/exchange"))
    return json(data)
  }
  const plugin = await OrcaTermAuthPlugin()
  const flow = await plugin.auth.methods[0].authorize()
  assert.equal(flow.method, "auto")
  try {
    const res = await realFetch(new URL("/cb", flow.url), {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(flow.url).origin, connection: "close" },
      body: JSON.stringify({ code: "test-code", state: "identity-state", error: null }),
    })
    assert.equal(res.status, 200)
    return await flow.callback()
  } finally { flow.__cap.close() }
}

test("QR re-sign-in keeps identity across token and nickname changes, separating other users", async () => {
  const first = await scan({ userId: 123, accessToken: token("123", 1), providerUsername: "Alice" })
  const again = await scan({ userId: 123, accessToken: token("123", 2), providerUsername: "Renamed" })
  const other = await scan({ userId: 456, accessToken: token("456", 3), providerUsername: "Alice" })
  for (const result of [first, again, other]) {
    assert.equal(result.type, "success")
    assert.equal(result.accountId, result.userId)
    assert.equal(result.uid, result.userId)
  }
  assert.notEqual(first.access, again.access)
  assert.equal(first.accountId, again.accountId)
  assert.notEqual(first.accountId, other.accountId)
})

test("QR sign-in falls back to the token userId when the exchange omits it", async () => {
  const result = await scan({ accessToken: token("token-user", 1) })
  assert.equal(result.type, "success")
  assert.equal(result.accountId, "token-user")
  assert.equal(result.uid, "token-user")
})

test("QR sign-in refuses to save an account with no stable identity", async () => {
  const result = await scan({ accessToken: token(undefined, 1) })
  assert.equal(result.type, "failed")
  assert.match(result.error, /no userId/)
})

test("renewal supplies identity for older stored OAuth credentials", async () => {
  const before = token("legacy-user", 1)
  const after = token("legacy-user", 2)
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://orcaterm.com/cgi/api?action=OAuthRefreshToken")
    return json({ accessToken: after, expiresIn: 7200 })
  }
  const plugin = await OrcaTermAuthPlugin()
  const next = await plugin.auth.refresh({ type: "oauth", access: before, refresh: before })
  assert.equal(next.access, after)
  assert.equal(next.accountId, "legacy-user")
  assert.equal(next.uid, "legacy-user")
  assert.equal(next.userId, "legacy-user")
})

test("renewal preserves an existing account name and vendor uid", async () => {
  const before = token("user", 1)
  globalThis.fetch = async () => json({ accessToken: token("user", 2), expiresIn: 7200 })
  const plugin = await OrcaTermAuthPlugin()
  const next = await plugin.auth.refresh({ type: "oauth", access: before, refresh: before, accountId: "My account", uid: "user" })
  assert.equal(next.accountId, "My account")
  assert.equal(next.uid, "user")
})

test("loading older accounts backfills identity without dropping credentials or metadata", async () => {
  const saved = []
  const plugin = await OrcaTermAuthPlugin({ client: { auth: { async set(value) { saved.push(value) } } } })
  for (const user of ["first-user", "second-user"]) {
    const credential = { type: "oauth", access: token(user, 1), refresh: token(user, 1), expires: 123, metadata: { nickname: "Same name" } }
    await plugin.auth.loader(async () => credential)
    assert.deepEqual(saved.at(-1), { path: { id: "orcaterm" }, body: {
      ...credential, accountId: user, uid: user, userId: user,
    } })
  }
  assert.equal(saved.length, 2)
})

test("loading an identified account preserves its name and avoids rewriting it", async () => {
  let writes = 0
  const plugin = await OrcaTermAuthPlugin({ client: { auth: { async set() { writes++ } } } })
  await plugin.auth.loader(async () => ({ type: "oauth", access: token("user", 1), accountId: "My account", uid: "user" }))
  assert.equal(writes, 0)
})

test("quota refresh backfills an older account before another sign-in, even if quota is unavailable", async () => {
  const saved = []
  const plugin = await OrcaTermAuthPlugin({ client: { auth: { async set(value) { saved.push(value) } } } })
  const credential = { type: "oauth", access: token("quota-user", 1), refresh: token("quota-user", 1) }
  globalThis.fetch = async () => { throw new Error("quota unavailable") }
  const usage = await plugin.auth.usage(async () => credential)
  assert.match(usage.error, /quota unavailable/)
  assert.deepEqual(saved, [{ path: { id: "orcaterm" }, body: {
    ...credential, accountId: "quota-user", uid: "quota-user", userId: "quota-user",
  } }])
})
