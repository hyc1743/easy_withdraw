
## 多搬砖任务并行执行

- 在搬砖页填写一组配置，点击“添加并启动任务”，修改配置后再次添加。
- 分别添加 CEX 到 DEX、DEX 到 CEX 任务，确认列表同时显示运行中。
- 点击不同任务，确认详情、日志和进度对应所选任务，刷新页面后仍能看到全部运行任务。
- 停止其中一个任务，确认其余任务继续刷新和执行；点击“继续”恢复该任务。
- 在操作尚未结束时停止任务，确认当前操作结束后不会再次调度；删除任务后不会重新出现。
- 服务重启后，有下次执行时间的任务恢复调度；执行中断且结果不确定的任务保持停止，避免自动重复执行。
- 非搬砖任务仍维持原有互斥规则。停止不会撤回已经提交的提现或链上交易。
- 自动回归（使用隔离数据目录）：
  `EW_DATA_DIR=$(mktemp -d) node --import tsx --test tests/tasks-multiple-arbitrage.test.ts tests/tasks-runtime.test.ts tests/tasks-hydration-interrupted.test.ts`
