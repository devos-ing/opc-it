# M3 私有 Sandbox 验收 Runbook

本流程证明已批准 Work 能在专用 Mac mini 上执行并得到独立 review，同时保持 Target Repository `contents: read`。M3 到 verified Candidate Result 为止；publisher、commit、branch、Pull Request 与自动 merge 全部禁用。

## 固定版本与停止条件

- Control Repository：`0xroylee/OPC`（private）
- Action SHA：`e0c54d6350d0be14d0482fd1d1b535469455f95d`
- Reusable Workflow SHA：`8053a44e6990956fdf512d82caf377ef4566aa58`
- Sandbox：`0xroylee/opc-m3-sandbox`（private、非 fork、无外部 collaborator）
- Bun：`1.3.8`
- Codex CLI：`0.144.4`
- Executor：`gpt-5.6-luna` / `high` / `opc-executor`
- Reviewer：`gpt-5.6-sol` / `xhigh` / `opc-reviewer`

任一 SHA、visibility、owner、runner profile digest、模型 route 或权限不一致时立即停止。不得换成 branch、tag、短 SHA、API key 或 `openai/codex-action`。

## 1. 本地门禁

在 Control Repository 根目录执行：

```bash
rtk bun run typecheck
rtk bun run lint
rtk bun test
rtk bun run build
rtk git status --short
```

前四条必须退出 `0`。若 build 更新 tracked bundle，先确认只反映已审查 source；最后状态必须无意外变更。保存命令、时间、commit SHA 和完整输出。

## 2. Control / Target 只读预检

```bash
rtk git remote -v
rtk gh repo view 0xroylee/OPC --json nameWithOwner,visibility,isFork,defaultBranchRef
rtk gh repo view 0xroylee/opc-m3-sandbox --json nameWithOwner,visibility,isFork,defaultBranchRef
rtk gh secret list --repo 0xroylee/opc-m3-sandbox
rtk gh variable list --repo 0xroylee/opc-m3-sandbox
rtk gh api repos/0xroylee/opc-m3-sandbox/actions/permissions/workflow
rtk gh api repos/0xroylee/opc-m3-sandbox/actions/runners
```

两个 repository 必须同 owner 且 private；sandbox 不能是 fork。Repository secrets 不得包含 OpenAI、Codex、ChatGPT、GitHub PAT、SSH 或部署 credential。专用 runner 必须通过 [Mac runner runbook](mac-runner.md) 全部检查。

## 3. 安装固定 Target caller

先保持 kill switch 关闭：

```bash
rtk gh variable set OPC_ENABLED --body false --repo 0xroylee/opc-m3-sandbox
rtk bun dist/cli.js onboard-preview \
  --repository 0xroylee/opc-m3-sandbox \
  --control-owner 0xroylee \
  --control-ref 8053a44e6990956fdf512d82caf377ef4566aa58 \
  --approver 0xroylee \
  --output .opc/m3-sandbox-preview
```

将生成的 `.github/workflows/opc.yml`、Issue template 与 `.codex-pipeline.yml` 作为一次人工审查的 sandbox setup commit。核对：

- caller 只触发 `issues.labeled`、schedule 与手动 dispatch，且没有会阻塞 cron 的 workflow-level concurrency；reusable workflow 只用 `opc-control-${repository}` 串行 claim/reconcile，随后由 active-claim lease 保证单一执行；
- reusable workflow 固定到上面的 40 位 Workflow SHA；所有 OPC Action refs 固定到 Action SHA；
- GitHub-hosted control/heartbeat 仅有必要的 Issue/Actions 权限；Mac executor/reviewer 都只有 `contents: read`；
- checkout 使用批准 base SHA、`persist-credentials: false`；local Action commands 不接收 `github-token`；
- 没有 provider secret、publisher、Contents write、commit、branch、Pull Request 或 merge step。
- Target caller 不能传 model、effort、profile 或 Codex version；固定 Action 内部将 executor 锁定为 `gpt-5.6-luna/high`，reviewer 锁定为 `gpt-5.6-sol/xhigh`。
- `OPC_ENABLED` 在 execute、review 和 conclude/recover 各边界重新求值；GitHub-hosted review gate 与 `complete-run` 还必须重新读取 default branch 当前 Repository Policy 的 `enabled`。任一开关关闭后不得产生新的状态转换。
- executor 的批准时限在 checkout 前的第一个 durable step 建立为绝对 deadline，checkout、bootstrap、Codex 与全部 Evidence 共用；95 分钟 job 上限为最多 90 分钟批准预算保留清理余量。reviewer 固定 900 秒，20 分钟 job 上限同样保留收尾余量。
- heartbeat 的 165 分钟上限覆盖 30 分钟排队 lease、95 分钟 execute 与 20 分钟 review，并留有轮询收尾余量；人工取消不得进入 `complete-run` 或自动 Recovery。

完成 setup 与 runner 检查后才启用：

```bash
rtk gh variable set OPC_ENABLED --body true --repo 0xroylee/opc-m3-sandbox
```

## 4. 每个案例的批准输入

每个案例都使用新的 Work Issue、当时 default-branch 的 40 位 `base_sha`、当前 `.codex-pipeline.yml` canonical digest，以及 owner 的未编辑 `/opc approve sha256:...`。成功案例从 `test/fixtures/mac/success-contract.yml` 派生；forbidden-path 本地边界用 `test/fixtures/mac/forbidden-path-contract.yml`。不要直接使用 fixture 中的占位 SHA。

