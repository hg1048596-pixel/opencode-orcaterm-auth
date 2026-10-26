/**
 * opencode-orcaterm-auth
 *
 * OrcaTerm（腾讯云遨驰终端）AI 反代插件，同时是 OpenCode v1 插件与 magpie 供应商插件。
 *
 * 上游协议（逆向自 orcaterm.cloud.tencent.com 前端 bundle，2026-10 版本）：
 *   会话接口  POST {ASSISTANT_BASE}/chat?name=<assistant>&mode=<0|1|2>&csrfCode=<skey-hash>
 *             body: {conversationId, user:{id, setting:{...}}, input:{id, content, files,
 *                    historyMessages}, stream:true}
 *             headers: x-seqid + cookie(uin/skey) + 浏览器族头
 *             响应: SSE，逐行 `data: {...}`，正文在 content，思考在 reasoningContent
 *   账号接口  POST https://api.orcaterm.cloud.tencent.com/cgi/api?<action 签名>
 *             body: {action, data}；head/tail 双写（X-CsrfCode 取 cookie skey 的 djb2）
 *
 * 本文件的对外契约完全按 magpie 文档：
 *   config / auth{methods, loader, usage} / provider.models / chat.headers
 */
import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const PROVIDER = "orcaterm"

// ── 上游常量（改动只需改这里） ───────────────────────────────────────────────
const ASSISTANT_BASE = "https://lightai.cloud.tencent.com/assistant"
const CAPI_ORIGIN = "https://orcaterm.cloud.tencent.com"
const CAPI_URL = "https://api.orcaterm.cloud.tencent.com/cgi/api"
const WEB_TERMINAL = "https://orcaterm.cloud.tencent.com/terminal"

/** OrcaTerm 内置助手的名字（lighthouse/orcaterm/cvm...），决定话术与工具集 */
const ASSISTANT = {
  orcaterm: "orcaterm",
  lighthouse: "lighthouse",
}
/** 0=RE_ACT 1=PLAN_ACT 2=AUTO_ACT */
const MODE = { react: 0, planact: 1, autoact: 2 }

/**
 * 上游模型 id（前端常量 bt.*，2026-10 快照）。
 * `name` 是展示名，`id` 是真正写进请求体的 model。
 */
const MODEL_SPECS = [
  {
    id: "deepseek-chat-latest",
    name: "DeepSeek-V4-Pro",
    reasoning: true,
    context: 128000,
    output: 32000,
    tool_call: false,
    aliases: ["deepseek", "deepseek-v3", "deepseek-chat", "deepseek-v4", "deepseek-v4-pro"],
  },
  {
    id: "hy3-preview",
    name: "Hy3-preview (混元)",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    aliases: ["hy3", "hunyuan", "hunyuan-t1", "hunyuan-3"],
  },
  {
    id: "glm-4.7",
    name: "GLM-5.2 (智谱)",
    reasoning: false,
    context: 200000,
    output: 32000,
    tool_call: false,
    aliases: ["glm", "glm-4.7", "glm-5", "glm-5.2", "bigmodel"],
  },
  {
    id: "glm-4.7-thinking",
    name: "GLM-5.2 Thinking",
    reasoning: true,
    context: 200000,
    output: 32000,
    tool_call: false,
    aliases: ["glm-thinking", "glm-5.2-thinking"],
  },
  {
    id: "kimi-k2",
    name: "Kimi-k2.6 (月之暗面)",
    reasoning: false,
    context: 256000,
    output: 32000,
    tool_call: false,
    aliases: ["kimi", "kimi-k2", "kimi-k2.6", "moonshot"],
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi-k2 Thinking",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    aliases: ["kimi-thinking"],
  },
  {
    id: "hunyuan-turbos",
    name: "Hunyuan TurboS",
    reasoning: false,
    context: 128000,
    output: 16000,
    tool_call: false,
    aliases: ["hunyuan-turbos", "turbos"],
  },
  {
    id: "hunyuan-t1",
    name: "Hunyuan T1",
    reasoning: true,
    context: 128000,
    output: 16000,
    tool_call: false,
    aliases: ["hunyuan-t1-latest"],
  },
]

const ALIAS_TO_ID = (() => {
  const m = new Map()
  for (const spec of MODEL_SPECS) {
    m.set(spec.id.toLowerCase(), spec.id)
    for (const a of spec.aliases) m.set(a.toLowerCase(), spec.id)
  }
  return m
})()

// ── 小工具 ─────────────────────────────────────────────────────────────────
function uid(prefix = "") {
  return prefix + randomBytes(12).toString("hex")
}

/** 腾讯 sckey 系 csrf：cookie 里 skey 的 djb2，& 0x7fffffff */
function csrfCode(skey) {
  if (!skey) return ""
  let h = 5381
  for (let i = 0; i < skey.length; i++) h = ((h << 5) + h + skey.charCodeAt(i)) | 0
  return String(h & 0x7fffffff)
}

/** OrcaTerm 网页 OAuth 入口（纯前端跳转，不需要凭据；2026-10 实测只支持 wechat） */
const OAUTH_ORIGIN = "https://orcaterm.com"
const OAUTH_PROVIDER = "wechat"

/**
 * 构造 OrcaTerm 登录页 URL。
 * 与前端 bundle 里的 `l(e)` 一致：/oauth/authorize?provider=…&source=web&return_url=…
 */
function loginUrl(provider = OAUTH_PROVIDER, returnUrl = "https://orcaterm.cloud.tencent.com/terminal") {
  const u = new URL(`${OAUTH_ORIGIN}/oauth/authorize`)
  u.searchParams.set("provider", provider)
  u.searchParams.set("source", "web")
  u.searchParams.set("return_url", returnUrl)
  return u.toString()
}

/**
 * 后台启动 login.mjs，立刻返回一个「句柄」，而不是等它跑完。
 *
 * 关键：authorize() 必须马上返回 url，magpie 才能打开浏览器；
 * 如果在这里 await 整个登录（最长 300s），就变成：
 *   authorize 等用户扫码 → 用户等浏览器打开 → 浏览器要等 authorize 返回 url
 * 三方互等，magpie 端就一直显示「登录未完成」。
 *
 * 所以：这里只负责把脚本拉起来并返回 wait()，真正的等待放到 callback()。
 */
