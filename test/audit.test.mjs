import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { OrcaTermAuthPlugin, _internal as i } from "../index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
process.env.ORCATERM_NO_PACE = "1"
const bytes = (s) => new TextEncoder().encode(s)
const frame = (content) => `data: ${JSON.stringify({ content })}\n\n`
const body = (s) => new ReadableStream({ start(c) { c.enqueue(bytes(s)); c.close() } })
const extract = (s, split = false) => {
  const e = i.createAnswerExtractor()
  let out = ""
  for (const chunk of split ? [...s] : [s]) out += e.push(chunk)
  return out + e.finish()
}
async function ask(response, stream = false, signal) {
  globalThis.fetch = async () => response
  const plugin = await OrcaTermAuthPlugin()
  const loader = await plugin.auth.loader(async () => ({ key: "uin=o1234567890; skey=AUDIT_FAKE_ONLY" }))
  return loader.fetch("https://unused.invalid", {
    body: JSON.stringify({ stream, messages: [{ role: "user", content: "hi" }] }), signal,
  })
}

test("whole envelopes allow leading whitespace and fences in any chunk shape", () => {
  const envelope = '{"action":"completion","taskCompletion":"Hello"}'
  for (const raw of [envelope, " \n" + envelope, "\n```json\n" + envelope + "\n```", "  ```\n" + envelope + "\n``` "]) {
    for (const split of [false, true]) assert.equal(extract(raw, split), "Hello")
  }
})

test("a leading envelope-shaped example followed by prose survives intact", () => {
  const raw = '{"action":"completion","taskCompletion":"example"} followed by explanation'
  for (const split of [false, true]) assert.equal(extract(raw, split), raw)
  const e = i.createAnswerExtractor()
  let out = e.push('{"action":"completion","taskCompletion":"example"}')
  out += e.push(" followed by explanation") + e.finish()
  assert.equal(out, raw)
})

test("capitalised trailing envelopes use the same recognition as whole envelopes", () => {
  const raw = 'Some prose.\n{"Action":"completion","TaskCompletion":"ignored"}'
  for (const split of [false, true]) assert.equal(extract(raw, split), "Some prose.\n")
})

test("a long partial envelope opening never leaks before its action key arrives", () => {
  const prefix = "A normal answer.\n"
  const raw = prefix + "{" + " ".repeat(120) + '"action":"completion","taskCompletion":"ignored"}'
  assert.equal(extract(raw, true), prefix)
  assert.equal(extract(raw), prefix)
})

test("a whitespace-prefixed envelope yields the same non-streaming answer", async () => {
  const res = await i.upstreamToJSON(body(frame('\n{"action":"completion","taskCompletion":"Hello"}') + "data: [DONE]\n\n"), { model: "m" })
  assert.equal((await res.json()).choices[0].message.content, "Hello")
})

for (const stream of [false, true]) {
  test(`an initial error without a final newline is classified (stream=${stream})`, async () => {
    const res = await ask(new Response("data: [ERROR]: quota exhausted", { headers: { "content-type": "text/event-stream" } }), stream)
    assert.equal(res.status, 429)
  })

  test(`DONE cancels and releases a still-open upstream (stream=${stream})`, async () => {
    let cancelled = false
    const upstream = new ReadableStream({
      start(c) { c.enqueue(bytes(frame("answer") + "data: [DONE]\n\n")) },
      cancel() { cancelled = true },
    })
    const res = stream ? i.upstreamToOpenAI(upstream, { model: "m" }) : await i.upstreamToJSON(upstream, { model: "m" })
    await res.text()
    assert.equal(cancelled, true)
    assert.equal(upstream.locked, false)
  })

  test(`loader releases the peek reader after DONE (stream=${stream})`, async () => {
    let cancelled = false
    const upstream = new ReadableStream({
      start(c) { c.enqueue(bytes(frame("answer") + "data: [DONE]\n\n")) },
      cancel() { cancelled = true },
    })
    const res = await ask(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), stream)
    await res.text()
    assert.equal(cancelled, true)
    assert.equal(upstream.locked, false)
  })

  test(`a peek read failure returns an OpenAI 502 (stream=${stream})`, async () => {
    const upstream = new ReadableStream({ start(c) { c.error(new Error("socket reset during peek")) } })
    const res = await ask(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), stream)
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /socket reset/)
    assert.equal(upstream.locked, false)
  })

  test(`an abort during peek returns 499 (stream=${stream})`, async () => {
    const upstream = new ReadableStream({ start(c) { c.error(new DOMException("cancelled", "AbortError")) } })
    const res = await ask(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), stream)
    assert.equal(res.status, 499)
  })
}

test("a final quota error without newline errors a stream and cools its pacer", async () => {
  let penalized = false
  const response = i.upstreamToOpenAI(body(frame("prefix text") + "data: [ERROR]: quota exhausted"), {
    model: "m", pacer: { penalize() { penalized = true } },
  })
  await assert.rejects(response.text(), (err) => err.statusCode === 429)
  assert.equal(penalized, true)
})

test("a non-streaming refusal stops reading a connection that stays open", async () => {
  let cancelled = false
  const upstream = new ReadableStream({
    start(c) { c.enqueue(bytes("data: [ERROR]: quota exhausted\n\n")) },
    cancel() { cancelled = true },
  })
  const res = await i.upstreamToJSON(upstream, { model: "m" })
  assert.equal(res.status, 429)
  assert.equal(cancelled, true)
  assert.equal(upstream.locked, false)
})

