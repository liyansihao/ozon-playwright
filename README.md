# Ozon Playwright 版本

基于 Playwright Chrome 的 Ozon → MaoziERP → 1688 批量选品与上架流程。

主要能力：

- 使用持久化 Chrome 配置与解压版 Maozi 插件
- 扫描 Ozon 商品来源并在收藏前校验纯 FBS
- 通过 1688 图片搜索与价格聚类估算采购成本
- 严格执行利润率门槛（默认 `> 30%`）
- 匹配店铺和水印后逐条提交上架
- 失败记录后继续下一个商品
- 支持断点续跑、去重、并发预检与精确目标控制

## 环境要求

- Node.js 20+
- Python 3.10+
- Chrome / Chromium
- 已解压的 Maozi 采集插件目录
- 有效的 Ozon、MaoziERP 与 1688 登录状态

## 安装

```bash
npm install
python3 -m pip install -r requirements.txt
```

## 初始化浏览器登录

```bash
export FLOW_B_EXTENSION_DIR=/absolute/path/to/maozi-plugin
export FLOW_B_PW_PROFILE=/absolute/path/to/playwright-profile
npm run flow:b:setup
```

浏览器打开后完成 Ozon 和 MaoziERP 登录，再按 `Ctrl+C` 结束初始化。

## 只读校验

```bash
export FLOW_B_STORE_NEEDLE='丽丽1号'
export FLOW_B_WATERMARK_NEEDLE='lysh'
node flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs verify
```

## 批量运行

先准备一个文本文件，每行一个 Ozon 卖家、分类、专区或搜索页 URL：

```bash
export FLOW_B_TARGET_PUBLISH_COUNT=100
export FLOW_B_PROFIT_THRESHOLD=30
export FLOW_B_TARGET_FAVORITES=160
export FLOW_B_PUBLISH_WORKERS=4

node flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs run \
  /absolute/path/to/run-dir \
  /absolute/path/to/source-urls.txt
```

也可以分步执行：

```bash
node flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs scan source-urls.txt source-scan.json
node flow_b_codex_transfer_20260608/scripts/flow_b_playwright.mjs publish /absolute/path/to/run-dir
```

## 连续验收与 24 小时运行

监督脚本会固定验收窗口和运行目录。浏览器意外退出时会沿用原窗口、登录配置和已发布计数继续运行：

```bash
export FLOW_B_EXTENSION_DIR=/absolute/path/to/maozi-plugin
export FLOW_B_PW_PROFILE=/absolute/path/to/playwright-profile
export FLOW_B_MAOZI_CONTINUE_LOGIN=1
export FLOW_B_STORE_ID=104965 FLOW_B_WATERMARK_ID=60822
export FLOW_B_STORE_NEEDLE='丽丽1号' FLOW_B_WATERMARK_NEEDLE='lysh'
export FLOW_B_ACCEPTANCE_SECONDS=86400 FLOW_B_ACCEPTANCE_TARGET=600
export FLOW_B_TARGET_PUBLISH_COUNT=720 FLOW_B_EXCLUDED_SKUS=2815247918
export FLOW_B_PUBLISH_WORKERS=8 FLOW_B_MAX_PUBLISH_WORKERS=12
export FLOW_B_TAB_WORKERS=6 FLOW_B_MAX_TAB_WORKERS=10 FLOW_B_FAVORITE_WORKERS=6
export FLOW_B_TARGET_FAVORITES=1000 FLOW_B_MAX_LINKS_PER_SOURCE=12
export FLOW_B_POLL_INTERVAL_MS=5000 FLOW_B_PRODUCER_INTERVAL_MS=10000
export FLOW_B_SKIP_RETAINED=1 FLOW_B_LOW_DELTA_BATCH_LIMIT=0
export FLOW_B_RESTART_DELAY_SECONDS=5

flow_b_codex_transfer_20260608/scripts/run_acceptance_supervised.sh \
  /absolute/path/to/new-run-dir \
  /absolute/path/to/source-urls.txt
```

可通过 `FLOW_B_SOURCE_YIELD_SEED_FILES`、`FLOW_B_STATE_SEED_FILES` 和 `FLOW_B_FAVORITE_SEED_FILES` 指向上一轮 JSONL 文件，以继承来源收益和终态排重。采集端会把高收益已扫描来源切成 60 条反馈小批；网络失败会降低并发，Ozon 软拦截会触发移动冷却。验收产物包括 `acceptance_summary.json`、`published.jsonl`、`sku_states.jsonl`、`favorite_collection.jsonl`、阶段耗时和来源收益。

## 测试

```bash
npm test
```

2026-07-14 完整测试基线：Node 106 项、Python 9 项。固定两小时真实窗口确认 52 个有效唯一 SKU，速度 26 个/小时；所有计数商品利润率严格大于 30%。

## 安全说明

- 仓库不包含插件文件、浏览器配置、Cookie、访问令牌、运行日志或商品数据。
- `publish` 和 `run` 会产生真实上架操作；首次使用请先运行 `verify`，再用小目标测试。
- 利润结果依赖 Ozon 页面信息、1688 搜索匹配和 MaoziERP 计算结果，正式批量运行前应人工抽查。
