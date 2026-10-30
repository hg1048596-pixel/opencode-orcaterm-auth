/**
 * opencode-orcaterm-auth
 *
 * OrcaTerm (Tencent Cloud's terminal; 腾讯云遨驰终端) AI reverse proxy: both an
 * OpenCode v1 plugin and a magpie provider plugin.
 *
 * Upstream protocol (reverse-engineered from orcaterm.cloud.tencent.com's
 * frontend bundle, the 2026-10 build):
 *   chat endpoint   POST {ASSISTANT_BASE}/chat?name=<assistant>&mode=<0|1|2>&csrfCode=<skey-hash>
 *                   body: {conversationId, user:{id, setting:{...}}, input:{id, type:"start",
 *                          input:<system prefix + transcript + current turn>, files:[], historyMessages:[]}, stream:true}
 *                   headers: x-seqid + cookie(uin/skey) + the browser-family headers
 *                   response: SSE, one `data: {...}` per line; the text is in content, the
 *                   thinking in reasoningContent
 *   account API     POST https://api.orcaterm.cloud.tencent.com/cgi/api for uin/skey,
 *                   or https://orcaterm.com/cgi/api for the OAuth ot_session cookie.
 *                   body: {action, data}; console cookies also require X-CsrfCode.
 *
 * The outward contract of this file follows magpie's docs exactly:
 *   config / auth{methods, loader, usage} / provider.models / chat.headers
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  OAUTH_BASE,
  createLocalCapture,
  exchangeCode,
  looksLikeAccessToken,
  readTokenClaims,
  refreshAccessToken,
  startWechatLogin,
} from "./wechat.mjs"

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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


const PROVIDER = "orcaterm"

// ---- upstream constants (the only place to change them) ---------------------
const ASSISTANT_BASE = "https://lightai.cloud.tencent.com/assistant"
const CAPI_ORIGIN = "https://orcaterm.cloud.tencent.com"
const CAPI_URL = "https://api.orcaterm.cloud.tencent.com/cgi/api"
const WEB_TERMINAL = "https://orcaterm.cloud.tencent.com/terminal"

/** OrcaTerm's built-in assistants (lighthouse/orcaterm/cvm...): which script and tool set runs */
const ASSISTANT = {
  orcaterm: "orcaterm",
  lighthouse: "lighthouse",
}
/** 0=RE_ACT 1=PLAN_ACT 2=AUTO_ACT */
const MODE = { react: 0, planact: 1, autoact: 2 }

/**
 * Upstream model ids (the frontend's bt.* constants, 2026-10 snapshot).
 *
 * `id` is what actually goes into the request body as the model; `name` is only
 * shown in the picker, so it has to match the id — earlier the marketing names
 * on the UI (DeepSeek-V4-Pro, GLM-5.2, Kimi-k2.6) were taken for model names.
 * Those were guessed from interface copy, with nothing behind them, and they
 * don't match what the server actually serves.
 *
 * The context and output caps are estimates too: upstream never publishes a
 * window size for a model.
 */
/**
 * What OrcaTerm actually serves, and what to call it.
 *
 * The desktop client's own table keeps two fields apart, and that is the trap
 * here: `newModelId` is the id sent upstream, `modelName` is the label its
 * picker shows. They are not the same string, and the ids carry a namespace — so
 * the wire id is `TokenHub/glm-5.3` or `Hunyuan3/hy3`, not `glm-5.3`. Sent bare,
 * upstream answers `LLM(glm-5.3) is not loaded`.
 *
 * `id` is what goes on the wire; `name` is what the user reads. Older ids stay in
 * `aliases` so a config written against them keeps resolving.
 *
 * `listed: false` keeps an id resolvable but out of `provider.models`: the README
 * says not to use those, because they answer on the endpoint yet cannot be
 * selected in OrcaTerm's own picker, so calling them goes around the product's
 * interface. They stay only so an existing config does not break.
 */
const MODEL_SPECS = [
  // ---- the desktop picker's nine, labelled as it labels them ---------------
  {
    id: "TokenHub/deepseek-v4-pro",
    name: "Deepseek-V4-Pro",
    reasoning: true,
    context: 128000,
    output: 32000,
    tool_call: false,
    aliases: ["Deepseek-V4-Pro", "deepseek-v4-pro", "deepseek-chat-latest", "deepseek-chat", "deepseek", "deepseek-v4"],
  },
  {
    id: "TokenHub/deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    reasoning: false,
    context: 128000,
    output: 32000,
    tool_call: false,
    aliases: ["DeepSeek-V4-Flash", "deepseek-v4-flash", "deepseek-flash"],
  },
  {
    id: "TokenHub/deepseek-v4.1-flash",
    name: "DeepSeek-V4.1-Flash",
    reasoning: false,
    context: 128000,
    output: 32000,
    tool_call: false,
    aliases: ["DeepSeek-V4.1-Flash", "deepseek-v4.1-flash"],
  },
  {
    id: "TokenHub/glm-5.3",
    name: "GLM-5.3",
    reasoning: true,
    context: 200000,
    output: 32000,
    tool_call: false,
    aliases: ["GLM-5.3", "glm-5.3", "glm"],
  },
  {
    id: "TokenHub/glm-5.3-flash",
    name: "GLM-5.3-Flash",
    reasoning: false,
    context: 200000,
    output: 32000,
    tool_call: false,
    aliases: ["GLM-5.3-Flash", "glm-5.3-flash"],
  },
  {
    id: "TokenHub/glm-5.2",
    name: "GLM-5.2",
    reasoning: false,
    context: 200000,
    output: 32000,
    tool_call: false,
    // the older glm-4.7 is the same entry under its previous id
    aliases: ["GLM-5.2", "glm-5.2", "glm-4.7", "bigmodel"],
  },
  {
    id: "TokenHub/kimi-k3",
    name: "Kimi-K3",
    reasoning: false,
    context: 256000,
    output: 32000,
    tool_call: false,
    // the picker used to label this entry "Kimi-k2.6" with id kimi-k2
    aliases: ["Kimi-K3", "kimi-k3", "kimi", "kimi-k2", "kimi-k2.6", "Kimi-k2.6", "moonshot"],
  },
  {
    id: "Hunyuan3/hy3",
    name: "Hy3",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    aliases: ["Hy3", "hy3", "hy3-preview", "Hy3-preview", "hunyuan", "hunyuan-t1", "hunyuan-3"],
  },
  {
    id: "Hunyuan3/hy4-preview",
    name: "Hy4-preview",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    aliases: ["Hy4-preview", "hy4-preview", "hy4", "hunyuan4"],
  },

  // ---- also served, and worth offering ------------------------------------
  {
    id: "glm-4.7-thinking",
    name: "GLM-5.2 Thinking",
    reasoning: true,
    context: 200000,
    output: 32000,
    tool_call: false,
    listed: false,
    aliases: ["glm-thinking", "glm-5.2-thinking", "GLM-5.2-Thinking"],
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi-k2.6 Thinking",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    listed: false,
    aliases: ["kimi-thinking", "Kimi-k2.6-Thinking"],
  },
  {
    id: "kimi-k2.5",
    name: "Kimi-k2.5",
    reasoning: false,
    context: 256000,
    output: 32000,
    tool_call: false,
    listed: false,
    aliases: ["Kimi-k2.5"],
  },
  {
    id: "kimi-k2.5-thinking",
    name: "Kimi-k2.5 Thinking",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    listed: false,
    aliases: ["Kimi-k2.5-Thinking"],
  },
  {
    id: "kimi-latest",
    name: "Kimi Latest",
    reasoning: false,
    context: 256000,
    output: 32000,
    tool_call: false,
    listed: false,
    aliases: ["Kimi-Latest"],
  },
  {
    id: "hunyuan-turbos",
    name: "Hunyuan-TurboS",
    reasoning: false,
    context: 128000,
    output: 16000,
    tool_call: false,
    listed: false,
    aliases: ["Hunyuan-TurboS", "turbos"],
  },
  {
    id: "qwen3",
    name: "Qwen3",
    reasoning: false,
    context: 128000,
    output: 32000,
    tool_call: false,
    listed: false,
    aliases: ["Qwen3", "qwen"],
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    reasoning: true,
    context: 128000,
    output: 32000,
    tool_call: false,
    listed: false,
    aliases: ["DeepSeek-Reasoner", "deepseek-r1"],
  },
]