排队命令：

```bash
rtk bun dist/cli.js queue-plan \
  --repository 0xroylee/opc-m3-sandbox \
  --contract .opc/m3-work.yml \
  --approved-digest sha256:<canonical-work-contract-digest>
```

必要时手动触发：

```bash
rtk gh workflow run opc.yml \
  --repo 0xroylee/opc-m3-sandbox \
  --ref main \
  -f reason=m3-proof \
  -f issue_number=<issue-number>
```

## 5. 真实矩阵

每次只运行一行，归档 evidence 后再准备下一行。失败注入只能通过单独、人工审查的 sandbox fixture/base/policy commit；不得替换 host Codex binary、profile、network wrapper 或 Action bundle。

| Case | 可控输入 | 必须观察到的结果 |
|---|---|---|
| success | 单文件、`src/**` 内、可由固定 unit evidence 验证的小改动 | Candidate bundle + pass review；Issue 按 `claimed → running → reviewing → result-ready` 持久化；attempt 1 completed |
| executor failure | 批准一个由 executor 结构化返回 `failed` 的 sandbox-only impossible fixture | failure record；review 未启动；消耗一个 attempt；Recovery 遵守批准预算 |
| Evidence failure | 使用人工审查的 sandbox policy，让固定 evidence command 对该 base 确定退出非零 | bundle 保留；review 未启动；消耗一个 attempt；log 已脱敏 |
| review mismatch | 使用 acceptance 与候选内容确定不一致的批准 fixture | bundle 保留；review 为 fail；消耗一个 attempt；不能进入 verified |
| duplicate trigger | success Work 在第一次 claim 后立即重复手动 dispatch | 只有一个 claim / execution；第二次为 active-claim no-op |
| timeout | 使用批准 timeout 下限和确定超时的 sandbox fixture | bootstrap、Codex 与 Evidence 共享同一个 deadline；bounded execution failure；worktree 清理；消耗一个 attempt；无遗留 Codex 进程 |
| simulated offline recovery | claim 后停止 runner service，保持 `OPC_ENABLED=true`，等待 lease expiry 与 schedule reconcile | `queued` 不产生 heartbeat；未开始的 attempt 消耗为零；回到 ready；旧 run 被取消；恢复后仍用同一 approval/base |

若某个负向 fixture 没有确定地产生目标故障，记录为未完成，不得把手工编辑 Issue label、artifact 或 review JSON 当作通过证据。

## 6. Artifact 与权限取证

对每个 run 执行：

```bash
rtk gh run view <run-id> --repo 0xroylee/opc-m3-sandbox
rtk gh run view <run-id> --log --repo 0xroylee/opc-m3-sandbox
rtk gh api repos/0xroylee/opc-m3-sandbox/actions/runs/<run-id>/artifacts
rtk gh issue view <issue-number> --comments --repo 0xroylee/opc-m3-sandbox
rtk gh pr list --state all --repo 0xroylee/opc-m3-sandbox
rtk gh api repos/0xroylee/opc-m3-sandbox/branches
```

保存并核对：

- `bundle-index.json` 的 outer digest、manifest `artifact_sha256`、每个 changed content/evidence log digest；
- Result Manifest、Result Review、criterion-to-evidence 映射与 heartbeat 首条/5 分钟节拍/最终 stopped 时间线；
- 只有 `in_progress` executor/reviewer 可以产生 running heartbeat；普通 workflow `updated_at` 与纯 queued 状态都不能续租；
- conclude 必须等待 heartbeat job；heartbeat job list 不可信、超时或失败时必须归类为 infrastructure Run Incident，不能写入 `result-ready`；
- executor 与 reviewer 是两个 fresh ephemeral session；reviewer 只下载 Candidate bundle；
- 日志和 artifacts 不含 `GITHUB_TOKEN`、Actions runtime token、API key、Codex home、`auth.json`、ChatGPT credential、环境 dump、executor conversation 或 rollout/session 文件；
- GitHub permission summary 保持 Contents read-only；没有 OPC commit、delivery branch、Pull Request 或 repository write。
- 成功 run 的 transition comments 最终为 `result-ready`；execution/evidence/review 失败由 `complete-run` 从可信 Jobs API job 与固定 step 名分类，并只占用一个批准的 Recovery attempt；OpenAI/API/runner incident 不占用 attempt。旧的 caller-supplied `recover` payload 必须被拒绝。

Branch 取证要区分 sandbox setup branch 与 OPC 新建分支；M3 预期 OPC 新建分支为零。PR 列表为空。

## 7. 收尾

矩阵完成或任何 fail-closed 条件触发后先关闭新工作：

```bash
rtk gh variable set OPC_ENABLED --body false --repo 0xroylee/opc-m3-sandbox
```

M3 result approval 必须附：本地全量门禁、Mac identity/profile/digest 检查、所有 workflow/Issue/artifact URL、权限 summary、heartbeat timeline、Candidate/Review digests、七行真实矩阵结果，以及零 OPC branch/PR 的证明。

到这里停止。不要启用 M4 publisher。删除 sandbox、deregister runner 或删除 auth/artifacts 都需要 owner 的新明确批准。
