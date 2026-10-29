/**
 * 自测：不碰真实账号，用本地 mock 上游验证插件的转换链路。
 *
 *   node test/selftest.mjs
 *
 * 覆盖：
 *   1. csrfCode / actionSignature / parseTicket 等纯函数
 *   2. toUpstreamBody：system 前缀、历史切分、tool 降级
 *   3. loader().fetch：请求打到 mock 上游，流式与非流式两种回包都能被还原成 OpenAI 格式
 *   4. 上游报错 → OpenAI 形状的 error + x-magpie-sign-in
 *   5. config / provider 钩子的形状符合 magpie 文档
 */
import assert from "node:assert/strict"
import http from "node:http"
import pluginDefault, { _internal } from "../index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter. The pacer's own
// tests build their own instance and are unaffected.
process.env.ORCATERM_NO_PACE = "1"

const OrcaTermAuthPlugin = pluginDefault.server

let pass = 0
let fail = 0
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      console.log(`  ✓ ${name}`)
    })
    .catch((e) => {
      fail++
      console.log(`  ✗ ${name}\n      ${e?.message ?? e}`)
    })
}

// ── mock 上游 ───────────────────────────────────────────────────────────────
const received = []
let mode = "stream" // stream | stream-cumulative | json-error | http-401

const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    received.push({ url: req.url, headers: req.headers, body })
    // 网页端发 /chat 之前会先 POST /conversation 登记会话，上下文靠这个保
    assert.ok(
      req.url.startsWith("/assistant/chat") || req.url.startsWith("/assistant/conversation"),
      `mock 只该收到 /assistant/chat 与 /assistant/conversation，实际：${req.url}`,
    )
    assert.ok(req.headers.cookie?.includes("skey="), "必须带 skey cookie")

    if (req.url.startsWith("/assistant/conversation")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 0, data: { id: "conversation-ok" }, message: "OK", error: null }))
      return
    }

    if (mode === "http-401") {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 500, message: "NEED_UIN_AND_SKEY" }))
      return
    }
    if (mode === "json-error") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 500, message: "NEED_UIN_AND_SKEY" }))
      return
    }

    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" })
    // 上游的两种帧形状：content 是「本帧新增」，fullContent 是「累计全文」。
    // 早先这里把累计值塞进 content，测的是插件替上游纠错，与真机不符。
    const frames =
      mode === "stream-cumulative"
        ? [
            { fullContent: "你" },
            { fullContent: "你好" },
            { fullContent: "你好，" },
            { fullContent: "你好，世界" },
          ]
        : [{ content: "你" }, { content: "好" }, { content: "，" }, { content: "世界" }]
    for (const c of frames) {
      res.write(`data: ${JSON.stringify({ ...c, id: "m1" })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ reasoningContent: "思考中", id: "m1" })}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  })
})

await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port
const MOCK = `http://127.0.0.1:${port}`

// 把插件的上游地址指向 mock：靠替换全局 fetch 的前缀实现，不动源码常量
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input)
  if (url === "https://orcaterm.com/oauth/wechat/config") {
    return Promise.resolve(new Response(JSON.stringify({ code: 0, data: {
      appid: "audit", redirect_uri: "https://orcaterm.com/oauth/wechat/bridge",
      state: "audit-state", scope: "snsapi_login",
    } }), { headers: { "content-type": "application/json" } }))
  }
  if (url.includes("lightai.cloud.tencent.com")) {
    return realFetch(url.replace("https://lightai.cloud.tencent.com", MOCK), init)
  }
  if (url.includes("api.orcaterm.cloud.tencent.com")) {
    return realFetch(url.replace("https://api.orcaterm.cloud.tencent.com", MOCK), init)
  }
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init)
  throw new Error(`Unexpected external request in test: ${url}`)
}

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────
console.log("\n[1] 纯函数")