function createPacer({ limit = 10, windowMs = 60000, useEnv = true } = {}) {
  /** When each recent chat was sent. */
  const sent = []
  /** No request may go before this time after a 429. */
  let blockedUntil = 0

  // Read at call time, not construction time: the budget is per account and the
  // operator may want to leave room for the desktop client, and the test suite
  // sends far more than ten requests in a row.
  const budget = () => {
    if (!useEnv) return limit
    const n = Number(process.env.ORCATERM_CHAT_RPM)
    return Number.isFinite(n) && n > 0 ? n : limit
  }

  const prune = (now) => {
    while (sent.length && now - sent[0] >= windowMs) sent.shift()
  }

  return {
    async wait(signal) {
      // A test suite (or a script driving the plugin) can turn the pacer off
      // wholesale: it is a courtesy to the account budget, not a correctness rule.
      if (process.env.ORCATERM_NO_PACE) return
      for (;;) {
        if (signal?.aborted) return
        const now = Date.now()
        prune(now)
        if (now < blockedUntil) {
          await sleep(Math.min(blockedUntil - now, 5000), signal)
          continue
        }
        if (sent.length < budget()) {
          sent.push(now)
          return
        }
        // the oldest must fall out of the window before another may go
        const waitFor = Math.max(50, windowMs - (now - sent[0]) + 5)
        await sleep(Math.min(waitFor, 5000), signal)
      }
    },
    /** A 429 came back: hold everything for a window rather than retry into it. */
    penalize(ms = 15000) {
      if (process.env.ORCATERM_NO_PACE) return
      blockedUntil = Math.max(blockedUntil, Date.now() + ms)
    },
    /** How long this pacer is holding requests back (for tests). */
    blockedForTest() {
      return Math.max(0, blockedUntil - Date.now())
    },
    /** How many are counted right now (for tests). */
    size() {
      prune(Date.now())
      return sent.length
    },
  }
}

/**
 * One pacer per account, not one for the whole module.
 *
 * The limit is per account upstream, so a shared instance would make one
 * account's sends — and its 429 cool-down — hold up every other account magpie
 * has signed in. Keyed by `fingerprint(auth)`, which is the same identity the
 * conversation and the account card use.
 */
const pacers = new Map()

function pacerFor(auth) {
  const key = fingerprint(auth)
  let p = pacers.get(key)
  if (!p) {
    // Bound the map the way the session map is bounded. Evict the oldest entry
    // rather than clearing: `clear()` would also drop live cool-downs, handing
    // every account a fresh budget the moment the map filled up.
    if (pacers.size >= 64) {
      const oldest = pacers.keys().next().value
      if (oldest !== undefined) pacers.delete(oldest)
    }
    p = createPacer()
    pacers.set(key, p)
  }
  return p
}

/**
 * Wait `ms`, but stop early if the caller goes away.
 *
 * The abort listener is removed when the timeout wins, so a long-lived signal
 * does not accumulate listeners across waits; and an already-aborted signal
 * resolves at once instead of waiting the full time.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener?.("abort", finish, { once: true })
  })
}

const ALIAS_TO_ID = (() => {
  const m = new Map()
  for (const spec of MODEL_SPECS) {
    m.set(spec.id.toLowerCase(), spec.id)
    for (const a of spec.aliases) m.set(a.toLowerCase(), spec.id)
  }
  return m
})()

// ---- small helpers ----------------------------------------------------------
function uid(prefix = "") {
  return prefix + randomBytes(12).toString("hex")
}

/**
 * The id the web client puts in `input.id` — a plain uuid v4, 36 characters with
 * hyphens (module 73383's `Ub` is uuid v4, bundle 2026-10).
 *
 * This has to match, not merely be unique. Upstream rejected the ids this plugin
 * used to make (`in-` + 24 hex) with `Invalid inputId`, and the bundle shows
 * nothing that registers an input before `/chat`, so upstream is reading the
 * shape of the id itself.
 */
function inputId() {
  return randomUUID()
}

/** Tencent's skey-style csrf: djb2 of the cookie's skey, & 0x7fffffff */
function csrfCode(skey) {
  if (!skey) return ""
  let h = 5381
  for (let i = 0; i < skey.length; i++) h = ((h << 5) + h + skey.charCodeAt(i)) | 0
  return String(h & 0x7fffffff)
}

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
    // a single k=v, or k=v&k=v
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
      // one value alone: treat it as the skey
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
 * The cookie header upstream accepts.
 *
 * Measured (2026-10-26, lightai gateway):
 *   - skey alone          → NEED_UIN_AND_SKEY
 *   - p_uin+p_skey alone  → NEED_UIN_AND_SKEY
 *   - uin + skey          → VERIFY_SKEY_UIN_FAILED (it reaches the verify layer;
 *                           fake credentials stop there)
 *   - uin with or without the o prefix → both accepted
 * So uin and skey must be a pair, and both real: no placeholder uin is derived
 * here any more.
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
  // Account identity: a WeChat access token carries a userId; a console session
  // is uin + the first 12 characters of skey.
  //
  // The fallback is deliberately a constant, not a slice of the token: a token
  // without a `userId` claim is replaced on every renewal, and keying on its
  // tail would hand that account a brand-new pacer — and a brand-new budget —
  // every two hours. One shared fallback key is the conservative choice.
  const bearer = bearerOf(auth)
  if (bearer) return `wechat:${readTokenClaims(bearer).userId || "unknown"}`
  const t = auth?.ticket
  const uin = t?.uin || t?.p_uin || ""
  return `${uin}:${String(t?.skey ?? "").slice(0, 12)}`
}

/**
 * The WeChat OAuth access token, when this account signed in by scanning.
 *
 * Two credentials can drive upstream and they are not interchangeable:
 *   - `uin` + `skey` — the console session cookie; full account authority.
 *   - a WeChat OAuth access token — a 1024-character JWT, two hours, renewable,
 *     confined to this product. Measured 2026-10-27: it drives /assistant/chat
 *     fine, namespaced model ids included.
 * Recognised by shape, so a pasted token works without any metadata.
 */
function bearerOf(auth) {
  const candidates = [auth?.key, auth?.access, auth?.metadata?.accessToken, auth?.ticket?.raw]
  for (const c of candidates) {
    const s = String(c ?? "").trim()
    if (looksLikeAccessToken(s)) return s
  }
  return ""
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
 * magpie's docs: init.body is a JSON string, **or bytes when it isn't UTF-8
 * text**. This folds the shapes (string / Uint8Array / ArrayBuffer / any object
 * that isn't a readable stream) into text.
 */
function bodyToText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (typeof body === "object") {
    // URLSearchParams and the like
    if (typeof body.toString === "function" && body.constructor?.name !== "Object") return String(body)
    try {
      return JSON.stringify(body)
    } catch {
      return ""
    }
  }
  return String(body)
}

// ---- model resolution -------------------------------------------------------
function resolveModel(requested) {
  const raw = String(requested ?? "").trim()
  const key = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1).trim() : raw
  // An empty string, or a bare slash ("orcaterm/"), falls back to the default
  // model: an empty model must never be sent upstream
  if (!key) return MODEL_SPECS[0].id
  const hit = ALIAS_TO_ID.get(key.toLowerCase())
  if (hit) return hit
  // so a model upstream adds later doesn't 404: pass it through as given
  return key
}


