# 发布与同步

当前修复版本：`opencode-orcaterm-auth@0.2.8`。

个人 npm 包和社区 PR 共用请求转换、答案解析、错误分类、账号控速及微信 OAuth 实现。个人包另外保留 `login.mjs` 等手动工具及旧浏览器登录入口；社区包不包含启动浏览器的辅助脚本。

## 发布前验证

```powershell
npm test
npm pack --ignore-scripts
```

测试共 116 项：34 项主链路、51 项边界、24 项审核回归、7 项额度测试。测试不使用真实腾讯账号，扫码配置用测试桩，网络只连接回环服务器。

打包后必须解包并检查入口可加载，特别确认包含 `wechat.mjs`。发布产物归档在 `package/`，其 SHA1 应与 npm 的 `dist.shasum` 一致。

## npm 发布

```powershell
npm whoami
npm publish --access public
npm view opencode-orcaterm-auth version dist.shasum
```

实际发布时优先提交已经验证的 tgz：`npm publish <tgz路径> --access public`，避免验证后重新打包引入内容漂移。

## GitHub

- 个人仓库：<https://github.com/hg1048596-pixel/opencode-orcaterm-auth>，分支 `main`。
- 社区 PR：<https://github.com/magpie-community/plugins/pull/460>，来源为 `hg1048596-pixel/plugins:orcaterm-provider`。
- 社区包名为 `@magpie-community/opencode-orcaterm-auth`。它由社区仓库合并后的发布流程管理，个人 npm 包的版本与它分别维护。

## 安装

```powershell
magpie plugin add opencode-orcaterm-auth@0.2.8
magpie plugin login orcaterm
```

微信 QR 登录为推荐入口，拿到可续期的 OrcaTerm OAuth token；`uin` + `skey` 是腾讯云控制台会话，作为 fallback。模型只列出产品选择器中的九个，旧 id 仅保留兼容解析。

本地验证不代表真实上游或扫码流程已通过；本轮没有执行真实账号测试。