await ok("csrfCode 按 djb2 折叠到 31 位", () => {
  const v = Number(_internal.csrfCode("abcdef"))
  assert.ok(Number.isInteger(v))
  assert.ok(v >= 0 && v <= 0x7fffffff)
  assert.equal(_internal.csrfCode("abcdef"), _internal.csrfCode("abcdef"))
  assert.equal(_internal.csrfCode(""), "")
})


await ok("parseTicket 认多种贴法", () => {
  const t1 = _internal.parseTicket("uin=o123; skey=AAA")
  assert.equal(t1.uin, "o123")
  assert.equal(t1.skey, "AAA")

  // 裸 skey 能解析出 skey，但没有 uin —— 上游会拒绝，loader 会拦下
  const t2 = _internal.parseTicket("skinnySecret")
  assert.equal(t2.skey, "skinnySecret")
  assert.equal(t2.uin, "")

  // p_uin / p_skey 会被提升成 uin / skey
  const t3 = _internal.parseTicket("p_uin=o9; p_skey=BBB")
  assert.equal(t3.skey, "BBB")
  assert.equal(t3.uin, "o9")

  assert.equal(_internal.parseTicket(""), null)
})

await ok("cookieHeader：uin 与 skey 必须成对（实测上游行为）", () => {
  // 只有 skey → 不产出 cookie 头（上游会回 NEED_UIN_AND_SKEY）
  assert.equal(_internal.cookieHeader({ ticket: { skey: "AAA" } }), "")
  // 成对 → 产出，且同时含 uin 与 skey
  const h = _internal.cookieHeader({ ticket: { uin: "o123", skey: "AAA" } })
  assert.ok(h.includes("uin=o123"))
  assert.ok(h.includes("skey=AAA"))
  assert.equal(h, _internal.cookieHeader({ ticket: { uin: "o123", skey: "AAA" } }))
})

await ok("pacer：窗口内的请求放行，超出要等（上游 10 RPM）", async () => {
  // 窗口缩到 300ms、额度 2，验证放行与阻塞，不用真等一分钟
  const saved = process.env.ORCATERM_NO_PACE
  delete process.env.ORCATERM_NO_PACE
  try {
    const p = _internal.createPacer({ limit: 2, windowMs: 300, useEnv: false })
    const t0 = Date.now()
    await p.wait()
    await p.wait()
    const fast = Date.now() - t0
    assert.ok(fast < 120, `前两个应当立刻放行，实际等了 ${fast}ms`)
    await p.wait() // 第三个必须等窗口滑过去
    const slow = Date.now() - t0
    assert.ok(slow >= 250, `第三个应当被窗口挡住，实际只等了 ${slow}ms`)
    assert.equal(p.size() <= 2, true, `窗口内计数不应超过额度：${p.size()}`)
  } finally {
    if (saved !== undefined) process.env.ORCATERM_NO_PACE = saved
  }
})

await ok("pacer：429 之后进入冷却，不会立刻再打", async () => {
  const saved = process.env.ORCATERM_NO_PACE
  delete process.env.ORCATERM_NO_PACE
  try {
    const p = _internal.createPacer({ limit: 10, windowMs: 60000, useEnv: false })
    await p.wait()
    const t0 = Date.now()
    p.penalize(200)
    await p.wait()
    const waited = Date.now() - t0
    assert.ok(waited >= 180, `429 后应冷却，实际只等了 ${waited}ms`)
  } finally {
    if (saved !== undefined) process.env.ORCATERM_NO_PACE = saved
  }
})
await ok("resolveModel：别名与裸 id 都能命中", () => {
  assert.equal(_internal.resolveModel("deepseek"), "TokenHub/deepseek-v4-pro")
  assert.equal(_internal.resolveModel("orcaterm/kimi"), "TokenHub/kimi-k3")
  assert.equal(_internal.resolveModel("glm-4.7-thinking"), "glm-4.7-thinking")
  assert.equal(_internal.resolveModel("brand-new-model"), "brand-new-model")
})

