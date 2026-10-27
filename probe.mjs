#!/usr/bin/env node
/**
 * 真机探针：拿你自己的 OrcaTerm 凭据，直接打一次上游，确认协议还通。
 * 不写入任何文件，不打印完整 skey。
 *
 *   node probe.mjs "uin=o1234567; skey=xxxxxxxx"
 *   ORCA_SKEY=xxxx node probe.mjs
 *   node probe.mjs            # 交互式粘贴
 *
 * 输出：
 *   1. 助手 /chat 的 HTTP 状态与前几帧（判断登录态是否有效、SSE 帧长什么样）
 *   2. cgi/api DescribeUserUsageStats 的原始返回（判断额度字段）
 *   3. 若干模型各打一次，列出可用/不可用
 */
import readline from "node:readline/promises"
import { randomUUID } from "node:crypto"
import { stdin, stdout } from "node:process"
import { _internal } from "./index.mjs"

const ASSISTANT_BASE = _internal.ASSISTANT_BASE
const CAPI = _internal.CAPI_URL

const redact = (s) => {
  const t = String(s ?? "")
  return t.length <= 6 ? "***" : `${t.slice(0, 3)}***${t.slice(-3)}`
}

async function getTicket() {
  let raw = process.argv[2] ?? process.env.ORCA_SKEY ?? ""
  if (!raw) {
    const rl = readline.createInterface({ input: stdin, output: stdout })
    raw = await rl.question(
      "粘贴 OrcaTerm 的 cookie（必须含 uin=… 与 skey=…，从 F12 → Cookies 复制），回车继续：\n> ",
    )
    rl.close()
  }
  const t = _internal.parseTicket(raw)
  if (!t) {
    console.error("没解析出 skey")
    process.exit(2)
  }
  if (!t.uin) {
    console.error(
      "缺少 uin。实测上游要求 uin 与 skey 成对出现：\n" +
        "  只给 skey 或只给 p_uin/p_skey 都会得到 NEED_UIN_AND_SKEY。\n" +
        "请在 F12 → Application → Cookies → orcaterm.cloud.tencent.com 里把 uin 也复制上。",
    )
    process.exit(2)
  }
  return t
}

function headers(ticket, extra = {}) {
  return {
    accept: "text/event-stream",
    "accept-language": "zh-CN,zh;q=0.9",
    "content-type": "application/json",
    origin: "https://orcaterm.cloud.tencent.com",
    referer: "https://orcaterm.cloud.tencent.com/terminal",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    cookie: _internal.cookieHeader({ ticket }),
    ...extra,
  }
}

async function probeChat(ticket, model) {
  const body = _internal.toUpstreamBody(
    {
      model,
      stream: true,
      messages: [
        { role: "system", content: "只回答四个字以内。" },
        { role: "user", content: "用一句话确认你在。" },
      ],
    },
    { conversationId: `cid-probe-${Date.now()}`, userId: "probe-user" },
  )
  body.user.setting.model = _internal.resolveModel(model)
  const csrf = _internal.csrfCode(ticket.skey)
  const url = `${ASSISTANT_BASE}/chat?name=orcaterm&mode=0&csrfCode=${csrf}`

  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headers(ticket, { "x-seqid": body.input.id }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
  } catch (e) {
    return { ok: false, status: 0, note: `网络错误：${e.message}` }
  }
  const ttfb = Date.now() - t0
  const ctype = res.headers.get("content-type") ?? ""

  if (!res.ok || !ctype.includes("event-stream")) {
    const text = await res.text()
    return { ok: false, status: res.status, note: text.slice(0, 300), ttfb }
  }

  // 读前若干字节就够判断是否有效
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let raw = ""
  let text = ""
  let reason = ""
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    raw += dec.decode(value, { stream: true })
    let nl
    while ((nl = raw.indexOf("\n")) >= 0) {
      const line = raw.slice(0, nl)
      raw = raw.slice(nl + 1)
      const ev = _internal.parseSseLine(line)
      if (!ev || ev.done) continue
      if (ev.error) return { ok: false, status: res.status, note: `上游错误：${ev.error}`, ttfb }
      if (ev.content) text += ev.content
      if (ev.reasoning) reason += ev.reasoning
    }
    if (text.length > 0 && Date.now() - t0 > 3000) break
  }
  try {
    await reader.cancel()
  } catch {
    /* ignore */
  }
  return {
    ok: !!(text || reason),
    status: res.status,
    ttfb,
    sample: (text || "").slice(0, 120).replace(/\s+/g, " ") || (reason ? "[仅思考]" : ""),
  }
}