function startLoginScript({ timeoutSec = 300, extraArgs = [] } = {}) {
  let scriptPath
  try {
    scriptPath = join(dirname(fileURLToPath(import.meta.url)), "login.mjs")
  } catch {
    return { wait: async () => ({ ok: false, error: "定位 login.mjs 失败" }), cancel: () => {} }
  }

  // 结果落盘：authorize 与 callback 是两次独立 RPC，宿主进程万一重启，
  // 内存里的句柄就没了，靠这个文件把结果找回来。
  //
  // 安全：文件里是明文凭据（uin + skey），所以
  //   - 只写到用户私有目录（不是共享 TEMP），权限 0600；
  //   - 被 readLoginResult() 读走时立刻删除；
  //   - 无论成败，子进程结束时都尝试删除，避免残留。
  const resultFile = join(loginStateDir(), `login-${Date.now()}-${randomBytes(4).toString("hex")}.json`)
  const args = [scriptPath, "--json", `--timeout=${timeoutSec}`, ...extraArgs]
  let child
  try {
    child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } catch (err) {
    return {
      wait: async () => ({ ok: false, error: `启动登录脚本失败：${err?.message ?? err}` }),
      cancel: () => {},
    }
  }

  let outBuf = ""
  let errBuf = ""
  const cap = (s, chunk) => (s + chunk).slice(-8192)

  child.stdout?.on("data", (d) => {
    outBuf = cap(outBuf, String(d))
  })
  child.stderr?.on("data", (d) => {
    errBuf = cap(errBuf, String(d))
  })

  // 子进程自己也有一层超时，这里多给 30s 缓冲，防止父进程先死
  const killer = setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }, (timeoutSec + 30) * 1000)

  const done = new Promise((resolve) => {
    child.on("error", (err) => {
      clearTimeout(killer)
      resolve({ ok: false, error: `登录脚本运行失败：${err?.message ?? err}` })
    })
    child.on("close", () => {
      clearTimeout(killer)
      // login.mjs 在 --json 模式只打印一行 JSON
      const line = outBuf
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith("{") && s.endsWith("}"))
        .pop()
      if (!line) {
        resolve({
          ok: false,
          error: `登录脚本没有返回结果${errBuf ? `：${errBuf.trim().slice(-300)}` : ""}`,
        })
        return
      }
      try {
        const j = JSON.parse(line)
        if (j.ok && j.ticket) {
          const res = { ok: true, uin: j.uin, ticket: j.ticket }
          // 落盘，供可能重启后的 callback 取回
          try {
            writeFileSync(resultFile, JSON.stringify(res), { mode: 0o600 })
          } catch {
            /* ignore */
          }
          resolve(res)
        } else {
          resolve({ ok: false, error: j.error || "登录未完成" })
        }
      } catch {
        resolve({ ok: false, error: `登录脚本输出无法解析：${line.slice(0, 200)}` })
      }
    })
  })

  return {
    resultFile,
    wait: () => done,
    cancel: () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      clearTimeout(killer)
      // 取消时也不留凭据文件
      try {
        unlinkSync(resultFile)
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 插件自己的私有状态目录（仅当前用户可访问）。
 * 用它而不是共享的 TEMP，避免同一台机器上别的账户读到凭据。
 */
function loginStateDir() {
  const base =
    process.env.LOCALAPPDATA ??
    process.env.XDG_STATE_HOME ??
    join(homedir(), ".local", "state")
  const dir = join(base, "orcaterm-magpie", "login-state")
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* 建不出来就退回 TEMP */
    return tmpdir()
  }
  return dir
}

/**
 * 从落盘文件取回登录结果 —— 宿主进程重启后，内存里的句柄没了，
 * 但脚本早已把结果写在这里。
 *
 * 读到就删：凭据只应存在于 magpie 的 plugin-auth.json 里，不该在磁盘上多留一份。
 */
function readLoginResult(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"))
    // 立刻抹掉，无论内容是否可用
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
    if (j?.ok && j.ticket) return { ok: true, uin: j.uin, ticket: j.ticket }
    return { ok: false, error: j?.error || "登录未完成" }
  } catch {
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
    return null
  }
}

/** cgi/api 的 action 签名（前端 89596.Td），失败时上游回 VERIFY_USER_FAILED */
function actionSignature(fields) {
  const parts = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null && fields[k] !== "")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&")
  return createHash("sha1").update(parts).digest("hex")
}

/**
 * 把用户贴进来的东西解析成凭据。
 * 支持：整段 cookie 字符串 / `uin=o123; skey=xxx` / 裸 skey / skey-uin 组合。
 */
function parseTicket(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return null
  const out = { uin: "", skey: "", p_skey: "", p_uin: "", raw: "" }

  if (text.includes("=") && text.includes(";")) {
    out.raw = text
    for (const part of text.split(";")) {
      const eq = part.indexOf("=")
      if (eq < 0) continue
      const k = part.slice(0, eq).trim()
      const v = part.slice(eq + 1).trim()
      if (k === "uin" || k === "p_uin") out[k] = v
      else if (k === "skey" || k === "p_skey") out[k] = v
    }
  } else if (text.includes("=")) {
    // 单个 k=v，或 k=v&k=v
    const pairs = text.split(/[&\s]+/)
    const obj = {}
    for (const p of pairs) {
      const eq = p.indexOf("=")
      if (eq > 0) obj[p.slice(0, eq).trim()] = p.slice(eq + 1).trim()
    }
    if (obj.skey || obj.p_skey || obj.uin || obj.p_uin) {
      Object.assign(out, {
        uin: obj.uin || obj.p_uin || "",
        skey: obj.skey || "",
        p_skey: obj.p_skey || obj.skey || "",
        p_uin: obj.p_uin || obj.uin || "",
      })
      out.raw = text
    } else {
      // 只有一个值：当作 skey
      out.skey = text
    }
  } else {
    out.skey = text
  }

  if (!out.skey && out.p_skey) out.skey = out.p_skey
  if (!out.uin && out.p_uin) out.uin = out.p_uin
  if (!out.skey) return null
  if (!out.raw) {
    out.raw = [out.uin && `uin=${out.uin}`, `skey=${out.skey}`].filter(Boolean).join("; ")
  }
  return out
}

