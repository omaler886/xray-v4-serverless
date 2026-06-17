# xray-v4-serverless

通过 Serverless 函数临时启动 `xray-core`，用指定 Xray 节点探测实际出口 IPv4。

## 原理

函数收到请求后会：

1. 读取请求里的 Xray 分享链接或 `outbound` 节点配置。
2. 在系统临时目录生成一次性 Xray 配置。
3. 启动本地 `127.0.0.1:<random>` HTTP 代理入站。
4. 让 Node 通过该 HTTP 代理访问 IPv4-only 探测地址。
5. 返回节点出口 IPv4，并清理临时进程和配置文件。

这样不依赖系统自带 `curl`。如果你手动测试，等价思路是：

```powershell
curl.exe -4 --proxy http://127.0.0.1:1080 https://api.ipify.org
```

注意：如果使用 `socks5h`，域名解析会交给代理侧，单独加 `curl -4` 并不一定能约束远端解析。因此这里优先使用 IPv4-only 服务，并在临时 Xray 配置里设置 `UseIPv4`。

## 文件

- `api/probe-v4.js`: Serverless HTTP 入口，Vercel Node Function 可直接识别。
- `src/probe.js`: 核心探测逻辑。
- `src/share-link.js`: `vless://`、`vmess://`、`trojan://`、`ss://` 分享链接解析。
- `src/server.js`: 本地开发服务器。
- `examples/outbound.example.json`: 请求体示例。
- `examples/share-link.example.json`: 分享链接请求体示例。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `XRAY_BIN` | 推荐 | `xray` 或 `xray.exe` 的绝对路径。不设置时默认读取 `bin/xray` 或 `bin/xray.exe`。 |
| `PROBE_TOKEN` | 部署必填 | API 访问 token，请求头使用 `Authorization: Bearer <token>`。 |
| `PROBE_TIMEOUT_MS` | 可选 | 默认 `15000`，范围 `1000-60000`。 |
| `ALLOW_UNAUTHENTICATED_PROBE` | 仅本地可选 | 设置为 `1` 时允许无 token 调用。公网不要开启。 |

## 本地运行

先下载对应平台的 `xray-core`，然后指定路径：

```powershell
cd "D:\proxy config\xray-v4-serverless"
$env:XRAY_BIN="D:\tools\xray\xray.exe"
$env:PROBE_TOKEN="change-me"
npm run dev
```

调用接口：

```powershell
$body = Get-Content .\examples\share-link.example.json -Raw
curl.exe -X POST "http://127.0.0.1:8787/api/probe-v4" `
  -H "content-type: application/json" `
  -H "authorization: Bearer change-me" `
  --data $body
```

成功响应示例：

```json
{
  "ok": true,
  "ipv4": "1.2.3.4",
  "latencyMs": 1350,
  "provider": "https://api.ipify.org",
  "node": "example-vless-node",
  "error": null
}
```

失败时会返回明确错误，但不会回显节点密钥。

## 本地烟测

没有真实节点时，可以先用 Xray 的 `freedom` 出口验证服务机制：

```powershell
$body = '{"node":"freedom-ipv4-smoke","timeoutMs":15000,"outbound":{"protocol":"freedom","settings":{"domainStrategy":"UseIPv4"}}}'
curl.exe -X POST "http://127.0.0.1:8787/api/probe-v4" `
  -H "content-type: application/json" `
  -H "authorization: Bearer change-me" `
  --data $body
```

这只能证明 Serverless 函数能启动 Xray 并拿到 IPv4；真实节点是否可用仍要用你的节点链接或 outbound 配置验证。

## 请求体格式

最方便的方式是直接提交分享链接：

```json
{
  "node": "my-node",
  "timeoutMs": 15000,
  "shareLink": "vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&security=tls&type=tcp&sni=example.com#my-node"
}
```

支持字段名：

- `shareLink`
- `link`
- `url`
- `nodeUrl`

支持协议：

- `vless://`
- `vmess://`
- `trojan://`
- `ss://`

也可以直接提交单个 Xray outbound：

