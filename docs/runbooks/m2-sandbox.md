# M2 私有 Sandbox 验收 Runbook

本流程只证明 GitHub 控制面：批准、排队、claim、重复触发幂等、Recovery 去重与权限边界。M2 不运行 Codex、不 checkout Target Repository、不创建分支或 Pull Request，也不配置 OpenAI secret。

## 固定版本

- Control Repository：`0xroylee/OPC`（private）
- Action SHA：`756ddb463fb99a7e34ea255d6268a5ca649f71b2`
- Reusable Workflow SHA：`796deffdc81a4212a630badea8a42d16630f1e84`
- Sandbox 示例：`0xroylee/opc-m2-sandbox`

若任一 SHA 与仓库历史不一致，停止验收并重新渲染；不得用 `main`、tag 或短 SHA 替代。

## 1. 本地门禁

在 Control Repository 根目录运行：

```bash
rtk bun run typecheck
rtk bun run lint
rtk bun test
rtk bun run build
rtk git status --short
```

前四条必须退出 `0`，最后一条必须为空。记录完整输出与两个 SHA。

## 2. 发布私有 Control Repository

确认 `origin` 精确指向 `git@github.com:0xroylee/OPC.git`，远端为 private，然后推送包含上述两个 SHA 的 `main`。不要创建公开仓库。

在 Control Repository 的 GitHub 页面打开 **Settings → Actions → General → Access**，选择 **Accessible from repositories owned by '0xroylee' user** 并保存。GitHub 会给 Target runner 一个一小时后自动过期的只读下载 token；同 owner 的 private repository 才能调用该私有 Action/workflow。注意：Target Repository 的 collaborator 可从运行日志间接看到 Control workflow 的日志，因此 sandbox 不应加入外部 collaborator。

官方说明：[Sharing actions and workflows from your private repository](https://docs.github.com/en/actions/how-tos/reuse-automations/share-across-private-repositories)。

## 3. 创建并初始化一次性 Sandbox

使用当前 owner 的交互式 `gh` 会话创建 `0xroylee/opc-m2-sandbox`，visibility 必须是 `PRIVATE`、`isFork` 必须是 `false`。不要添加 collaborator、Deploy Key、PAT、GitHub App 或 repository secret。

先生成离线预览：

```bash
rtk bun run build
rtk bun dist/cli.js onboard-preview \
  --repository 0xroylee/opc-m2-sandbox \
  --control-owner 0xroylee \
  --control-ref 796deffdc81a4212a630badea8a42d16630f1e84 \
  --approver 0xroylee \
  --output .opc/m2-sandbox-preview
```

核对三份输出后复制到 Sandbox：

- `.github/workflows/opc.yml`
- `.github/ISSUE_TEMPLATE/opc-work.yml`
- `.codex-pipeline.yml`

所有生成文件最初均为 mode `0600`，且 policy 保持 `enabled: false`。完成以下检查后，才在 Sandbox 的 policy 中把它改为 `enabled: true` 并提交：

- caller 只包含 `issues.labeled`、`schedule`、`workflow_dispatch`；
- reusable workflow pin 为上面的 40 位 SHA；
- job 权限只有 `contents: read`、`issues: write`、`actions: write`；
- 没有 `pull_request` / `pull_request_target`；
- 没有 executor、publisher、OpenAI secret 或 Contents write。

设置 repository variable（不是 secret）：

```bash
rtk gh variable set OPC_ENABLED --body true --repo 0xroylee/opc-m2-sandbox
```

## 4. 创建已签名 Work Issue

以 Sandbox 当前 default-branch commit 作为 `base_sha`，以启用后的 `.codex-pipeline.yml` canonical digest 作为 `policy_sha`，生成一个完整 Work contract。使用 owner 的交互式会话执行：

```bash
rtk bun dist/cli.js queue-plan \
  --repository 0xroylee/opc-m2-sandbox \
  --contract .opc/m2-sandbox-work.yml \
  --approved-digest sha256:<canonical-work-contract-digest>
```

该命令必须依次创建 unassigned Issue、写入 owner 的未编辑 `/opc approve sha256:...` comment，最后把唯一状态标签设为 `opc:ready`。标签本身不算批准。

## 5. Claim 与重复触发

若 Issue label event 尚未触发，显式运行 caller：

```bash
rtk gh workflow run opc.yml \
  --repo 0xroylee/opc-m2-sandbox \
  --ref main \
  -f reason=manual-proof \
  -f issue_number=<issue-number>
```

立即再触发一次相同输入。等待两次 workflow 结束，然后核对：

- Issue 最终只有一个 `opc:claimed` 状态标签；
- transition timeline 只有一次成功的 `ready → claimed`；
- 第二次为 `active-claim` no-op，没有第二个 claim；
- transition metadata 包含 `run_id`、`claimed_at`、30 分钟 `lease_deadline`、attempt、base SHA 与 approval digest；
- Actions 日志显示 reusable workflow SHA `796deff…` 与 Action SHA `756ddb4…`；
- workflow 只运行 GitHub-hosted `dispatch-and-claim`，没有 Target checkout、本地进程、Mac runner 或执行阶段。

M2 的预期停止点是 `opc:claimed`。不要手工伪造 Delivered、分支或 PR。

## 6. 权限与负向证据

保存以下只读输出：

```bash
rtk gh secret list --repo 0xroylee/opc-m2-sandbox
rtk gh api repos/0xroylee/opc-m2-sandbox/actions/permissions/workflow
rtk gh pr list --state all --repo 0xroylee/opc-m2-sandbox
rtk gh api repos/0xroylee/opc-m2-sandbox/branches
rtk gh issue view <issue-number> --comments --repo 0xroylee/opc-m2-sandbox
rtk gh run list --workflow opc.yml --repo 0xroylee/opc-m2-sandbox
```

验收要求：secret 列表没有 OpenAI/Codex credential；PR 列表为空；除初始化分支外没有 OPC 分支；Issue timeline 与 run 列表能证明一次 claim 和重复触发 no-op。

## 7. Evidence 记录

在 M2 result approval 中附上：

- 本地全量门禁输出；
- Control Action SHA 与 Workflow SHA；
- Sandbox repository URL、Work Issue URL、两次 Actions run URL；
- Issue 状态/transition timeline；
- duplicate trigger 与 Recovery fingerprint dedupe 的证据；
- workflow 权限 API 输出、空 secret/PR 证明；
- 没有 checkout、代码执行、分支或 publisher 的日志片段。

验收后先执行 `OPC_ENABLED=false`。删除 Sandbox 是破坏性操作，只能在 evidence 已归档且 owner 明确批准后执行。
