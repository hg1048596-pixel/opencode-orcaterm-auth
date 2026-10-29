# 发布产物

这个目录存的是**实际发布到 npm 的包**，用来在没有 npm、或网络受限、或 2FA 不便的环境里，装到与 npm 上逐字节相同的那一版。

| 文件 | 对应版本 | 与 npm 的一致性 |
| --- | --- | --- |
| `opencode-orcaterm-auth-0.2.4.tgz` | `latest` = 0.2.4 | sha1 `89a070e3ca4f0965a1abc755291e6d0afeca9fd0`（npm 打包时自己算的也是这个值） |
| `opencode-orcaterm-auth-0.2.3.tgz` | 0.2.3，上一版 | sha1 `f11a418c7d29105d37a8332ffc98e5a682169888`，与 npm 的 `dist.shasum` 相同 |

0.2.4 与 0.2.3 的**代码逐字节相同**，只改了文档（README 口径、CHANGELOG、PUBLISH 里的数字）。

## 怎么用

**`magpie plugin add` 不接受 `.tgz`**——实测会报
`exports no OpenCode plugin function`（它把压缩包当成文件入口去 import）。所以先解开再装：

```bash
# 解开（解开后是 package/ 子目录）
tar -xzf opencode-orcaterm-auth-0.2.4.tgz -C ./unpacked

# 装目录，不是装 tgz
magpie plugin add ./unpacked/package
magpie plugin login orcaterm
```

或者用 npm 装成全局包，再按名字装进 magpie：

```bash
npm i -g ./opencode-orcaterm-auth-0.2.4.tgz
magpie plugin add opencode-orcaterm-auth
```

## 校验

```bash
# Windows
Get-FileHash .\opencode-orcaterm-auth-0.2.4.tgz -Algorithm SHA1
# macOS / Linux
sha1sum opencode-orcaterm-auth-0.2.4.tgz
# 期望：89a070e3ca4f0965a1abc755291e6d0afeca9fd0
```

## 为什么放这里

`npm publish` 需要 2FA，自动化环境里不好复现；把发布产物留在仓库里，任何机器都能装到与 npm 相同的那一版，也便于核对「我装的和作者发的是不是同一个东西」。

发布新版本时这个目录要一起更新：`npm pack` 后放进 `package/`，在上表补一行，并更新上面的文件名。
