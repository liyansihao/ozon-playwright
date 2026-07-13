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

## 测试

```bash
npm test
```

当前精简发布版测试基线：Node 84 项、Python 4 项。

## 安全说明

- 仓库不包含插件文件、浏览器配置、Cookie、访问令牌、运行日志或商品数据。
- `publish` 和 `run` 会产生真实上架操作；首次使用请先运行 `verify`，再用小目标测试。
- 利润结果依赖 Ozon 页面信息、1688 搜索匹配和 MaoziERP 计算结果，正式批量运行前应人工抽查。
