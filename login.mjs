#!/usr/bin/env node
/**
 * OrcaTerm 自动登录脚本（CDP 版）
 *
 * 为什么需要 CDP：
 *   `uin` / `skey` 是 HttpOnly cookie，网页脚本读不到；
 *   日常浏览器的 cookie 库是 v20（App-Bound 加密），普通进程解不开；
 *   新版 Chrome/Edge 又禁止对「默认 profile」开调试端口。
 *   所以只能由一个我们自建的浏览器实例来提供 cookie —— 它的调试端口归我们。
 *
 * 登录态复用：
 *   默认使用**固定的持久 profile**（不是临时目录）。第一次要扫码，
 *   之后 cookie 一直在里面，再次登录时直接读取、无需扫码。
 *   用 --fresh 可以强制换新 profile（重新扫码）。
 *
 * 用法：
 *   node login.mjs                 # 持久 profile：首次扫码，之后免扫码
 *   node login.mjs --fresh         # 临时 profile，强制重新扫码
 *   node login.mjs --browser=edge  # 指定浏览器
 *   node login.mjs --timeout=300   # 扫码等待秒数
 *   node login.mjs --json          # 机器可读输出（供 magpie 插件调用）
 *   node login.mjs --show-profile  # 打印 profile 路径
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const ASSISTANT_BASE = "https://lightai.cloud.tencent.com/assistant"
const TERMINAL = "https://orcaterm.cloud.tencent.com/terminal"
const LOGIN_URL = "https://orcaterm.com/oauth/authorize?provider=wechat&source=web"
/**
 * 真正会签发 uin/skey 的是腾讯云 SSO（域 .cloud.tencent.com），
 * 不是 orcaterm.com —— 后者只发 ot_session，而 AI 接口不认它。
 * 所以扫码要落在腾讯云登录页上。
 */
const SSO_URL = "https://cloud.tencent.com/login"

// ── 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const hit = argv.find((a) => a.startsWith(`${f}=`))
  return hit ? hit.slice(f.length + 1) : d
}
const JSON_OUT = has("--json")
const HEADLESS = has("--headless")
const FRESH = has("--fresh")
const SHOW_PROFILE = has("--show-profile")
const TIMEOUT_S = Number(val("--timeout", "300"))
const WANT = (val("--browser", "") || "").toLowerCase()

const out = (obj) => {
  if (JSON_OUT) {
    console.log(JSON.stringify(obj))
  } else if (obj.ok) {
    console.log(`\n✓ 登录成功`)
    console.log(`  uin    : ${obj.uin}`)
    console.log(`  ticket : ${obj.ticket.replace(/skey=(\w{4})\w+/, "skey=$1…（已隐藏）")}`)
    console.log(`  来源    : ${obj.reused ? "复用已保存的登录态（未扫码）" : "本次扫码登录"}`)
  } else {
    console.error(`✗ ${obj.error}`)
  }
}
const die = (msg, code = 1) => {
  out({ ok: false, error: msg })
  process.exit(code)
}

// ── 持久 profile 路径 ──────────────────────────────────────────────────────
function profileDir() {
  const base =
    process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    join(homedir(), ".local", "share")
  return join(base, "orcaterm-magpie", "browser-profile")
}

// ── 浏览器发现 ─────────────────────────────────────────────────────────────
/**
 * 优先用 Edge —— 它通常是 Windows 上的默认浏览器，用户日常就在里面登录。
 * 用 --browser=chrome 可以强制换。
 */
function pickBrowser() {
  const env = process.env
  const defs = {
    edge: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/usr/bin/microsoft-edge",
    ],
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ],
  }
  const order = WANT ? [WANT] : ["edge", "chrome"]
  for (const name of order) {
    const hit = (defs[name] ?? []).find((p) => p && existsSync(p))
    if (hit) return { name, exe: hit }
  }
  return null
}

// ── CDP ────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener("message", (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  ready() {
    return new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res(this), { once: true })
      this.ws.addEventListener("error", () => rej(new Error("CDP 连接失败")), { once: true })
    })
  }
  call(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 20000)
    })
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 访问本机回环地址时绕开代理。
 *
 * magpie 设置全局代理时会把 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 写进环境变量，
 * 而 Bun（插件宿主用的运行时）的 fetch 会读这些变量 —— 连 127.0.0.1 也会被送去代理，
 * 表现为「浏览器调试端口没起来」：端口其实好好的，只是探测请求被代理挡了。
 *
 * 光删环境变量不够（Bun 可能在启动时就缓存了代理配置），
 * 所以这里用 node:net 直接发 HTTP 请求，完全绕开 fetch 的代理逻辑。
 */
