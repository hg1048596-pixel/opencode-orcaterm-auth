# opencode-orcaterm-auth

> ## ⚠️ 已知问题：自动扫码登录尚未修好
>
> **`magpie plugin login orcaterm` → 选「浏览器登录（自动）」目前可能失败**，
> 界面上会显示「浏览器调试端口没起来」或「登录未完成」。
>
> **请直接用「手动粘贴 cookie」那条路**（第 2 项），一次粘贴长期有效：
>
> ```bash
> magpie plugin login orcaterm     # 选第 2 项：手动粘贴 cookie
> ```
>
> 原因：插件自建的浏览器 profile 曾被异常中断，导致 `--remote-debugging-port`
> 无法监听；叠加 magpie 的**全局代理**会让 Bun 的 `fetch` 把 `127.0.0.1` 也送进代理
> （已在脚本里改用 `node:net` 直连绕开，但 profile 本身仍需重建）。
> 重建 profile 需要你确认后才会执行，详见 [§9 已知问题](#9-已知问题)。

把**腾讯云 OrcaTerm（遨驰终端）AI 助手**的问答额度，反代成 **OpenAI Chat Completions 兼容**接口，
作为 magpie / OpenCode 的供应商插件使用。写完就能用：

```bash
magpie plugin add ./orcaterm-magpie-plugin
magpie plugin login orcaterm          # 选「手动粘贴 cookie」
magpie provider test orcaterm
```

模型 id 形如 `orcaterm/deepseek`、`orcaterm/kimi`、`orcaterm/glm`，任何 agent 都能直接选。

---

## 1. 它做了什么

```
agent ──OpenAI/Anthropic/Gemini 任意协议──▶ magpie 网关
                                              │ 转成 Chat Completions
                                              ▼
                                   本插件 loader().fetch
                                              │ body / SSE 双向翻译
                                              ▼
                        lightai.cloud.tencent.com/assistant/chat   (OrcaTerm 后端)
```

- **入**：gateway 已把各类协议统一成 `POST /chat/completions` 的 body。
- **转**：`toUpstreamBody()` 把 `messages[]` 压成 OrcaTerm 要的
  `{conversationId, user:{setting}, input:{content, historyMessages}, stream:true}`：
  - `system` / `developer` 拼成带标记的前缀，塞进 `input.content`（上游没有 system 字段）；
  - 除最后一条 user 外全部进 `historyMessages`；
  - `tool_calls` 与 `tool` 结果降级成普通文本轮次——**上游不执行工具循环**，
    工具调用由客户端自己完成，插件只做文本往返。
- **出**：上游是 SSE，正文在 `content`、思考在 `reasoningContent`；
  这里逐帧翻译成 `chat.completion.chunk`（`delta.content` / `delta.reasoning_content`），
  兼容上游「累计全文」与「纯增量」两种发法，最后补 `finish_reason` 与可选 `usage` 帧。

## 2. 登录：为什么必须粘贴 cookie

OrcaTerm 的会话接口**不接受 API key**，只认 `tencent.com` 域下的 **HttpOnly cookie**（`uin` + `skey`）。
浏览器不会把 HttpOnly cookie 交出去，插件也没有登录令牌，所以走「粘贴凭据」。

### 上游鉴权面（2026-10-26 实测）

| 送出的 cookie | 上游返回 | 说明 |
| --- | --- | --- |
| 无 | `NEED_UIN_AND_SKEY` | 根本没进校验层 |
| 只有 `skey` | `NEED_UIN_AND_SKEY` | **必须有 uin**，不能只贴 skey |
| 只有 `p_uin` + `p_skey` | `NEED_UIN_AND_SKEY` | 这两个名字上游不认 |
| `uin` + `skey`（假值） | `VERIFY_SKEY_UIN_FAILED` | 已进入校验层，假凭据到此为止 |
| `uin` 带/不带 `o` 前缀 | 都认 | `o0123456789` 与 `0123456789` 等价 |

另外实测：`csrfCode` 参数、`Origin` / `Referer`、`X-CsrfCode` 头**都不是门槛**，
值错或缺失都不会改变错误码——真正决定成败的只有 `uin` + `skey` 这一对。

所以插件在 `loader` 里就强制要求两者齐全：只有 skey 会直接返回空对象（账号显示不可用），
不会把一次注定失败的请求打到上游。

### 操作步骤

**方式一：自动登录（推荐）**

```bash
magpie plugin login orcaterm
```

选「浏览器登录 OrcaTerm（自动，推荐）」，再选「复用上次登录态（免扫码）」：

- **第一次**：会打开一个浏览器窗口，微信扫码 → 自动读取凭据 → 完成登录；
- **以后**：同一个 profile 里 cookie 还在，**直接免扫码完成**；
- cookie 失效时（通常几天到几周）会自动打开登录页让你重扫。

全程不需要手动复制 cookie。

**方式二：手动粘贴 cookie**

选第二项，粘贴 `uin=o123456789; skey=AbCdEf...`。

**方式三：单独跑登录脚本**

```bash
node login.mjs                 # 持久 profile：首次扫码，之后免扫码
node login.mjs --fresh         # 强制换新 profile 重新扫码
node login.mjs --json          # 机器可读，供插件调用
node login.mjs --browser=edge  # 指定浏览器
node login.mjs --show-profile  # 打印 profile 路径
```

### 为什么必须由「我们自己的浏览器实例」提供 cookie

这三条路都验证过，只有最后一条可行：

| 方案 | 结果 |
| --- | --- |
| 网页 OAuth 回调带回凭据 | ❌ 微信 `redirect_uri` 被写死成 `orcaterm.com/oauth/callback`，`return_url` 被忽略 |
| `OAuthExchangeToken{sessionId}` 换取 | ❌ 只返回 `ot_session`（accessToken），而 AI 接口不认它 |
| 直接读日常浏览器的 cookie 库 | ❌ 全部是 **v20（App-Bound 加密）**，普通进程无法解密 |
| 给日常浏览器开调试端口 | ❌ 新版 Chrome/Edge 禁止对**默认 profile**开调试端口（端口/管道都试过） |
| **自建持久 profile + CDP** | ✅ 调试端口归我们，`Network.getCookies` 可读 HttpOnly |

> 实测细节：`--user-data-dir` 指向默认 profile 时，`--remote-debugging-port`
> 静默失效；`--remote-debugging-pipe` 直接报 `file descriptors are not open`。
> 换成独立目录立刻正常。这是浏览器的安全策略，不是代码问题。

### 扫码要扫「腾讯云」，不是 OrcaTerm

`uin` / `skey` 由**腾讯云 SSO**（`.cloud.tencent.com`）签发；
OrcaTerm 自己的登录（`orcaterm.com`）只发 `ot_session`，而 AI 接口不认它。

所以脚本打开的是 `cloud.tencent.com/login`。若扫 OrcaTerm 的登录页，
即使登录成功也永远拿不到 `uin`/`skey` —— 这是最容易踩的坑。

### 诊断工具：能不能直接导入日常浏览器的凭据

```bash
node import-cookies.mjs
```

它会扫描本机 Chrome/Edge 的 cookie 库，尝试用 DPAPI 解密并直接导入。
如果浏览器把 cookie 存成了老格式（v10）就能成功，**完全不用扫码**；
若是 v20，它会明确告诉你为什么不行。

> **实战结论（2026-10-27）**：日常 Edge 的 cookie 是 v20，解不开；
> 但插件自建 profile 里的 cookie 是 **v10**，可以用 DPAPI 解密 ——
> 也就是说只要那个 profile 登录过一次，之后就能直接把 `uin`/`skey` 读出来写进 magpie，
> 既不用再扫码，也不用翻 DevTools。
>
> v10 明文的前 32 字节是 `sha256(host_key)` 的域绑定前缀，必须去掉才是真实值。

### 全局代理会挡住本机调试端口

magpie 开着全局代理时，插件宿主（Bun）的 `fetch` 会读 `HTTP_PROXY`，
**连 `127.0.0.1` 也被送进代理**，于是浏览器调试端口探测失败，
界面上显示「浏览器调试端口没起来」——端口其实是好的。

所以登录脚本里访问回环地址一律用 `node:net` 直连（`httpGetLocal`），不走 `fetch`。

### 额度字段（实测）

真实额度在 `DescribeUserBillingStatus` 的 `usageStats[]` 里，`feature === "hunyuan_ai"`：

```json
{"feature":"hunyuan_ai","quotaLimit":1000,"quotaUsed":0,
 "quotaStartDate":"...","quotaEndDate":"..."}
```

注意这个接口**不接受任何 data 字段**（多塞一个就回 `property xxx should not exist`），
而 `DescribeUserUsageStats` 的 `feature` 只认 `hunyuan_ai` / `session_share` / `secret`。

### 上游鉴权面（2026-10-26 实测）

| 送出的凭据 | 上游返回 | 说明 |
| --- | --- | --- |
| 无 / 只有 `skey` / 只有 `p_uin`+`p_skey` | `NEED_UIN_AND_SKEY` | 没进校验层 |
| `uin` + `skey`（假值） | `VERIFY_SKEY_UIN_FAILED` | 已进入校验层 |
| `uin` + `skey`（真实） | 直接出 SSE 帧 | 可用 |
| `Cookie: ot_session=<token>` | `NEED_UIN_AND_SKEY` | OAuth 签发的 token 不认 |
| `Authorization: Bearer <token>` | `NEED_UIN_AND_SKEY` | 同上 |

另外实测：`csrfCode` 参数、`Origin` / `Referer`、`X-CsrfCode` 头**都不是门槛**，
真正决定成败的只有 `uin` + `skey` 这一对。

> 微信是唯一可用的 OAuth provider；`google` / `qq` / `phone` 等一律返回 400。

`.mjs` 里的凭据只写在 magpie 自己的 `plugin-auth.json`（权限 600），插件不落任何额外文件。

## 3. 模型

| 模型 id | 展示名 | 思考 | 上下文 |
| --- | --- | --- | --- |
| `deepseek-chat-latest` | DeepSeek-V4-Pro | ✓ | 128k |
| `hy3-preview` | Hy3-preview（混元） | ✓ | 256k |
| `glm-4.7` | GLM-5.2（智谱） | | 200k |
| `glm-4.7-thinking` | GLM-5.2 Thinking | ✓ | 200k |
| `kimi-k2` | Kimi-k2.6（月之暗面） | | 256k |
| `kimi-k2-thinking` | Kimi-k2 Thinking | ✓ | 256k |
| `hunyuan-turbos` | Hunyuan TurboS | | 128k |
| `hunyuan-t1` | Hunyuan T1 | ✓ | 128k |

别名可用：`deepseek`、`kimi`、`glm`、`hunyuan`、`moonshot`…（见 `index.mjs` 的 `MODEL_SPECS.aliases`）。
上游若上线新模型，请求里直接写它的 id 会**透传**过去，不必等插件发版。

`cost` 全为 0：这是额度制，不是按 token 计费，避免 magpie 把它当付费模型参与比价。

## 4. 用量 / 额度

`auth.usage` 会调 OrcaTerm 的 `DescribeUserUsageStats`，把问答次数画在账号卡片与 `magpie quota` 上。
这个接口的返回字段**没有公开文档**，插件按常见字段名探测（`used|Used|count` / `limit|total|quota`）；
探测不到时显示一条说明而不是瞎报数字。

想看真实字段长什么样，跑一次探针：

```bash
node probe.mjs "uin=o123; skey=xxx"
```

它会把 `/chat` 的可用性、各模型实测、`DescribeUserUsageStats` 的**原始返回**都打出来——
照着返回改 `index.mjs` 里的 `pickNumber` 字段名即可精确对齐。

## 5. 错误与重新登录

| 上游情况 | 插件行为 |
| --- | --- |
| `401` 或 200+JSON `NEED_UIN_AND_SKEY` / `VERIFY_SKEY_UIN_FAILED` / `VERIFY_LOGIN_FAILED` | 回 OpenAI 形状的 `401` + 头 `x-magpie-sign-in: expired`，magpie 标记账号需重登并停止派发 |
| 其它非 2xx | 原状态码透传，`error.message` 里带上游原文 |
| 网络失败 | `502`，magpie 照常做账号/模型故障切换 |
| 流中途断 | 补一帧说明文本 + `finish_reason: stop`，不让客户端卡死 |

`auth.refresh` 故意不提供：cookie 由腾讯登录态维护，插件无法续期，只能等用户重新粘贴。

## 6. 自测

不碰真实账号，纯本地 mock：

```bash
npm test                      # 两套一起跑（80 项）
node test/selftest.mjs        # 32 项：主链路
node test/edge.mjs            # 48 项：对抗性边界
```

`selftest.mjs` 覆盖：纯函数、body 转换、SSE 双向翻译、错误路径、钩子形状、
以及**入口不导出多余函数**（magpie 会把入口导出的每个函数都当插件运行，这是常见翻车点）。

`edge.mjs` 覆盖的是真实会踩到的边界，都是跑出来才发现的：

| 项 | 现象 | 处理 |
| --- | --- | --- |
| 单帧拆成多 chunk / 逐字节写入 | 正文完整不重复 | TextDecoder `stream` 模式 |
| 多字节汉字被切在字符中间 | 不出现乱码 | 同上 |
| 只有 `\r` 作行尾 | 整段流被当一行丢弃 | `takeSseLines()` 统一三种行尾 |
| 上游不发 `[DONE]` 就关流 | 客户端收不到结束 | 收尾兜底补 `finish_reason` |
| 上游只发 `reasoningContent` | 正文空白 | `finishUp` 里把思考补成正文 |
| 上游只用 `fullContent` 累计全文 | 正文重复 | 以 `fullContent` 为准换算增量 |
| 200 + HTML（登录页/网关页） | 静默空回答 | 识别非 SSE 响应并回 502 |
| `messages: []` / `content: null` | 给上游发空 input | 补占位内容 |
| 客户端断连 | 上游连接泄漏 | `ReadableStream.cancel()` 掐上游 |
| `model` = `"orcaterm/"` | 上游收到空 model | 回落默认模型 |
| body 是 `Uint8Array` | 直接 400 | `bodyToText()` 统一形态 |

## 7. 已知边界

- **无工具执行**：上游是「终端助手」而非函数调用 API，`tool_calls` 只能降级成文本。
  Agent 侧的工具仍由客户端自己跑，插件不参与。
- **无图片**：`image_url` 只被替换成 `[图片]` 占位（`user.setting.multimodal` 默认关）。
- **上下文靠重放**：上游按 `conversationId` 存会话，插件为每个账号生成一个稳定 id；
  但为了每轮都准确，仍把完整历史放进 `historyMessages` 重放一遍。
- **并发**：`package.json` 里 `magpie.maxConcurrency: 2`，OrcaTerm 对并发敏感，别调高。
- **协议会变**：上游是未公开接口，改版后按 `probe.mjs` 的输出和 `index.mjs` 顶部的常量区对一遍即可。

## 8. 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 插件本体（唯一入口，符合 magpie 加载规则） |
| `login.mjs` | 自动登录脚本（持久 profile + CDP 读 cookie） |
| `import-cookies.mjs` | 尝试从本机浏览器直接导入凭据（v10 可解、v20 不行） |
| `probe.mjs` | 真机探针，用来校准协议与用量字段 |
| `test/selftest.mjs` | 主链路自测（33 项） |
| `test/edge.mjs` | 对抗性边界测试（48 项） |
| `package.json` | `magpie.maxConcurrency` / `magpie.icon` / keywords |

## 9. 已知问题

### 自动扫码登录（未修好）

**症状**：`magpie plugin login orcaterm` 选「浏览器登录（自动）」后，
界面提示「浏览器调试端口没起来」或停在「登录未完成」。

**两个独立原因**：

1. **全局代理挡住本机回环**
   magpie 开全局代理时会把 `HTTP_PROXY` 写进环境变量，插件宿主（Bun）的 `fetch`
   连 `127.0.0.1` 也送进代理 → 调试端口探测失败。
   *已修*：`login.mjs` 改用 `node:net` 直连（`httpGetLocal`），不走 `fetch`。

2. **持久 profile 损坏**（未修）
   插件自建 profile（`%LOCALAPPDATA%\orcaterm-magpie\browser-profile`）
   在一次异常中断后无法监听调试端口 —— 同样参数换成全新目录立刻正常。
   *未修*：需要删除并重建该 profile，**这一步会动到本地数据，须用户确认后才执行**。

**当前可用的替代路径**（都验证过）：

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 手动粘贴 | `magpie plugin login orcaterm` → 第 2 项 | 一次粘贴长期有效，**推荐** |
| 从 profile 解密 | `node import-cookies.mjs` | profile 里 cookie 是 v10，能直接解出来 |
| 单独探针 | `node probe.mjs "uin=…; skey=…"` | 只校验，不写库 |

### 额度窗口只有「AI 问答」

上游 `DescribeUserBillingStatus` 还会返回 `session_share` / `secret` / `space`，
这些与 AI 额度无关，插件只展示 `hunyuan_ai`（1000 次/月）。

## 10. 凭据安全

凭据（`uin` + `skey`）等同于你的腾讯云登录态，插件在几个环节做了约束：

| 环节 | 处理 |
| --- | --- |
| 最终存放 | 只存 magpie 自己的 `plugin-auth.json`（权限 600） |
| 登录过程中的中转文件 | 写在私有目录 `%LOCALAPPDATA%\orcaterm-magpie\login-state`（不是共享 TEMP），权限 0600 |
| 中转文件生命周期 | 读到即删；登录成功/失败/取消都会清理 |
| 日志 | 不打印 `uin` / `skey` / cookie；错误信息里的 URL 会去掉查询串（`redactUrl`） |
| 仓库 | `.gitignore` 排除 `*.ticket` / `ot-ticket.*`；npm `files` 只含源码与文档 |
| 测试 | 用的都是 `o1234567890` / `SECRET123456` 这类占位值 |

> `import-cookies.mjs` 会**读取**本机浏览器 cookie 库，但只在内存里解密、
> 不写任何中间文件；解不开（v20）时会明确说明而不落盘。

MIT。
