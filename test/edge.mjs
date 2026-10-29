/**
 * 对抗性边界测试（独立运行，不依赖真实网络/账号）
 *
 *   node test/edge.mjs
 *
 * 目标：把 index.mjs 放到真实会遇到的坏输入下，找真缺陷。
 * 每项测试都用断言表达「期望行为」；断言失败即记为缺陷候选。
 *
 * 覆盖：
 *   A. 传输层分块：单帧拆两半 / 逐字节 / 多字节 UTF-8 切在字符中间 / 1MB 大帧 / 末行无换行
 *   B. 行格式：data: 无空格 / CRLF / TAB / 只有 CR 的旧式行尾 / 注释行
 *   C. 收尾：无 [DONE] / [ERROR]: / [ERROR] / [ABORTED]
 *   D. 空与异常上游：只 reasoning / 500+HTML / 200+HTML / 200 空 SSE
 *   E. 客户端：init.signal 中途 abort / 消费端 cancel（连接泄漏）
 *   F. 请求体：Uint8Array（magpie 文档说 body 可能是字节）/ 空 messages / 只有 system /
 *              末条 assistant / content 非字符串
 *   G. model：undefined / provider 前缀 / 大小写混写 / 空串 / 只有斜杠
 */
import assert from "node:assert/strict"
import http from "node:http"
import pluginDefault, { _internal } from "../index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"

const OrcaTermAuthPlugin = pluginDefault.server
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 结果统计 ───────────────────────────────────────────────────────────────
let pass = 0
const failures = []

async function ok(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    const msg = String(e?.message ?? e)
    failures.push({ name, msg })
    console.log(`  ✗ ${name}\n      ${msg.split("\n").join("\n      ")}`)
  }
}

// 收集异步炸出来的东西，避免整个测试进程被带崩（同时在 abort 用例里作为断言依据）
const rejections = []
const uncaught = []
process.on("unhandledRejection", (r) => rejections.push(r))
process.on("uncaughtException", (e) => uncaught.push(e))

// ── mock 上游 ───────────────────────────────────────────────────────────────
const requests = []
const sockets = new Set()
let handler = null
let upRes = null

const server = http.createServer((req, res) => {
  const bufs = []
  req.on("data", (c) => bufs.push(c))
  req.on("end", () => {
    const rec = {
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(bufs).toString("utf8"),
      closed: false,
      endedAt: 0,
    }
    requests.push(rec)
    res.on("close", () => {
      rec.closed = true
      if (!rec.endedAt) rec.endedAt = Date.now()
    })
    if (!handler) {
      res.writeHead(500, { "content-type": "text/plain" })
      res.end("no handler")
      return
    }
    Promise.resolve()
      .then(() => handler(req, res, rec))
      .catch(() => {
        try {
          res.destroy()
        } catch {}
      })
  })
})
server.on("connection", (s) => {
  sockets.add(s)
  s.on("close", () => sockets.delete(s))
})

await new Promise((r) => server.listen(0, "127.0.0.1", r))
const MOCK = `http://127.0.0.1:${server.address().port}`