function httpGetLocal(port, path, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, v) => {
      if (settled) return
      settled = true
      fn(v)
    }
    let sock
    try {
      sock = net.connect(port, "127.0.0.1", () => {
        sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
      })
    } catch (e) {
      done(reject, e)
      return
    }
    let buf = ""
    sock.on("data", (d) => {
      buf += d.toString("utf8")
      if (buf.length > 8 * 1024 * 1024) {
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
      }
    })
    sock.on("end", () => {
      const idx = buf.indexOf("\r\n\r\n")
      if (idx < 0) return done(reject, new Error("响应不完整"))
      const head = buf.slice(0, idx)
      const status = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) ?? [])[1] ?? 0)
      let body = buf.slice(idx + 4)
      // 处理 chunked
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        let out = ""
        let rest = body
        for (;;) {
          const nl = rest.indexOf("\r\n")
          if (nl < 0) break
          const size = parseInt(rest.slice(0, nl).trim(), 16)
          if (!size) break
          out += rest.slice(nl + 2, nl + 2 + size)
          rest = rest.slice(nl + 2 + size + 2)
        }
        body = out
      }
      done(resolve, { status, body })
    })
    sock.on("error", (e) => done(reject, e))
    setTimeout(() => {
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      done(reject, new Error("超时"))
    }, timeoutMs).unref?.()
  })
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await httpGetLocal(port, "/json/list", 2500)
      if (r.status === 200) {
        const list = JSON.parse(r.body)
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
        if (page) return page.webSocketDebuggerUrl
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  return null
}

// ── cookie → ticket ────────────────────────────────────────────────────────
function pickTicket(cookies) {
  const get = (n) => cookies.find((c) => c.name === n)?.value ?? ""
  const uin = get("uin") || get("p_uin")
  const skey = get("skey") || get("p_skey")
  if (!uin || !skey) return null
  const parts = [`uin=${uin}`, `skey=${skey}`]
  const pskey = get("p_skey")
  const puin = get("p_uin")
  if (pskey && pskey !== skey) parts.push(`p_skey=${pskey}`)
  if (puin && puin !== uin) parts.push(`p_uin=${puin}`)
  return { uin, skey, ticket: parts.join("; ") }
}

function csrfCode(skey) {
  if (!skey) return ""
  let h = 5381
  for (let i = 0; i < skey.length; i++) h = ((h << 5) + h + skey.charCodeAt(i)) | 0
  return String(h & 0x7fffffff)
}