```json
{
  "node": "my-node",
  "timeoutMs": 15000,
  "outbound": {
    "protocol": "vless",
    "settings": {
      "vnext": [
        {
          "address": "example.com",
          "port": 443,
          "users": [
            {
              "id": "00000000-0000-0000-0000-000000000000",
              "encryption": "none"
            }
          ]
        }
      ]
    },
    "streamSettings": {
      "network": "tcp",
      "security": "tls",
      "tlsSettings": {
        "serverName": "example.com"
      }
    }
  }
}
```

也兼容：

- `{ "outbounds": [ ... ] }`
- `{ "config": { "outbounds": [ ... ] } }`

如果节点使用很少见的传输层参数，建议直接提交 Xray outbound JSON；分享链接解析器覆盖常见的 TCP、TLS、Reality、WebSocket、gRPC、HTTPUpgrade 和 XHTTP 参数。

## 部署建议

适合：

- AWS Lambda
- 阿里云函数计算
- 腾讯云云函数
- 允许执行随包二进制的 Vercel Node Functions

不适合：

- Cloudflare Workers，因为不能运行 `xray-core` 本地二进制。
- 只允许 Edge Runtime 的平台，因为 Xray 需要子进程和 TCP。

部署时需要把 Linux 版本 `xray` 二进制随函数一起打包，或通过环境变量 `XRAY_BIN` 指向运行时可执行路径。若平台不保留可执行权限，可以在启动前复制到 `/tmp` 并 `chmod +x`，这部分需要按平台补适配。

## GitHub Actions 私有运行

仓库根目录已提供 `.github/workflows/probe-xray-ipv4.yml`。它不是定时任务，只能手动运行，适合放在 private repo 里当一次性探测器。

私有运行步骤：

1. 把项目推到 GitHub private repository。
2. 进入 `Settings -> Secrets and variables -> Actions -> Repository secrets`。
3. 按你的输入形态新增 secret，三选一即可：
   - `XRAY_SHARE_LINK`: 单个节点链接。
   - `XRAY_SHARE_LINKS`: 多个节点链接，一行一个，适合 4 个 UUID 不同的节点。
   - `XRAY_SUBSCRIPTION_URLS`: 多个订阅 URL，一行一个，Action 会临时拉取并提取节点链接。
   - `SUBSCRIPTION_USER_AGENT`: 可选。订阅服务返回 403 时，可以填它要求的客户端 UA。
   - `GIST_TOKEN`: 可选。开启 Gist 发布时需要，使用带 `gist` 权限的 PAT。
   - `GIST_ID`: 可选。开启 Gist 发布时需要，填已有 secret gist 的 ID。
   - `GIST_FILENAME`: 可选。默认 `patched-subscription.txt`。
   - `GIST_OUTPUT_FORMAT`: 可选。默认输出 `vless://`、`vmess://`、`trojan://`、`ss://` 分享链接；只有设为 `original` 才保留原订阅格式。
4. 进入 `Actions -> Probe Xray IPv4 -> Run workflow`。
5. 默认最多探测 4 个节点；需要完整处理订阅可把 `max_nodes` 改成 `100`。
6. 默认不显示节点名、出口 IPv4 和详细错误；私有调试时才打开 `reveal_results`。
7. 默认不发布替换后的订阅；需要写入 Gist 时才打开 `publish_gist`。
8. 没配置 `GIST_TOKEN` 前，可以同时打开 `publish_gist` 和 `publish_gist_dry_run`，只验证生成，不写入 Gist。
9. 默认不跑测试，只执行一次探测；需要检查代码时再打开 `run_checks`。

如果 4 个节点只是 UUID 不同、服务器和传输参数完全一样，通常出口 IPv4 也一样。为了省额度，建议先把 `max_nodes` 设为 `1` 验证出口；只有怀疑某个 UUID 权限不同或可用性不同，再设为 `4` 全部测。

额度控制：

- 只支持 `workflow_dispatch` 手动触发，没有 `schedule`。
- `timeout-minutes: 30`，允许一次处理较大的订阅。
- `concurrency.cancel-in-progress: true`，重复点击会取消上一次。
- `max_nodes` 默认 `4`，最多允许 `100`；公开仓库实测建议先小批量，确认后再跑满。
- `probe_concurrency` 默认 `4`，最多允许 `10`，避免同时启动过多 Xray 进程。
- `probe_retries` 默认 `1`，最多允许 `3`，用于缓解节点临时断连或探测站点偶发失败。
- secret 缺失会在下载 xray 前停止，避免空跑。
- 不上传 artifact，不保存临时 Xray 配置。
- `reveal_results` 默认 `false`，公开日志只显示成功数量和是否拿到 IPv4，不显示具体 IP。
- `publish_gist` 默认 `false`，避免误覆盖私密订阅。
- `publish_gist_dry_run` 可在没有 `GIST_TOKEN` 时验证补丁生成，不会更新 Gist。