/**
 * 上游能接受的 cookie 头。
 *
 * 实测（2026-10-26，lightai 网关）：
 *   - 只有 skey          → NEED_UIN_AND_SKEY
 *   - 只有 p_uin+p_skey  → NEED_UIN_AND_SKEY
 *   - uin + skey         → VERIFY_SKEY_UIN_FAILED（进入校验层，假凭据到此为止）
 *   - uin 带不带 o 前缀   → 都认
 * 所以 uin 和 skey 必须成对且真实，这里不再派生占位 uin。
 */
function cookieHeader(auth) {
  const t = auth?.ticket
  if (!t?.skey || !t?.uin) return ""
  const parts = [`uin=${t.uin}`, `skey=${t.skey}`]
  if (t.p_skey) parts.push(`p_skey=${t.p_skey}`)
  if (t.p_uin) parts.push(`p_uin=${t.p_uin}`)
  return parts.join("; ")
}

function fingerprint(auth) {
  // 账号唯一性：uin + skey 前 12 位
  const t = auth?.ticket
  const uin = t?.uin || t?.p_uin || ""
  return `${uin}:${String(t?.skey ?? "").slice(0, 12)}`
}

function baseHeaders(extra = {}) {
  return {
    accept: "text/event-stream",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    origin: CAPI_ORIGIN,
    referer: `${WEB_TERMINAL}`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ...extra,
  }
}

/**
 * magpie 文档：init.body 是 JSON 字符串，**不是 UTF-8 文本时为字节**。
 * 这里把三种形态（string / Uint8Array / ArrayBuffer / 可读流之外的对象）统一成文本。
 */
function bodyToText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (typeof body === "object") {
    // URLSearchParams 之类
    if (typeof body.toString === "function" && body.constructor?.name !== "Object") return String(body)
    try {
      return JSON.stringify(body)
    } catch {
      return ""
    }
  }
  return String(body)
}

// ── 模型解析 ───────────────────────────────────────────────────────────────
function resolveModel(requested) {
  const raw = String(requested ?? "").trim()
  const key = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1).trim() : raw
  // 空串、只有斜杠（"orcaterm/"）都回落默认模型，不能把空 model 发给上游
  if (!key) return MODEL_SPECS[0].id
  const hit = ALIAS_TO_ID.get(key.toLowerCase())
  if (hit) return hit
  // 上游新增模型时不至于 404：原样透传
  return key
}


// ── 请求体：OpenAI Chat Completions → OrcaTerm assistant ────────────────────
/**
 * OrcaTerm 的 assistant 只吃「一段用户话 + 历史消息列表」，没有 system 字段。
 * 这里把 OpenAI 的 messages 压成：
 *   - system/developer 拼接后塞进 input.content 头部（带标记，便于模型识别）
 *   - 除最后一条 user 外，其余全部进 historyMessages
 *   - assistant.tool_calls / tool 结果降级成普通文本轮次
 */
function toUpstreamBody(body, { conversationId, userId }) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const systems = []
  const turns = []

  const textOf = (content) => {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part
          if (part?.type === "text") return part.text ?? ""
          if (part?.type === "image_url") return "[图片]"
          return ""
        })
        .filter(Boolean)
        .join("\n")
    }
    return ""
  }

  for (const msg of messages) {
    const role = msg?.role ?? "user"
    if (role === "system" || role === "developer") {
      const t = textOf(msg.content).trim()
      if (t) systems.push(t)
      continue
    }
    if (role === "tool") {
      const t = textOf(msg.content).trim()
      if (t) turns.push({ role: "user", content: `[工具结果 ${msg.tool_call_id ?? ""}]\n${t}` })
      continue
    }
    if (role === "assistant") {
      const t = textOf(msg.content).trim()
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      if (t) turns.push({ role: "assistant", content: t })
      if (calls.length) {
        const desc = calls
          .map((c) => `${c?.function?.name ?? "tool"}(${c?.function?.arguments ?? ""})`)
          .join("\n")
        turns.push({ role: "assistant", content: `[调用工具]\n${desc}` })
      }
      continue
    }
    const t = textOf(msg.content)
    turns.push({ role: "user", content: t })
  }

  const lastUser = (() => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "user") return i
    return -1
  })()

  let inputText = ""
  const history = []
  if (lastUser === -1) {
    // 全是 assistant / 空：把最后一条当输入
    inputText = turns.length ? turns[turns.length - 1].content : ""
    history.push(...turns.slice(0, -1))
  } else {
    inputText = turns[lastUser].content
    history.push(...turns.slice(0, lastUser))
    // 最后一条 user 之后如果还有 assistant（罕见），当历史一起带过去
    history.push(...turns.slice(lastUser + 1))
  }

  // 工具循环 / 多轮里，把末尾 assistant 内容并入历史即可；上游 input 必须是 user
  const historyMessages = history
    .filter((t) => t.content && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content }))

  const prefix = systems.length
    ? `[系统指令，优先级高于后续对话]\n${systems.join("\n\n")}\n[系统指令结束]\n\n`
    : ""

  // 上游要求 input.content 非空：messages 为空 / content 为 null 时不能交白卷
  let content = prefix + inputText
  if (!content.trim()) {
    content = prefix
      ? `${prefix}（用户没有提供内容，请简短说明你需要什么信息）`
      : "（用户没有提供内容，请简短说明你需要什么信息）"
  }

  return {
    conversationId,
    user: {
      id: userId,
      setting: {
        model: null, // 由调用方填
        enableThinking: false,
        language: "zh",
        multimodal: false,
        // 关掉上游自带的工具/MCP，纯问答最稳
        tools: [],
        mcpServers: [],
        uiServers: [],
        approvedTools: [],
        approvedMCPTools: [],
        hideToolMessage: true,
        isNormalToolMessageIgnored: true,
      },
    },
    input: {
      id: uid("in-"),
      content,
      files: [],
      historyMessages,
    },
    stream: true,
  }
}

// ── SSE 解析：上游 data 行 → delta {content, reasoning} ─────────────────────
/**
 * 从缓冲区切出完整行。
 * SSE 规范允许 \r\n、\n、\r 三种行尾，这里统一处理，
 * 返回 [lines, rest]；rest 是还没收到换行的尾巴。
 */
function takeSseLines(buf) {
  const lines = []
  let i = 0
  let start = 0
  while (i < buf.length) {
    const ch = buf[i]
    if (ch === "\n") {
      lines.push(buf.slice(start, i))
      i += 1
      start = i
    } else if (ch === "\r") {
      lines.push(buf.slice(start, i))
      i += buf[i + 1] === "\n" ? 2 : 1
      start = i
    } else {
      i += 1
    }
  }
  return [lines, buf.slice(start)]
}

function parseSseLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith("data:")) return null
  const payload = trimmed.slice(5).trim()
  if (!payload) return null
  if (payload === "[DONE]") return { done: true }
  if (payload.startsWith("[ERROR]")) {
    return { error: payload.replace(/^\[ERROR\]:?\s*/, "") || "上游返回错误" }
  }
  if (payload.startsWith("[ABORTED]")) return { done: true }
  try {
    const obj = JSON.parse(payload)
    // 两种封装都见过：裸对象 与 {data: {...}}
    const d = obj?.data && typeof obj.data === "object" ? obj.data : obj
    const content = typeof d?.content === "string" ? d.content : ""
    const reasoning =
      typeof d?.reasoningContent === "string"
        ? d.reasoningContent
        : typeof d?.reasoning === "string"
          ? d.reasoning
          : ""
    const full =
      typeof d?.fullContent === "string" ? d.fullContent : undefined
    return { content, reasoning, full, raw: d }
  } catch {
    return null
  }
}

/**
 * 把上游 SSE 字节流转成 OpenAI chat.completion.chunk 流。
 * 上游给的是「累计全文」式增量（content 为本次新增），因此直接对外发 delta；
 * 若发现上游发的是累计值（比已发长度长且以已发内容开头），则换算成增量。
 */
function upstreamToOpenAI(upstreamBody, { model, includeUsage, requestBody }) {
  const encoder = new TextEncoder()
  const id = uid("chatcmpl-")
  const created = Math.floor(Date.now() / 1000)
  let sentContent = ""
  let sentReasoning = ""
  let emitText = 0
  let emitReason = 0
  let closed = false
  let reader = null

  // 客户端断连 / 主动取消时要能反手关掉上游，否则连接会泄漏
  const releaseUpstream = () => {
    try {
      reader?.cancel?.()
    } catch {
      /* ignore */
    }
    try {
      upstreamBody.cancel?.()
    } catch {
      /* ignore */
    }
  }

  const chunk = (delta, finish = null, extra = {}) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      ...extra,
    })}\n\n`

  const stream = new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(encoder.encode(s))
      const finishUp = (reason = "stop", { skipReasoningFallback = false } = {}) => {
        if (closed) return
        // 上游只给了思考、没给正文：收尾前把思考补成正文，避免客户端显示空白。
        // 但出错路径（skipReasoningFallback）不能补——否则错误信息会被思考文本顶掉，
        // 用户最后看到的是「我先想想」而不是「额度已用尽」。
        if (!skipReasoningFallback && emitText === 0 && sentReasoning) {
          push(chunk({ content: sentReasoning }))
          emitText = sentReasoning.length
        }
        closed = true
        push(chunk({}, reason))
        if (includeUsage) {
          push(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [],
              usage: {
                prompt_tokens: estimateTokens(requestBody),
                completion_tokens: Math.ceil((sentContent.length + sentReasoning.length) / 2),
                total_tokens:
                  estimateTokens(requestBody) + Math.ceil((sentContent.length + sentReasoning.length) / 2),
              },
            })}\n\n`,
          )
        }
        push("data: [DONE]\n\n")
        controller.close()
      }

      // 首个 chunk：给 role，客户端据此建消息
      push(chunk({ role: "assistant", content: "" }))

      reader = upstreamBody.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const [lines, rest] = takeSseLines(buf)
          buf = rest
          for (const line of lines) {
            const ev = parseSseLine(line)
            if (!ev) continue
            if (ev.done) {
              finishUp("stop")
              return
            }
            if (ev.error) {
              push(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: `\n[OrcaTerm] ${ev.error}` }, finish_reason: null }],
                })}\n\n`,
              )
              emitText += 1
              finishUp("stop", { skipReasoningFallback: true })
              return
            }

            let textDelta = ev.content ?? ""
            // 上游可能只给 fullContent（累计全文）：以它为准换算增量
            if (typeof ev.full === "string") {
              if (ev.full.startsWith(sentContent)) {
                textDelta = ev.full.slice(sentContent.length)
              } else if (ev.full.length > sentContent.length) {
                textDelta = ev.full.slice(sentContent.length)
              } else {
                textDelta = ""
              }
            } else if (
              // 兼容「累计式」content：若新内容以已发内容开头，取增量
              textDelta &&
              sentContent &&
              textDelta.startsWith(sentContent) &&
              textDelta.length > sentContent.length
            ) {
              textDelta = textDelta.slice(sentContent.length)
            }
            if (textDelta) {
              sentContent += textDelta
              emitText += textDelta.length
              push(chunk({ content: textDelta }))
            }

            let reasonDelta = ev.reasoning ?? ""
            if (
              reasonDelta &&
              sentReasoning &&
              reasonDelta.startsWith(sentReasoning) &&
              reasonDelta.length > sentReasoning.length
            ) {
              reasonDelta = reasonDelta.slice(sentReasoning.length)
            }
            if (reasonDelta) {
              sentReasoning += reasonDelta
              emitReason += reasonDelta.length
              push(chunk({ reasoning_content: reasonDelta }))
            }
          }
        }
        const [tailLines, tailRest] = takeSseLines(buf)
        const pending = tailRest.trim() ? [...tailLines, tailRest] : tailLines
        for (const line of pending) {
          const ev = parseSseLine(line)
          if (!ev || ev.done || ev.error) continue
          let d = ev.content ?? ""
          if (d && sentContent && d.startsWith(sentContent) && d.length > sentContent.length) {
            d = d.slice(sentContent.length)
          }
          if (d) {
            sentContent += d
            emitText += d.length
            push(chunk({ content: d }))
          }
          let r = ev.reasoning ?? ""
          if (r && sentReasoning && r.startsWith(sentReasoning) && r.length > sentReasoning.length) {
            r = r.slice(sentReasoning.length)
          }
          if (r) {
            sentReasoning += r
            emitReason += r.length
            push(chunk({ reasoning_content: r }))
          }
        }
        finishUp("stop")
      } catch (err) {
        if (!closed) {
          push(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: `\n[OrcaTerm] 连接中断：${err?.message ?? err}` },
                  finish_reason: "stop",
                },
              ],
            })}\n\n`,
          )
          finishUp("stop")
        }
      }
    },
    // 客户端断连（agent 放弃请求）时立刻掐掉上游，避免连接泄漏
    cancel() {
      closed = true
      releaseUpstream()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  })
}