// 把插件的上游地址指向 mock（与 selftest.mjs 同思路：替换全局 fetch 前缀，不动源码常量）
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input)
  if (url.includes("lightai.cloud.tencent.com")) {
    return realFetch(url.replace("https://lightai.cloud.tencent.com", MOCK), init)
  }
  if (url.includes("api.orcaterm.cloud.tencent.com")) {
    return realFetch(url.replace("https://api.orcaterm.cloud.tencent.com", MOCK), init)
  }
  return realFetch(input, init)
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
const dataLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`

function sseHead(res, extra = {}) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...extra })
}

/** 按给定字节边界把 buf 分片写入，片间 sleep(gap) 模拟 TCP 分包 */
async function writeParts(res, parts, gap = 20) {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]?.length) res.write(parts[i])
    if (i < parts.length - 1 && gap) await sleep(gap)
  }
}

/** 把 OpenAI SSE 文本拆成帧；返回 {out, doneSeen, text} */
function frames(text) {
  const out = []
  let doneSeen = false
  for (const raw of text.split("\n")) {
    const t = raw.trim()
    if (!t.startsWith("data:")) continue
    const p = t.slice(5).trim()
    if (p === "[DONE]") {
      doneSeen = true
      continue
    }
    try {
      out.push(JSON.parse(p))
    } catch {
      out.push({ __unparsable: p })
    }
  }
  return { out, doneSeen, text }
}

const contentOf = (out) => out.map((c) => c?.choices?.[0]?.delta?.content ?? "").join("")
const reasonOf = (out) => out.map((c) => c?.choices?.[0]?.delta?.reasoning_content ?? "").join("")
const finishes = (out) => out.map((c) => c?.choices?.[0]?.finish_reason).filter(Boolean)

// ── 插件实例 ───────────────────────────────────────────────────────────────
const plugin = await OrcaTermAuthPlugin({ client: { app: { log: () => {} } } })
const authObj = { type: "api", key: "uin=o1234567; skey=SECRET123456" }
const loader = await plugin.auth.loader(async () => authObj)

const URL_CHAT = `${_internal.ASSISTANT_BASE}/chat`

async function ask(body, { signal, raw } = {}) {
  return loader.fetch(URL_CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(10000),
  })
}

async function askText(body, opts) {
  const res = await ask(body, opts)
  const text = await res.text()
  return { res, ...frames(text) }
}

/**
 * 同上，但容忍「流以错误结束」：中断与上游失败都会让这条流 error，
 * 直接 res.text() 会抛异常。返回 {out, text, err}，err 为空表示正常收尾。
 */
async function askTextSafe(body, opts) {
  const res = await ask(body, opts)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let text = ""
  let err = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
    }
  } catch (e) {
    err = e
  }
  return { res, text, err, ...frames(text) }
}

const SIMPLE = { model: "kimi", stream: true, messages: [{ role: "user", content: "hi" }] }

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[A] 传输层分块")
// ══════════════════════════════════════════════════════════════════════════

await ok("A1 单帧拆成两半（中间 40ms 延迟）→ 内容完整、不重复", async () => {
  handler = async (req, res) => {
    sseHead(res)
    const line = dataLine({ content: "你好，世界" })
    const buf = Buffer.from(line, "utf8")
    const cut = Math.floor(buf.length / 2)
    await writeParts(res, [buf.subarray(0, cut), buf.subarray(cut)], 40)
    res.end("data: [DONE]\n\n")
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "你好，世界", `拆包后正文被破坏：${JSON.stringify(contentOf(out))}`)
  assert.equal(doneSeen, true, "拆包不应吞掉 [DONE]")
})

await ok("A2 逐字节写入（每字节一个 chunk）→ 内容完整", async () => {
  handler = async (req, res) => {
    sseHead(res)
    const buf = Buffer.from(dataLine({ content: "汉字" }) + "data: [DONE]\n\n", "utf8")
    const parts = []
    for (let i = 0; i < buf.length; i++) parts.push(buf.subarray(i, i + 1))
    await writeParts(res, parts, 2)
    res.end()
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "汉字", `逐字节拆包后正文被破坏：${JSON.stringify(contentOf(out))}`)
  assert.equal(doneSeen, true)
})

await ok("A3 多字节 UTF-8 被切在字符中间（'世' 的 3 字节分 3 次到）→ 不出现乱码/丢字", async () => {
  handler = async (req, res) => {
    sseHead(res)
    const buf = Buffer.from(dataLine({ content: "世界和平" }) + "data: [DONE]\n\n", "utf8")
    const at = buf.indexOf(Buffer.from("世", "utf8"))
    assert.ok(at > 0)
    await writeParts(res, [buf.subarray(0, at + 1), buf.subarray(at + 1, at + 2), buf.subarray(at + 2)], 25)
    res.end()
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "世界和平", `多字节切分后正文被破坏：${JSON.stringify(contentOf(out))}`)
  assert.equal(doneSeen, true)
})

await ok("A4 末行无换行（上游最后一行 data: 后直接 end）→ 内容仍被收下", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ content: "前半" }))
    res.end(`data: ${JSON.stringify({ content: "尾帧" })}`) // 故意不带 \n
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "前半尾帧", `无尾换行的末帧被丢掉：${JSON.stringify(contentOf(out))}`)
  assert.equal(doneSeen, true, "上游没发 [DONE] 时必须自己补")
})

await ok("A6 非流式 + 末帧无换行 → 内容完整（残留缓冲必须被解析）", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ content: "甲" }))
    res.end(`data: ${JSON.stringify({ content: "乙" })}`) // 无尾换行
  }
  const res = await ask({ model: "kimi", stream: false, messages: [{ role: "user", content: "hi" }] })
  const j = await res.json()
  const got = j.choices[0].message.content
  assert.equal(got, "甲乙", `非流式路径残留 buf 未解析（upstreamToJSON 结尾无 buf 兜底）：实际 ${JSON.stringify(got)}`)
})

await ok("A7 非流式 + 流在 UTF-8 字符中间被截断 → 不能出替换字符或丢字", async () => {
  handler = (req, res) => {
    sseHead(res)
    const full = Buffer.from(dataLine({ content: "结尾" }), "utf8")
    // 切掉最后一个汉字的最后一字节，模拟上游异常截断
    res.write(full.subarray(0, full.length - 2))
    res.end()
  }
  const res = await ask({ model: "kimi", stream: false, messages: [{ role: "user", content: "hi" }] })
  const j = await res.json()
  const got = j.choices[0].message.content
  assert.ok(!got.includes("\uFFFD"), `出现替换字符 U+FFFD：${JSON.stringify(got)}`)
})

await ok("A5 1MB 单帧跨 4 个 chunk → 不截断", async () => {
  const big = "世".repeat(350000) // 350k 字符 ≈ 1.05MB
  const payload = Buffer.from(dataLine({ content: big }) + "data: [DONE]\n\n", "utf8")
  handler = async (req, res) => {
    sseHead(res)
    const step = Math.floor(payload.length / 4)
    await writeParts(
      res,
      [payload.subarray(0, step), payload.subarray(step, step * 2), payload.subarray(step * 2, step * 3), payload.subarray(step * 3)],
      5,
    )
    res.end()
  }
  const { out } = await askText(SIMPLE)
  const got = contentOf(out)
  assert.equal(got.length, big.length, `1MB 帧被截断：期望 ${big.length} 字符，实际 ${got.length}`)
  assert.equal(got, big, "1MB 帧内容不一致")
})

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[B] 行格式健壮性")
// ══════════════════════════════════════════════════════════════════════════

await ok("B1 data: 无空格 / TAB / CRLF 行尾 / 注释行 / event 行 → 都能正确解析", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(`data:${JSON.stringify({ content: "A" })}\n\n`) // 紧贴，无空格
    res.write(`data: {"content":"B"}\r\n\r\n`) // CRLF 行尾
    res.write(`data:\t{"content":"C"}\n\n`) // TAB 分隔
    res.write(": keep-alive\n\n") // SSE 注释
    res.write("event: message\n") // 事件名行
    res.write(`data: {"content":"D"}\n`) // 单 LF
    res.end("data: [DONE]\n\n")
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "ABCD", `行格式变体解析失败：${JSON.stringify(contentOf(out))}`)
  assert.equal(doneSeen, true)
})

await ok("B2 只有 \\r 作行分隔（SSE 规范允许的旧式行尾）→ 应能解析", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(`data: ${JSON.stringify({ content: "甲" })}\rdata: ${JSON.stringify({ content: "乙" })}\rdata: [DONE]\r`)
    res.end()
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(
    contentOf(out),
    "甲乙",
    `只按 \\n 切行，\\r 行尾的整段流被当成一行 JSON.parse 失败后静默丢弃：实际正文 ${JSON.stringify(contentOf(out))}，doneSeen=${doneSeen}`,
  )
})

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[C] 收尾与错误标记")
// ══════════════════════════════════════════════════════════════════════════

await ok("C1 上游完全不发 [DONE] 就关流 → 客户端仍收到 finish_reason:stop + [DONE]", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ content: "半句话" }))
    res.end()
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "半句话")
  assert.deepEqual(finishes(out), ["stop"], `缺少 finish_reason:stop：${JSON.stringify(finishes(out))}`)
  assert.equal(doneSeen, true, "缺少 [DONE]")
})

await ok("C2 data: [ERROR]:xxx → 以错误结束这条流（不挂死、不当正文）", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end("data: [ERROR]:模型额度已用尽\n\n")
  }
  // 设计：上游把失败写在 200 的流里，若当成正文，magpie 会记为成功 ——
  // 既不切换账号也不让该账号休息。所以流一开始就是错误帧时，直接以错误结束。
  const res = await ask(SIMPLE)
  assert.notEqual(res.status, 200, `错误帧不该以 200 收场：${res.status}`)
  const j = await res.json()
  assert.ok(
    JSON.stringify(j).includes("模型额度已用尽"),
    `上游的错误原因没透出：${JSON.stringify(j)}`,
  )
  assert.ok(j.error?.message?.includes("OrcaTerm"), "错误信息应带来源标记")
})

await ok("C3 data: [ERROR]（无冒号）→ 也要给出错误，且不空", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end("data: [ERROR]\n\n")
  }
  const res = await ask(SIMPLE)
  assert.notEqual(res.status, 200, `错误帧不该以 200 收场：${res.status}`)
  const j = await res.json()
  assert.ok(
    String(j.error?.message ?? "").trim().length > 0,
    `空错误文本：${JSON.stringify(j)}`,
  )
})

await ok("C4 data: [ABORTED] → 当正常收尾，不当错误、不挂死", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ content: "被中断前的话" }))
    res.end("data: [ABORTED]\n\n")
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "被中断前的话")
  assert.deepEqual(finishes(out), ["stop"])
  assert.equal(doneSeen, true)
})

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[D] 空与异常上游")
// ══════════════════════════════════════════════════════════════════════════

await ok("D1 上游只发 reasoningContent、从不发 content（带 [DONE]）→ 输出不能是空白", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ reasoningContent: "先想一下：" }))
    res.write(dataLine({ reasoningContent: "答案是 42。" }))
    res.end("data: [DONE]\n\n")
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(reasonOf(out), "先想一下：答案是 42。", "思考内容丢了")
  assert.ok(
    contentOf(out).trim().length > 0,
    `正文是空白（客户端若只渲染 content 会显示空回答）；实际 content=${JSON.stringify(contentOf(out))}，reasoning=${JSON.stringify(reasonOf(out))}`,
  )
  assert.equal(doneSeen, true)
})

// 对照：同一场景但不发 [DONE]，用于定位 D1 的根因是「[DONE] 分支提前 return 跳过了兜底」
await ok("D1b 对照：只发 reasoning、且不发 [DONE] → 兜底生效（证明 D1 根因在 [DONE] 提前 return）", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ reasoningContent: "只想了没答" }))
    res.end()
  }
  const { out } = await askText(SIMPLE)
  assert.ok(
    contentOf(out).trim().length > 0,
    `无 [DONE] 时兜底也没生效；content=${JSON.stringify(contentOf(out))}`,
  )
})

await ok("D9 include_usage + 只有 reasoning（带 [DONE]）→ 不发伪造 usage 帧", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ reasoningContent: "想了" }))
    res.end("data: [DONE]\n\n")
  }
  const { out } = await askText({ ...SIMPLE, stream_options: { include_usage: true } })
  // 上游不返回 token 数，字符数只是估算；当真实 usage 报上去会让费用与上下文统计失真
  assert.ok(!out.some((c) => c?.usage), "不应伪造 usage 帧")
  // 而且思考内容仍要兜底成正文，不能给出空回复
  assert.ok(contentOf(out).trim().length > 0, "只有思考时应兜底成正文")
})

await ok("D2 非流式：上游只发 reasoning → message.content 不能为空", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ reasoningContent: "只想了没答" }) + "data: [DONE]\n\n")
  }
  const res = await ask({ model: "deepseek", stream: false, messages: [{ role: "user", content: "hi" }] })
  const j = await res.json()
  const msg = j.choices[0].message
  assert.ok(
    (msg.content || "").trim().length > 0,
    `message.content 为空字符串（index.mjs:602 的 \`content || (upstreamError ? "" : "")\` 恒为空）；reasoning_content=${JSON.stringify(msg.reasoning_content)}`,
  )
})