// OrcaTerm 选择器显示的是标签，发给上游的 id 是另一个字符串（它自己表里
// `modelName` 与 `newModelId`）。把标签当 id 发就是 "LLM(x) is not loaded"；
// `hy3-preview` 根本不是一个 id，它是 hunyuan-t1 的标签，拿它请求会 401。
await ok("resolveModel：界面标签要落到真正可用的 id", () => {
  assert.equal(_internal.resolveModel("Hy3-preview"), "Hunyuan3/hy3")
  assert.equal(_internal.resolveModel("hy3-preview"), "Hunyuan3/hy3")
  assert.equal(_internal.resolveModel("Deepseek-V4-Pro"), "TokenHub/deepseek-v4-pro")
  assert.equal(_internal.resolveModel("GLM-5.2"), "TokenHub/glm-5.2")
  assert.equal(_internal.resolveModel("Kimi-k2.6"), "TokenHub/kimi-k3")
})

// ── 2. 请求体转换 ───────────────────────────────────────────────────────────
console.log("\n[2] toUpstreamBody")

await ok("system 提到前缀，历史与末轮分离", () => {
  const up = _internal.toUpstreamBody(
    {
      model: "deepseek",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "第二问" },
      ],
    },
    { conversationId: "cid-1", userId: "u-1" },
  )
  assert.equal(up.conversationId, "cid-1")
  assert.ok(up.input.input.startsWith("[system instructions"))
  assert.ok(up.input.input.endsWith("第二问"))
  // 网页端主聊天不发 historyMessages：会话登记后上下文由服务端按
  // conversationId 维护（实测第二轮仍能答出上一轮的名字）
  assert.equal(up.input.historyMessages.length, 0)
  // 首轮回合的类型标记，以及正文所在字段
  assert.equal(up.input.type, "start")
  assert.equal(up.stream, true)
})

await ok("tool 结果与 tool_calls 降级成文本轮次", () => {
  const up = _internal.toUpstreamBody(
    {
      messages: [
        { role: "user", content: "查天气" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"深圳"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "晴 30度" },
      ],
    },
    { conversationId: "cid-2", userId: "u-2" },
  )
  // 末轮是工具结果 → 作为 input；工具调用记录进历史
  const joined = [up.input.input, ...up.input.historyMessages.map((m) => m.content)].join("\n")
  assert.ok(joined.includes("get_weather"), "工具调用要降级成文本")
  assert.ok(joined.includes("晴 30度"), "工具结果不能丢")
  assert.ok(up.input.input.includes("[tool result"), "末轮工具结果应成为 input")
})

await ok("数组式 content 只取文本", () => {
  const up = _internal.toUpstreamBody(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: "http://x/y.png" } },
          ],
        },
      ],
    },
    { conversationId: "c", userId: "u" },
  )
  assert.ok(up.input.input.includes("看图"))
  assert.ok(up.input.input.includes("[image]"))
})

// ── 3. loader().fetch 端到端 ────────────────────────────────────────────────
console.log("\n[3] loader().fetch 端到端")

const plugin = await OrcaTermAuthPlugin({
  client: { app: { log: () => {} } },
})
const authObj = { type: "api", key: "uin=o1234567; skey=SECRET123456" }
const getAuth = async () => authObj
const loader = await plugin.auth.loader(getAuth)

async function readSSE(res) {
  const text = await res.text()
  const chunks = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const p = t.slice(5).trim()
    if (p === "[DONE]") continue
    chunks.push(JSON.parse(p))
  }
  return chunks
}

