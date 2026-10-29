# 0.2.5

2026-10-29：同步社区审核修复，并补充本轮审计发现的边界用例。

- 修复扫码回调收到 JSON `null`、数组或错误字段类型时的未捕获异常；无效输入返回 400，仍可继续接收正常扫码。
- 修复答案 envelope 前有空白、换行、围栏时丢失正文，以及 JSON 示例后的解释被截断。以 envelope 形状开头的回复会暂存至结束后判定；普通正文和 reasoning 继续流式输出。
- 流尾无换行的拒绝帧也转换成错误；正常 `[DONE]`、拒绝、取消及连接异常都会清理 reader。
- HTTP 200 下的 JSON `code: 429` 直接返回 429 并冷却账号，不再依赖错误文案。
- 首段 SSE 和非 SSE 正文读取失败统一返回 OpenAI 格式的 499/502。
- 共用实现与社区 PR 对齐：按账号控速、只列出九个推荐模型、移除 `/conversation` 登记、登录页面校验 Origin/state、补全 OAuth 续期字段。
- 保留个人包的浏览器登录入口，并补齐该入口使用的 Node 模块导入。
- 新增 21 项回归测试；旧测试的扫码配置改用桩，不连接腾讯上游。

# 0.2.4

纯文档改动，**代码与 0.2.3 逐字节相同**（`index.mjs` / `wechat.mjs` / `login.mjs` /
`import-cookies.mjs` / `probe.mjs` 的 SHA256 全部一致）。发这一版只是为了让 npm 上的 README
跟上仓库：0.2.3 的 npm 页面还是改口径之前的内容。

- README 与社区包、PR 正文统一口径：13 条可核对事实逐条一致（模型命名空间、九个推荐 id、
  五个主机及各自收到什么、transcript 承载上下文、429 的两种到达方式、10 次/分钟、per-account 控速等）。
- 修正请求格式描述：`input:{content, historyMessages}` → `input:{id, type, input, files, historyMessages:[]}`，
  并说明之前的轮次走 transcript、`historyMessages` 恒为空，也不再 `POST /conversation`。
- 补「会连到哪些主机」表与限流说明；`maxConcurrency` 订正为 1，并注明 auth 钩子上也声明了。
- `PUBLISH.md` 的版本号与随版本漂移的数字（文件数、打包体积、测试项数）一并订正。
- `package/` 放入与 npm 逐字节相同的 0.2.4 发布产物，并给出 sha1 便于核对。

# 0.2.3

纯文档改动，功能与 0.2.2 相同。

- README 删掉已过时的「自动扫码登录（未修好）」一节——扫码登录已经能用，而且现在是推荐路径。
- 「凭据安全」补齐两种凭据的权限面对比：扫码拿到的 OAuth token 只对 OrcaTerm 生效、两小时自动续期；
  `uin` + `skey` 等同腾讯云控制台会话。
- 修正过期的测试项数（33/48 → 34/51）。

> 0.2.3 是实际发布到 npm 的当前版本（`latest`）。仓库里曾短暂退回 0.2.2 是因为当时误判 0.2.3
> 未发布成功；两者内容一致，只是版本号不同。

# 0.2.2

只改文档。

- README 删掉已过时的「自动扫码登录（未修好）」一节 —— 扫码登录已经能用，而且现在就是推荐路径。
  第 9 章只保留额度窗口的说明。
- 「凭据安全」补齐两种凭据的权限面对比：扫码得到的 OAuth token 只对 OrcaTerm 生效、两小时自动续期；
  `uin` + `skey` 等同腾讯云控制台会话。推荐前者。
- 修正过期的测试项数（33/48 → 34/51）。

功能与 0.2.1 相同。

# 0.2.1

修掉 `[LLM_ERROR]: Invalid inputId: in-…`，并修正模型清单与答案解析。全部结论来自对真实接口的实测。

## 修复

- **`Invalid inputId`（issue #1）**：`input.id` 必须是 uuid v4，之前发的是 `in-` + 24 位 hex。
  改用 `crypto.randomUUID()`，每次请求新生成。旧形状至今仍被上游拒绝，所以这不是上游放宽了。
- **模型 id 缺命名空间前缀**：模型要用 `TokenHub/<model>` 和 `Hunyuan3/<model>`。
  发裸名 `glm-5.3` 会被拒成 `LLM(glm-5.3) is not loaded`，加前缀才通。桌面端选择器里
  那九个模型现在全部可用。
- **答案被 JSON 信封包住**：上游流的是助手自己的消息对象
  `{"action":"completion","taskCompletion":"…"}`，有时带围栏、有时散文在前。现在会解包，
  且流式与非流式共用同一个解析器（之前各写一份，非流式因此会对同一份字节答"空回复"）。
- **多轮丢上下文**：magpie 每次请求都给新的 `sessionID`，服务端会话状态靠不住；
  历史改为以 transcript 写进 `input.input`，`historyMessages` 保持为空。
- **限流**：上游每账号 10 次/分钟，打满返回的是 HTTP 200 + `{"code":429,…}`（不是 SSE 错误帧）。
  新增滑动窗口控速 + 429 冷却，`maxConcurrency` 改为 1。

## 新增

- **微信扫码登录**（`magpie plugin login orcaterm` 第一项）：本地页面 `127.0.0.1:4080` 内嵌
  二维码，扫完自动继续。拿到的是 OrcaTerm 自己的 OAuth accessToken —— 两小时有效、自动续期、
  只能用于 OrcaTerm；比原来的 `uin`+`skey`（等同腾讯云控制台完整会话）权限面小得多。
  两种凭据都支持，按 key 形状自动判别，老配置不受影响。
- 环境变量：`ORCATERM_CHAT_RPM`（限流额度）、`ORCATERM_NO_PACE=1`（关闭控速）、
  `ORCATERM_CAPTURE_PORT` / `_HOST` / `_BASE`（扫码页面地址）。

## 注意

- **只用 OrcaTerm 模型选择器里那九个模型**。其余 id 虽然在接口上能通，但在选择器里选不到，
  属于绕过界面调用，**有封号风险**，README 已写明。

## 测试

34（selftest）+ 51（edge）= 85 项全过。