await ok("D3 上游 500 且 body 是 HTML → 不抛异常，回 OpenAI 形状错误", async () => {
  handler = (req, res) => {
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" })
    res.end("<html><head><title>500</title></head><body>Internal Server Error</body></html>")
  }
  const res = await ask(SIMPLE)
  assert.ok(res.status >= 400, `status 应为错误码，实际 ${res.status}`)
  assert.ok(res.headers.get("content-type")?.includes("json"), `应回 JSON，实际 ${res.headers.get("content-type")}`)
  const j = await res.json()
  assert.equal(typeof j.error?.message, "string")
  assert.ok(j.error.message.length > 0, "错误信息为空")
  assert.ok(j.error.message.includes("500") || j.error.message.includes("Internal Server Error"), `错误信息没带上游线索：${JSON.stringify(j.error.message)}`)
})

await ok("D4 上游 200 但 body 是 HTML（登录页/网关页）→ 应识别为错误，不能静默空回答", async () => {
  handler = (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end("<html><body>请先登录腾讯云</body></html>")
  }
  const res = await ask(SIMPLE)
  const status = res.status
  const text = await res.text()
  const isError = status >= 400 || text.includes("[OrcaTerm]") || text.includes('"error"')
  assert.ok(
    isError,
    `200 + text/html 被当成 SSE 静默吞掉，客户端看到空回答；status=${status}，body 前 60 字=${JSON.stringify(text.slice(0, 60))}`,
  )
})