function estimateTokens(body) {
  try {
    // 注意：要传 OpenAI 的原始 body（有 messages），不是转换后的上游 body
    const n = JSON.stringify(body?.messages ?? body ?? "").length
    return Math.max(1, Math.ceil(n / 3))
  } catch {
    return 1
  }
}

/** 非流式：把整段读完成后一次性回 chat.completion */
async function upstreamToJSON(upstreamBody, { model, upstreamReqBody, requestBody }) {
  const reader = upstreamBody.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let content = ""
  let reasoning = ""
  let upstreamError = ""
  let sawDone = false

  const absorb = (line) => {
    const ev = parseSseLine(line)
    if (!ev) return
    if (ev.done) {
      sawDone = true
      return
    }
    if (ev.error) {
      upstreamError = ev.error
      return
    }
    // 上游可能只给 fullContent（累计全文），与流式路径保持一致：以它为准
    if (typeof ev.full === "string") {
      if (ev.full.startsWith(content)) content = ev.full
      else if (ev.full.length > content.length) content = ev.full
    } else if (ev.content) {
      const d = ev.content
      if (content && d.startsWith(content) && d.length > content.length) content = d
      else content += d
    }
    if (ev.reasoning) {
      const d = ev.reasoning
      if (reasoning && d.startsWith(reasoning) && d.length > reasoning.length) reasoning = d
      else reasoning += d
    }
  }

  for (;;) {
    let chunkRead
    try {
      chunkRead = await reader.read()
    } catch (err) {
      // 客户端 abort / 网络中断：不能把异常抛给 magpie（那边会当成插件崩溃），
      // 回一个明确的错误 Response，让故障切换照常进行。
      const aborted = err?.name === "AbortError"
      const prompt_tokens = estimateTokens(requestBody ?? upstreamReqBody)
      return new Response(
        JSON.stringify({
          id: uid("chatcmpl-"),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `[OrcaTerm] ${aborted ? "客户端已取消请求" : "连接中断"}` },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens, completion_tokens: 1, total_tokens: prompt_tokens + 1 },
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      )
    }
    const { done, value } = chunkRead
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const [lines, rest] = takeSseLines(buf)
    buf = rest
    for (const line of lines) absorb(line)
    if (sawDone) {
      buf = ""
      break
    }
  }
  if (buf.trim() && !sawDone) absorb(buf)

  const prompt_tokens = estimateTokens(requestBody ?? upstreamReqBody)
  const completion_tokens = Math.max(1, Math.ceil((content.length + reasoning.length) / 2))
  // 正文为空时不能交白卷：优先用思考内容，再退到错误说明
  let finalContent = content
  if (!finalContent && reasoning) finalContent = reasoning
  if (!finalContent && upstreamError) finalContent = `[OrcaTerm] ${upstreamError}`
  if (!finalContent) finalContent = "（OrcaTerm 返回了空回复）"
  const message = { role: "assistant", content: finalContent }
  if (reasoning) message.reasoning_content = reasoning
  return new Response(
    JSON.stringify({
      id: uid("chatcmpl-"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/**
 * 错误信息里可能带完整 URL（含 csrfCode —— 它是 skey 的 djb2 派生值）。
 * 进日志 / UI 前把查询串抹掉，避免把派生凭据带出去。
 */
function redactUrl(text) {
  return String(text ?? "").replace(/https?:\/\/[^\s"'）)]+/g, (m) => {
    const q = m.indexOf("?")
    return q < 0 ? m : `${m.slice(0, q)}?…`
  })
}

function openaiError(status, message, code = "upstream_error") {
  return new Response(
    JSON.stringify({
      error: { message, type: status === 401 ? "authentication_error" : "upstream_error", code },
    }),
    { status, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

// ── 上游调用：一次 assistant/chat（流式），失败可判读 ────────────────────────
async function callAssistant({ auth, upstream, model, assistant, mode, signal, seqId }) {
  const skey = auth?.ticket?.skey
  const csrf = csrfCode(skey)
  const url = `${ASSISTANT_BASE}/chat?name=${encodeURIComponent(assistant)}&mode=${mode}&csrfCode=${csrf}`
  const body = structuredClone(upstream)
  body.user.setting.model = model

  const headers = baseHeaders({
    "x-seqid": seqId || body.input.id,
    cookie: cookieHeader(auth),
  })

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
}

/** 从上游错误响应里读出人话 + 判断是否需要重新登录 */
async function classifyUpstreamError(res) {
  let text = ""
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  let code = ""
  let message = text.slice(0, 500)
  try {
    const j = JSON.parse(text)
    code = j?.error?.name ?? j?.message ?? j?.code ?? ""
    message = j?.error?.message ?? j?.message ?? message
  } catch {
    /* 非 JSON：原样 */
  }
  const signIn =
    /NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_USER_FAILED|VERIFY_LOGIN_FAILED|NOT_LOGIN|UNAUTHORIZED|LOGIN_EXPIRED/i.test(`${code} ${message}`)
  return {
    code: String(code || `${res.status}`),
    message: String(message || `OrcaTerm answered ${res.status}`),
    signIn: signIn ? "expired" : undefined,
    status: res.status,
  }
}

/**
 * 登录时立刻校验凭据，别让用户存进一个坏的。
 *
 * 判据（2026-10 实测）：
 *   - 只有 skey / 只有 p_uin+p_skey → NEED_UIN_AND_SKEY（cookie 根本没被接受）
 *   - uin + skey 但 skey 是假的     → VERIFY_SKEY_UIN_FAILED（进了校验层）
 *   - uin + skey 且真实             → 直接开始出 SSE 帧
 * 所以「拿到非鉴权类错误」就等于凭据是有效的。
 */
async function verifyTicket(ticket, { timeoutMs = 20000 } = {}) {
  const skey = ticket?.skey
  if (!skey || !ticket?.uin) {
    return { ok: false, reason: "uin 与 skey 必须成对提供" }
  }
  const body = {
    conversationId: `cid-verify-${Date.now()}`,
    user: { id: ticket.uin, setting: { model: MODEL_SPECS[0].id } },
    input: { id: `verify-${Date.now()}`, content: "ping", files: [], historyMessages: [] },
    stream: true,
  }
  let res
  try {
    res = await fetch(
      `${ASSISTANT_BASE}/chat?name=${ASSISTANT.orcaterm}&mode=${MODE.react}&csrfCode=${csrfCode(skey)}`,
      {
        method: "POST",
        headers: baseHeaders({ "x-seqid": body.input.id, cookie: cookieHeader({ ticket }) }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
  } catch (err) {
    // 网络不通不代表凭据有问题；放行，让真正请求时再报
    return { ok: true, reason: `无法在线校验（${err?.message ?? err}），已跳过` }
  }

  const ctype = res.headers.get("content-type") ?? ""
  if (ctype.includes("event-stream")) {
    // 真的开始出帧了：凭据有效
    try {
      await res.body?.cancel?.()
    } catch {
      /* ignore */
    }
    return { ok: true, reason: "" }
  }

  let text = ""
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  // 上游错误体有两种形状：{code, message, error:{name,message}} 与 {data:{Response:{Error:{Code}}}}
  // 注意 error.name 只是 HTTP 状态文案（"Internal Server Error"），真正的错误码在 message 里
  let code = ""
  try {
    const j = JSON.parse(text)
    const parts = [
      j?.message,
      j?.error?.message,
      j?.code,
      j?.data?.Response?.Error?.Code,
      j?.data?.Response?.Error?.Message,
      j?.Response?.Error?.Code,
    ].filter((v) => v !== undefined && v !== null && String(v).trim())
    code = parts.join(" | ")
  } catch {
    code = text.slice(0, 200)
  }
  if (/NEED_UIN_AND_SKEY/i.test(code)) {
    return { ok: false, reason: "上游没接受这组 cookie（需要 uin 与 skey 同时存在）" }
  }
  if (/VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED/i.test(code)) {
    return { ok: false, reason: "skey 已过期，或与这个 uin 不匹配" }
  }
  // 其它错误（限流、风控、5xx）说明凭据本身是通的
  return { ok: true, reason: "" }
}

// ── 用量（cgi/api DescribeUserUsageStats） ────────────────────────────────
async function capiRequest(auth, action, data = {}) {
  const t = auth?.ticket ?? {}
  const seq = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const uin = t.uin || t.p_uin || ""
  const fields = { action, uin, ownerUin: uin }
  const sig = actionSignature(fields)
  const url = `${CAPI_URL}?action=${encodeURIComponent(action)}&t=${seq}`
  const res = await fetch(url, {
    method: "POST",
    headers: baseHeaders({
      accept: "application/json",
      "content-type": "application/json",
      "x-seqid": seq,
      "x-referer": WEB_TERMINAL,
      "x-csrfcode": csrfCode(t.skey),
      cookie: cookieHeader(auth),
    }),
    // 实测：上游对 data 字段严格校验，多塞 sig 会回
    // "property feature should not exist"。原样发 {action, data} 即可。
    body: JSON.stringify({ action, data }),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

// ── 插件本体 ───────────────────────────────────────────────────────────────
// 注意：magpie 会把入口模块导出的每个函数都当插件调用，
// 所以工厂不单独 export，只挂在 default.server 上（OpenCode v1 形状）。
const OrcaTermAuthPlugin = async ({ client } = {}) => {
  const log = (level, message) => {
    try {
      // magpie: client.app.log；OpenCode 同签名
      client?.app?.log?.({ body: { service: "orcaterm", level, message } })
    } catch {
      /* 没有 client 就静默 */
    }
  }

  /**
   * 每个账号自己的状态：会话 id 与临时配置。
   * 键用「登录指纹」，不用 provider —— magpie 多账号时各账号互不干扰。
   */
  const sessions = new Map()
  /**
   * 会话键 = 账号指纹 + magpie 会话 id。
   * 上游按 conversationId 存会话，若只用账号指纹，同一账号下不同对话会串上下文。
   * 顺手做个上限，反复重登时不至于无限累积。
   */
  const sessionFor = (auth, sid) => {
    const fp = `${fingerprint(auth)}:${sid || "default"}`
    let s = sessions.get(fp)
    if (!s) {
      if (sessions.size > 64) sessions.clear()
      s = { conversationId: uid("cid-"), userId: uid("u-") }
      sessions.set(fp, s)
    }
    return s
  }

  const modelsBlock = Object.fromEntries(
    MODEL_SPECS.map((spec) => [
      spec.id,
      {
        name: spec.name,
        id: spec.id,
        limit: { context: spec.context, output: spec.output },
        reasoning: spec.reasoning,
        // 上游只回文本、从不产生 tool_calls；声明 true 会让 agent 等不到工具调用而空转到步数上限
        tool_call: false,
        modalities: { input: ["text"] },
        // 走额度而非计费，cost 全 0，避免 magpie 当成付费模型参与比价
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      },
    ]),
  )

  return {
    // ── 供应商声明 ──────────────────────────────────────────────────────
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "OrcaTerm",
        npm: "@ai-sdk/openai-compatible", // chat completions：网关负责把各家协议转成它
        api: `${ASSISTANT_BASE}/chat`,
        models: modelsBlock,
      }
    },

    auth: {
      provider: PROVIDER,

      methods: [
        {
          type: "oauth",
          // 标签直接写明「已知问题」，让用户在选择前就知道该选哪条路
          label: "浏览器登录 OrcaTerm（自动 · ⚠ 已知问题，建议改用手动粘贴）",
          /**
           * 全自动登录：由 login.mjs 拉起一个浏览器实例（带独立 profile + 调试端口），
           * 用户在浏览器里微信扫码，脚本通过 CDP 的 Network.getCookies 读出
           * HttpOnly 的 uin / skey，校验后交回来。
           *
           * 为什么必须用 CDP：
           *   - uin/skey 是 HttpOnly，document.cookie 读不到；
           *   - 微信回调被服务端写死到 orcaterm.com/oauth/callback，return_url 被忽略，
           *     没法把凭据重定向到本地；
           *   - 只有调试协议能绕过 HttpOnly 限制读到 cookie。
           */
          async authorize(inputs) {
            const provider = String(inputs?.provider ?? OAUTH_PROVIDER)
            // 默认复用持久 profile 里已保存的登录态；fresh=yes 才强制重新扫码
            const fresh = inputs?.fresh === "yes"

            // 只「启动」脚本、不 await —— 必须立刻返回 url，magpie 才能开浏览器。
            // 如果在这里等登录完成（最长 300s），就会变成三方互等：
            //   authorize 等扫码 → 用户等浏览器打开 → 浏览器要等 authorize 返回 url
            // magpie 端因此一直显示「登录未完成」。
            const job = startLoginScript({
              timeoutSec: Number(inputs?.timeoutSec ?? 300),
              extraArgs: fresh ? ["--fresh"] : [],
            })

            return {
              url: loginUrl(provider),
              instructions: fresh
                ? "已打开浏览器窗口，请在这个窗口里微信扫码。登录完成后会自动继续。"
                : "已打开浏览器窗口。若上次登录仍有效会直接完成；否则请在这个窗口里微信扫码。",
              // auto：callback() 自己等结果，不需要用户再往 magpie 里粘任何东西
              method: "auto",
              // 关键：浏览器是插件自己开的（带调试端口，才能读 HttpOnly cookie）。
              // 不设这个字段，magpie 会再打开一次默认浏览器，用户很可能在
              // 那个窗口里扫码，而我们的调试窗口拿不到 cookie —— 表现为
              // 「浏览器里登录成功，magpie 无反应」。
              opened: true,
              // 仅供测试/调试取消用；magpie 忽略未知字段
              __job: job,
              async callback() {
                let res = await job.wait()
                // 宿主进程若重启过，内存句柄就没了 —— 脚本其实已经把结果落盘，
                // 这里再兜一次，避免「明明登录成功却报未完成」。
                // readLoginResult 读到即删，凭据不在磁盘上多留一份。
                if (!res.ok && job.resultFile) {
                  const fromDisk = readLoginResult(job.resultFile)
                  if (fromDisk?.ok) res = fromDisk
                }
                // 成功或失败都清掉落盘文件
                try {
                  unlinkSync(job.resultFile)
                } catch {
                  /* 已被 readLoginResult 删掉，或本来就没写 */
                }
                if (!res.ok) {
                  return {
                    type: "failed",
                    error:
                      `${res.error || "浏览器登录未完成"}\n\n` +
                      "【已知问题】自动扫码登录目前不可靠（调试端口可能起不来，或被全局代理挡住）。\n" +
                      "请改用「手动粘贴 cookie」：F12 → Application → Cookies → cloud.tencent.com，" +
                      "把 uin 与 skey 两行一起复制，粘贴成 uin=o…; skey=… 即可，一次长期有效。",
                  }
                }
                return {
                  type: "success",
                  key: res.ticket,
                  accountId: res.uin,
                  metadata: { uin: res.uin, provider },
                }
              },
            }
          },
          prompts: [
            {
              type: "select",
              key: "fresh",
              message: "登录方式",
              options: [
                { label: "复用上次登录态（免扫码）", value: "no", hint: "推荐" },
                { label: "重新扫码登录", value: "yes" },
              ],
            },
          ],
        },
        {
          type: "api",
          label: "手动粘贴 cookie（uin=…; skey=…）",
          placeholder: "uin=o1234567890; skey=AbCdEf123456...",
        },
      ],

      /**
       * 每个请求的出口。magpie 的网关已经把 agent 的协议转成 Chat Completions，
       * 我们负责：OpenAI body → OrcaTerm body → 上游 SSE → OpenAI SSE。
       */
      async loader(getAuth) {
        const auth = await getAuth()
        const ticket = parseTicket(auth?.key ?? auth?.ticket?.skey ?? auth?.access ?? "")
        // 没登录：loader 返回空对象是 OpenCode 惯例（等于「还没配」），账号显示未登录
        if (!ticket) return {}
        // 实测：上游要求 uin 与 skey 成对出现，缺一个直接 NEED_UIN_AND_SKEY。
        // 这里抛带 signIn 的错误，magpie 会把账号标成「需要重新登录」，
        // 而不是退回去打一个注定 404 的地址。
        if (!ticket.uin) {
          throw Object.assign(
            new Error("OrcaTerm 需要 uin 与 skey 成对：请在 F12 → Cookies 里把 uin 一起复制进来"),
            { signIn: "expired" },
          )
        }
        const bound = { ...auth, ticket }

        return {
          baseURL: ASSISTANT_BASE,
          apiKey: "orcaterm", // magpie 会用它填 Authorization；上游不看，但别留空

          async fetch(input, init) {
            const url = typeof input === "string" ? input : input?.url ?? String(input)
            // 接住网关与 chat.headers 加的头（文档的 4 层覆盖顺序），
            // 尤其是 chat.headers 写进来的会话 id，用来给上游分会话。
            const inHeaders = new Headers(init?.headers ?? {})
            const sessionId = inHeaders.get("x-orcaterm-session") || ""
            const session = sessionFor(bound, sessionId)
            let openaiBody
            try {
              openaiBody = JSON.parse(bodyToText(init?.body) || "{}")
            } catch {
              return openaiError(400, "请求体不是合法 JSON")
            }

            const requested = openaiBody?.model
            const model = resolveModel(requested)
            const stream = openaiBody?.stream !== false
            const includeUsage = openaiBody?.stream_options?.include_usage === true

            const upstream = toUpstreamBody(openaiBody, session)

            let res
            try {
              res = await callAssistant({
                auth: bound,
                upstream,
                model,
                assistant: ASSISTANT.orcaterm,
                mode: MODE.react,
                signal: init?.signal,
                // chat.headers 写进来的会话 id：同一段对话用同一个 seqid
                seqId: inHeaders.get("x-orcaterm-session") || undefined,
              })
            } catch (err) {
              // 中断（客户端放弃）不该被当成上游故障
              if (err?.name === "AbortError") return openaiError(499, "客户端已取消请求")
              return openaiError(502, `连不上 OrcaTerm：${redactUrl(err?.message ?? err)}`)
            }

            if (!res.ok) {
              const info = await classifyUpstreamError(res)
              // 只有确认是登录问题才回 401（magpie 默认 401 会标记账号、停止派发）；
              // 额度不足 / 风控 / 5xx 一律 502，让 magpie 走故障切换而不是误标重登。
              const status = info.signIn ? 401 : info.status >= 400 ? info.status : 502
              const e = openaiError(status, `OrcaTerm: ${info.message}`, info.code)
              if (info.signIn) e.headers.set("x-magpie-sign-in", info.signIn)
              return e
            }

            // 上游可能 200 但回的压根不是 SSE：JSON 错误、HTML 登录页、纯文本风控提示。
            // 只要 content-type 不是 event-stream，一律当错误处理 —— 否则会被 SSE 解析器
            // 静默吞掉，客户端看到一个 200 的空回答，排查起来极其难受。
            const ctype = res.headers.get("content-type") ?? ""
            const looksSSE = ctype.includes("event-stream")
            const looksHTML = ctype.includes("html") || ctype.includes("xml")
            if (!looksSSE) {
              const text = await res.text()
              let msg = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)
              let signIn
              try {
                const j = JSON.parse(text)
                msg = j?.error?.message ?? j?.message ?? msg
              } catch {
                /* HTML / 纯文本：用剥标签后的文本 */
              }
              if (/NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED/i.test(msg)) {
                signIn = "expired"
              }
              const e = openaiError(
                signIn ? 401 : 502,
                `OrcaTerm${looksHTML ? " 返回了非 SSE 响应（可能被网关/登录页拦截）" : ""}：${msg || "空响应"}`,
                "upstream_error",
              )
              if (signIn) e.headers.set("x-magpie-sign-in", signIn)
              return e
            }
            // content-type 缺失也要兜底：没有 body 就直接报错，别静默空回答
            if (!res.body) return openaiError(502, "OrcaTerm 返回了空响应")

            if (stream) return upstreamToOpenAI(res.body, { model, includeUsage, requestBody: openaiBody })
            return upstreamToJSON(res.body, { model, upstreamReqBody: upstream, requestBody: openaiBody })
          },
        }
      },

      /** magpie 自己的钩子：把 OrcaTerm 的问答额度显示在账号卡片上 */
      async usage(getAuth) {
        const auth = await getAuth()
        const ticket = parseTicket(auth?.key ?? "")
        if (!ticket) return { error: "还没登录", windows: [] }
        if (!ticket.uin) return { error: "凭据缺少 uin，请重新粘贴 uin 与 skey", windows: [] }
        const bound = { ...auth, ticket }

        // usage 抛异常会让账号卡片显示报错，这里全部兜住，最差只是「读不到额度」
        try {
          // 实测（2026-10-27）：真实额度在 DescribeUserBillingStatus 的 usageStats[]，
          // 不在 DescribeUserUsageStats（那个的 feature 只认 hunyuan_ai/session_share/secret）。
          const billing = await capiRequest(bound, "DescribeUserBillingStatus", {})
          const resp = billing?.data?.Response ?? billing?.Response
          if (resp?.Error) {
            const code = resp.Error.Code ?? ""
            if (/VERIFY_SKEY_UIN_FAILED|VERIFY_USER_FAILED|VERIFY_LOGIN_FAILED|NOT_LOGIN/i.test(code)) {
              return { error: `OrcaTerm 拒绝了登录（${code}），请重新登录`, windows: [], signIn: "expired" }
            }
            return { error: `OrcaTerm 读额度失败：${code || resp.Error.Message}`, windows: [] }
          }

          const stats = Array.isArray(resp?.usageStats) ? resp.usageStats : []
          const windows = []
          for (const st of stats) {
            const feature = st?.feature ?? ""
            // hunyuan_ai = AI 问答次数额度；其它 feature 是会话分享/密钥/空间，不是我们要的
            if (feature !== "hunyuan_ai") continue
            const limit = Number(st.quotaLimit)
            const used = Number(st.quotaUsed)
            if (!Number.isFinite(limit) || limit < 0) continue
            windows.push({
              name: "AI 问答",
              used: limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : 0,
              display: `${used} / ${limit}`,
              amount: used,
              limit,
              unit: "次",
              ...(st.quotaEndDate ? { resetsAt: toIso(st.quotaEndDate) } : {}),
              ...(st.quotaStartDate && st.quotaEndDate
                ? {
                    span: Math.max(
                      1,
                      Math.round((Date.parse(st.quotaEndDate) - Date.parse(st.quotaStartDate)) / 1000),
                    ),
                  }
                : {}),
            })
          }

          // 顺手拿一下账号名，让账号卡片显示得清楚些
          let user
          try {
            const info = await capiRequest(bound, "GetUserInfo", {})
            const ir = info?.data?.Response ?? info?.Response
            user = ir?.nickName ?? ir?.username ?? ir?.uin
          } catch {
            /* 取不到就算了 */
          }

          if (!windows.length) {
            return {
              user,
              plan: resp?.roleType ? `OrcaTerm ${resp.roleType}` : undefined,
              windows: [],
              error: "OrcaTerm 没有返回 AI 问答额度字段",
            }
          }
          return {
            user,
            plan: resp?.roleType ? `OrcaTerm ${resp.roleType}` : undefined,
            windows,
          }
        } catch (err) {
          return { error: `读取额度失败：${redactUrl(err?.message ?? err)}`, windows: [] }
        }
      },

    },

    // ── 每个账号的模型列表：上游目录会变，这里按账号实测一次 ────────────────
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        return provider.models
      },
    },

    // ── 会话头：把 magpie 的会话 id 带到 fetch，用来给上游分会话 ─────────────
    // magpie 的 input.sessionID 在同一段对话的各轮之间保持不变，
    // 用它派生 conversationId，避免同一账号下不同对话串上下文。
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER) return
      try {
        output.headers["x-orcaterm-session"] = input.sessionID || uid("s-")
      } catch {
        /* ignore */
      }
    },
  }
}

function pickNumber(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v)
  }
  return null
}

function toIso(v) {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

// ── 测试出口（magpie 只把导出的函数当插件，_internal 是对象，不会被调用） ────
export const _internal = {
  PROVIDER,
  MODEL_SPECS,
  ASSISTANT_BASE,
  CAPI_URL,
  csrfCode,
  actionSignature,
  parseTicket,
  cookieHeader,
  fingerprint,
  loginUrl,
  verifyTicket,
  OAUTH_PROVIDER,
  bodyToText,
  resolveModel,
  toUpstreamBody,
  parseSseLine,
  upstreamToOpenAI,
  openaiError,
  modelsBlockFor: () =>
    Object.fromEntries(MODEL_SPECS.map((s) => [s.id, { name: s.name, id: s.id }])),
}

export default { id: "opencode-orcaterm-auth", server: OrcaTermAuthPlugin }
