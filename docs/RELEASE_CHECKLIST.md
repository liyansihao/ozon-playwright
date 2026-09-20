# 稳定版交付检查

这份代码目前默认是模拟模式，运行 `npm run app:demo` 不会访问真实店铺。

正式发行前必须完成：

1. 在全新 Windows 11 和 macOS Apple Silicon 上执行 `npm ci`。
2. 执行 `npm test`，保存完整日志。
3. 用脱敏候选跑 `npm run app:demo`，检查候选、审核、发布、状态查询。
4. 关闭进程后重新运行状态命令，确认任务仍然保存。
5. 把 FlowHub 种子和审核连接到版本化 HTTP 或命令协议，不能导入 FlowHub 目录或共享数据库。
6. 把现有 publish-runner 封装成 PublisherPort；发布前先持久化 operation，accepted 后必须回查，unknown 不得重发。
7. 在测试店铺完成少量授权真实验证，再进行24小时和72小时稳定观察。
8. 通过后设置 `OZON_ALLOW_PRODUCTION_WRITES=1`，并由用户单独授权生产切换。

`npm run package:release` 只生成可审查的 npm 发布包和 manifest，不代表已经允许真实上架。
