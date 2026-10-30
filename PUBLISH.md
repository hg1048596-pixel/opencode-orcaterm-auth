# 发布与同步

当前修复版本：`opencode-orcaterm-auth@0.2.9`。

个人 npm 包和社区 PR 共用请求转换、答案解析、错误分类、账号控速及微信 OAuth 实现。个人包另外保留 `login.mjs` 等手动工具及旧浏览器登录入口；社区包不包含启动浏览器的辅助脚本。

## 发布前验证

```powershell
npm test
npm pack --ignore-scripts
```

测试共 124 项：34 项主链路、51 项边界、24 项审核回归、7 项额度测试、8 项账号身份测试。测试不使用真实腾讯账号，扫码配置用测试桩，网络只连接回环服务器。

打包后必须解包并检查入口可加载，特别确认包含 `wechat.mjs`。发布产物归档在 `package/`，其 SHA1 应与 npm 的 `dist.shasum` 一致。

## npm 发布

```powershell
npm whoami
cd D:\DSH-PORTABLE\work\orcaterm-magpie-plugin
npm publish --access public
npm view opencode-orcaterm-auth version dist.shasum
```

按以上目录命令发布。发布前验证 `npm pack` 的归档；发布后下载注册表产物，核对文件内容和 SHA1。

## GitHub

- 个人仓库：<https://github.com/hg1048596-pixel/opencode-orcaterm-auth>，分支 `main`。
- 原社区 PR：<https://github.com/magpie-community/plugins/pull/460>，已经合并。后续扫码、额度和账号身份修复来自 `hg1048596-pixel/plugins:fix/orcaterm-null-callback`。
- 社区包名为 `@magpie-community/opencode-orcaterm-auth`。该包尚未首次发布到 npm，trusted publishing 无法创建新包；此 PR 合并后，在 owner 完成首次发布之前，magpie 从社区 `dist` 分支安装 0.1.1。个人 npm 包的版本与它分别维护。

## 安装

```powershell
magpie plugin add opencode-orcaterm-auth@0.2.9
magpie plugin login orcaterm
```

微信 QR 登录为推荐入口，拿到可续期的 OrcaTerm OAuth token；`uin` + `skey` 是腾讯云控制台会话，作为 fallback。模型只列出产品选择器中的九个，旧 id 仅保留兼容解析。

验证范围：模拟回调、账号身份及请求回归均通过；用户已确认真实微信扫码登录成功，本机 magpie 的真实额度刷新也成功。身份补齐使用宿主的账号作用域 SDK，已有重复记录不会由插件主动删除。
