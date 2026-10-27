# opencode-orcaterm-auth

> ## 📌 建议只用 OrcaTerm 模型选择器里出现的那几个模型
>
> 插件按 id 能列出更多模型，但**只有下面这九个在 OrcaTerm 自己的模型选择器里能选**：
> Hy4-preview、Hy3、Kimi-K3、GLM-5.3-Flash、GLM-5.3、GLM-5.2、DeepSeek-V4.1-Flash、
> DeepSeek-V4-Flash、Deepseek-V4-Pro。
>
> 其余 id（如 `deepseek-reasoner`、`qwen3`、`kimi-latest`、`hunyuan-turbos` 等）虽然在接口上
> 能通，但**在 OrcaTerm 里无法直接选用**，属于绕过界面调用，**不建议使用**——上游可能据此判定
> 异常，**存在封号风险**。要用就只用上面九个。

把**腾讯云 OrcaTerm（遨驰终端）AI 助手**的问答额度，反代成 **OpenAI Chat Completions 兼容**接口，
作为 magpie / OpenCode 的供应商插件使用。写完就能用：

```bash
magpie plugin add ./orcaterm-magpie-plugin
magpie plugin login orcaterm          # 选第 1 项：微信扫码登录（推荐）
magpie provider test orcaterm
```

模型名形如 `orcaterm/Deepseek-V4-Pro`、`orcaterm/GLM-5.3`、`orcaterm/Kimi-K3`，任何 agent 都能直接选
（大小写与界面标签都能用）。

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

## 2. 登录：微信扫码（推荐）

插件的上游鉴权有两种凭据，**扫码拿到的那种权限面小得多**：

| 凭据 | 来源 | 有效期 | 权限范围 |
| --- | --- | --- | --- |
| `uin` + `skey` | 腾讯云**控制台完整会话** cookie | 长期，直到登出控制台 | 整个腾讯云控制台 |
| **OAuth accessToken** | OrcaTerm 微信扫码 | **2 小时，自动续期** | 仅 OrcaTerm |

所以首选扫码。两种都可以用，插件按 key 的形状自动判别（`eyJ…` 开头 → Bearer，其余 → cookie）。

### 方式一：微信扫码（推荐）

```bash
magpie plugin login orcaterm     # 选第 1 项
```

会打开 `http://127.0.0.1:4080/login`，页内是微信二维码，**扫完自动继续**，不用复制任何链接。

原理：页面用官方 `wxLogin.js` 内嵌二维码，并设 `self_redirect: true` —— 这样扫码后的回跳落在
它自建的内层 iframe 里，OrcaTerm 的回调页能把 `code` `postMessage` 回宿主页。不设这个参数的话，
微信会做顶层跳转把宿主页顶掉，消息就永远收不到了。

远程部署（magpie 装在服务器上）时页面监听在服务器回环地址，需要转发端口：

```bash
ssh -L 4080:127.0.0.1:4080 <server>
```

端口/监听地址可用 `ORCATERM_CAPTURE_PORT`、`ORCATERM_CAPTURE_HOST`、`ORCATERM_CAPTURE_BASE` 改。

token 到期前 magpie 会用 `OAuthRefreshToken` 自动换新的，正常使用**不会**要求重新扫码。

### 方式二：手动粘贴 cookie（备用）

选第 3 项，粘贴 `uin=o123456789; skey=AbCdEf...`。长期有效，但等同于把控制台会话交给插件。

### 上游 cookie 鉴权面（2026-10-26 实测，仅 cookie 方式适用）

| 送出的 cookie | 上游返回 | 说明 |
| --- | --- | --- |
| 无 | `NEED_UIN_AND_SKEY` | 根本没进校验层 |
| 只有 `skey` | `NEED_UIN_AND_SKEY` | **必须有 uin**，不能只贴 skey |
| 只有 `p_uin` + `p_skey` | `NEED_UIN_AND_SKEY` | 这两个名字上游不认 |
| `uin` + `skey`（假值） | `VERIFY_SKEY_UIN_FAILED` | 已进入校验层，假凭据到此为止 |
| `uin` 带/不带 `o` 前缀 | 都认 | `o0123456789` 与 `0123456789` 等价 |

另外实测：`csrfCode` 参数、`Origin` / `Referer`、`X-CsrfCode` 头**都不是门槛**，
值错或缺失都不会改变错误码——真正决定成败的只有 `uin` + `skey` 这一对。

### 方式三：拉起本机浏览器（性能受限，仍可用）