await ok("D5 上游 200 但 SSE 立即结束（空流）→ 仍给 stop + [DONE]", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end()
  }
  const { out, doneSeen } = await askText(SIMPLE)
  assert.equal(contentOf(out), "")
  assert.deepEqual(finishes(out), ["stop"])
  assert.equal(doneSeen, true)
})

await ok("D6 上游只用 fullContent（累计全文）→ 增量换算正确、不重复", async () => {
  handler = (req, res) => {
    sseHead(res)
    for (const s of ["一", "一二", "一二三"]) res.write(dataLine({ fullContent: s }))
    res.end("data: [DONE]\n\n")
  }
  const { out, doneSeen } = await askText(SIMPLE)
  const got = contentOf(out)
  assert.equal(got, "一二三", `fullContent 未被使用（index.mjs:507/512 只认 ev.content）：实际 ${JSON.stringify(got)}`)
  assert.equal(doneSeen, true)
})

await ok("D7 上游用 {data:{...}} 包装 → 能解包", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ data: { content: "包装" } }))
    res.end("data: [DONE]\n\n")
  }
  const { out } = await askText(SIMPLE)
  assert.equal(contentOf(out), "包装", `{data:{}} 包装解析失败：${JSON.stringify(contentOf(out))}`)
})

await ok("D8 进入 fetch 前 signal 已是 aborted → 不能挂死", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ content: "x" }))
  }
  const ac = new AbortController()
  ac.abort()
  const r = await loader.fetch(URL_CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SIMPLE),
    signal: ac.signal,
  })
  const text = await r.text()
  assert.ok(text.length > 0, "预 abort 时返回了空 body")
  try {
    upRes?.destroy()
  } catch {}
})

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[E] 客户端中断")
// ══════════════════════════════════════════════════════════════════════════