泄露控制：

- 节点链接只从 GitHub Secrets 读取。
- workflow 会逐行对节点链接和订阅 URL 执行 `add-mask`。
- 不要在 workflow 里添加 `env`、`printenv`、`set -x` 或 `echo $XRAY_SHARE_LINK`。
- 不建议给 public repo 或 fork PR 开启带 secret 的运行。
- 公开仓库不要打开 `reveal_results`，否则节点名、出口 IPv4 和详细错误会进入公开 Actions 日志。
- 开启 `publish_gist` 时不要打印 Gist URL 或 raw URL；把 `GIST_ID` 和最终订阅 raw URL 当作私密信息保存。

### 发布到 secret Gist

GitHub 的 secret gist 是 unlisted，不会出现在个人主页列表，但知道链接的人仍可访问。公开仓库使用时不要把 Gist URL、Raw URL 或 Gist ID 写进日志、README、issue、commit。

准备步骤：

1. 手动创建一个 secret gist，里面放一个占位文件，例如 `patched-subscription.txt`。
2. 记录该 Gist 的 ID，放入仓库 secret：`GIST_ID`。
3. 创建一个只用于 Gist 的 GitHub PAT，权限勾选 `gist`，放入仓库 secret：`GIST_TOKEN`。
4. 手动运行 workflow，保持 `reveal_results=false`，打开 `publish_gist=true`。
5. 首次建议同时打开 `publish_gist_dry_run=true` 验证生成链路；确认后再关闭 dry-run 正式写入。

发布行为：

- 只在至少一个节点探测成功时发布。
- 成功节点会把订阅里的 `server` 替换为探测出的 IPv4。
- 默认发布为一行一个的分享链接订阅，输出是 `vless://`、`vmess://`、`trojan://`、`ss://`，不会输出 sing-box JSON。
- 输入仍支持 Clash/Mihomo YAML、sing-box JSON 和常见分享链接订阅。
- 如果确实想保持输入原格式，把 `GIST_OUTPUT_FORMAT` secret 设为 `original`。
- 默认分享链接输出会跳过探测失败的节点；写入 Gist 前会校验每条输出节点的 server 都是 IPv4。
- 多个订阅 URL 和 `XRAY_SHARE_LINKS` 会默认汇聚成同一个私密 Gist 文件。
- 替换后的内容只写入 Gist，不会作为 artifact 上传，不会打印到日志。
- 汇聚发布会清理旧的拆分文件，例如 `patched-subscription-1.txt`、`patched-subscription-2.txt`。
- 没有任何成功节点时，不会覆盖 Gist 文件。

公开仓库建议：

- 把 `GIST_TOKEN`、`GIST_ID`、`XRAY_SUBSCRIPTION_URLS` 放在 `xray-probe` Environment secrets。
- 给 `xray-probe` Environment 设置 required reviewers，避免误触发发布。
- `publish_gist=true` 时仍保持 `reveal_results=false`。

订阅返回 403 时：

- 优先确认订阅 URL 在 GitHub Actions 所在网络能访问。
- 当前脚本会自动尝试 `ClashforWindows`、`clash.meta`、`ClashX Pro`、`Shadowrocket` 等常见 User-Agent。
- 如果机场要求固定客户端标识，把该值放到 `SUBSCRIPTION_USER_AGENT` secret。
- 如果服务商封锁 GitHub Actions IP，只能改用 `XRAY_SHARE_LINKS` 直接放节点链接，或换自托管 runner。

## 安全注意

- 不要把真实节点 JSON 提交到仓库。
- 公网部署必须设置 `PROBE_TOKEN`。
- 函数超时时间建议大于 `PROBE_TIMEOUT_MS + 5s`。
- 并发请求会各自启动一个 Xray 进程，生产环境需要加调用频率限制。