async function probeUsage(ticket) {
  const uin = ticket.uin || ticket.p_uin || ""
  const sig = _internal.actionSignature({ action: "DescribeUserUsageStats", uin, ownerUin: uin })
  const seq = `${Date.now()}-1`
  let res
  try {
    res = await fetch(`${CAPI}?action=DescribeUserUsageStats&t=${seq}`, {
      method: "POST",
      headers: headers(ticket, {
        accept: "application/json",
        "x-seqid": seq,
        "x-referer": "https://orcaterm.cloud.tencent.com/terminal",
        "x-csrfcode": _internal.csrfCode(ticket.skey),
      }),
      body: JSON.stringify({
        action: "DescribeUserUsageStats",
        data: { feature: "ai", sig },
      }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (e) {
    return `网络错误：${e.message}`
  }
  const text = await res.text()
  return `${res.status} ${text.slice(0, 600)}`
}

const ticket = await getTicket()
console.log(`\n凭据：uin=${ticket.uin} skey=${redact(ticket.skey)}`)
console.log(`csrfCode=${_internal.csrfCode(ticket.skey)}\n`)

console.log("── 0. 鉴权面自检（确认错误码落在哪一层） ──")
{
  const body = JSON.stringify({
    conversationId: `cid-${randomUUID()}-orcaterm`,
    user: { id: "probe", setting: { model: "deepseek-chat-latest" } },
    // 三个助手侧的 input.id 都要是 uuid v4：上游按形状校验，回 Invalid inputId
    input: { id: randomUUID(), content: "ping", files: [], historyMessages: [] },
    stream: true,
  })
  const url = `${ASSISTANT_BASE}/chat?name=orcaterm&mode=0&csrfCode=${_internal.csrfCode(ticket.skey)}`
  const r = await fetch(url, { method: "POST", headers: headers(ticket), body })
  const text = await r.text()
  const code = (text.match(/"message":"([^"]+)"/) ?? [])[1] ?? text.slice(0, 120)
  const meaning = {
    NEED_UIN_AND_SKEY: "cookie 没被接受：uin 与 skey 必须成对，且 uin 不能缺",
    VERIFY_SKEY_UIN_FAILED: "凭据已进入校验层但被拒：skey 过期或不属于这个 uin",
    VERIFY_LOGIN_FAILED: "登录态无效：请重新登录 OrcaTerm 再复制 cookie",
  }[code]
  console.log(`  ${r.status} ${code}${meaning ? `\n     → ${meaning}` : ""}`)
}

console.log("\n── 1. 会话接口（默认模型） ──")
const first = await probeChat(ticket, "deepseek-chat-latest")
console.log(first.ok ? `  ✓ ${first.status} 首字 ${first.ttfb}ms  「${first.sample}」` : `  ✗ ${first.status} ${first.note}`)

if (first.ok) {
  console.log("\n── 2. 各模型可用性 ──")
  for (const spec of _internal.MODEL_SPECS) {
    if (spec.id === "deepseek-chat-latest") continue
    const r = await probeChat(ticket, spec.id)
    console.log(
      r.ok ? `  ✓ ${spec.id.padEnd(22)} ${r.ttfb}ms  「${r.sample}」` : `  ✗ ${spec.id.padEnd(22)} ${r.status} ${r.note}`,
    )
  }
}

console.log("\n── 3. 用量接口（原文，便于校准 usage 钩子） ──")
console.log("  " + (await probeUsage(ticket)))

console.log("\n完成。若 1 成功但 2 全失败，多半是 cookie 只有部分权限或账号未开通。")
void 0