await ok("E1 init.signal 中途 abort → 不挂死、无未捕获异常、上游连接被释放", async () => {
  let rec = null
  handler = (req, res) => {
    rec = requests[requests.length - 1]
    upRes = res
    sseHead(res)
    res.write(dataLine({ content: "开头" }))
    const t = setInterval(() => {
      if (!res.writableEnded) res.write(dataLine({ content: "拖" }))
    }, 80)
    res.on("close", () => clearInterval(t))
  }
  const ac = new AbortController()
  const res = await loader.fetch(URL_CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SIMPLE),
    signal: ac.signal,
  })
  const reader = res.body.getReader()
  const first = await reader.read()
  assert.ok(first.value?.length, "应先收到首帧")
  const beforeRej = rejections.length
  const beforeUnc = uncaught.length

  ac.abort()

  const dec = new TextDecoder()
  let text = ""
  let readErr = null
  // 中断后这条流会以错误结束，读取时抛异常是预期行为
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
    }
  } catch (e) {
    readErr = e
  }
  const f = frames(text)
  // 设计：中断必须以错误结束这条流，不能伪装成正常收尾 —— 否则 magpie 记成成功，
  // 既不切换账号也不让该账号休息。所以这里不再要求 [DONE] 与「连接中断」正文帧。
  assert.ok(
    readErr || f.doneSeen === false,
    `abort 后应体现出中断（流以错误结束），实际尾部=${JSON.stringify(text.slice(-120))}`,
  )
  await sleep(150)
  assert.equal(
    rejections.length,
    beforeRej,
    `出现了未捕获的 Promise 拒绝：${rejections.slice(beforeRej).map((r) => String(r?.message ?? r)).join("; ")}`,
  )
  assert.equal(uncaught.length, beforeUnc, `出现了未捕获异常：${uncaught.slice(beforeUnc).map(String).join("; ")}`)
  assert.equal(rec.closed, true, "abort 后上游连接应被释放（实际仍开着）")
  try {
    upRes?.destroy()
  } catch {}
})

await ok("E2 消费端 cancel（客户端断连）→ 上游连接应被释放，不泄漏", async () => {
  let rec = null
  handler = (req, res) => {
    rec = requests[requests.length - 1]
    upRes = res
    sseHead(res)
    res.write(dataLine({ content: "第一段" }))
    const t = setInterval(() => {
      if (!res.writableEnded) res.write(dataLine({ content: "x" }))
    }, 60)
    res.on("close", () => clearInterval(t))
  }
  const res = await ask(SIMPLE)
  const reader = res.body.getReader()
  const first = await reader.read()
  assert.ok(first.value?.length, "应先收到首帧")
  await reader.cancel() // 模拟 magpie 侧断连
  await sleep(500)
  try {
    assert.equal(rec.closed, true, "消费端 cancel 后 500ms 上游连接仍开着（ReadableStream 没有 cancel 钩子，未 cancel 上游 reader）")
  } finally {
    try {
      upRes?.destroy()
    } catch {}
  }
})

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[F] 请求体")
// ══════════════════════════════════════════════════════════════════════════

await ok("F1 body 是 Uint8Array（magpie 文档：body 可能是字节）→ 消息不能被丢", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const payload = { model: "kimi", stream: true, messages: [{ role: "user", content: "字节体里的问题" }] }
  const res = await ask(null, { raw: new TextEncoder().encode(JSON.stringify(payload)) })
  assert.equal(res.status, 200)
  await res.text()
  const up = JSON.parse(requests.at(-1).body)
  assert.ok(
    up.input.input.includes("字节体里的问题"),
    `Uint8Array body 被当成 "{}" 解析丢弃：上游收到 input.content=${JSON.stringify(up.input.input)}，model=${JSON.stringify(up.user.setting.model)}`,
  )
  assert.equal(up.user.setting.model, "TokenHub/kimi-k3", "model 也应从字节体里解析出来")
})

