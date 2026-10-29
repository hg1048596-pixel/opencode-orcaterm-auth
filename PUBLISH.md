# 发布与上架

按 [magpie 官方文档「发布与上架」](https://usemagpie.ai/docs/zh/plugins#publish) 整理的步骤。
本目录已把能自动化的部分做完，剩下需要账号/凭据的步骤由你执行。

## 一、发布前检查（已全部通过）

| 项 | 状态 |
| --- | --- |
| `package.json` 有 `name` / `version` / `type` / `main` | ✅ `opencode-orcaterm-auth` @ `0.2.3` |
| `exports["./server"]` 指向入口 | ✅ `./index.mjs` |
| 入口只导出 `default {id, server}` 与 `_internal` | ✅ 无多余函数导出（magpie 会把导出的函数都当插件跑） |
| `keywords` 含 `opencode` + `opencode-plugin` + 厂商名 | ✅ `orcaterm` / `tencent` / `provider` |
| `magpie.maxConcurrency` | ✅ `1`（1–1000 整数），auth 钩子上也声明了 |
| `magpie.icon` | ✅ 内联 `data:image/png`，192×192，13 KB（上限 1 MB） |
| `files` 只含运行必需文件 | ✅ 10 个文件，打包 71 kB |
| 单元测试 | ✅ 34 + 51 = 85 项全过 |
| `npm pack --dry-run` | ✅ 正常 |

> `repository` / `homepage` / `bugs` 已指向 <https://github.com/hg1048596-pixel/opencode-orcaterm-auth>，
> 无需再改。若换了仓库地址，同步改 `package.json` 与 `registry-entry.json` 即可。

## 二、npm 发布

```bash
# 1. 登录（会打开浏览器）
npm login

# 2. 确认身份
npm whoami

# 3. 发布
npm publish --access public
```

包名 `opencode-orcaterm-auth` 经查**未被占用**，可直接发布。

发布后用户即可：

```bash
magpie plugin add opencode-orcaterm-auth
magpie plugin add opencode-orcaterm-auth@0.2.3     # 固定版本
```

## 三、GitHub 仓库（两个用途）

### 3.1 打 `magpie-plugin` topic → 出现在「插件 → 发现 → 非官方插件 · GitHub」

```bash
git init
git add -A
git commit -m "feat: OrcaTerm provider plugin for magpie/OpenCode"
git branch -M main
git remote add origin https://github.com/hg1048596-pixel/opencode-orcaterm-auth.git
git push -u origin main
```

然后在 GitHub 仓库页面 **Settings → Topics** 添加：`magpie-plugin`

要求（文档原文）：
- `package.json` 必须在**仓库根目录**；
- 仓库里提交的代码必须是**能直接加载的文件**（`dist` 只在发布时构建的仓库不会显示）；
- fork / 已归档仓库 / magpie-community 自己的仓库不显示。

> 本目录结构已满足：`package.json` + `index.mjs` 都在根目录，无构建步骤。

### 3.2 提交到社区 registry → 出现在「推荐列表」

文档给的 `registry.json` 条目已生成在 [`registry-entry.json`](./registry-entry.json)：

```json
{
  "package": "opencode-orcaterm-auth",
  "name": "OrcaTerm",
  "icon": "https://raw.githubusercontent.com/hg1048596-pixel/opencode-orcaterm-auth/main/icon.png",
  "providers": ["orcaterm"],
  "summary": { "en": "…", "zh": "…" }
}
```

提 PR 到 <https://github.com/magpie-community/plugins/blob/main/registry.json>，
把这一项加进数组即可。

> 想先本地验证条目效果：
> ```bash
> MAGPIE_PLUGIN_MARKET=<你的 registry.json 地址> magpie plugin
> ```

## 四、可选：并入社区包

文档还给了社区包命名约定：

```
packages/<name>  →  @magpie-community/opencode-<name>-auth
```

即放进 `magpie-community/plugins` 的 `packages/orcaterm`，包名改成
`@magpie-community/opencode-orcaterm-auth`。这类包会在每个 magpie 里**自动更新**
（启动后不久一次，之后每小时一次）。

推版本号到 `main` 就会自动发布。

## 五、发布后自检

```bash
magpie plugin add opencode-orcaterm-auth     # 从 npm 装
magpie plugin login orcaterm                 # 选「手动粘贴 cookie」
magpie provider test orcaterm
magpie quota
```

## 六、当前必须写进 README 的限制（已写）

- **自动扫码登录不可靠**（调试端口 / 全局代理 / profile 损坏），建议手动粘贴；
- 上游只接受 `uin` + `skey`，不接受 `ot_session` 或 Bearer；
- 无工具调用（`tool_call: false`），无图片输入；
- 额度为 `hunyuan_ai` 每月 1000 次。
