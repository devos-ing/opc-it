# M3 专用 Mac Runner Runbook

本文件用于验收一台只服务于 OPC 私有 sandbox 的 Mac mini。所有检查都在 `opc-runner` 的登录会话中执行；任何身份、权限、版本或 digest 不一致都必须停止，不得临时放宽 profile 或把个人凭证复制给 runner。

## 1. 身份与服务

执行批准计划锁定的检查：

```bash
rtk id opc-runner
rtk stat -f '%Su %Sp' /Users/opc-runner
rtk launchctl print gui/$(id -u opc-runner)
rtk git --version
rtk node --version
rtk bun --version
rtk codex --version
rtk codex login status
```

验收条件：

- 当前 runner service 的用户是 `opc-runner`，该用户不属于 `admin` 组；`/Users/opc-runner`、runner root、worktree root 与 Codex home 都是该用户所有且 mode `0700`。
- `bun --version` 必须精确为 `1.3.8`。Node 只用于 GitHub runner 的 `node24` Action host；仓库安装、测试、构建、CLI 与 worker 执行全部使用 Bun。
- `codex --version` 必须精确为 release manifest 的 `0.144.4`，`codex login status` 必须显示 ChatGPT 登录，不能显示 API Key 模式。
- runner 只注册到一次性 private sandbox，labels 精确包含 `self-hosted,macOS,ARM64,opc`，同一时间只执行一个 job。

补充只读检查：

```bash
rtk groups opc-runner
rtk security find-identity -v -p codesigning
rtk stat -f '%Su %Sp %N' /Users/opc-runner/.config/opc
rtk stat -f '%Su %Sp %N' /Users/opc-runner/.config/opc/runner.json
rtk stat -f '%Su %Sp %N' /Users/opc-runner/.codex
rtk stat -f '%Su %Sp %N' /Users/opc-runner/.codex/auth.json
```

`groups` 不得包含 `admin`。专用账户不得拥有开发者签名身份，也不得存在个人 GitHub CLI、SSH、npm、云厂商或部署凭证。不要打印、复制、hash 或上传 `auth.json` 内容。

## 2. Host-owned 配置

固定 manifest 位于 `/Users/opc-runner/.config/opc/runner.json`，mode `0600`，格式为：

```json
{
  "version": 1,
  "runner_user": "opc-runner",
  "codex": {
    "path": "/absolute/path/to/codex",
    "version": "0.144.4",
    "sha256": "sha256:<64 hex>",
    "home": "/Users/opc-runner/.codex"
  },
  "auth": { "credentials_store": "file" },
  "requirements": {
    "path": "/absolute/host-owned/requirements.toml",
    "sha256": "sha256:<64 hex>"
  },
  "profiles": {
    "opc-executor": {
      "path": "/absolute/host-owned/opc-executor.config.toml",
      "sha256": "sha256:<64 hex>"
    },
    "opc-reviewer": {
      "path": "/absolute/host-owned/opc-reviewer.config.toml",
      "sha256": "sha256:<64 hex>"
    }
  },
  "network_deny": {
    "command": "/absolute/host-owned/network-deny",
    "sha256": "sha256:<64 hex>"
  }
}
```

验收条件：

- Codex home 在 runner/worktree roots 之外，目录 mode `0700`；`auth.json`、manifest、requirements 与两个 profile 都是 mode `0600`。
- `cli_auth_credentials_store = "file"`；managed requirements 只允许 `opc-executor` 与 `opc-reviewer`。
- executor 只可写当前 worktree 与 job temp；reviewer 为只读。两个 profile 都禁止模型生成的本地工具读取 persistent Codex home，并禁止 workload 网络。
- `network_deny.command` 必须是 OS 强制执行的 wrapper，owner/mode/digest 与 manifest 相同；不能用提示词或普通环境变量代替网络隔离。
- 每个 job 都由 `verify-codex-runner` 重新检查当前用户、owner、mode、版本、非 credential 文件 digest，以及 ChatGPT 登录状态；验证过程只检查 `auth.json` 元数据。

## 3. Bun cache 与 fail-closed bootstrap

使用专用账户在目标 sandbox 的固定 base revision 上交互式预热 Bun cache：

```bash
rtk bun install --frozen-lockfile --ignore-scripts
```

随后删除预热产生的工作目录。正式 dry run 的 bootstrap 必须经过 manifest 固定的 OS network-deny wrapper。若 lockfile 不匹配、cache miss、wrapper digest 漂移或 bootstrap 尝试联网，job 必须失败并保留 Run Incident / Evidence，不得临时开放网络。

## 4. GitHub runner 注册检查

从 owner 的交互式 `gh` 会话执行：

```bash
rtk gh api repos/0xroylee/opc-m3-sandbox/actions/runners
rtk gh api repos/0xroylee/opc-m3-sandbox/actions/permissions/workflow
```

只允许一台 online runner，名称与 Mac mini inventory 一致，labels 包含上述四项；workflow 默认权限不能提供 Contents write。Runner registration token 只用于一次注册，不进入 repository secret、日志或 evidence。

## 5. 停机与恢复

模拟 offline 时先把 `OPC_ENABLED=false`，停止专用 LaunchAgent/runner service，等待 30 分钟 lease 过期并让 schedule reconcile。预期当前 attempt 不被消耗、Work 回到 `opc:ready`；持续基础设施 outage 达 24 小时后进入 Terminal Blocker。恢复服务后先重跑本文件全部检查，再重新启用 repository variable。

不要删除 runner 目录、auth 或 artifacts。Deregister 与删除 sandbox 都是独立的破坏性操作，只能在 evidence 已归档且 owner 明确批准后执行。
