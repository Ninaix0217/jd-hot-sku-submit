// Import inside CUA JS for live use. Tests may supply an entirely offline driver.
import path from 'node:path';

export function createCheckpointWriter({fs, batchPath, poolPath}) {
  if (path.resolve(batchPath) === path.resolve(poolPath)) throw new Error('Batch/pool paths must differ');
  async function atomic(target, data) {
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target + '.tmp', JSON.stringify(data, null, 2));
    await fs.rename(target + '.tmp', target);
  }
  return async state => {
    await atomic(batchPath, state);
    await atomic(poolPath, {poolId: state.poolId, cursor: state.cursor,
      usedKeys: state.usedKeys, latestBatch: batchPath});
  };
}
export function classifySku(text = '', {invalid = false} = {}) {
  const s = text.replace(/\s+/g, '').toLowerCase();
  const quota = s.match(/单日提报sku数量已达上限[:：]?(\d+)/);
  if (quota) return {kind: 'daily_limit', limit: Number(quota[1]), message: text};
  if (s.includes('sku对应的spu已存在')) return {kind: 'spu_exists', message: text};
  if (invalid) return {kind: 'unknown_error', message: text};
  return {kind: 'valid', message: text};
}

export function productKey(url) {
  const u = new URL(url);
  const id = u.searchParams.get('id');
  return id ? `${u.hostname}${u.pathname}?id=${id}` : url;
}