await ok("F2 非法 JSON 字符串 body → 400（不崩）", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end("data: [DONE]\n\n")
  }
  const res = await ask(null, { raw: "{not json" })
  assert.equal(res.status, 400)
  const j = await res.json()
  assert.equal(typeof j.error?.message, "string")
})

await ok("F3 messages: [] → 不能给上游发空 input.content", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const res = await ask({ model: "kimi", stream: true, messages: [] })
  await res.text()
  const up = JSON.parse(requests.at(-1).body)
  assert.ok(
    up.input.input.trim().length > 0,
    `messages:[] 时 input.content 为空串，上游大概率报错或答非所问：${JSON.stringify(up.input)}`,
  )
})

await ok("F4 messages 里 content 是 null/数字 → 不能给上游发空 input.content", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const res = await ask({ model: "kimi", stream: true, messages: [{ role: "user", content: null }] })
  await res.text()
  const up = JSON.parse(requests.at(-1).body)
  assert.ok(up.input.input.trim().length > 0, `content:null 时 input.content 为空串：${JSON.stringify(up.input.input)}`)
})

await ok("F5 只有 system → input 非空、history 为空（不崩）", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const res = await ask({ model: "kimi", stream: true, messages: [{ role: "system", content: "你是助手" }] })
  await res.text()
  const up = JSON.parse(requests.at(-1).body)
  assert.ok(up.input.input.includes("你是助手"))
  assert.equal(up.input.historyMessages.length, 0)
})

await ok("F6 最后一条是 assistant → 不能把 assistant 内容当成自己的问题、也不能空 input", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const res = await ask({
    model: "kimi",
    stream: true,
    messages: [
      { role: "user", content: "问题一" },
      { role: "assistant", content: "回答一" },
    ],
  })
  await res.text()
  const up = JSON.parse(requests.at(-1).body)
  assert.equal(up.input.input, "问题一", `末条 assistant 时 input 选错：${JSON.stringify(up.input.input)}`)
  // 历史不再随请求上传：会话登记后上下文由服务端按 conversationId 维护。
  // 末条 assistant 的内容不能当成用户问题，这一点由上面 input 的取值保证。
  assert.equal(up.input.historyMessages.length, 0)
})

await ok("F7 messages 不是数组（字符串）→ 不崩，仍是合法请求", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const res = await ask({ model: "kimi", stream: true, messages: "hello" })
  assert.equal(res.status, 200)
  await res.text()
  const up = JSON.parse(requests.at(-1).body)
  assert.equal(typeof up.input.input, "string")
  assert.ok(Array.isArray(up.input.historyMessages))
})

await ok("F8 带 tool_calls / tool 结果的多轮 → 上游 input 非空且不丢工具信息", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const res = await ask({
    model: "kimi",
    stream: true,
    messages: [
      { role: "user", content: "查天气" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"深圳"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "晴 30 度" },
    ],
  })
  await res.text()
  const up = JSON.parse(requests.at(-1).body)
  const joined = [up.input.input, ...up.input.historyMessages.map((m) => m.content)].join("\n")
  assert.ok(joined.includes("get_weather"), "工具调用丢了")
  assert.ok(joined.includes("晴 30 度"), "工具结果丢了")
  assert.ok(up.input.input.includes("[tool result"), "末轮工具结果应成为 input")
})

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[G] model 解析")
// ══════════════════════════════════════════════════════════════════════════

handler = (req, res) => {
  sseHead(res)
  res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
}

const modelCases = [
  ["G1 model 缺失（undefined）→ 默认 deepseek", undefined, "TokenHub/deepseek-v4-pro"],
  ["G2 provider 前缀 orcaterm/kimi", "orcaterm/kimi", "TokenHub/kimi-k3"],
  ["G3 大小写混写 ORCATERM/Kimi-K2-Thinking", "ORCATERM/Kimi-K2-Thinking", "kimi-k2-thinking"],
  ["G4 前后空格 ' Kimi '", " Kimi ", "TokenHub/kimi-k3"],
  ["G5 未知模型原样透传（不 404）", "brand-new-model", "brand-new-model"],
  ["G6 空串 → 默认", "", "TokenHub/deepseek-v4-pro"],
  ["G7 数字 model 不崩", 123, "123"],
  ["G8 只有斜杠 'orcaterm/' → 应回落默认模型", "orcaterm/", "TokenHub/deepseek-v4-pro"],
]

