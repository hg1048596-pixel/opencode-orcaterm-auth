# 发布产物

本目录归档实际发布到 npm 的包，供离线核对和安装。

| 文件 | 版本 | SHA1 |
| --- | --- | --- |
| `opencode-orcaterm-auth-0.2.5.tgz` | 0.2.5，本轮修复版 | `56823cb481aba83c3ad29d74fd8033f5fe81b7cd` |
| `opencode-orcaterm-auth-0.2.4.tgz` | 0.2.4 | `89a070e3ca4f0965a1abc755291e6d0afeca9fd0` |
| `opencode-orcaterm-auth-0.2.3.tgz` | 0.2.3 | `f11a418c7d29105d37a8332ffc98e5a682169888` |

0.2.5 包含代码修复，详见根目录 CHANGELOG.md；0.2.4 与 0.2.3 的代码相同，仅文档不同。

先解包再安装目录；magpie 不直接导入 tgz：

```powershell
New-Item -ItemType Directory unpacked -Force
tar -xzf opencode-orcaterm-auth-0.2.5.tgz -C unpacked
magpie plugin add ./unpacked/package
magpie plugin login orcaterm
```

发布后用 `npm view opencode-orcaterm-auth@0.2.5 dist.shasum` 核对以上 SHA1。