export function createRunner({manifest, driver, save, restored = null, pool = null}) {
  const order = [...new Set(manifest.skus.map(x => String(x.sku)))];
  if (!manifest.poolId || !order.length || order.some(x => !/^\d+$/.test(x)))
    throw new Error('Manifest requires poolId and nonempty numeric SKU strings');
  for (const x of manifest.links) {
    const u = new URL(x.url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Invalid candidate URL');
  }
  if ((restored && restored.poolId !== manifest.poolId) || (pool && pool.poolId !== manifest.poolId))
    throw new Error('Link pool fingerprint changed; do not reuse cursor');
  if (restored && JSON.stringify(restored.skuOrder) !== JSON.stringify(order))
    throw new Error('Different SKU batch; pass shared pool instead of full restored state');
  const state = restored ? structuredClone(restored) : {
    version: 1, poolId: manifest.poolId, skuOrder: order, status: 'running',
    cursor: pool?.cursor ?? 0, usedKeys: [...(pool?.usedKeys ?? [])], records: [], pending: null,
  };
  if (!Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor > manifest.links.length)
    throw new Error('Cursor out of bounds');
  const persist = () => save(structuredClone(state));
  const completed = sku => state.records.some(r => r.sku === sku);
  const summary = () => ({status: state.status, total: order.length,
    processed: state.records.length, successes: state.records.filter(r => r.status === 'success').length,
    cursor: state.cursor, currentSku: state.pending?.sku ?? null});

  async function existing(reason) {
    const p = state.pending;
    // These attempts were caused by an invalid SKU, not proof of occupied links.
    state.cursor = p.startCursor;
    state.records.push({sku: p.sku, status: 'existing', reason});
    state.pending = null;
    state.status = 'running';
    await persist();
    await driver.closeForm();
  }
  async function applySignal(signal) {
    if (signal.kind === 'unknown_error') {
      state.status = 'needs_attention';
      state.stopReason = signal.message || 'Unknown SKU validation error';
      await persist();
      return true;
    }
    if (signal.kind === 'daily_limit') {
      state.status = 'daily_limit';
      state.stopReason = signal.message;
      state.limit = signal.limit;
      await persist();
      return true;
    }
    if (signal.kind === 'spu_exists') {
      // A delayed submission may have created the exact SKU while the form stayed open.
      const record = state.pending?.intent ? await driver.readRecord(state.pending.sku, false) : null;
      if (record) await confirm(record);
      else await existing(signal.message);
      return true;
    }
    return false;
  }
  async function confirm(record) {
    const p = state.pending;
    if (!record || record.sku !== p.sku) {
      state.status = 'needs_attention';
      state.stopReason = 'Form closed without a matching SKU record';
      p.phase = 'reconcile';
      await persist();
      return;
    }
    const rec = {...record, sku: p.sku, status: 'success', link: null};
    state.records.push(rec);
    state.pending = null;
    await persist(); // Success survives a subsequent URL-reading interruption.
    try {rec.link = await driver.readBindingURL(rec.sku);} catch {rec.link = null;}
    if (rec.link && !state.usedKeys.includes(productKey(rec.link))) state.usedKeys.push(productKey(rec.link));
    await persist();
  }
  async function step() {
    if (state.status !== 'running') return summary();
    if (!state.pending) {
      const sku = order.find(x => !completed(x));
      if (!sku) {state.status = 'complete'; await persist(); return summary();}
      const old = await driver.readRecord(sku, false);
      if (old) {
        state.records.push({...old, sku, status: 'existing', reason: 'List record already exists'});
        await persist();
        return summary();
      }
      state.pending = {sku, startCursor: state.cursor, tries: 0, phase: 'preparing', intent: null};
      await persist();
    }
    const p = state.pending;
    if (p.phase === 'preparing') {
      await driver.openSku(p.sku);
      const early = await driver.readSignal();
      // Only quota is terminal before images; SPU is checked after both uploads.
      if (early.kind === 'daily_limit') {await applySignal(early); return summary();}
      await driver.uploadImages();
      if (await applySignal(await driver.readSignal())) return summary();
      p.phase = 'prepared';
      await persist();
      return summary();
    }
    if (!(await driver.formOpen())) {await confirm(await driver.readRecord(p.sku, true)); return summary();}
    if (!(await driver.matchesSku(p.sku))) throw new Error('Current form SKU differs from pending SKU');
    if (p.tries >= 50) {
      p.tries = 0;
      if (await applySignal(await driver.readSignal())) return summary();
      await persist();
    }
    while (state.cursor < manifest.links.length && state.usedKeys.includes(productKey(manifest.links[state.cursor].url)))
      state.cursor++;
    if (state.cursor >= manifest.links.length) {
      state.status = 'links_exhausted'; await persist(); return summary();
    }
    const index = state.cursor++;
    p.intent = {index, url: manifest.links[index].url};
    p.phase = 'intent';
    await persist(); // Before the external action, including before filling the URL.
    await driver.submitTriple(p.intent.url);
    p.phase = 'submitted';
    p.tries++;
    await persist();
    if (!(await driver.formOpen())) await confirm(await driver.readRecord(p.sku, true));
    return summary();
  }
  async function safelyStep() {
    try {return await step();} catch (error) {
      if (state.pending) {
        try {
          if (!(await driver.formOpen())) {
            const record = await driver.readRecord(state.pending.sku, true);
            if (record) {await confirm(record); return summary();}
          } else if (await applySignal(await driver.readSignal())) return summary();
        } catch { /* Preserve the original error and uncertain intent. */ }
        if (state.pending) state.pending.phase = 'reconcile';
      }
      state.status = 'needs_attention';
      state.stopReason = String(error.message ?? error);
      await persist();
      return summary();
    }
  }
  return {
    state, summary,
    poolState: () => ({poolId: state.poolId, cursor: state.cursor, usedKeys: [...state.usedKeys]}),
    async init() {await driver.prepareBatch(order, Boolean(state.pending)); await persist(); return summary();},
    async resume() {
      if (state.pending) {
        const open = await driver.formOpen();
        const rec = await driver.readRecord(state.pending.sku, !open);
        if (rec) {state.status = 'running'; await confirm(rec);}
        else if (await driver.formOpen()) {
          if (state.status === 'daily_limit') await driver.revalidateSku(state.pending.sku);
          if (await applySignal(await driver.readSignal())) return summary();
          if (!(await driver.matchesSku(state.pending.sku))) {
            state.status = 'needs_attention';
            state.stopReason = 'Current form SKU differs from pending SKU';
            await persist();
            return summary();
          }
          await driver.uploadImages();
          if (await applySignal(await driver.readSignal())) return summary();
          state.pending.phase = 'prepared';
          state.status = 'running';
        } else if (!state.pending.intent && state.pending.tries === 0) {
          state.status = 'running';
          state.pending.phase = 'preparing';
        } else {
          state.status = 'needs_attention';
          state.stopReason = 'Uncertain prior submission; reconcile SKU with the list before reopening';
        }
      } else if (state.status === 'needs_attention') state.status = 'running';
      await persist();
      return summary();
    },
    async verifyLinks() {
      for (const rec of state.records.filter(x => x.status === 'success' && !x.link)) {
        rec.link = await driver.readBindingURL(rec.sku);
        if (rec.link && !state.usedKeys.includes(productKey(rec.link))) state.usedKeys.push(productKey(rec.link));
        await persist();
      }
      return state.records.filter(x => x.status === 'success' && !x.link).map(x => x.sku);
    },
    async runSlice({maxSteps = 25, budgetMs = 30000} = {}) {
      const start = Date.now();
      for (let n = 0; n < maxSteps && Date.now() - start < budgetMs && state.status === 'running'; n++)
        await safelyStep();
      return summary();
    },
  };
}

export function createCuaDriver({tab, browser, image, bindOpenedTab}) {
  const skuField = () => tab.playwright.getByRole('textbox', {name: '商品SKU编号 *', exact: true});
  const button = name => tab.playwright.getByRole('button', {name, exact: true});
  const row = sku => tab.playwright.getByRole('row').filter({hasText: 'SKU编号：' + sku});
  const refresh = () => tab.getAXState({emit: false});
  const formOpen = () => skuField().isVisible();
  async function closeForm() {if (await formOpen()) {await button('返回').click(); await refresh();}}
  async function uploadOne(label) {
    const group = tab.playwright.getByRole('group', {name: label, exact: true});
    const ready = () => group.locator('li.is-success', {}).count();
    if (await ready()) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const pick = tab.playwright.waitForEvent('filechooser', {timeoutMs: 10000});
        // Prevent an unhandled chooser rejection if click fails before awaiting pick.
        const outcome = pick.then(value => ({value}), error => ({error}));
        await group.getByText('上传图片', {exact: true}).click();
        const result = await outcome;
        if (result.error) throw result.error;
        await result.value.setFiles([image]);
        await refresh();
        await group.locator('li.is-success', {}).waitFor({state: 'visible', timeoutMs: 10000});
        return;
      } catch (e) {
        if (attempt || !/Timed out.*file chooser/i.test(e.message ?? '')) throw e;
        await refresh();
        if (await ready()) return;
      }
    }
  }
  return {
    formOpen, closeForm,
    async prepareBatch(skus, preserve) {
      if (preserve && await formOpen()) return;
      await closeForm();
      await tab.playwright.getByRole('textbox', {name: 'SKU编号', exact: false}).fill(skus.join(','));
      await button('查询').click();
      await refresh();
      if (!(await tab.playwright.getByText('100条/页', {exact: true}).isVisible())) {
        await tab.playwright.getByText(/^\d+条\/页$/).filter({visible: true}).click();
        await refresh();
        await tab.playwright.getByText('100条/页', {exact: true}).click();
        await refresh();
      }
    },
    async openSku(sku) {
      await closeForm();
      await button('新建提报商品').click();
      await skuField().fill(sku);
      await skuField().press('Tab');
      await refresh();
    },
    matchesSku: sku => skuField().evaluate(e => e.value).then(value => value === sku),
    async revalidateSku(sku) {
      await skuField().fill('');
      await skuField().fill(sku);
      await skuField().press('Tab');
      await refresh();
    },
    async readSignal() {
      if (!(await formOpen())) return classifySku('');
      const signal = await skuField().evaluate(e => {
        const group = e.closest('.jd-form-item');
        return {text: group?.innerText ?? '',
          invalid: e.getAttribute('aria-invalid') === 'true' || Boolean(group?.classList.contains('is-error'))};
      });
      return classifySku(signal.text, {invalid: signal.invalid});
    },
    async uploadImages() {
      for (const label of ['同款商品主图 *', '同款商品规格图 *']) await uploadOne(label);
    },
    async submitTriple(url) {
      if (!(await formOpen())) return;
      const field = tab.playwright.getByRole('textbox', {name: '同款链接 *', exact: true});
      await field.fill(url);
      await field.press('Tab');
      if (!(await formOpen())) return;
      const point = await button('提交').evaluate(e => {
        const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
      });
      await tab.click(point, {clickCount: 3});
      await refresh();
    },
    async readRecord(sku, wait) {
      const target = row(sku);
      if (wait) {try {await target.waitFor({state: 'visible', timeoutMs: 5000});} catch {return null;}}
      else if (!(await target.isVisible())) return null;
      const message = await target.innerText();
      if (!new RegExp('SKU编号[:：]\\s*' + sku + '(?!\\d)').test(message)) return null;
      const cells = await target.getByRole('cell').allTextContents({});
      return {sku, message, auditStatus: cells.at(-2)?.trim() ?? '',
        submittedAt: message.match(/20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0] ?? ''};
    },
    async readBindingURL(sku) {
      const before = await browser.tabs.list();
      let fresh;
      for (let n = 0; n < 2 && !fresh; n++) {
        await row(sku).getByText('查看链接', {exact: true}).click();
        await refresh();
        const created = (await browser.tabs.list()).filter(t => !before.some(b => b.id === t.id));
        if (created.length > 1) throw new Error('Multiple new tabs; inspect before closing any');
        fresh = created[0];
      }
      if (!fresh?.url) return null;
      const opened = await bindOpenedTab(fresh.id);
      await opened.close();
      return fresh.url;
    },
  };
}
