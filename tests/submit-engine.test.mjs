import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRunner, createCuaDriver, createCheckpointWriter, classifySku, productKey} from '../skills/jd-hot-sku-submit/scripts/submit_engine.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const links = Array.from({length: 80}, (_, i) => ({url: `https://haohuo.jinritemai.com/detail?id=${i}`}));
const manifest = (skus = ['111']) => ({poolId: 'same-pool', skus: skus.map(sku => ({sku})), links});
class Mock {
  constructor(opts = {}) {this.opts = opts; this.open = false; this.calls = []; this.records = new Map(); this.submits = []; this.uploads = 0; this.signalReads = 0; this.postReads = 0;}
  async prepareBatch() {this.calls.push('prepareBatch');}
  async openSku(sku) {this.sku = sku; this.open = true; this.calls.push('open:' + sku);}
  async closeForm() {this.open = false;}
  async formOpen() {
    if (this.opts.delayed && this.submits.length === 1 && ++this.postReads >= 2) this.open = false;
    return this.open;
  }
  async matchesSku(sku) {return sku === this.sku;}
  async uploadImages() {this.uploads++; this.calls.push('upload');}
  async revalidateSku() {this.calls.push('revalidate'); if (this.opts.resetQuota) this.opts.quota = false;}
  async readSignal() {
    this.signalReads++;
    if (this.opts.quota) return classifySku('单日提报sku数量已达上限：20');
    if (this.opts.invalidSku) return classifySku('商品不存在', {invalid: true});
    if ((this.opts.spuAfterUpload && this.uploads > 0) ||
        (this.opts.lateSpu && this.sku === '111' && this.submits.length >= 50))
      return classifySku('sku对应的spu已存在');
    return classifySku('');
  }
  async submitTriple(url) {
    this.submits.push({sku: this.sku, url});
    if (this.opts.success || this.opts.delayed || this.opts.throwAfterSuccess) {
      this.records.set(this.sku, {sku: this.sku, auditStatus: '审核中', submittedAt: '2026-10-04 10:00:00'});
      this.open = Boolean(this.opts.delayed);
    }
    if (this.opts.closeWithoutRecord) this.open = false;
    if (this.opts.throwAfterSuccess) throw new Error('Button disappeared');
  }
  async readRecord(sku) {return this.records.get(sku) ?? null;}
  async readBindingURL() {return this.opts.actualURL ?? this.submits.at(-1)?.url ?? null;}
}
function setup(d, m = manifest(), more = {}) {
  const saved = [];
  const r = createRunner({manifest: m, driver: d, save: async s => saved.push(s), ...more});
  return {r, saved};
}

