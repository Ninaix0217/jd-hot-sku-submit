# 浏览器驱动与续跑

执行网页提报时读取。API 以当次 CUA 文档为准；语义选择器来自实际页面，页面变化后先重新读取 DOM。

## 使用引擎

在 CUA JS 会话完成浏览器/标签页绑定与文档读取后导入本地模块。网站动作全部通过绑定工具 API。

```js
var fs = await import('node:fs/promises');
var mod = await import('file:///ABSOLUTE_SKILL_PATH/scripts/submit_engine.mjs');
var manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
var restored = checkpointPath ? JSON.parse(await fs.readFile(checkpointPath, 'utf8')) : null;
// 当前会话有提交授权后才调用 init()/runSlice()。
var driver = mod.createCuaDriver({
  tab, browser, image: manifest.image,
  bindOpenedTab: id => cua.getTab(id, {browser: browser.browserId}),
});
var runner = mod.createRunner({
  manifest, restored, driver,
  save: mod.createCheckpointWriter({fs, batchPath: batchCheckpoint, poolPath: sharedPoolCheckpoint}),
});
await runner.init();
nodeRepl.write(await runner.runSlice({maxSteps:25, budgetMs:30000}));
```

路径均为参数。模块导入不支持时，在 CUA 中按源码与当次受支持方法实现等价流程，不改用外部 Playwright/CDP 程序。

同批续跑使用完整状态；新批次用 `pool:{poolId,cursor,usedKeys}` 传入最新共享池。`needs_attention/daily_limit` 的恢复用 `resume()`，先核对页面；不能仅改状态再重发。

检查点写入器先原子保存批次，再更新共享池。共享池带 `latestBatch`。若中断恰好发生在两次保存之间，恢复时比较最近批次的游标与共享池，使用已落盘的最新批次，并核对当前 SKU；不能退回旧游标。

旧格式检查点如果只有 `linkCursor`，先核对原始清单的有序链接与新清单完全一致，再取新清单的真实指纹、旧游标，并从历次成功记录的实际 URL 经 `productKey()` 汇总 `usedKeys`。不能凭相同文件名给不明旧池补指纹。迁移新文件并保留原记录；同时读取待提报文件，避免遗漏每日额度阻塞项。

## 页面定位

- 筛选：抽屉关闭时 `getByRole('textbox',{name:'SKU编号',exact:false})`，避免匹配抽屉 SKU。
- 抽屉字段：textbox 精确名称“商品SKU编号 *”“同款链接 *”。
- 图片 group：精确名称“同款商品主图 *”“同款商品规格图 *”。另有“商品主图”区域，不是这两处目标。
- 按钮：新建提报商品、返回、查询、提交，精确匹配。
- 成功行：用 `SKU编号：<sku>` 过滤，再核对编号，不能依赖 DOM 断行。筛选包括本批全部 SKU，必要时 100条/页，防止成功被筛掉。

先注册 `waitForEvent('filechooser')`，点击目标区域“上传图片”，再 `setFiles([absoluteImagePath])`。区域 `li.is-success` 与页面状态确认上传；不调用未公开上传接口。

提交时只读 DOM 取按钮 `getBoundingClientRect()`，再受支持的 `tab.click(point,{clickCount:3})`。evaluate 不用于点击、分发事件、调用业务函数或抓接口。每次动作后做支撑下一步的轻量状态读取，可用 `getAXState({emit:false})`，不逐候选输出完整树/截图。

## 恢复要点

- 成功晚到：下一链接填入前/填入时表单消失，查当前 SKU，读实际绑定 URL。
- 查看链接新页晚出现：刷新状态再列标签页；必要时再点击一次这个只读入口。确切接管/关闭自己新开的临时页，不关用户原有页。
- 中断丢变量：从检查点重建对象，先核对当前 SKU，不重置游标。
- 连续三击在实际工作中使用，但离线验证不能证明后端每次在两秒内产生三次 click；不明确时核实受支持能力。

## 输入与状态

清单：`{poolId,skus:[{sku,row?}],links:[{url,row?}],image,sku_file?,link_file?}`。指纹绑定有序 URL 内容，文件名相同不等于同一池。

状态：`{version,poolId,skuOrder,status,cursor,usedKeys,records,pending}`。`pending` 含当前 SKU、SKU 起始游标、50 次复查计数、阶段与提交意图。

`records` 仅记录 `success/existing`。`daily_limit/links_exhausted/needs_attention` 是整批停止状态，不算已完成；`pending` 和未完成清单保留。