test("a JSON code 429 is authoritative without rate-limit keywords", async () => {
  const saved = process.env.ORCATERM_NO_PACE
  delete process.env.ORCATERM_NO_PACE
  try {
    for (const message of ["Too fast", "稍后再试", ""]) {
      const key = `uin=o429${message.length}; skey=AUDIT_429_${message.length}`
      const plugin = await OrcaTermAuthPlugin()
      const loader = await plugin.auth.loader(async () => ({ key }))
      globalThis.fetch = async () => new Response(JSON.stringify({ code: 429, message }), { headers: { "content-type": "application/json" } })
      const res = await loader.fetch("https://unused.invalid", { body: JSON.stringify({ stream: false }) })
      assert.equal(res.status, 429)
      assert.equal((await res.json()).error.code, 429)
      assert.ok(i.pacerFor({ ticket: i.parseTicket(key) }).blockedForTest() > 0)
    }
  } finally {
    if (saved === undefined) delete process.env.ORCATERM_NO_PACE
    else process.env.ORCATERM_NO_PACE = saved
  }
})

test("a non-SSE body read failure returns 502", async () => {
  const upstream = new ReadableStream({ start(c) { c.error(new Error("JSON socket reset")) } })
  const res = await ask(new Response(upstream, { headers: { "content-type": "application/json" } }))
  assert.equal(res.status, 502)
})

test("empty SSE does not reuse an already-locked response body", async () => {
  const res = await ask(new Response("", { headers: { "content-type": "text/event-stream" } }))
  assert.equal(res.status, 200)
  assert.ok((await res.json()).choices[0].message.content)
})

test("callback rejects invalid JSON shapes and remains alive for a valid scan", async () => {
  const cap = i.createLocalCapture({ appid: "audit", redirectUri: "https://orcaterm.com/oauth/wechat/bridge", state: "audit-state", timeoutMs: 5000 })
  try {
    const url = await cap.ready
    const send = (value) => realFetch(new URL("/cb", url), {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin, connection: "close" }, body: JSON.stringify(value),
    })
    for (const value of [null, [], 42, "text", {}, { code: {}, state: "audit-state" }, { code: "C", state: 42 }, { code: "C", state: "audit-state", error: {} }]) {
      const res = await send(value)
      assert.equal(res.status, 400)
      assert.equal((await res.json()).ok, false)
    }
    assert.equal((await (await send({ code: "C", state: "audit-state" })).json()).ok, true)
    assert.deepEqual(await cap.wait, { code: "C", state: "audit-state" })
  } finally { cap.close() }
})

test("callback preserves bridge errors without a code and still permits a later scan", async () => {
  const cap = i.createLocalCapture({ appid: "audit", redirectUri: "https://orcaterm.com/oauth/wechat/bridge", state: "audit-state", timeoutMs: 5000 })
  try {
    const url = await cap.ready
    const send = (value) => realFetch(new URL("/cb", url), {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin, connection: "close" }, body: JSON.stringify(value),
    })
    const res = await send({ state: "audit-state", error: "access_denied" })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: false, error: "access_denied" })
    assert.equal((await (await send({ code: "C", state: "audit-state" })).json()).ok, true)
    assert.deepEqual(await cap.wait, { code: "C", state: "audit-state" })
  } finally { cap.close() }
})

test("official bridge success with error null passes through the login page", async () => {
  const cap = i.createLocalCapture({ appid: "audit", redirectUri: "https://orcaterm.com/oauth/wechat/bridge", state: "audit-state", timeoutMs: 5000 })
  try {
    const url = await cap.ready
    const html = await (await realFetch(url, { headers: { connection: "close" } })).text()
    const script = /<script>\s*([\s\S]*?)<\/script>/.exec(html)?.[1]
    assert.ok(script)
    let listener
    const elements = new Map(["wrap", "done"].map(id => [id, { style: {}, textContent: "" }]))
    vm.runInNewContext(script, {
      WxLogin: function () {}, URL, location: { href: url },
      document: { getElementById: id => elements.get(id) },
      window: { addEventListener(type, callback) { if (type === "message") listener = callback } },
      fetch(target, init) {
        return realFetch(target, { ...init, headers: { ...init.headers, origin: new URL(url).origin, connection: "close" } })
      },
    }, { timeout: 1000 })
    // The public /oauth/wechat/bridge uses URLSearchParams.get(...) || null
    // for code, state and error; successful scans therefore carry error: null.
    await listener({ origin: "https://orcaterm.com", data: {
      type: "wechat-oauth-callback", code: "C", state: "audit-state", error: null,
    } })
    assert.match(elements.get("done").textContent, /^Scanned/)
    assert.deepEqual(await cap.wait, { code: "C", state: "audit-state" })
  } finally { cap.close() }
})

test("official bridge cancellation with code null keeps the error message", async () => {
  const cap = i.createLocalCapture({ appid: "audit", redirectUri: "https://orcaterm.com/oauth/wechat/bridge", state: "audit-state", timeoutMs: 5000 })
  try {
    const url = await cap.ready
    const send = value => realFetch(new URL("/cb", url), {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin, connection: "close" }, body: JSON.stringify(value),
    })
    const error = await send({ code: null, state: "audit-state", error: "access_denied" })
    assert.equal(error.status, 200)
    assert.deepEqual(await error.json(), { ok: false, error: "access_denied" })
    const missing = await send({ code: null, state: "audit-state", error: null })
    assert.equal(missing.status, 400)
    const success = await send({ code: "C", state: "audit-state", error: null })
    assert.equal((await success.json()).ok, true)
    assert.deepEqual(await cap.wait, { code: "C", state: "audit-state" })
  } finally { cap.close() }
})