test('quota priority, whitespace variants and debounce semantics', () => {
  assert.equal(classifySku('SKU 对应的 SPU 已存在').kind, 'spu_exists');
  const q = classifySku('sku对应的spu已存在 单日提报SKU数量已达上限:25');
  assert.equal(q.kind, 'daily_limit'); assert.equal(q.limit, 25);
  assert.equal(classifySku('请不要重复提交，请稍后再试').kind, 'valid');
});
test('pool fingerprint / different SKU batch cannot silently reuse full checkpoint', () => {
  assert.throws(() => setup(new Mock(), manifest(), {pool: {poolId: 'changed', cursor: 10}}), /fingerprint/);
  const {r} = setup(new Mock());
  assert.throws(() => setup(new Mock(), manifest(['222']), {restored: r.state}), /Different SKU batch/);
});
test('quota before images stops the entire batch, consumes no candidate and retains SKU', async () => {
  const d = new Mock({quota: true}), {r} = setup(d, manifest(['111', '222']));
  await r.init(); await r.runSlice();
  assert.equal(r.state.status, 'daily_limit'); assert.equal(r.state.pending.sku, '111');
  assert.equal(d.uploads, 0); assert.equal(d.submits.length, 0); assert.equal(r.state.cursor, 0);
  assert.equal(r.state.records.length, 0);
});
test('SPU is checked after both images, not treated as success', async () => {
  const d = new Mock({spuAfterUpload: true}), {r} = setup(d);
  await r.init(); await r.runSlice();
  assert.equal(d.uploads, 1); assert.equal(d.submits.length, 0);
  assert.equal(r.state.records[0].status, 'existing'); assert.equal(r.state.status, 'complete');
});
test('explicit unknown SKU validation error stops without draining candidate pool', async () => {
  const d = new Mock({invalidSku: true}), {r} = setup(d);
  await r.init(); await r.runSlice();
  assert.equal(r.state.status, 'needs_attention'); assert.equal(d.submits.length, 0);
  assert.equal(r.state.cursor, 0); assert.equal(r.state.pending.sku, '111');
});
test('50 unsuccessful candidates trigger one SKU recheck and recover pool for next SKU', async () => {
  const d = new Mock({lateSpu: true}), {r} = setup(d, manifest(['111', '222']));
  await r.init(); await r.runSlice({maxSteps: 52});
  assert.equal(d.submits.length, 50); assert.equal(d.signalReads, 3); // early, after images, after 50
  assert.equal(r.state.cursor, 0); assert.equal(r.state.records[0].status, 'existing');
  await r.runSlice({maxSteps: 2});
  assert.equal(d.submits.at(-1).sku, '222'); assert.equal(d.submits.at(-1).url, links[0].url);
});
test('delayed closure is reconciled before another URL, actual binding beats last intent', async () => {
  const actualURL = links[7].url;
  const d = new Mock({delayed: true, actualURL}), {r} = setup(d);
  await r.init(); await r.runSlice();
  assert.equal(d.submits.length, 1); assert.equal(r.state.status, 'complete');
  assert.equal(r.state.records[0].link, actualURL);
});
test('button timeout after real success does not cause resubmission', async () => {
  const d = new Mock({throwAfterSuccess: true}), {r} = setup(d);
  await r.init(); await r.runSlice();
  assert.equal(d.submits.length, 1); assert.equal(r.state.records.length, 1);
  assert.equal(r.state.records[0].status, 'success');
});
test('closed form without exact SKU is uncertain, even after resume', async () => {
  const d = new Mock({closeWithoutRecord: true}), {r} = setup(d);
  await r.init(); await r.runSlice(); await r.resume(); await r.runSlice();
  assert.equal(r.state.status, 'needs_attention'); assert.equal(d.submits.length, 1);
  assert.equal(r.state.records.length, 0); assert.equal(r.state.pending.sku, '111');
});
test('existing list record skips without uploading or submitting', async () => {
  const d = new Mock(); d.records.set('111', {sku: '111'}); const {r} = setup(d);
  await r.init(); await r.runSlice();
  assert.equal(r.state.records[0].status, 'existing'); assert.equal(d.uploads, 0);
  assert.equal(d.submits.length, 0);
});
test('confirmed product is excluded even with different tracking params', async () => {
  const d = new Mock({success: true});
  const {r} = setup(d, manifest(), {pool: {poolId: 'same-pool', cursor: 0,
    usedKeys: [productKey(links[0].url + '&origin_type=604')]}});
  await r.init(); await r.runSlice();
  assert.equal(d.submits[0].url, links[1].url);
});
test('saved intent with late success resumes without another click', async () => {
  const first = setup(new Mock()).r.state;
  first.pending = {sku: '111', startCursor: 0, tries: 0, phase: 'intent', intent: {index: 0, url: links[0].url}};
  first.cursor = 1; first.status = 'needs_attention';
  const d = new Mock(); d.records.set('111', {sku: '111'}); d.opts.actualURL = links[0].url;
  const {r} = setup(d, manifest(), {restored: first});
  await r.init(); await r.resume(); await r.runSlice();
  assert.equal(d.submits.length, 0); assert.equal(r.state.records[0].status, 'success');
  assert.equal(r.state.status, 'complete');
});
test('daily resume revalidates actual page quota rather than assuming midnight reset', async () => {
  const d = new Mock({quota: true, success: true}), {r} = setup(d);
  await r.init(); await r.runSlice(); await r.resume();
  assert.equal(r.state.status, 'daily_limit'); assert.equal(d.submits.length, 0);
  d.opts.resetQuota = true;
  await r.resume(); await r.runSlice();
  assert.equal(r.state.status, 'complete'); assert.equal(d.submits.length, 1);
  assert.ok(d.calls.includes('revalidate'));
});
test('quota during 50-check stops batch, no later SKU is opened', async () => {
  const d = new Mock(), {r} = setup(d, manifest(['111', '222']));
  await r.init(); await r.runSlice({maxSteps: 51});
  d.opts.quota = true;
  await r.runSlice();
  assert.equal(r.state.status, 'daily_limit'); assert.equal(d.submits.length, 50);
  assert.deepEqual(d.calls.filter(x => x.startsWith('open:')), ['open:111']);
});
test('exhausted link pool retains uncompleted SKU', async () => {
  const d = new Mock(); const {r} = setup(d, {...manifest(), links: [links[0]]});
  await r.init(); await r.runSlice();
  assert.equal(r.state.status, 'links_exhausted'); assert.equal(r.state.pending.sku, '111');
  assert.equal(r.state.records.length, 0); assert.equal(d.submits.length, 1);
});
test('late SPU plus an exact new SKU record is success, not a false skip', async () => {
  const d = new Mock({lateSpu: true}), {r} = setup(d);
  await r.init(); await r.runSlice({maxSteps: 51});
  d.records.set('111', {sku: '111'});
  await r.runSlice();
  assert.equal(r.state.status, 'complete'); assert.equal(r.state.records[0].status, 'success');
  assert.equal(d.submits.length, 50); assert.equal(r.state.cursor, 50);
});