for (const [name, model, expect] of modelCases) {
  await ok(name, async () => {
    const body = { stream: true, messages: [{ role: "user", content: "hi" }] }
    if (model !== undefined) body.model = model
    const res = await ask(body)
    await res.text()
    const up = JSON.parse(requests.at(-1).body)
    assert.equal(up.user.setting.model, expect, `期望 ${expect}，实际上游收到 ${JSON.stringify(up.user.setting.model)}`)
  })
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n[H] 用量 / 路径一致性 / 非流式中断")
// ══════════════════════════════════════════════════════════════════════════

const usageOf = (out) => out.find((c) => c?.usage)?.usage

await ok("H1 include_usage → 大输入也不伪造 usage（上游没有真实 token 数）", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: "ok" }) + "data: [DONE]\n\n")
  }
  const small = await askText({
    model: "kimi",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "hi" }],
  })
  const big = await askText({
    model: "kimi",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "字".repeat(3000) }],
  })
  // 上游不返回 token 数；按字符估算再当 usage 上报，会让费用与上下文统计失真
  assert.equal(usageOf(small.out), undefined, "不应伪造 usage 帧")
  assert.equal(usageOf(big.out), undefined, "不应伪造 usage 帧")
  // 但两条流的正文都必须是完整的，不能因为不发 usage 就丢了内容
  assert.ok(contentOf(small.out).includes("ok"))
  assert.ok(contentOf(big.out).includes("ok"))
})

await ok("H2 非流式 + 上游只用 fullContent → 内容不能是占位空回复（与流式路径一致）", async () => {
  handler = (req, res) => {
    sseHead(res)
    for (const s of ["一", "一二", "一二三"]) res.write(dataLine({ fullContent: s }))
    res.end("data: [DONE]\n\n")
  }
  const res = await ask({ model: "kimi", stream: false, messages: [{ role: "user", content: "hi" }] })
  const j = await res.json()
  const got = j.choices[0].message.content
  assert.equal(got, "一二三", `非流式路径不认 fullContent（upstreamToJSON.absorb 只读 ev.content）：实际 ${JSON.stringify(got)}`)
})

await ok("H3 reasoning 后紧跟 [ERROR] → 以错误结束，错误原因不被思考文本顶掉", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ reasoningContent: "我先想想" }))
    res.end("data: [ERROR]:额度已用尽\n\n")
  }
  // 设计：流中途的失败要使这条流错误结束（不是发完思考再正常收尾），
  // 且错误原因必须是上游那句，而不是「我先想想」。
  const { out, text, err } = await askTextSafe(SIMPLE)
  assert.ok(err, `流应以错误结束（实际没有报错，正文=${JSON.stringify(contentOf(out))}）`)
  assert.ok(
    String(err?.message ?? err).includes("额度已用尽"),
    `错误原因被思考文本顶掉了：${String(err?.message ?? err)}`,
  )
})

await ok("H4 非流式 + 客户端中途 abort → loader.fetch 不能抛异常（应回错误 Response）", async () => {
  handler = (req, res) => {
    upRes = res
    sseHead(res)
    res.write(dataLine({ content: "第一段" }))
    const t = setInterval(() => {
      if (!res.writableEnded) res.write(dataLine({ content: "拖" }))
    }, 60)
    res.on("close", () => clearInterval(t))
  }
  const ac = new AbortController()
  const beforeRej = rejections.length
  const beforeUnc = uncaught.length
  const p = loader.fetch(URL_CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "kimi", stream: false, messages: [{ role: "user", content: "hi" }] }),
    signal: ac.signal,
  })
  setTimeout(() => ac.abort(), 120)
  try {
    const res = await p
    const text = await res.text()
    assert.ok(text.length > 0, "非流式 abort 返回了空 body")
  } catch (e) {
    throw new Error(
      `非流式路径没有 try/catch，abort 时 loader.fetch 直接 reject（magpie 侧会看到未处理异常）：${e?.message ?? e}`,
    )
  } finally {
    await sleep(120)
    assert.equal(rejections.length, beforeRej, `出现未捕获 Promise 拒绝：${rejections.slice(beforeRej).map(String).join("; ")}`)
    assert.equal(uncaught.length, beforeUnc, "出现未捕获异常")
    try {
      upRes?.destroy()
    } catch {}
  }
})

await ok("H5 非流式 1MB 单帧 → 不截断", async () => {
  const big = "字".repeat(350000)
  handler = (req, res) => {
    sseHead(res)
    res.end(dataLine({ content: big }) + "data: [DONE]\n\n")
  }
  const res = await ask({ model: "kimi", stream: false, messages: [{ role: "user", content: "hi" }] })
  const j = await res.json()
  assert.equal(j.choices[0].message.content.length, big.length, "非流式大帧被截断")
})

