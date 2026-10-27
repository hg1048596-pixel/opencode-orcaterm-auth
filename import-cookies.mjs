#!/usr/bin/env node
/**
 * 从日常浏览器的 cookie 库直接取 OrcaTerm 凭据。
 *
 * 为什么需要这个：新版 Chrome/Edge 禁止对「默认 profile」开调试端口，
 * 且 cookie 是 v20（App-Bound）加密，普通进程解不开。
 * 所以自动化读不到日常浏览器的 cookie。
 *
 * 但有一个例外：如果浏览器把 cookie 存成了 v10（老格式），
 * 用 DPAPI 解出 key 就能直接解密 —— 不需要你扫码、也不需要翻 DevTools。
 *
 * 用法：
 *   node import-cookies.mjs            # 自动扫描本机浏览器，能解就导入
 *   node import-cookies.mjs --json     # 机器可读
 *
 * 退出码 0 且输出 ok:true 时，magpie 可直接使用返回的 ticket。
 */
import { readFileSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { createDecipheriv, createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"

const JSON_OUT = process.argv.includes("--json")
const out = (o) => {
  if (JSON_OUT) console.log(JSON.stringify(o))
  else if (o.ok) {
    console.log(`✓ 已从 ${o.source} 导入`)
    console.log(`  uin    : ${o.uin}`)
    console.log(`  ticket : ${o.ticket.replace(/skey=(\w{4})\w+/, "skey=$1…（已隐藏）")}`)
  } else {
    console.error(`✗ ${o.error}`)
  }
}

function csrfCode(skey) {
  if (!skey) return ""
  let h = 5381
  for (let i = 0; i < skey.length; i++) h = ((h << 5) + h + skey.charCodeAt(i)) | 0
  return String(h & 0x7fffffff)
}

async function verify(ticket) {
  const body = {
    conversationId: `cid-${randomUUID()}-orcaterm`,
    user: { id: ticket.uin, setting: { model: "deepseek-chat-latest" } },
    // input.id 要是网页端那个 uuid v4 的形状，否则上游回 Invalid inputId
    input: { id: randomUUID(), content: "ping", files: [], historyMessages: [] },
    stream: true,
  }
  let res
  try {
    res = await fetch(
      `https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=${csrfCode(ticket.skey)}`,
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-seqid": body.input.id,
          origin: "https://orcaterm.cloud.tencent.com",
          referer: "https://orcaterm.cloud.tencent.com/terminal",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          cookie: ticket.ticket,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    )
  } catch (e) {
    return { ok: true, note: `离线校验跳过：${e.message}` }
  }
  const ct = res.headers.get("content-type") ?? ""
  if (ct.includes("event-stream")) {
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
    code = [j?.message, j?.error?.message].filter(Boolean).join(" | ") || code
  } catch {
    /* ignore */
  }
  if (/NEED_UIN_AND_SKEY/i.test(code)) return { ok: false, reason: "上游没接受这组 cookie" }
  if (/VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED/i.test(code)) {
    return { ok: false, reason: "skey 过期或与 uin 不匹配" }
  }
  return { ok: true }
}

/** 用 DPAPI 解出 AES key（v10 用） */
function dpapiKey(root) {
  try {
    const ls = JSON.parse(readFileSync(join(root, "Local State"), "utf8"))
    const enc = ls?.os_crypt?.encrypted_key
    if (!enc) return null
    const wrapped = Buffer.from(enc, "base64")
    if (wrapped.subarray(0, 5).toString() !== "DPAPI") return null
    const tmp = mkdtempSync(join(tmpdir(), "imp-"))
    const b = join(tmp, "b.bin")
    const k = join(tmp, "k.bin")
    writeFileSync(b, wrapped.subarray(5))
    const ps = `Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes('${b.replace(/\\/g, "\\\\")}'); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes('${k.replace(/\\/g, "\\\\")}',$d)`
    execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" })
    const key = readFileSync(k)
    rmSync(tmp, { recursive: true, force: true })
    return key
  } catch {
    return null
  }
}

/** v10：AES-256-GCM，前 3 字节是版本 */
function decryptV10(buf, key) {
  const iv = buf.subarray(3, 15)
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(15, buf.length - 16)
  const dec = createDecipheriv("aes-256-gcm", key, iv)
  dec.setAuthTag(tag)
  return Buffer.concat([dec.update(data), dec.final()])
}

/**
 * 新版 Chrome/Edge 在 v10 明文前面加了 32 字节域绑定前缀 = sha256(host_key)。
 * 校验通过就把它切掉，否则原样返回。
 */
function stripDomainBinding(raw, hostKey) {
  if (raw.length > 32) {
    const expect = createHash("sha256").update(hostKey).digest()
    if (raw.subarray(0, 32).equals(expect)) return raw.subarray(32)
  }
  return raw
}

async function tryProfile(name, root) {
  const db = join(root, "Default", "Network", "Cookies")
  if (!existsSync(db)) return { ok: false, why: "无 cookie 库" }

  const tmp = mkdtempSync(join(tmpdir(), "impdb-"))
  const cp = join(tmp, "Cookies")
  try {
    copyFileSync(db, cp)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    return { ok: false, why: `库被占用（请完全退出 ${name}）：${e.code}` }
  }

  let rows
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const d = new DatabaseSync(cp, { readOnly: true })
    rows = d
      .prepare(
        "SELECT host_key,name,encrypted_value FROM cookies WHERE name IN ('uin','skey','p_uin','p_skey') AND host_key LIKE '%tencent%'",
      )
      .all()
    d.close()
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    return { ok: false, why: `读库失败：${e.message.slice(0, 80)}` }
  }
  rmSync(tmp, { recursive: true, force: true })

  if (!rows.length) return { ok: false, why: "库里没有 uin/skey（该浏览器没登录过腾讯云）" }

  const key = dpapiKey(root)
  if (!key) return { ok: false, why: "取不到解密 key" }

  const vals = {}
  let v20 = 0
  for (const r of rows) {
    const buf = Buffer.from(r.encrypted_value)
    const ver = buf.subarray(0, 3).toString()
    if (ver !== "v10") {
      v20++
      continue
    }
    try {
      vals[r.name] = stripDomainBinding(decryptV10(buf, key), r.host_key).toString("utf8")
    } catch {
      /* 单条失败不影响其它 */
    }
  }

  const uin = vals.uin || vals.p_uin
  const skey = vals.skey || vals.p_skey
  if (!uin || !skey) {
    return {
      ok: false,
      why:
        v20 > 0
          ? `cookie 是 v20（App-Bound）加密，普通进程解不开（${v20} 条）`
          : "解出的值不完整",
    }
  }
  return {
    ok: true,
    uin,
    skey,
    ticket: `uin=${uin}; skey=${skey}`,
  }
}

async function main() {
  const env = process.env
  const targets = [
    ["Chrome", join(env.LOCALAPPDATA ?? "", "Google\\Chrome\\User Data")],
    ["Edge", join(env.LOCALAPPDATA ?? "", "Microsoft\\Edge\\User Data")],
    ["Chrome", join(homedir(), "Library/Application Support/Google/Chrome")],
    ["Edge", join(homedir(), "Library/Application Support/Microsoft Edge")],
  ].filter(([, p]) => p && existsSync(p))

  if (!targets.length) {
    out({ ok: false, error: "没找到 Chrome 或 Edge 的配置目录" })
    process.exit(1)
  }

  const reasons = []
  for (const [name, root] of targets) {
    const r = await tryProfile(name, root)
    if (r.ok) {
      const v = await verify(r)
      if (!v.ok) {
        out({ ok: false, error: `${name} 的凭据无效：${v.reason}` })
        process.exit(1)
      }
      out({ ok: true, uin: r.uin, ticket: r.ticket, accountId: r.uin, source: name })
      return
    }
    reasons.push(`${name}: ${r.why}`)
  }

  out({
    ok: false,
    error:
      "无法从本机浏览器直接导入。\n  " +
      reasons.join("\n  ") +
      "\n\n替代方案：magpie plugin login orcaterm → 选第 2 项，手动粘贴 uin=…; skey=…",
  })
  process.exit(1)
}

main().catch((e) => {
  out({ ok: false, error: e?.message ?? String(e) })
  process.exit(1)
})
