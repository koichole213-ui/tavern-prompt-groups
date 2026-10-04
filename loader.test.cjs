const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { version } = require('./package.json');
const source = fs.readFileSync(`${__dirname}/loader.js`, 'utf8');
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function setup(load, text = source) {
  const state = { calls: [], messages: [], timers: new Map(), starts: 0, stops: 0 };
  const host = { toastr: { warning: message => state.messages.push(message) } };
  let hide;
  const context = {
    window: { parent: host, addEventListener: (name, fn) => { if (name === 'pagehide') hide = fn; } },
    setTimeout: fn => { const key = Symbol(); state.timers.set(key, fn); return key; },
    clearTimeout: key => state.timers.delete(key),
    __import: async url => { state.calls.push(url); return load(url, state); },
  };
  vm.runInNewContext(text.replace('import(url)', '__import(url)'), context);
  return { state, hide: () => hide() };
}
const moduleFor = state => ({ version, default: () => { state.starts++; return () => { state.stops++; }; } });
test('在线 JSON、加载器、模块、源码版本一致', async () => {
  const json = JSON.parse(fs.readFileSync(`${__dirname}/prompt-groups.json`, 'utf8'));
  assert.equal(json.content, source); assert.equal(json.version, version);
  assert.ok(source.includes(`const VERSION = '${version}';`));
  const moduleSource = fs.readFileSync(`${__dirname}/prompt-groups.module.js`, 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
  assert.equal(module.version, version); assert.equal(typeof module.default, 'function');
});
test('按精确标签加载且只启动一次', async () => {
  const { state } = setup((url, state) => moduleFor(state)); await tick();
  assert.equal(state.starts, 1); assert.equal(state.calls.length, 1);
  assert.ok(state.calls[0].endsWith(`@v${version}/prompt-groups.module.js`)); assert.equal(state.timers.size, 0);
});
test('主入口失败后尝试备用入口', async () => {
  const { state } = setup((url, state) => { if (url.includes('cdn.jsdelivr.net')) throw new Error('offline'); return moduleFor(state); });
  await tick(); assert.equal(state.starts, 1); assert.equal(state.calls.length, 2); assert.ok(state.calls[1].includes('fastly.jsdelivr.net'));
});
test('无效版本不发送请求', async () => {
  const { state } = setup(() => { throw new Error(); }, source.replace(`'${version}'`, "'../main'")); await tick();
  assert.equal(state.calls.length, 0); assert.ok(state.messages[0].includes('版本号格式不正确'));
});
test('未发布或离线时失败提示，不启动或更改数据', async () => {
  const { state } = setup(() => { throw new Error('404'); }); await tick();
  assert.equal(state.starts, 0); assert.equal(state.calls.length, 2); assert.ok(state.messages[0].includes('已有分组不会删除'));
});
test('版本不匹配或导出不完整时拒绝启动', async () => {
  for (const bad of [{ version: '0.0.0', default() {} }, { version }]) {
    const { state } = setup(() => bad); await tick(); assert.equal(state.starts, 0); assert.equal(state.calls.length, 2); assert.equal(state.messages.length, 1);
  }
});
test('下载尚未完成就停用，不启动也不显示失败', async () => {
  let resolve;
  const result = setup((url, state) => new Promise(done => { resolve = () => done(moduleFor(state)); }));
  result.hide(); resolve(); await tick();
  assert.equal(result.state.starts, 0); assert.equal(result.state.messages.length, 0); assert.equal(result.state.calls.length, 1);
});
test('已启动脚本停用时调用清理函数', async () => {
  const result = setup((url, state) => moduleFor(state)); await tick(); result.hide();
  assert.equal(result.state.stops, 1);
});
test('超时后使用备用入口，迟到模块不重复启动', async () => {
  let late;
  const result = setup((url, state) => url.includes('cdn.jsdelivr.net') ? new Promise(resolve => { late = () => resolve(moduleFor(state)); }) : moduleFor(state));
  [...result.state.timers.values()][0](); await tick(); assert.equal(result.state.starts, 1);
  late(); await tick(); assert.equal(result.state.starts, 1);
});