await ok("H6 上游 200 但 body 是 text/plain 错误文本（网关拦截）→ 不能静默空回答", async () => {
  handler = (req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    res.end("gateway blocked: request rejected by waf")
  }
  const res = await ask(SIMPLE)
  const status = res.status
  const text = await res.text()
  const surfaced = status >= 400 || text.includes("waf") || text.includes("[OrcaTerm]")
  assert.ok(
    surfaced,
    `200 + text/plain 被当 SSE 静默吞掉（looksSSE/looksHTML 都不匹配就直接进流式解析）：` +
      `status=${status}，body 前 80 字=${JSON.stringify(text.slice(0, 80))}`,
  )
})

await ok("H7 上游 200 且无 content-type、body 是 JSON 错误 → 应报错而不是空回答", async () => {
  handler = (req, res) => {
    res.writeHead(200, {})
    res.end(JSON.stringify({ code: 500, message: "VERIFY_LOGIN_FAILED" }))
  }
  const res = await ask(SIMPLE)
  const status = res.status
  const text = await res.text()
  const surfaced = status >= 400 || text.includes("VERIFY_LOGIN_FAILED") || text.includes("[OrcaTerm]")
  assert.ok(
    surfaced,
    `无 content-type 的 JSON 错误被静默吞掉：status=${status}，body 前 80 字=${JSON.stringify(text.slice(0, 80))}`,
  )
})

// ══════════════════════════════════════════════════════════════════════════
// [I] 动作信封（上游真实分片）
// ══════════════════════════════════════════════════════════════════════════
console.log("\n[I] 动作信封")

// 上游真的会这么发：整段回答是一个 assistant 消息对象，按字符切开流出来
// （2026-10-27 实测帧：{"id":…,"content":"{\n","reasoningContent":""…}）
const ENVELOPE_DELTAS = [
  "",
  "{\n",
  '  "',
  'action":',
  ' "com',
  'pletion",\n',
  '  "',
  "ph_",
  '1":',
  ' "--",\n',
  '  "',
  "taskCompletion",
  '":',
  ' "用一句',
  "话介绍",
  "你自己",
  '",\n',
  '  "',
  "action",
  'Id":',
  " null\n",
  "}",
]

await ok("I1 信封按真实分片流出 → 只出 taskCompletion 的正文", async () => {
  handler = (req, res) => {
    sseHead(res)
    for (const d of ENVELOPE_DELTAS) res.write(dataLine({ content: d, reasoningContent: "", reasoning: false, type: "ai", code: 0 }))
    res.end("data: [DONE]\n\n")
  }
  const { out } = await askTextSafe(SIMPLE)
  assert.equal(contentOf(out), "用一句话介绍你自己", `信封没解包或正文被改：${JSON.stringify(contentOf(out))}`)
  assert.ok(!contentOf(out).includes("taskCompletion"), "信封字段漏到了正文里")
  assert.ok(!contentOf(out).includes("action"), "信封字段漏到了正文里")
})

await ok("I2 正文在前、```json 围栏信封在后 → 围栏与信封都不出现在正文里", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ content: "已记住你的名字。" }))
    res.write(dataLine({ content: '```json\n{\n  "action": "completion",\n  "taskCompletion": "已记住。"\n}\n```' }))
    res.end("data: [DONE]\n\n")
  }
  const res = await ask(SIMPLE)
  const text = await res.text()
  assert.ok(text.includes("已记住你的名字。"), `正文丢了：${JSON.stringify(text.slice(0, 200))}`)
  assert.ok(!text.includes("taskCompletion"), "信封漏到了正文里")
  assert.ok(!text.includes("```json"), "围栏漏到了正文里")
})

await ok("I3 非流式：正文 + 围栏信封 → 只留正文", async () => {
  handler = (req, res) => {
    sseHead(res)
    res.write(dataLine({ content: "好的，" }))
    res.write(
      dataLine({
        content:
          '```json\n{\n  "action": "completion",\n  "ph_1": "--",\n  "taskCompletion": "好的，已记住。"\n}\n```',
      }),
    )
    res.end("data: [DONE]\n\n")
  }
  const res = await ask({ ...SIMPLE, stream: false })
  const j = await res.json()
  const c = j.choices[0].message.content
  assert.equal(c, "好的，", `非流式没切干净：${JSON.stringify(c)}`)
})

// ══════════════════════════════════════════════════════════════════════════
// 收尾
// ══════════════════════════════════════════════════════════════════════════
for (const s of sockets) {
  try {
    s.destroy()
  } catch {}
}
await new Promise((r) => server.close(r))

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`)
if (failures.length) {
  console.log("\n失败清单：")
  for (const f of failures) console.log(`  - ${f.name}`)
  process.exitCode = 1
}