async function verify(ticket) {
  const body = {
    conversationId: `cid-verify-${Date.now()}`,
    user: { id: ticket.uin, setting: { model: "deepseek-chat-latest" } },
    input: { id: `v-${Date.now()}`, content: "ping", files: [], historyMessages: [] },
    stream: true,
  }
  let res
  try {
    res = await fetch(`${ASSISTANT_BASE}/chat?name=orcaterm&mode=0&csrfCode=${csrfCode(ticket.skey)}`, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "x-seqid": body.input.id,
        origin: "https://orcaterm.cloud.tencent.com",
        referer: TERMINAL,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        cookie: ticket.ticket,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
  } catch (e) {
    return { ok: true, note: `离线校验跳过：${e.message}` }
  }
  const ctype = res.headers.get("content-type") ?? ""
  if (ctype.includes("event-stream")) {
    try {
      await res.body?.cancel?.()
    } catch {
      /* ignore */
    }
    return { ok: true }
  }
  let text = ""
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  let code = text.slice(0, 200)
  try {
    const j = JSON.parse(text)
    code = [j?.message, j?.error?.message, j?.code].filter(Boolean).join(" | ") || code
  } catch {
    /* ignore */
  }
  if (/NEED_UIN_AND_SKEY/i.test(code)) return { ok: false, reason: "上游没接受这组 cookie" }
  if (/VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED/i.test(code)) {
    return { ok: false, reason: "skey 过期或与 uin 不匹配（请重新登录）" }
  }
  return { ok: true }
}

/**
 * 从 CDP 读 cookie。
 * `Network.getCookies` 不传 urls 时会返回该浏览器上下文里**所有** cookie，
 * 比按 url 过滤更不容易漏（登录过程中会跳多个域名）。
 */
async function readTicket(cdp, { debug = false } = {}) {
  try {
    const r = await cdp.call("Network.getCookies", {})
    const cookies = r.cookies ?? []
    const t = pickTicket(cookies)
    if (t) return t
    if (debug) {
      const names = cookies
        .map((c) => c.name)
        .filter((n) => /uin|skey|session|login|token/i.test(n))
        .slice(0, 20)
      return { __debug: `共 ${cookies.length} 个 cookie，相关的：${names.join(", ") || "无"}` }
    }
    return null
  } catch {
    return null
  }
}
// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  if (SHOW_PROFILE) {
    console.log(profileDir())
    return
  }

  const browser = pickBrowser()
  if (!browser) die("没找到 Chrome 或 Edge。请安装其中之一，或用 --browser= 指定。")

  let userDir
  if (FRESH) {
    userDir = mkdtempSync(join(tmpdir(), "ot-login-"))
  } else {
    userDir = profileDir()
    try {
      mkdirSync(userDir, { recursive: true })
    } catch (err) {
      die(`无法创建 profile 目录 ${userDir}：${err?.message ?? err}`)
    }
  }

  if (!JSON_OUT) {
    console.log(`浏览器 : ${browser.name}`)
    console.log(`profile: ${userDir}${FRESH ? "（临时，本次有效）" : "（持久，下次免扫码）"}`)
  }

  const port = 49300 + Math.floor(Math.random() * 500)
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-features=Translate",
    TERMINAL,
  ]
  if (HEADLESS) args.push("--headless=new")

  if (!JSON_OUT) console.log("启动浏览器…\n")
  const proc = spawn(browser.exe, args, { stdio: "ignore", detached: false })

  let cdp = null
  try {
    const wsUrl = await waitForCdp(port, 30000)
    if (!wsUrl) {
      die(
        "浏览器调试端口没起来。常见原因：浏览器版本过旧，或被安全软件拦截。\n" +
          `可以手动验证：启动浏览器后访问 http://127.0.0.1:${port}/json/version`,
      )
    }
    cdp = await new CDP(wsUrl).ready()
    await cdp.call("Network.enable")

    // 把窗口拉到前台并最大化：
    // 否则用户很可能去用自己已经开着的浏览器扫码，
    // 而那个浏览器的 cookie 我们读不到 —— 表现为「登录成功但插件无反应」。
    try {
      await cdp.call("Page.enable")
      await cdp.call("Page.bringToFront")
      const { windowId } = await cdp.call("Browser.getWindowForTarget")
      await cdp.call("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      })
      await cdp.call("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "maximized" },
      })
    } catch {
      /* 某些环境不支持，忽略 */
    }

    // 先把浏览器送到登录页（复用模式也照做：没登录会显示登录页，已登录会直接进终端）
    try {
      await cdp.call("Page.navigate", { url: SSO_URL })
      await cdp.call("Page.bringToFront")
    } catch {
      /* ignore */
    }

    // 先立刻读一次：持久 profile 里有登录态的话，这一步就命中，不用扫码
    const first = await readTicket(cdp)
    let ticket = first && !first.__debug ? first : null
    const reused = !!ticket

    if (!ticket) {
      if (!JSON_OUT) {
        console.log("")
        console.log("  ┌─────────────────────────────────────────────────────────┐")
        console.log("  │  请在弹出的 Edge 窗口里微信扫码                          │")
        console.log("  │                                                         │")
        console.log("  │  · 这个窗口是插件专用的（独立配置，不带你的书签/扩展）   │")
        console.log("  │  · 扫完这次，cookie 会保存在这里，以后不用再扫          │")
        console.log("  │  · 请勿在你平时那个 Edge 窗口里扫码 —— 那个我们读不到    │")
        console.log("  └─────────────────────────────────────────────────────────┘")
        console.log("")
      }
      const deadline = Date.now() + TIMEOUT_S * 1000
      let lastHint = 0
      while (Date.now() < deadline) {
        const got = await readTicket(cdp, { debug: true })
        if (got && !got.__debug) {
          ticket = got
          break
        }
        if (!JSON_OUT && Date.now() - lastHint > 15000) {
          lastHint = Date.now()
          const hint = got?.__debug ?? "读取失败"
          console.log(`  …还在等扫码（${hint}）`)
        }
        await sleep(1200)
      }
    }

    if (!ticket) die(`等待 ${TIMEOUT_S}s 仍未拿到 uin+skey，请确认已完成微信扫码。`)

    if (!JSON_OUT) console.log(reused ? "已从 profile 直接读到登录态，正在校验…" : "拿到 cookie，正在校验…")
    const v = await verify(ticket)
    if (!v.ok) die(`校验失败：${v.reason}`)
    if (v.note && !JSON_OUT) console.log(`  （${v.note}）`)

    out({ ok: true, uin: ticket.uin, ticket: ticket.ticket, accountId: ticket.uin, reused })
  } finally {
    cdp?.close()
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    if (FRESH) {
      setTimeout(() => {
        try {
          rmSync(userDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }, 800)
    }
  }
}

main().catch((e) => die(e?.message ?? String(e)))