function uploadTab(failure) {
  const images = new Map(), clicks = [], writes = [];
  let chooseCount = 0, clickedGroup;
  const tab = {
    getAXState: async () => '',
    playwright: {
      waitForEvent: () => {
        chooseCount++;
        if (chooseCount === 1 && failure) return Promise.reject(new Error(failure));
        return Promise.resolve({setFiles: async files => {images.set(clickedGroup, true); writes.push({group: clickedGroup, files});}});
      },
      getByRole: (_role, {name}) => ({
        locator: () => ({count: async () => images.has(name) ? 1 : 0, waitFor: async () => {assert.ok(images.has(name));}}),
        getByText: () => ({click: async () => {clickedGroup = name; clicks.push(name);}}),
      }),
    },
  };
  return {tab, images, clicks, writes, count: () => chooseCount};
}
test('chooser timeout is retried once; completed image is never uploaded twice', async () => {
  const fake = uploadTab('Timed out after 10000ms waiting for file chooser.');
  const d = createCuaDriver({tab: fake.tab, image: 'image.png'});
  await d.uploadImages(); await d.uploadImages();
  assert.equal(fake.count(), 3); assert.equal(fake.writes.length, 2);
  assert.equal(new Set(fake.writes.map(x => x.group)).size, 2);
});
test('approval rejection is not retried as an upload timeout', async () => {
  const fake = uploadTab('Automatic approval review rejected this upload');
  const d = createCuaDriver({tab: fake.tab, image: 'image.png'});
  await assert.rejects(() => d.uploadImages(), /rejected/);
  assert.equal(fake.count(), 1); assert.equal(fake.writes.length, 0);
});
test('checkpoint writer survives updates and preserves batch/pool provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-skill-test-'));
  const batchPath = path.join(root, 'batch', 'checkpoint.json');
  const poolPath = path.join(root, 'shared.json');
  const write = createCheckpointWriter({fs, batchPath, poolPath});
  const state = setup(new Mock()).r.state;
  await write(state); state.cursor = 12; await write(state);
  assert.equal(JSON.parse(await fs.readFile(batchPath, 'utf8')).cursor, 12);
  const shared = JSON.parse(await fs.readFile(poolPath, 'utf8'));
  assert.equal(shared.cursor, 12); assert.equal(shared.latestBatch, batchPath);
  assert.throws(() => createCheckpointWriter({fs, batchPath, poolPath: batchPath}), /must differ/);
  // Keep the tiny temp fixture; never recursively delete a computed Windows path.
});