// ---- request body: OpenAI Chat Completions → OrcaTerm assistant -------------
/**
 * OrcaTerm's assistant only takes "one user message + a list of history
 * messages"; it has no system field. So OpenAI's messages are squeezed into:
 *   - system/developer joined together at the head of input.input (marked, so
 *     the model can tell them apart)
 *   - earlier turns become a transcript in input.input; historyMessages stays empty
 *   - assistant.tool_calls / tool results degrade into plain text turns
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
          if (part?.type === "image_url") return "[image]"
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
      if (t) turns.push({ role: "user", content: `[tool result ${msg.tool_call_id ?? ""}]\n${t}` })
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
        turns.push({ role: "assistant", content: `[called tool]\n${desc}` })
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
    // all assistant / empty: use the last turn as the input
    inputText = turns.length ? turns[turns.length - 1].content : ""
    history.push(...turns.slice(0, -1))
  } else {
    inputText = turns[lastUser].content
    history.push(...turns.slice(0, lastUser))
    // Only what came before the last user turn is context. An assistant turn
    // after it is the reply the caller wants continued, not something to put in
    // front of the question.
  }

  // Nothing goes up as `historyMessages`, and the conversation id can't carry the
  // thread either: magpie hands every request a fresh `sessionID`
  // (`magpie-<random>`, measured 2026-10-27 — four requests, four ids), so each
  // turn would otherwise reach upstream as a new conversation and the assistant
  // would forget everything said before it.
  //
  // What magpie does give is the whole message list every time, so the earlier
  // turns travel in the text as a transcript — the one thing a stateless gateway
  // can rely on.
  //
  // (`historyMessages` itself was tried: an entry's kind is in `type`, not
  // `role`, and with the wrong field upstream fails inside its own handler with
  // "[type] is not a function". With the right field it is accepted but the text
  // comes back echoed into the answer, so the transcript is better.)
  const historyMessages = []

  const transcript = history
    .filter((t) => (t.content ?? "").trim())
    .map((t) => (t.role === "assistant" ? `assistant: ${t.content.trim()}` : `user: ${t.content.trim()}`))
  const transcriptPrefix = transcript.length
    ? `[earlier in this conversation]\n${transcript.join("\n")}\n[end of earlier conversation]\n\n`
    : ""

  // Tool traffic has to survive too: with no history on the wire, a tool's
  // result is invisible upstream, and dropping it silently loses what the tool
  // found. It is already part of `transcript`; this keeps it visible when it
  // fell outside it.
  const toolNotes = history
    .filter((t) => (t.content ?? "").trim() && /\[(called tool|tool result)/.test(t.content))
    .map((t) => t.content.trim())
    .filter((note) => !transcriptPrefix.includes(note))
  const toolPrefix = toolNotes.length ? `${toolNotes.join("\n")}\n\n` : ""

  const prefix = systems.length
    ? `[system instructions, higher priority than the conversation]\n${systems.join("\n\n")}\n[end of system instructions]\n\n`
    : ""

  // Upstream requires input.content to be non-empty: an empty messages list or
  // a null content can't go up blank
  let content = prefix + transcriptPrefix + toolPrefix + inputText
  if (!content.trim()) {
    content = prefix
      ? `${prefix}(no content was given; ask briefly what is needed)`
      : "(no content was given; ask briefly what is needed)"
  }

  return {
    conversationId,
    user: {
      id: userId,
      setting: {
        model: null, // filled in by the caller
        enableThinking: false,
        language: "zh",
        multimodal: false,
        // Turn off upstream's own tools and MCP so this request is a plain
        // question and answer.
        //
        // Note: these fields mean "give it no tools", not "forbid it to act".
        // The assistant runs in RE_ACT mode, so upstream may still decide by
        // itself to call a built-in ability (running a command on the user's
        // server, say). That can't be confirmed from this plugin's side, so:
        //   - declare no tools and approve none;
        //   - hideToolMessage: false — if it does call one, the trace shows up
        //     in the reply where the user can see it, instead of being quietly
        //     hidden.
        tools: [],
        mcpServers: [],
        uiServers: [],
        approvedTools: [],
        approvedMCPTools: [],
        hideToolMessage: false,
        isNormalToolMessageIgnored: false,
      },
    },
    // The web client's own shape for a first turn: `type: "start"` and the text
    // in `input.input` — not `content`, and not an invented `in-…` id.
    input: {
      id: inputId(),
      type: "start",
      input: content,
      files: [],
      historyMessages,
    },
    stream: true,
  }
}

// ---- SSE parsing: upstream data lines → delta {content, reasoning} ----------
/**
 * Cut complete lines out of the buffer.
 * SSE allows \r\n, \n and \r line ends, and all three are handled here.
 * Returns [lines, rest]; rest is the tail that hasn't seen a line end yet.
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
    return { error: payload.replace(/^\[ERROR\]:?\s*/, "") || "the upstream returned an error" }
  }
  if (payload.startsWith("[ABORTED]")) return { done: true }
  try {
    const obj = JSON.parse(payload)
    // both wrappers have been seen: a bare object, and {data: {...}}
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
 * `fullContent` is the whole text so far, turned into the delta this frame
 * should send.
 *
 * Two cases:
 *   - it continues on top of what was sent (same prefix) → the difference is
 *     the delta;
 *   - it rewrote what came before (different prefix) → the difference means
 *     nothing, so send the whole thing again and let the client see the
 *     complete new text, instead of gluing two halves into garbage.
 *     The earlier implementation only did slice(sent.length), so "xyzw" after
 *     "abc" came out as "w".
 */
function fullToDelta(full, sent) {
  if (full === sent) return ""
  if (full.startsWith(sent)) return full.slice(sent.length)
  return full
}
/**
 * The trailing action envelope, cut out of an answer that already arrived.
 *
 * Upstream sometimes puts the prose first and the envelope after it, in one
 * answer: some prose followed by a ```` ```json ```` fenced
 * `{"action": "completion", "taskCompletion": "…"}`. A streaming reader sees the
 * prose go by before there is any envelope to recognise, so the envelope is
 * removed from the tail instead.
 *
 * The opening is matched leniently — `{"action"`, `{" action"`, and a fence in
 * front of it — because the assistant formats its own JSON and does not always
 * write it the same way.
 */
function stripTrailingEnvelope(text) {
  const raw = String(text ?? "")
  const opening = /\{\s*"action"\s*:/gi
  const starts = []
  let m
  while ((m = opening.exec(raw))) starts.push(m.index)
  // from the last candidate backwards: the first one whose tail parses wins
  for (let k = starts.length - 1; k >= 0; k--) {
    let idx = starts[k]
    // a fence in front of the object belongs to it, not to the prose
    const before = raw.slice(0, idx)
    const fence = before.match(/```(?:json)?\s*$/i)
    if (fence) idx = before.length - fence[0].length
    const tail = raw
      .slice(starts[k])
      .trim()
      .replace(/\s*```$/, "")
      .trim()
    try {
      const obj = JSON.parse(tail)
      if (isActionEnvelope(obj) && raw.slice(0, idx).trim()) return raw.slice(0, idx)
    } catch {
      /* not a whole object from here; try an earlier opening */
    }
  }
  return raw
}

/**
 * The answer arrives wrapped in the assistant's own action envelope, not as
 * plain prose:
 *
 *   {"action": "completion", "ph_1": "--", "taskCompletion": "…the answer…"}
 *
 * The web client parses that object (`parseJson`, module 72825) and shows
 * `taskCompletion`; it also `JSON.parse`s tool-call and review actions the same
 * way. Passed on raw, the extension or agent behind magpie shows the whole
 * object as the reply, braces and all — which is what happened before this.
 *
 * Two jobs, then:
 *   - `taskCompletion` is the answer, so that is what comes out;
 *   - every other action (`review`, tool traffic) is not prose an OpenAI client
 *     can use, and there is none of it in practice here — the request declares
 *     no tools — so the raw text is kept rather than invented into prose.
 *
 * A reply that is not an envelope at all is returned untouched: the model may
 * well answer with braces of its own.
 */
function unwrapAnswer(text) {
  const raw = String(text ?? "")
  // The assistant sometimes fences the envelope the way it fences code, so the
  // fence comes off first — `parseJson` in the web client strips ```` ```json ````
  // the same way before parsing.
  const s = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  if (!s.startsWith("{")) return raw
  let obj
  try {
    obj = JSON.parse(s)
  } catch {
    // still arriving, or the model wrote braces that don't parse: leave it be
    return raw
  }
  // Key lookup is case-insensitive, the same way `isActionEnvelope` treats the
  // verb: the assistant writes its own JSON and does not always keep the case.
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return raw
  const action = obj.action ?? obj.Action
  if (typeof action !== "string") return raw
  const completion = obj.taskCompletion ?? obj.TaskCompletion
  return typeof completion === "string" ? completion : raw
}

/** JSON string escapes, for reading the envelope's answer as it arrives. */
const JSON_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }

/**
 * How much of a plain reply is held back so an envelope appended after the
 * prose is still recognised. Big enough for `{"action": …` to appear, small
 * enough that a reply starting to stream is not visibly delayed.
 */
const ENVELOPE_TAIL = 48

/**
 * The answer inside the assistant's action envelope, for a reply that is still
 * arriving.
 *
 * Upstream does not stream bare prose. It streams the assistant's own message
 * object, character by character:
 *
 *   {"action": "completion", "ph_1": "--", "taskCompletion": "…the answer…"}
 *
 * The web client collects that text and parses it (`parseJson`, module 72825);
 * what it shows is `taskCompletion`. So a stream that has to look like prose to
 * an OpenAI client needs the envelope recognised and only its answer passed on.
 *
 * Sometimes the prose arrives first and the envelope after it (measured
 * 2026-10-27): then the prose is the answer and the envelope is bookkeeping, so
 * it is cut and nothing more is sent.
 *
 * The rule is kept deliberately simple: remember the whole reply, work out what
 * the answer *should* be so far, and send on the part of it not sent yet.
 * Plain prose falls out of the same rule — its answer is itself.
 */

/** The `"taskCompletion"` value's opening quote in `s`, or -1 while it hasn't shown up. */
function answerStart(s) {
  // The field name, matched the way the client matches it — case-insensitively —
  // and with only the small amount of whitespace the assistant actually emits.
  // It is checked only after the reply has been established to be an envelope,
  // so a reply that merely quotes the field name is never read as one.
  const m = /"taskCompletion"\s{0,8}:\s{0,8}/i.exec(s)
  if (!m) return -1
  const j = m.index + m[0].length
  if (s[j] !== '"') return -1
  return j + 1
}

/** Decode the JSON string body starting at `s`, as much of it as has arrived. */
function decodeJsonString(s) {
  let out = ""
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"') return { text: out, ended: true }
    if (ch !== "\\") {
      out += ch
      i += 1
      continue
    }
    const next = s[i + 1]
    if (next === undefined) break
    if (next === "u") {
      if (i + 6 > s.length) break
      const code = parseInt(s.slice(i + 2, i + 6), 16)
      if (Number.isFinite(code)) out += String.fromCharCode(code)
      i += 6
      continue
    }
    out += JSON_ESCAPES[next] ?? next
    i += 2
  }
  return { text: out, ended: false }
}

