# Ozon 稳定版第一阶段实现

本目录以 `agent/sustain-ozon-publishing @ b4933911e53721839c585fb9c423208712f5e404` 为开发基线。
现网 FlowHub 不会被此目录启动或修改。

## 已实现

- `src/contracts/candidate.mjs`：FlowHub 种子输出的 CandidateEnvelope 校验。
- `src/contracts/review.mjs`：FlowHub 审核输出的 ReviewDecision 校验。
- `src/adapters/flowhub-seed-adapter.mjs`：只读种子适配器，只返回候选和游标。
- `src/adapters/flowhub-review-adapter.mjs`：审核适配器，不拥有发布权限。
- `src/core/task-store.mjs`：原子 JSON 持久化、任务状态转换、租约和事件记录。
- `src/app/orchestrator.mjs`：来源、审核、发布三个阶段的独立推进和错误隔离。
- `src/cli/ozon-app.mjs`：独立数据目录初始化和状态查看命令。

## 运行

```sh
npm install
npm run test:stable-core
npm run app:init -- ./data-dev
npm run app:status -- ./data-dev
```

真实来源、真实审核和真实发布必须在适配器中注入。当前测试使用假数据，不会访问 Ozon、ERP、1688 或生产 FlowHub。

## 接入 FlowHub 的规则

FlowHub 只能通过 `FlowHubSeedAdapter` 和 `FlowHubReviewAdapter` 接入。适配器可以调用明确的 HTTP、命令行或本地受控进程接口，但不能导入 FlowHub 工作目录、共享其 SQLite、读取日志猜状态或拥有发布凭据。每次请求必须带候选的 `evidence_revision`，审核结果必须回传同一版本。

下一阶段先实现本地文件/HTTP 合同测试，再接入冻结的 FlowHub 审核实现；完成黄金样例一致性后才考虑改写审核语言。发布器沿用目标分支现有 `publish-runner`，迁移时必须把 accepted、回查、库存确认和 unknown 状态接入 `TaskStore`。