选第 2 项。它拉起一个带调试端口的浏览器，靠 CDP 读 HttpOnly cookie。
**这条路对 profile 状态和全局代理敏感**，失败时改用手扫码或粘贴 cookie 即可。

### 方式四：单独跑登录脚本

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

### 只用这九个（OrcaTerm 选择器里能选到的）

| 模型 id（发给上游） | 展示名 | 思考 | 上下文 |
| --- | --- | --- | --- |
| `TokenHub/deepseek-v4-pro` | Deepseek-V4-Pro | ✓ | 128k |
| `TokenHub/deepseek-v4-flash` | DeepSeek-V4-Flash | | 128k |
| `TokenHub/deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | | 128k |
| `TokenHub/glm-5.3` | GLM-5.3 | ✓ | 200k |
| `TokenHub/glm-5.3-flash` | GLM-5.3-Flash | | 200k |
| `TokenHub/glm-5.2` | GLM-5.2 | | 200k |
| `TokenHub/kimi-k3` | Kimi-K3 | | 256k |
| `Hunyuan3/hy3` | Hy3 | ✓ | 256k |
| `Hunyuan3/hy4-preview` | Hy4-preview | ✓ | 256k |

> ⚠️ **下面这些不要用。** 它们在接口上能通，但**在 OrcaTerm 的模型选择器里选不到**，
> 属于绕过界面直接调用，上游可能据此判定异常，**有封号风险**：
> `glm-4.7-thinking`、`kimi-k2-thinking`、`kimi-k2.5`、`kimi-k2.5-thinking`、`kimi-latest`、
> `hunyuan-turbos`、`qwen3`、`deepseek-reasoner`。
> 它们留在清单里只是为了让已有的配置不至于断掉，**新配置请只用上面那九个**。

**id 是带命名空间的。** 这是最容易踩的坑：`glm-5.3` 会被上游拒成
`LLM(glm-5.3) is not loaded`，而 `TokenHub/glm-5.3` 正常——前缀就是全部差别。

别名可用：`deepseek`、`kimi`、`glm`、`hunyuan`、`moonshot`，以及界面标签本身
（`Deepseek-V4-Pro`、`GLM-5.3`、`Hy3-preview`…）。旧 id 如 `deepseek-chat-latest`、`glm-4.7`、
`kimi-k2`、`hunyuan-t1` 也会解析到对应的新 id（见 `index.mjs` 的 `MODEL_SPECS.aliases`）。

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
node test/edge.mjs            # 51 项：对抗性边界
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
| `test/selftest.mjs` | 主链路自测（34 项） |
| `test/edge.mjs` | 对抗性边界测试（51 项） |
| `package.json` | `magpie.maxConcurrency` / `magpie.icon` / keywords |

## 9. 额度窗口只有「AI 问答」

上游 `DescribeUserBillingStatus` 还会返回 `session_share` / `secret` / `space`，
这些与 AI 额度无关，插件只展示 `hunyuan_ai`（1000 次/月）。

扫码登录的账号读不到配额（额度接口只认控制台会话），账号卡片上不显示额度，这不影响使用。

## 10. 凭据安全

两种凭据的权限面差别很大：

| 凭据 | 权限范围 | 有效期 |
| --- | --- | --- |
| 微信扫码 → OAuth accessToken | **只对 OrcaTerm 生效** | 2 小时，自动续期 |
| 粘贴 `uin` + `skey` | **等同你的腾讯云登录态**（控制台、CVM、账单、API 密钥） | 长期，直到登出控制台 |

所以推荐扫码。无论哪种，插件在几个环节做了约束：

| 环节 | 处理 |
| --- | --- |
| 最终存放 | 只存 magpie 自己的 `plugin-auth.json`（权限 600） |
| 登录过程中的中转文件 | 写在私有目录 `%LOCALAPPDATA%\orcaterm-magpie\login-state`（不是共享 TEMP），权限 0600 |
| 中转文件生命周期 | 读到即删；登录成功/失败/取消都会清理 |
| 日志 | 不打印凭据；错误信息里的 URL 会去掉查询串（`redactUrl`） |
| 仓库 | `.gitignore` 排除 `*.ticket` / `ot-ticket.*`；npm `files` 只含源码与文档 |
| 测试 | 用的都是 `o1234567890` / `SECRET123456` 这类占位值 |

> `import-cookies.mjs` 会**读取**本机浏览器 cookie 库，但只在内存里解密、
> 不写任何中间文件；解不开（v20）时会明确说明而不落盘。

MIT。