/** True while `s` could still turn out to be an envelope, judged on what has arrived. */
function couldBeEnvelope(s) {
  const t = s.trimStart()
  if (!t) return true
  // A ```` ```json ```` fence may wrap it, and the fence itself arrives in
  // pieces (` ```` ` then `json\n` ). While nothing but a fence has arrived the
  // reply could still be either, so hold.
  if (t[0] === "`") return FENCE_OPENING.startsWith(t.slice(0, FENCE_OPENING.length)) || t.startsWith("```")
  const unfenced = t.replace(/^```(?:json)?\s*/i, "")
  if (unfenced !== t) {
    if (!unfenced) return true
    return couldBeEnvelope(unfenced)
  }
  // The opening may still be arriving, so compare only what is there. The
  // assistant writes its own JSON, so whitespace after `{` is expected
  // (`{\n  "action": …`), and the space before `:` is optional.
  if (!t.startsWith("{")) return false
  const rest = t.slice(1).replace(/^\s+/, "")
  if (!rest) return true
  if (rest.startsWith('"')) {
    // compared lowercased, to match how `isActionEnvelope` reads the verb
    const key = rest.slice(1).replace(/^\s+/, "").toLowerCase()
    if (!key) return true
    if (key.startsWith("action")) return true
    return "action".slice(0, key.length) === key
  }
  return false
}

/** How a fenced code block may open, as far as it can be judged while arriving. */
const FENCE_OPENING = "```json\n"

/** The verbs the client's own envelope can carry (module 82025). */
const ENVELOPE_ACTIONS = new Set(["completion", "ask", "review", "start", "planner", "default"])

/**
 * Whether a parsed object is the assistant's own action envelope — the message
 * object its client wraps a reply in — and not merely a JSON object with an
 * `action` key.
 *
 * The distinction matters: a Redux action, or a reducer a user asked the
 * assistant to write out, has an `action` too, and cutting there truncated the
 * reply. So a recognised verb has to come with one of the fields the client reads
 * a reply out of, and an unrecognised verb has to carry `taskCompletion` — the
 * one field a finished answer is always in. A snippet like
 * `{"action": "SAVE", "content": "…"}` at the end of an answer is then left
 * alone, which is what the reviewer's example was about.
 */
function isActionEnvelope(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
  const action = obj.action ?? obj.Action
  if (typeof action !== "string") return false
  const hasPayload =
    typeof (obj.taskCompletion ?? obj.TaskCompletion) === "string" ||
    typeof obj.thinking === "string" ||
    typeof obj.content === "string" ||
    typeof obj.question === "string"
  if (ENVELOPE_ACTIONS.has(action.toLowerCase())) return hasPayload
  return typeof (obj.taskCompletion ?? obj.TaskCompletion) === "string"
}

/** The last position where an envelope opening starts and is followed by nothing. */
function envelopeTailAt(s) {
  const opening = /\{\s*"action"\s*:/gi
  const starts = []
  let m
  while ((m = opening.exec(s))) if (m.index > 0) starts.push(m.index)
  return starts
}

/** Where a *complete* trailing envelope begins in `s`, or -1. */
function appendedEnvelopeAt(s) {
  const starts = envelopeTailAt(s)
  for (let k = starts.length - 1; k >= 0; k--) {
    const at = starts[k]
    // nothing may follow the object: this is the tail of the reply
    const tail = s
      .slice(at)
      .trim()
      .replace(/\s*```$/, "")
      .trim()
    let obj
    try {
      obj = JSON.parse(tail)
    } catch {
      continue
    }
    if (!isActionEnvelope(obj)) continue
    // the fence in front of it belongs to the envelope too
    const before = s.slice(0, at)
    const fence = before.match(/```(?:json)?\s*$/i)
    const start = fence ? before.length - fence[0].length : at
    if (s.slice(0, start).trim()) return start
  }
  return -1
}

/**
 * Where a *still-arriving* envelope begins, or -1.
 *
 * While the object is incomplete it cannot be judged, and letting the opening go
 * out would show `{"action":` as prose. So hold from there — but only while it
 * cannot be parsed yet: as soon as it parses and is not an envelope, it is
 * ordinary text and must flow again.
 */
function appendedEnvelopePendingAt(s) {
  const starts = envelopeTailAt(s)
  // The opening can itself span more than ENVELOPE_TAIL characters (for
  // example, a pretty-printed object with a long whitespace prefix). Hold
  // a partial opening before its action key is complete as well.
  const partial = s.lastIndexOf("{")
  if (partial > 0 && !starts.includes(partial) && couldBeEnvelope(s.slice(partial))) starts.push(partial)
  if (!starts.length) return -1
  const at = starts[starts.length - 1]
  const tail = s
    .slice(at)
    .trim()
    .replace(/\s*```$/, "")
    .trim()
  try {
    JSON.parse(tail)
    return -1 // complete, and `appendedEnvelopeAt` already rejected it
  } catch {
    /* still arriving */
  }
  if (!couldBeEnvelope(tail)) return -1
  const before = s.slice(0, at)
  const fence = before.match(/```(?:json)?\s*$/i)
  const start = fence ? before.length - fence[0].length : at
  return s.slice(0, start).trim() ? start : -1
}

function createAnswerExtractor() {
  /** The whole reply as it arrives. */
  let raw = ""
  /** How many characters of the answer have already been sent. */
  let sent = 0
  /** The answer can grow no more. */
  let closed = false
  /** Nothing more will arrive: stop holding a tail back. */
  let final = false

  /**
   * What the answer should be, given everything received so far.
   *
   * A reply that starts like an envelope is ambiguous until EOF: it can also
   * be a JSON example followed by prose. Hold that candidate until its complete
   * shape is known, so decoding it never discards later text. Ordinary prose
   * and reasoning still stream as they arrive.
   */
  const answerSoFar = () => {
    if (couldBeEnvelope(raw)) {
      if (!final) return ""
      if (isEnvelope(raw)) return unwrapAnswer(raw)
      // Preserve the decoded prefix if upstream ended inside the answer string.
      // A closed string followed by prose is an example, so keep it verbatim.
      const start = answerStart(raw)
      if (start >= 0) {
        const decoded = decodeJsonString(raw.slice(start))
        if (!decoded.ended) return decoded.text
      }
      return stripTrailingEnvelope(raw)
    }
    const appended = appendedEnvelopeAt(raw)
    if (appended > 0) return raw.slice(0, appended)

    // A trailing object is still arriving and could be the envelope: hold from
    // there rather than show `{"action":` as prose. Once it parses and turns out
    // not to be one, this stops matching and the text flows again.
    if (!final) {
      const pending = appendedEnvelopePendingAt(raw)
      if (pending > 0) return raw.slice(0, pending)
    }

    // no envelope at all: the reply is its own answer
    if (final) return stripTrailingEnvelope(raw)
    return raw.slice(0, Math.max(0, raw.length - ENVELOPE_TAIL))
  }

  const emit = () => {
    const want = answerSoFar()
    if (want.length <= sent) return ""
    const out = want.slice(sent)
    sent = want.length
    return out
  }

  return {
    /** A raw delta in; returns the part of the answer to send on now. */
    push(delta) {
      if (!delta || closed) return ""
      raw += delta
      // Deliberately never closes here. A complete envelope-shaped object is
      // only "trailing" as far as what has arrived: if more text follows it, it
      // was an example inside the answer, not the envelope, and closing early
      // dropped everything after it. Cutting the *output* is enough — sending
      // stops at the object — and `finish()` is what ends the stream.
      return emit()
    },
    /** Whatever is held back when the stream ends. */
    finish() {
      if (closed) return ""
      // Nothing more is coming: judge the whole text as it stands, without
      // holding a tail back for an envelope that will never arrive.
      final = true
      const out = emit()
      closed = true
      return out
    },
  }
}

/** Whether `s` (all of it, now that nothing more will arrive) is an envelope. */
function isEnvelope(s) {
  const t = s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  if (!t.startsWith("{")) return false
  try {
    const o = JSON.parse(t)
    return isActionEnvelope(o)
  } catch {
    return false
  }
}


/**
 * Upstream error codes → the status we answer magpie with.
 *
 * Measured (2026-10-27): OrcaTerm's AI gateway reports a failure as
 * `[ERROR]: …` inside the SSE — exhausted quota, rate limiting and an
 * unavailable model alike — while the HTTP status stays 200. Handed back to the
 * client as body text, magpie would take it for a normal answer: it would not
 * fail over to the next account, nor let this account rest — so it has to
 * become an error status.
 */
const ERROR_MAP = [
  // monthly quota gone: another account is worth trying, so mark it 429 and
  // magpie moves to the next one
  { re: /quota|额度|次数已用完|余额不足|allowance|insufficient/i, status: 429, type: "rate_limit_error" },
  // rate limited: the same, but it has to wait a while
  { re: /rate.?limit|too many|频繁|限流/i, status: 429, type: "rate_limit_error" },
  // sign-in problem: mark the account as needing to sign in again
  { re: /NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED|unauthorized|登录/i, status: 401, type: "authentication_error" },
]

/** Which status to answer with, judged from upstream's error text. */
function errorStatus(text, pacer) {
  const t = String(text ?? "")
  for (const m of ERROR_MAP) {
    if (m.re.test(t)) {
      // A rate limit is the one error the plugin can act on: hold this account's
      // next requests back instead of walking straight into the same wall.
      if (m.status === 429) pacer?.penalize()
      return m
    }
  }
  // every other upstream error (model unavailable, internal error) counts as a
  // server fault, so magpie fails over
  return { status: 502, type: "upstream_error" }
}

/** At most this much of the stream head is read: enough to see whether the first frame is an answer or an error. */
const SSE_PEEK_LIMIT = 8 * 1024

/** Cancel without waiting for a peer that may keep its socket open. */
function releaseReader(reader) {
  if (!reader) return
  try {
    void reader.cancel().catch(() => {})
  } catch {
    /* already released */
  }
  try {
    reader.releaseLock()
  } catch {
    /* a pending read owns the lock until cancellation completes */
  }
}

/**
 * Read the stream head until it's clear whether this is an answer or an error —
 * following packages/codearts' peekAnswer.
 *
 * Returns { verdict, code, chunks, reader, text }:
 *   verdict is "answer" or "error"; chunks are the raw bytes already read, and
 *   they must be replayed, or the opening text is lost.
 */
async function peekAnswer(body) {
  const head = { verdict: "", code: "", chunks: [], reader: null, text: "", decoder: new TextDecoder() }
  if (!body) return head
  head.reader = body.getReader()
  let done = false
  try {
    for (;;) {
      const v = classifyHead(head.text, done)
      if (v) {
        head.verdict = v
        break
      }
      if (head.text.length >= SSE_PEEK_LIMIT) break
      const r = await head.reader.read()
      if (r.done) {
        done = true
        continue
      }
      head.chunks.push(r.value)
      head.text += head.decoder.decode(r.value, { stream: true })
    }
  } catch (err) {
    releaseReader(head.reader)
    throw err
  }
  if (head.verdict === "error") {
    // an error stream is dropped outright; cancel isn't awaited, it can hang on
    // a live stream
    releaseReader(head.reader)
  }
  return head
}

/**
 * Look for an error frame among the head bytes read so far.
 * When `done` is true and no error has shown up, the stream is a normal answer
 * (or an empty one).
 */
function classifyHead(text, done) {
  const [lines, rest] = takeSseLines(text)
  if (done && rest.trim()) lines.push(rest)
  for (const line of lines) {
    const ev = parseSseLine(line)
    if (!ev) continue
    if (ev.error) return "error"
    // text means it's an answer; no need to wait for more
    if (ev.content || ev.reasoning || typeof ev.full === "string") return "answer"
  }
  if (done) return "answer"
  return ""
}

/** Pull upstream's error text out of the stream head already read. */
function errorCodeFromHead(text) {
  const [lines, rest] = takeSseLines(text)
  if (rest.trim()) lines.push(rest)
  for (const line of lines) {
    const ev = parseSseLine(line)
    if (ev?.error) return ev.error
  }
  return "the upstream returned an error"
}

/** Splice the bytes peek read back into the stream, then read the rest. */
function replayBody(head) {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (i < head.chunks.length) {
        controller.enqueue(head.chunks[i++])
        return
      }
      try {
        const r = await head.reader.read()
        if (r.done) {
          releaseReader(head.reader)
          controller.close()
          return
        }
        controller.enqueue(r.value)
      } catch (err) {
        releaseReader(head.reader)
        controller.error(err)
      }
    },
    cancel(reason) {
      releaseReader(head.reader)
    },
  })
}

/**
 * Turn the upstream SSE byte stream into an OpenAI chat.completion.chunk stream.
 * Upstream sends increments (content is what this frame adds), so the delta goes
 * out as is; when a frame turns out to carry the cumulative value (longer than
 * what was sent and starting with it), it is converted to an increment.
 */
function upstreamToOpenAI(upstreamBody, { model, pacer }) {
  const encoder = new TextEncoder()
  const id = uid("chatcmpl-")
  const created = Math.floor(Date.now() / 1000)
  let sentContent = ""
  let sentReasoning = ""
  let emitText = 0
  let closed = false
  let reader = null
  const answer = createAnswerExtractor()

  // Upstream has to be closed when the client disconnects or cancels, or the
  // connection leaks.
  //
  // reader only: once getReader() has been called the body is locked, and
  // upstreamBody.cancel() then throws "Cannot cancel a locked ReadableStream".
  // reader.cancel() returns a promise, and it isn't awaited — it can hang on a
  // live stream.
  const releaseUpstream = () => {
    if (!reader) {
      try {
        upstreamBody?.cancel?.()?.catch?.(() => {})
      } catch {
        /* ignore */
      }
      return
    }
    releaseReader(reader)
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
        // Whatever the extractor is still holding belongs to the answer, and it
        // has to go out before the "thinking but no text" fallback decides there
        // was no text at all.
        const held = skipReasoningFallback ? "" : answer.finish()
        if (held) {
          push(chunk({ content: held }))
          emitText += held.length
        }
        // Upstream sent thinking but no text: turn the thinking into text
        // before closing, so the client doesn't show a blank answer.
        // The error path (skipReasoningFallback) must not — otherwise the error
        // text is pushed out by the thinking, and what the user finally sees is
        // "let me think" instead of "quota used up".
        if (!skipReasoningFallback && emitText === 0 && sentReasoning) {
          push(chunk({ content: sentReasoning }))
          emitText = sentReasoning.length
        }
        closed = true
        push(chunk({}, reason))
        // No usage is reported: upstream returns no token counts, and the
        // character count here is only an estimate. Reported to magpie as real
        // usage it would make both cost and context statistics wrong; better to
        // report nothing and let the client know there is no such number.
        push("data: [DONE]\n\n")
        controller.close()
      }

      // first chunk: carries the role, which is how the client builds the message
      push(chunk({ role: "assistant", content: "" }))

      reader = upstreamBody.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      // A final line without a newline follows exactly the same path as every
      // complete line, including error classification and account cool-down.
      const absorb = (line) => {
        const ev = parseSseLine(line)
        if (!ev) return
        if (ev.done) {
          finishUp("stop")
          return
        }
        if (ev.error) {
          closed = true
          const m = errorStatus(ev.error, pacer)
          controller.error(Object.assign(new Error(`OrcaTerm: ${ev.error}`), { statusCode: m.status }))
          return
        }
        const textDelta = typeof ev.full === "string" ? fullToDelta(ev.full, sentContent) : (ev.content ?? "")
        if (textDelta) {
          sentContent += textDelta
          const visible = answer.push(textDelta)
          if (visible) {
            emitText += visible.length
            push(chunk({ content: visible }))
          }
        }
        const reasonDelta = ev.reasoning ?? ""
        if (reasonDelta) {
          sentReasoning += reasonDelta
          push(chunk({ reasoning_content: reasonDelta }))
        }
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const [lines, rest] = takeSseLines(buf)
          buf = rest
          for (const line of lines) {
            absorb(line)
            if (closed) return
          }
        }
        const [tailLines, tailRest] = takeSseLines(buf)
        const pending = tailRest.trim() ? [...tailLines, tailRest] : tailLines
        for (const line of pending) {
          absorb(line)
          if (closed) return
        }
        finishUp("stop")
      } catch (err) {
        // Interrupted while reading (abort / connection reset): this stream has
        // to end with an error. Earlier a "connection lost" text was sent here
        // and the stream stopped normally, so the client took it for an answer
        // and magpie didn't fail over.
        if (!closed) {
          closed = true
          controller.error(
            Object.assign(new Error(`OrcaTerm connection broke: ${err?.message ?? err}`), {
              statusCode: err?.name === "AbortError" ? 499 : 502,
            }),
          )
        }
      } finally {
        releaseUpstream()
      }
    },
    // cut upstream off the moment the client disconnects (the agent gave up),
    // so the connection doesn't leak
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

async function upstreamToJSON(upstreamBody, { model, pacer }) {
  const reader = upstreamBody.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let content = ""
  let reasoning = ""
  let upstreamError = ""
  let sawDone = false

  const absorb = (line) => {
    if (sawDone || upstreamError) return
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
    // same rule as the streaming path: content is an increment, only fullContent
    // needs converting
    if (typeof ev.full === "string") {
      const d = fullToDelta(ev.full, content)
      content += d
    } else if (ev.content) {
      content += ev.content
    }
    if (ev.reasoning) {
      reasoning += ev.reasoning
    }
  }

  try {
    for (;;) {
      let chunkRead
      try {
        chunkRead = await reader.read()
      } catch (err) {
        // Client abort / connection lost: answer with a real error status; it
        // must not be dressed up as an answer. Earlier this returned 200 plus a
        // "connection lost" text, magpie took it as success, and failover stopped.
        const aborted = err?.name === "AbortError"
        return openaiError(aborted ? 499 : 502, `OrcaTerm connection broke: ${err?.message ?? err}`)
      }
      const { done, value } = chunkRead
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const [lines, rest] = takeSseLines(buf)
      buf = rest
      for (const line of lines) absorb(line)
      if (sawDone || upstreamError) {
        buf = ""
        break
      }
    }
  } finally {
    releaseReader(reader)
  }
  if (buf.trim() && !sawDone) absorb(buf)

  // upstream ended with an error (quota, rate limit, sign-in) → answer with the
  // real error status
  if (upstreamError) {
    const m = errorStatus(upstreamError, pacer)
    // the upstream's own code is the useful thing here, not our error class:
    // pass the class as `type` and leave `code` to say what the upstream said.
    return openaiError(m.status, `OrcaTerm: ${upstreamError}`, upstreamError, m.type)
  }

  // The text is the assistant's action envelope, not plain prose: it is decoded
  // by the same extractor the streaming path uses, so the two can't drift apart.
  const extractor = createAnswerExtractor()
  const visible = extractor.push(content) + extractor.finish()
  // An empty text can't go up blank: the thinking is used first, then a note
  let finalContent = visible.trimEnd()
  if (!finalContent && reasoning) finalContent = reasoning
  if (!finalContent) finalContent = "(OrcaTerm returned an empty reply)"
  const message = { role: "assistant", content: finalContent }
  if (reasoning) message.reasoning_content = reasoning
  return new Response(
    JSON.stringify({
      id: uid("chatcmpl-"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/**
 * An error message can carry a full URL (with csrfCode — a djb2 derived from the
 * skey). The query string is wiped before anything reaches a log or the UI, so
 * the derived credential doesn't leak out.
 */
function redactUrl(text) {
  return String(text ?? "").replace(/https?:\/\/[^\s"'）)]+/g, (m) => {
    const q = m.indexOf("?")
    return q < 0 ? m : `${m.slice(0, q)}?…`
  })
}

/**
 * An OpenAI-shaped error response.
 * `code` is upstream's own error code or classification; `type` is OpenAI's
 * error category, honoured when it is passed (errorStatus gives a more accurate
 * one than the status code alone).
 */
function openaiError(status, message, code = "upstream_error", type) {
  const kind = type ?? (status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "upstream_error")
  return new Response(JSON.stringify({ error: { message, type: kind, code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

// ---- upstream call: one assistant/chat (streaming), failures readable -------
async function callAssistant({ auth, upstream, model, assistant, mode, signal }) {
  const bearer = bearerOf(auth)
  const skey = auth?.ticket?.skey
  // A Bearer token needs no csrfCode — that is derived from a skey this kind of
  // account does not have.
  const csrf = bearer ? "" : csrfCode(skey)
  const url = `${ASSISTANT_BASE}/chat?name=${encodeURIComponent(assistant)}&mode=${mode}${csrf ? `&csrfCode=${csrf}` : ""}`
  const body = structuredClone(upstream)
  body.user.setting.model = model

  const headers = baseHeaders({
    // x-seqid is this request's id, not the conversation's: the web page makes a
    // new one for every send, and reusing a fixed value could make upstream take
    // several requests for one.
    "x-seqid": body.input.id,
    ...(bearer
      ? { authorization: `Bearer ${bearer}`, "x-product": "orcaterm" }
      : { cookie: cookieHeader(auth) }),
  })

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
}

/** Read human-readable text out of an upstream error response + decide whether a new sign-in is needed */
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
    /* not JSON: as is */
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
 * Check the credential right at sign-in, so the user doesn't store a broken one.
 *
 * The evidence (measured 2026-10):
 *   - skey alone / p_uin+p_skey alone → NEED_UIN_AND_SKEY (the cookie was never
 *     accepted at all)
 *   - uin + skey but a fake skey      → VERIFY_SKEY_UIN_FAILED (it got into the
 *     verify layer)
 *   - uin + skey and real             → SSE frames start coming right away
 * So "a non-auth error came back" means the credential is valid.
 */
async function capiRequest(auth, action, data = {}) {
  const bearer = bearerOf(auth)
  const t = auth?.ticket ?? {}
  const seq = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  // OrcaTerm's AuthStore.syncCookie writes this access token as ot_session.
  // Its product API reads that cookie; an Authorization header is not enough.
  const url = `${bearer ? `${OAUTH_BASE}/cgi/api` : CAPI_URL}?action=${encodeURIComponent(action)}&t=${seq}`
  const res = await fetch(url, {
    method: "POST",
    headers: baseHeaders({
      accept: "application/json",
      "content-type": "application/json",
      "x-seqid": seq,
      ...(bearer ? {
        origin: OAUTH_BASE,
        referer: `${OAUTH_BASE}/terminal`,
        "x-referer": `${OAUTH_BASE}/terminal`,
        cookie: `ot_session=${bearer}`,
      } : {
        "x-referer": WEB_TERMINAL,
        "x-csrfcode": csrfCode(t.skey),
        cookie: cookieHeader(auth),
      }),
    }),
    // Measured: upstream validates the data field strictly, and an extra sig
    // comes back as "property feature should not exist". Sending {action, data}
    // as it is works.
    body: JSON.stringify({ action, data }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

// ---- the plugin itself ------------------------------------------------------
// The named OrcaTermAuthPlugin export is the plugin entry; _internal below is an
// object for tests, so magpie does not call it as a second plugin.
export const OrcaTermAuthPlugin = async ({ client } = {}) => {
  const log = (level, message) => {
    try {
      // magpie: client.app.log; OpenCode has the same signature
      client?.app?.log?.({ body: { service: "orcaterm", level, message } })
    } catch {
      /* no client: stay quiet */
    }
  }

  /**
   * Each account's own state: conversation ids and temporary settings.
   * Keyed by the sign-in fingerprint rather than the provider — with several
   * accounts on magpie, none of them gets in another's way.
   */
  const sessions = new Map()
  /**
   * Session key = account fingerprint + magpie session id.
   * Upstream keeps conversations by conversationId, so with the account
   * fingerprint alone, different chats on one account would share context.
   * There is a cap as well, so signing in over and over doesn't pile up without
   * limit.
   *
   * The conversation id is built the way the web client builds it
   * (`generateConversationId`, module 72535): `cid-<uuid>` plus `-<assistant>`
   * for any assistant that isn't lighthouse, plus `-<mode>` for any mode that
   * isn't RE_ACT. This plugin always asks as orcaterm in RE_ACT, so no mode
   * suffix.
   */
  const sessionFor = (auth, sid) => {
    const fp = `${fingerprint(auth)}:${sid || "default"}`
    let s = sessions.get(fp)
    if (!s) {
      if (sessions.size > 64) sessions.clear()
      s = {
        conversationId: `cid-${randomUUID()}-${ASSISTANT.orcaterm}`,
        userId: uid("u-"),
      }
      sessions.set(fp, s)
    }
    return s
  }

  /**
   * There is deliberately no `POST /conversation` here.
   *
   * The web client registers a conversation once and lets upstream keep the
   * thread. This plugin cannot do the same: magpie hands every request a fresh
   * session id, so `sessionFor` mints a new conversation id per request, and
   * registering each one filled the user's OrcaTerm history with an entry per
   * request — visible to them, and pointless, because the id is never reused.
   *
   * Context comes from the transcript in `input.input` instead (see
   * `toUpstreamBody`), and upstream answers without a registered conversation:
   * measured 2026-10-27, a chat with no `/conversation` call returns a normal
   * answer, and a two-turn exchange still carries the name from turn 1 through
   * the transcript.
   */

  const modelsBlock = Object.fromEntries(
    MODEL_SPECS.filter((spec) => spec.listed !== false).map((spec) => [
      spec.id,
      {
        name: spec.name,
        id: spec.id,
        limit: { context: spec.context, output: spec.output },
        reasoning: spec.reasoning,
        // Upstream answers with text only and never produces tool_calls;
        // declaring true would leave the agent waiting for a call it never gets
        // and spinning up to its step cap
        tool_call: false,
        modalities: { input: ["text"] },
        // metered by quota, not billed, so cost is all 0 — magpie then doesn't
        // price it as a paid model
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      },
    ]),
  )

  return {
    // ---- provider declaration -----------------------------------------------
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "OrcaTerm",
        npm: "@ai-sdk/openai-compatible", // chat completions: the gateway converts each vendor's protocol into it
        api: `${ASSISTANT_BASE}/chat`,
        models: modelsBlock,
      }
    },

    auth: {
      provider: PROVIDER,
      // Also declared on the hook, not only in package.json: siblings that get
      // this right (codearts, zcode) do both, and this is what the README's
      // "maxConcurrency is 1" describes. OrcaTerm's budget is per account and
      // shared with its own desktop client, so one in flight.
      maxConcurrency: 1,

      methods: [
        {
          type: "oauth",
          label: "WeChat QR sign-in (recommended: smallest credential, renewed every two hours)",
          /**
           * OrcaTerm's own WeChat OAuth, rather than the console session cookie.
           *
           * A one-off page is served locally (default http://127.0.0.1:4080/login)
           * and embeds WeChat's qrconnect widget with `self_redirect: true`, so
           * the return lands in the widget's own iframe and OrcaTerm's bridge page
           * can postMessage the code back to our page. The user only scans; no
           * URL has to be copied, which also closes the window where another tab
           * could consume the state first.
           *
           * Behind a remote deploy the page listens on the server's loopback and
           * the browser cannot reach it: `ssh -L 4080:127.0.0.1:4080 <server>`,
           * then open the address. ORCATERM_CAPTURE_PORT / _HOST / _BASE override it.
           */
          async authorize() {
            let started
            try {
              started = await startWechatLogin()
            } catch (err) {
              return {
                type: "failed",
                error: `Could not read the WeChat sign-in configuration: ${err?.message ?? err}. You can paste the cookie pair instead.`,
              }
            }

            const cap = createLocalCapture({
              appid: started.appid,
              redirectUri: started.redirectUri,
              state: started.state,
            })
            // `ready` rejects on a bind error, so a failure here becomes a failed
            // sign-in with a reason instead of a hang.
            let pageUrl
            try {
              pageUrl = await cap.ready
            } catch (err) {
              cap.close()
              return {
                type: "failed",
                error: `Could not start the local sign-in page (${err?.code ?? err?.message ?? err}). You can paste the cookie pair instead.`,
              }
            }

            return {
              url: pageUrl,
              instructions:
                "Scan the QR code in the page that opens; it carries on by itself, nothing to copy.\n" +
                "(If the page did not open, visit it yourself; behind a remote install, ssh -L 4080:127.0.0.1:4080 first)",
              method: "auto",
              // No `opened: true` here on purpose: that field means "the plugin
              // already opened a browser", and nothing has opened this page yet —
              // setting it would stop magpie from opening it and leave the user
              // with nothing on screen.
              // Test/debug only: close the local page before a scan happens.
              // magpie ignores unknown fields.
              __cap: cap,
              async callback() {
                try {
                  const { code, state } = await cap.wait
                  const r = await exchangeCode({ code, state })
                  // magpie writes the credential only when a `refresh` is present
                  // (host `save()`); with just a `key` it is stored as type "api"
                  // and never renewed.
                  return {
                    type: "success",
                    access: r.accessToken,
                    refresh: r.accessToken,
                    expires: r.expiresAt ?? Date.now() + 7200 * 1000,
                    userId: r.userId,
                    metadata: {
                      via: "wechat-qr",
                      userId: r.userId,
                      nickname: r.nickname,
                      avatar: r.avatar,
                      expires: r.expiresAt ?? undefined,
                    },
                  }
                } catch (err) {
                  return {
                    type: "failed",
                    error: `${err?.message ?? err}\n\nYou can paste the cookie pair instead.`,
                  }
                } finally {
                  cap.close()
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录 OrcaTerm（拉起本机浏览器 · ⚠ 已知问题，建议用上面的扫码）",
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
          label: "Paste the OrcaTerm cookie pair (uin=…; skey=…)",
          placeholder: "uin=o1234567890; skey=AbCdEf123456...",
        },
      ],

      /**
       * Renewal. A WeChat access token lives two hours; `OAuthRefreshToken` trades
       * it for a fresh one of the same length, so a normal session never sees an
       * expiry.
       *
       * A console cookie has nothing to renew — it lasts until the user signs out
       * of the console.
       */
      async refresh(auth) {
        const bearer = bearerOf(auth)
        if (!bearer) return null
        try {
          const r = await refreshAccessToken(bearer)
          return {
            key: r.accessToken,
            access: r.accessToken,
            refresh: r.accessToken,
            expires: r.expiresAt ?? undefined,
            metadata: { ...(auth?.metadata ?? {}), via: "wechat-qr", expires: r.expiresAt ?? undefined },
          }
        } catch (err) {
          if (/expired|invalid|失效|过期/i.test(String(err?.message ?? ""))) {
            throw Object.assign(new Error(`OrcaTerm sign-in expired, scan again: ${err?.message ?? err}`), {
              signIn: "expired",
            })
          }
          return null
        }
      },

      /**
       * The exit for every request. magpie's gateway has already turned the
       * agent's protocol into Chat Completions; what's left here is:
       * OpenAI body → OrcaTerm body → upstream SSE → OpenAI SSE.
       */
      async loader(getAuth) {
        const auth = await getAuth()
        // Two ways to be signed in, decided by the shape of the stored key: a
        // WeChat access token (JWT) becomes a Bearer credential, anything else is
        // taken as the console cookie pair.
        const bearer = bearerOf(auth)
        let bound
        if (bearer) {
          const claims = readTokenClaims(bearer)
          if (claims.exp && claims.exp * 1000 < Date.now()) {
            throw Object.assign(new Error("OrcaTerm sign-in expired, scan again"), { signIn: "expired" })
          }
          bound = { ...auth, bearer, ticket: null }
        } else {
          const ticket = parseTicket(auth?.key ?? auth?.ticket?.skey ?? auth?.access ?? "")
          // Not signed in: an empty object from the loader is the OpenCode
          // convention (it means "not configured yet"), and the account shows as
          // signed out
          if (!ticket) return {}
          // Measured: upstream wants uin and skey as a pair, and either one
          // missing is a flat NEED_UIN_AND_SKEY. Throwing an error with signIn set
          // makes magpie mark the account "needs a new sign-in", instead of
          // falling back to an address that is bound to 404.
          if (!ticket.uin) {
            throw Object.assign(
              new Error("OrcaTerm needs uin and skey together: copy uin alongside skey from F12 → Cookies"),
              { signIn: "expired" },
            )
          }
          bound = { ...auth, ticket }
        }

        return {
          baseURL: ASSISTANT_BASE,
          apiKey: "orcaterm", // magpie fills Authorization with it; upstream doesn't look, but don't leave it empty

          async fetch(input, init) {
            const url = typeof input === "string" ? input : input?.url ?? String(input)
            // Take the headers the gateway and chat.headers added (the docs'
            // 4-layer override order), especially the session id chat.headers
            // writes, which is what splits conversations upstream.
            const inHeaders = new Headers(init?.headers ?? {})
            const sessionId = inHeaders.get("x-orcaterm-session") || ""
            const session = sessionFor(bound, sessionId)
            let openaiBody
            try {
              openaiBody = JSON.parse(bodyToText(init?.body) || "{}")
            } catch {
              return openaiError(400, "The request body is not valid JSON")
            }

            const requested = openaiBody?.model
            const model = resolveModel(requested)
            const stream = openaiBody?.stream !== false

            const upstream = toUpstreamBody(openaiBody, session)

            // One pacer per account: the limit is per account upstream, and a
            // shared one would let one account's cool-down stall the others.
            const pacer = pacerFor(bound)

            // Upstream allows about ten chats a minute per account and answers a
            // burst with HTTP 200 + `{"code":429,…}` — not an SSE error. Other
            // clients on the same account are invisible from here, so this paces
            // itself and leaves the rest of the budget alone.
            await pacer.wait(init?.signal)

            let res
            try {
              if (init?.signal?.aborted) return openaiError(499, "the client cancelled the request")
              res = await callAssistant({
                auth: bound,
                upstream,
                model,
                assistant: ASSISTANT.orcaterm,
                mode: MODE.react,
                signal: init?.signal,
              })
              if (!res.ok) {
                const info = await classifyUpstreamError(res)
                // A limit reported by the status line rather than inside the body
                // has to cool this account's pacer down as well, or the next
                // request walks straight back into it.
                if (info.status === 429 || res.status === 429) pacer.penalize()
                // Only a confirmed sign-in problem answers 401 (magpie marks the
                // account and stops dispatching on a 401 by default); quota gone /
                // risk control / 5xx all answer 502, so magpie fails over instead
                // of mistaking it for a new sign-in.
                const status = info.signIn ? 401 : info.status >= 400 ? info.status : 502
                const e = openaiError(status, `OrcaTerm: ${info.message}`, info.code)
                if (info.signIn) e.headers.set("x-magpie-sign-in", info.signIn)
                return e
              }

              // Upstream can answer 200 with something that isn't SSE at all: a
              // JSON error, an HTML sign-in page, a plain-text risk-control
              // notice. Anything whose content-type isn't event-stream is treated
              // as an error — otherwise the SSE parser swallows it silently and
              // the client sees an empty 200 answer, which is painful to diagnose.
              const ctype = res.headers.get("content-type") ?? ""
              const looksSSE = ctype.includes("event-stream")
              const looksHTML = ctype.includes("html") || ctype.includes("xml")
              if (!looksSSE) {
                const text = await res.text()
                let msg = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)
                let json = null
                try {
                  json = JSON.parse(text)
                  msg = json?.error?.message ?? json?.message ?? msg
                } catch {
                  /* HTML / plain text: use the tag-stripped text */
                }
                // Classify by the upstream's own words — including the JSON body it
                // sends for a rate limit, `{"code":429,"message":"Rate limit
                // exceeded: chat-rpm"}`. Answering 502 for that made magpie treat a
                // limit as a server fault: no account switch, and the pacer never
                // cooled down, so the next request walked into the same wall.
                const m = Number(json?.code) === 429
                  ? errorStatus("rate limit", pacer)
                  : errorStatus(`${json?.code ?? ""} ${msg} ${text}`, pacer)
                const signIn = /NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED/i.test(msg)
                  ? "expired"
                  : undefined
                const status = signIn ? 401 : m.status
                const e = openaiError(
                  status,
                  `OrcaTerm${looksHTML ? " returned a non-SSE response (a gateway or sign-in page may have intercepted it)" : ""}: ${msg || "empty response"}`,
                  json?.code ?? "upstream_error",
                  signIn ? undefined : m.type,
                )
                if (signIn) e.headers.set("x-magpie-sign-in", signIn)
                return e
              }
              // a missing content-type needs its fallback too: no body is a
              // straight error, not a silent empty answer
              if (!res.body) return openaiError(502, "OrcaTerm returned an empty response")

              // Upstream reports a failure as `data: [ERROR]: …` while the HTTP
              // status stays 200. The head is read first to tell an answer from an
              // error: quota gone has to be 429 so magpie switches accounts, and a
              // dead sign-in has to be 401 to mark the account — otherwise the
              // failure is taken for a normal answer.
              const head = await peekAnswer(res.body)
              if (head.verdict === "error") {
                const code = errorCodeFromHead(head.text)
                const m = errorStatus(code, pacer)
                const e = openaiError(m.status, `OrcaTerm: ${code}`, code, m.type)
                if (m.status === 401) e.headers.set("x-magpie-sign-in", "expired")
                return e
              }

              // The stream head has already been read; splice it back in before
              // handing the stream to the converters, or the opening text is lost
              const body = replayBody(head)

              if (stream) return upstreamToOpenAI(body, { model, pacer })
              return await upstreamToJSON(body, { model, pacer })
            } catch (err) {
              if (err?.name === "AbortError" || init?.signal?.aborted) {
                return openaiError(499, "the client cancelled the request")
              }
              return openaiError(502, `cannot read OrcaTerm response: ${redactUrl(err?.message ?? err)}`)
            }
          },
        }
      },

      /** magpie's own hook: show OrcaTerm's Q&A quota on the account card */
      async usage(getAuth) {
        const auth = await getAuth()
        const bearer = bearerOf(auth)
        let bound = auth
        if (!bearer) {
          const ticket = parseTicket(auth?.key ?? "")
          if (!ticket) return { error: "not signed in", windows: [] }
          if (!ticket.uin) return { error: "the credential is missing uin; paste uin and skey again", windows: [] }
          bound = { ...auth, ticket }
        }

        // A throw in usage puts an error on the account card, so everything is
        // caught here; the worst case is just "can't read the quota"
        try {
          // Measured (2026-10-27): the real quota is in DescribeUserBillingStatus'
          // usageStats[], not in DescribeUserUsageStats (whose feature only knows
          // hunyuan_ai/session_share/secret).
          const billing = await capiRequest(bound, "DescribeUserBillingStatus", {})
          const resp = billing?.data?.Response ?? billing?.Response
          if (resp?.Error) {
            const code = resp.Error.Code ?? ""
            if (/VERIFY_SKEY_UIN_FAILED|VERIFY_USER_FAILED|VERIFY_LOGIN_FAILED|NOT_LOGIN/i.test(code)) {
              return { error: `OrcaTerm refused the sign-in (${code}); sign in again`, windows: [], signIn: "expired" }
            }
            return { error: `OrcaTerm could not read the allowance: ${code || resp.Error.Message}`, windows: [] }
          }

          const stats = Array.isArray(resp?.usageStats) ? resp.usageStats : []
          const windows = []
          for (const st of stats) {
            const feature = st?.feature ?? ""
            // hunyuan_ai = the AI Q&A turn quota; the other features are session
            // sharing / keys / storage, which aren't what we want
            if (feature !== "hunyuan_ai") continue
            const limit = Number(st.quotaLimit)
            const used = Number(st.quotaUsed)
            if (!Number.isFinite(limit) || limit < 0) continue
            windows.push({
              name: "AI Q&A",
              used: limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : 0,
              display: `${used} / ${limit}`,
              amount: used,
              limit,
              unit: "questions",
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

          // also pick up the account name, so the account card reads clearly
          let user = bearer ? readTokenClaims(bearer).nickname || undefined : undefined
          try {
            const info = await capiRequest(bound, "GetUserInfo", {})
            const ir = info?.data?.Response ?? info?.Response
            user = ir?.nickName ?? ir?.username ?? ir?.uin ?? user
          } catch {
            /* fine if it can't be read */
          }

          if (!windows.length) {
            return {
              user,
              plan: resp?.roleType ? `OrcaTerm ${resp.roleType}` : undefined,
              windows: [],
              error: "OrcaTerm returned no AI question allowance field",
            }
          }
          return {
            user,
            plan: resp?.roleType ? `OrcaTerm ${resp.roleType}` : undefined,
            windows,
          }
        } catch (err) {
          return { error: `could not read the allowance: ${redactUrl(err?.message ?? err)}`, windows: [] }
        }
      },

    },

    // ---- conversation header: carry magpie's session id to fetch, to split
    // conversations upstream ---------------------------------------------------
    // magpie's input.sessionID stays the same across the turns of one
    // conversation, so conversationId is derived from it: different chats on one
    // account don't share context.
    //
    // When magpie passes no session id — it does not for every caller — the
    // fallback has to be steady too: a fresh id per request opened a new
    // conversation upstream every turn and the thread was lost, while the same
    // turns went through when the plugin was driven directly.
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER) return
      try {
        output.headers["x-orcaterm-session"] = input.sessionID || "default"
      } catch {
        /* ignore */
      }
    },
  }
}

function toIso(v) {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

// ---- test exit (magpie calls only exported functions as plugins; _internal is
// an object, never called) ----------------------------------------------------
// Everything the tests reach for, as the other packages do: nothing here is
// part of the provider contract.
export const _internal = {
  PROVIDER,
  MODEL_SPECS,
  ALIAS_TO_ID,
  ASSISTANT,
  ASSISTANT_BASE,
  CAPI_URL,
  WEB_TERMINAL,
  uid,
  inputId,
  createPacer,
  pacerFor,
  createLocalCapture,
  isEnvelope,
  isActionEnvelope,
  appendedEnvelopeAt,
  unwrapAnswer,
  stripTrailingEnvelope,
  createAnswerExtractor,
  csrfCode,
  parseTicket,
  cookieHeader,
  fingerprint,
  baseHeaders,
  bodyToText,
  resolveModel,
  toUpstreamBody,
  takeSseLines,
  parseSseLine,
  fullToDelta,
  errorStatus,
  peekAnswer,
  classifyHead,
  errorCodeFromHead,
  replayBody,
  upstreamToOpenAI,
  upstreamToJSON,
  redactUrl,
  openaiError,
  callAssistant,
  classifyUpstreamError,
  capiRequest,
  toIso,
}



// Personal npm package also supports the OpenCode v1 server entry.
export default { id: "opencode-orcaterm-auth", server: OrcaTermAuthPlugin }