async function chat(body) {
  return loader.fetch(`${_internal.ASSISTANT_BASE}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
}

mode = "stream"
await ok("流式：逐帧 delta 拼出完整回答", async () => {
  received.length = 0
  const res = await chat({
    model: "deepseek",
    stream: true,
    messages: [{ role: "user", content: "你好" }],
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("content-type")?.includes("event-stream"), true)
  const chunks = await readSSE(res)
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  assert.equal(content, "你好，世界")
  const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? "").join("")
  assert.equal(reasoning, "思考中")
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "stop"))
  // 第一条是会话登记（POST /conversation），chat 请求排在它之后
  const chatReq = received.find((r) => r.url.startsWith("/assistant/chat"))
  assert.ok(chatReq, `没发出 /chat 请求，实际：${received.map((r) => r.url).join(", ")}`)
  const up = JSON.parse(chatReq.body)
  assert.equal(up.user.setting.model, "TokenHub/deepseek-v4-pro")
  assert.equal(up.stream, true)
  // 登记先于对话：否则每一轮都当首轮，上下文就丢了
  assert.ok(
    received.findIndex((r) => r.url.startsWith("/assistant/conversation")) <
      received.findIndex((r) => r.url.startsWith("/assistant/chat")),
    "会话登记必须发生在 /chat 之前",
  )
})

mode = "stream-cumulative"
await ok("fullContent 累计全文：换算成增量，不重复正文", async () => {
  mode = "stream-cumulative"
  const res = await chat({ model: "kimi", stream: true, messages: [{ role: "user", content: "hi" }] })
  const chunks = await readSSE(res)
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  assert.equal(content, "你好，世界")
})

mode = "stream"
await ok("非流式：整段读完后回 chat.completion", async () => {
  const res = await chat({ model: "glm", stream: false, messages: [{ role: "user", content: "hi" }] })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.choices[0].message.content, "你好，世界")
  // 上游给不出真实 token 数，估算值当 usage 会让费用与上下文算错，因此不报
  assert.equal(j.usage, undefined, "不应伪造 usage")
})

await ok("include_usage 不再发 usage 帧（上游无真实 token 数）", async () => {
  mode = "stream"
  const res = await chat({
    model: "deepseek",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "hi" }],
  })
  const chunks = await readSSE(res)
  assert.ok(!chunks.some((c) => c.usage), "不应有 usage 帧")
})

await ok("流式响应不带 content-length / content-encoding（改写正文时必须去掉）", async () => {
  mode = "stream"
  const res = await chat({ model: "deepseek", stream: true, messages: [{ role: "user", content: "hi" }] })
  assert.equal(res.headers.get("content-length"), null)
  assert.equal(res.headers.get("content-encoding"), null)
  assert.ok(res.headers.get("content-type").includes("event-stream"))
})

await ok("请求发往上游时不带 Authorization（凭据只走 cookie）", async () => {
  mode = "stream"
  received.length = 0
  await chat({ model: "deepseek", stream: true, messages: [{ role: "user", content: "hi" }] })
  const h = received[0].headers
  assert.equal(h.authorization, undefined)
  assert.ok(h.cookie.includes("uin=") && h.cookie.includes("skey="))
})

// ── 4. 错误路径 ─────────────────────────────────────────────────────────────
console.log("\n[4] 错误路径")

mode = "json-error"
await ok("200 + JSON 错误 → 401 + x-magpie-sign-in", async () => {
  const res = await chat({ model: "deepseek", stream: true, messages: [{ role: "user", content: "x" }] })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
  const j = await res.json()
  assert.ok(j.error.message.includes("NEED_UIN_AND_SKEY"))
})

mode = "http-401"
await ok("HTTP 401 → 401 + x-magpie-sign-in", async () => {
  const res = await chat({ model: "deepseek", stream: true, messages: [{ role: "user", content: "x" }] })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
})

await ok("没登录时 loader 返回空对象（magpie 视为不可用）", async () => {
  const l = await plugin.auth.loader(async () => ({ type: "api", key: "" }))
  assert.deepEqual(l, {})
})

await ok("只有 skey 没有 uin 时 loader 抛 signIn:expired（标记需重登，而不是静默失败）", async () => {
  await assert.rejects(
    () => plugin.auth.loader(async () => ({ type: "api", key: "justASkeyWithoutUin" })),
    (err) => {
      assert.equal(err.signIn, "expired")
      assert.ok(err.message.includes("uin"))
      return true
    },
  )
})

await ok("畸形 JSON 请求体 → 400", async () => {
  const res = await loader.fetch(`${_internal.ASSISTANT_BASE}/chat`, {
    method: "POST",
    body: "{not json",
  })
  assert.equal(res.status, 400)
})

await ok("body 是 Uint8Array 时也能解析（magpie 文档说 body 可能是字节）", async () => {
  mode = "stream" // 前面错误路径测试把 mock 停在 401 了
  const payload = JSON.stringify({
    model: "deepseek",
    stream: true,
    messages: [{ role: "user", content: "字节体" }],
  })
  const bytes = new TextEncoder().encode(payload)
  const res = await loader.fetch(`${_internal.ASSISTANT_BASE}/chat`, {
    method: "POST",
    body: bytes,
    signal: AbortSignal.timeout(15000),
  })
  assert.equal(res.status, 200)
  const chunks = await readSSE(res)
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  assert.equal(content, "你好，世界")
})

await ok("bodyToText 覆盖 string / bytes / ArrayBuffer", () => {
  assert.equal(_internal.bodyToText('{"a":1}'), '{"a":1}')
  assert.equal(_internal.bodyToText(new TextEncoder().encode("中文")), "中文")
  const ab = new TextEncoder().encode("ab").buffer
  assert.equal(_internal.bodyToText(ab), "ab")
  assert.equal(_internal.bodyToText(null), "")
})

// ── 5. 钩子形状 ─────────────────────────────────────────────────────────────
console.log("\n[5] 钩子形状")

await ok("config 声明 openai-compatible 供应商与全部模型", async () => {
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider.orcaterm
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(Object.keys(p.models).length, 9)
  for (const m of Object.values(p.models)) {
    assert.ok(m.limit.context > 0 && m.limit.output > 0)
    assert.equal(typeof m.tool_call, "boolean")
  }
})

await ok("config 不覆盖用户已配置的供应商", async () => {
  const cfg = { provider: { orcaterm: { name: "Mine", npm: "x", api: "y", models: {} } } }
  await plugin.config(cfg)
  assert.equal(cfg.provider.orcaterm.name, "Mine")
})

await ok("auth 钩子的必备字段齐全", () => {
  assert.equal(plugin.auth.provider, "orcaterm")
  // 三条路：微信扫码（推荐）→ 拉起本机浏览器（已知问题）→ 手动粘贴 cookie
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length === 3, "应当有 3 个登录方式")
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.ok(/WeChat.*QR|扫码/.test(plugin.auth.methods[0].label), "第一个应当是微信扫码")
  assert.equal(plugin.auth.methods[2].type, "api")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  // 扫码拿到的 token 只有两小时，必须能续期
  assert.equal(typeof plugin.auth.refresh, "function", "扫码登录需要 refresh 才能自动续期")
})

await ok("微信扫码：本地页面地址可用，扫码前不阻塞", async () => {
  const m = plugin.auth.methods[0]
  const t0 = Date.now()
  const r = await m.authorize({})
  const elapsed = Date.now() - t0
  try {
    assert.ok(elapsed < 8000, `authorize 花了 ${elapsed}ms，太慢`)
    assert.equal(r.method, "auto")
    assert.equal(typeof r.callback, "function")
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\/login$/, r.url)
    // 页面要能真的打开，且内嵌二维码脚本
    const page = await fetch(r.url).then((x) => x.text())
    assert.ok(page.includes("wxLogin.js"), "页面缺少官方二维码脚本")
    assert.ok(page.includes("self_redirect: true"), "必须 self_redirect，否则回跳会顶掉宿主页")
    assert.ok(page.includes("wechat-oauth-callback"), "页面缺少 postMessage 接收逻辑")
  } finally {
    // 不扫码，把等待中的本地接收页关掉，否则测试进程退不出去
    try {
      r.__cap?.close?.()
    } catch {
      /* ignore */
    }
  }
})

await ok("OAuth 方法走脚本自动登录（拉起本机浏览器）", async () => {
  const m = plugin.auth.methods[1]
  assert.equal(m.type, "oauth")
  // 真实调用会拉起浏览器，测试里只校验形状
  assert.equal(typeof m.authorize, "function")
  assert.ok(Array.isArray(m.prompts) && m.prompts[0].key === "fresh")
})

await ok("OAuth authorize 立刻返回且带 opened:true（否则 magpie 会再开一个浏览器）", async () => {
  const m = plugin.auth.methods[1]
  const t0 = Date.now()
  const r = await m.authorize({ fresh: "no" })
  const elapsed = Date.now() - t0

  // 必须秒回：一旦 await 登录过程，magpie 拿不到 url 就开不了浏览器（三方互等）
  assert.ok(elapsed < 5000, `authorize 花了 ${elapsed}ms，太慢`)
  assert.equal(r.method, "auto")
  assert.equal(typeof r.callback, "function")
  // opened 是宿主源码里的官方字段：告诉 magpie「浏览器我已经开了，别再开第二个」
  assert.equal(r.opened, true, "缺 opened:true 会导致用户在我们拿不到 cookie 的窗口里登录")
  assert.ok(r.url.startsWith("https://orcaterm.com/oauth/authorize?"), r.url)

  // 这个用例会真的拉起登录脚本（它在等扫码），测完必须掐掉，
  // 否则测试进程被它的子进程/浏览器挂住不退出。
  try {
    r.__job?.cancel?.()
  } catch {
    /* ignore */
  }
})


await ok("login.mjs 存在且 --show-profile 可用（不拉起浏览器）", async () => {
  const { existsSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const { execFileSync } = await import("node:child_process")
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, "..", "login.mjs")
  assert.ok(existsSync(script), "login.mjs 必须在插件根目录")

  // 只验证脚本能跑通并输出 profile 路径；真正拉起浏览器的路径留给人工/真机验证，
  // 否则测试会开一个浏览器窗口并卡在等扫码上。
  const out = execFileSync(process.execPath, [script, "--show-profile"], { encoding: "utf8" }).trim()
  assert.ok(out.includes("browser-profile"), `应输出 profile 路径，实际：${out}`)
})

await ok("chat.headers 只对自家 provider 生效，且用会话头而非 x-seqid", async () => {
  const out = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "openai" }, sessionID: "s1" }, out)
  assert.deepEqual(out.headers, {})
  await plugin["chat.headers"]({ model: { providerID: "orcaterm" }, sessionID: "s1" }, out)
  // 用独立头名，避免和上游的 x-seqid 语义混淆
  assert.equal(out.headers["x-orcaterm-session"], "s1")
  assert.equal(out.headers["x-seqid"], undefined)
})

await ok("chat.headers 写入会话头（供上游分会话）", async () => {
  const out = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "orcaterm" }, sessionID: "sess-abc" }, out)
  assert.equal(out.headers["x-orcaterm-session"], "sess-abc")
})

// magpie 并非每个调用方都给 sessionID。此时回退值必须稳定，否则每一轮都是新会话，
// 上游上下文就断了（实测：走网关两轮，第二轮记不得第一轮）。
await ok("chat.headers 没有 sessionID 时回退值稳定（不能每轮换一个）", async () => {
  const ids = []
  for (let i = 0; i < 3; i++) {
    const out = { headers: {} }
    await plugin["chat.headers"]({ model: { providerID: "orcaterm" } }, out)
    ids.push(out.headers["x-orcaterm-session"])
  }
  assert.equal(new Set(ids).size, 1, `回退的会话 id 不稳定：${JSON.stringify(ids)}`)
  assert.ok(ids[0], "回退值不能为空")
})


await ok("入口形状：default 是 OpenCode v1，且插件工厂是具名导出", async () => {
  const mod = await import("../index.mjs")
  assert.equal(mod.default.id, "opencode-orcaterm-auth")
  assert.equal(typeof mod.default.server, "function")
  assert.equal(typeof mod.OrcaTermAuthPlugin, "function")
})

// ── 收尾 ───────────────────────────────────────────────────────────────────
server.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
