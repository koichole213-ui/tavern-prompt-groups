const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = fs.readFileSync(`${__dirname}/prompt-groups.js`, 'utf8');
const exported = source.replace('  return stop;', '  globalThis.core = { normalizeGroups, snapshot, persistGroups, setGroupState, guardedUpdate, assertContext };\n  return stop;');
function preset(groups = { 剧情: ['a'], 剧情增强: ['b'] }) {
  return { settings: { temperature: .7 }, prompts: [
    { id: 'a', name: '剧情', enabled: false, content: 'A' },
    { id: 'b', name: '文风', enabled: false, content: 'B' },
    { id: 'chatHistory', name: '聊天记录', enabled: true },
  ], prompts_unused: [{ id: 'unused', name: '备用', enabled: false, content: '不要丢失' }], extensions: { other: { preserve: true }, prompt_groups: groups } };
}
function setup(groups, options = {}) {
  const saved = preset(groups);
  const state = { name: '测试预设', current: structuredClone(saved), saved: structuredClone(saved), events: {}, writes: [], callbackCalls: 0 };
  const context = { console, window: { addEventListener() {}, removeEventListener() {} }, eventOn: (event, fn) => { state.events[event] = fn; return { stop() {} }; }, getButtonEvent: x => x,
    tavern_events: { OAI_PRESET_CHANGED_BEFORE: 'before' }, getLoadedPresetName: () => state.name,
    getPreset: target => structuredClone(target === 'in_use' ? state.current : state.saved),
    isPresetNormalPrompt: p => p.id !== 'chatHistory', isPresetSystemPrompt: () => false,
    updatePresetWith: async (target, updater) => {
      state.callbackCalls++;
      if (options.failTarget === target) throw new Error('模拟保存失败');
      let input = structuredClone(target === 'in_use' ? state.current : state.saved);
      if (options.dropBeforeTarget === target) input.prompts_unused = [];
      const result = await updater(input);
      state.writes.push(target);
      if (options.dropAfterTarget === target) result.prompts.pop();
      if (target === 'in_use') state.current = structuredClone(result); else state.saved = structuredClone(result);
      return result;
    },
  };
  vm.runInNewContext(exported, context);
  return { core: context.core, state };
}
const plain = x => JSON.parse(JSON.stringify(x));
test('交付 JSON 和源码、版本、按钮一致', () => {
  const json = JSON.parse(fs.readFileSync(`${__dirname}/prompt-groups.standalone.json`, 'utf8'));
  assert.equal(json.content, source); assert.equal(json.version, require('./package.json').version);
  assert.deepEqual(json.button.buttons.map(b => b.name), ['分组管理', '切换分组']);
  new vm.Script(json.content);
});
test('前缀相似的分组只操作指定组', async () => {
  const { core, state } = setup(); await core.setGroupState(core.snapshot(), '剧情增强', true);
  assert.equal(state.current.prompts[0].enabled, false); assert.equal(state.current.prompts[1].enabled, true);
});
test('显式全部开启、全部关闭不受混合状态影响', async () => {
  const { core, state } = setup({ 混合: ['a', 'b'] }); state.current.prompts[0].enabled = true;
  await core.setGroupState(core.snapshot(), '混合', true); assert.ok(state.current.prompts.slice(0, 2).every(p => p.enabled));
  await core.setGroupState(core.snapshot(), '混合', false); assert.ok(state.current.prompts.slice(0, 2).every(p => !p.enabled));
});
test('保留原切换规则：任一开启则全部关闭', async () => {
  const { core, state } = setup({ 混合: ['a', 'b'] }); state.current.prompts[0].enabled = true;
  const result = await core.setGroupState(core.snapshot(), '混合', 'toggle'); assert.equal(result.enabled, false);
  await core.setGroupState(core.snapshot(), '混合', 'toggle'); assert.ok(state.current.prompts.slice(0, 2).every(p => p.enabled));
});
test('分组永久保存但不顺手保存当前其他修改', async () => {
  const { core, state } = setup(); const context = core.snapshot(); const original = structuredClone(state.saved);
  state.current.settings.temperature = 1.2; state.current.prompts[0].content = '尚未保存的文本';
  const before = core.normalizeGroups(state.current.extensions.prompt_groups); const next = core.normalizeGroups(before); next.新组 = ['a', 'b'];
  await core.persistGroups(context, before, next);
  assert.deepEqual(state.saved.prompts, original.prompts); assert.deepEqual(state.saved.settings, original.settings);
  assert.equal(state.current.prompts[0].content, '尚未保存的文本'); assert.equal(state.current.settings.temperature, 1.2);
  assert.deepEqual(state.saved.extensions.other, original.extensions.other);
  state.current = structuredClone(state.saved); assert.deepEqual(state.current.extensions.prompt_groups.新组, ['a', 'b']);
});
test('开关不修改具名预设、未使用词条或聊天占位符', async () => {
  const { core, state } = setup({ 组: ['a', 'chatHistory', 'unused'] }); const saved = structuredClone(state.saved);
  const result = await core.setGroupState(core.snapshot(), '组', true);
  assert.equal(result.count, 1); assert.equal(result.missing, 2);
  assert.deepEqual(state.saved, saved); assert.deepEqual(state.current.prompts_unused, saved.prompts_unused);
  assert.equal(state.current.prompts[2].enabled, true);
});
test('已切换的预设不接受旧窗口写入', async () => {
  const { core, state } = setup(); const context = core.snapshot(); state.name = '另一预设';
  await assert.rejects(core.setGroupState(context, '剧情', true), /预设已经切换/); assert.equal(state.writes.length, 0);
});
test('切走又切回同名预设也拒绝旧窗口', async () => {
  const { core, state } = setup(); const context = core.snapshot(); state.events.before();
  await assert.rejects(core.setGroupState(context, '剧情', true), /预设已经切换/); assert.equal(state.writes.length, 0);
});
test('条目数相同但编号变化仍拒绝', async () => {
  const { core, state } = setup(); const context = core.snapshot(); state.current.prompts[0].id = 'different';
  await assert.rejects(core.setGroupState(context, '剧情增强', true), /增删或调整顺序/); assert.equal(state.writes.length, 0);
});
test('updater 收到缺失词条时抛错，不调用保存', async () => {
  const { core, state } = setup(undefined, { dropBeforeTarget: 'in_use' });
  await assert.rejects(core.setGroupState(core.snapshot(), '剧情', true), /缺失/); assert.equal(state.writes.length, 0);
});
test('永久保存前的缺失检查也会中止', async () => {
  const { core, state } = setup(undefined, { dropBeforeTarget: '测试预设' });
  const before = core.normalizeGroups(state.current.extensions.prompt_groups);
  await assert.rejects(core.persistGroups(core.snapshot(), before, before), /缺失/); assert.equal(state.writes.length, 0);
});
test('保存后数据异常不会报告成功', async () => {
  const { core } = setup(undefined, { dropAfterTarget: 'in_use' });
  await assert.rejects(core.setGroupState(core.snapshot(), '剧情', true), /增删或调整顺序|核对未通过/);
});
test('具名预设保存失败时当前数据不改动', async () => {
  const { core, state } = setup(undefined, { failTarget: '测试预设' }); const original = structuredClone(state.current);
  const before = core.normalizeGroups(state.current.extensions.prompt_groups); const next = core.normalizeGroups(before); next.新增 = ['a'];
  await assert.rejects(core.persistGroups(core.snapshot(), before, next), /模拟保存失败/);
  assert.deepEqual(state.current, original); assert.equal(state.writes.length, 0);
});
test('只永久保存成功时准确报告当前同步失败', async () => {
  const { core, state } = setup(undefined, { failTarget: 'in_use' });
  const before = core.normalizeGroups(state.current.extensions.prompt_groups); const next = core.normalizeGroups(before); next.新增 = ['a'];
  await assert.rejects(core.persistGroups(core.snapshot(), before, next), /已保存.*同步失败/);
  assert.deepEqual(state.saved.extensions.prompt_groups.新增, ['a']); assert.equal(state.current.extensions.prompt_groups.新增, undefined);
});
test('特殊对象属性名称可真实保存并切换', async () => {
  const { core, state } = setup({}); const before = core.normalizeGroups({}); const next = core.normalizeGroups({});
  next.constructor = ['a']; next.__proto__ = ['b']; next.toString = ['a'];
  await core.persistGroups(core.snapshot(), before, next);
  assert.deepEqual(Object.keys(state.saved.extensions.prompt_groups), ['constructor', '__proto__', 'toString']);
  await core.setGroupState(core.snapshot(), '__proto__', true); assert.equal(state.current.prompts[1].enabled, true);
});
test('特殊字符名称不经过命令解析', async () => {
  const name = '甲 | /echo 测试 " <img> {{char}}'; const { core, state } = setup({ [name]: ['a'] });
  await core.setGroupState(core.snapshot(), name, true); assert.equal(state.current.prompts[0].enabled, true);
});
test('坏数据不被静默当成空分组覆盖', () => {
  const { core } = setup();
  for (const value of [null, [], 'bad', { 组: 'a' }, { 组: [123] }]) assert.throws(() => core.normalizeGroups(value), /格式异常/);
});
test('重复编号会去重，失效成员可明确返回', async () => {
  const { core } = setup({ 组: ['a', 'a', 'gone'] });
  assert.deepEqual(plain(core.normalizeGroups({ 组: ['a', 'a'] })), { 组: ['a'] });
  const result = await core.setGroupState(core.snapshot(), '组', true); assert.equal(result.count, 1); assert.equal(result.missing, 1);
});
test('空组和全失效组不写入预设', async () => {
  const { core, state } = setup({ 空: [], 失效: ['gone'] });
  await assert.rejects(core.setGroupState(core.snapshot(), '空', true), /没有可操作/);
  await assert.rejects(core.setGroupState(core.snapshot(), '失效', true), /没有可操作/); assert.equal(state.writes.length, 0);
});
test('其他操作改变分组后拒绝覆盖', async () => {
  const { core, state } = setup(); const before = core.normalizeGroups(state.current.extensions.prompt_groups);
  state.current.extensions.prompt_groups.其他 = ['a'];
  await assert.rejects(core.persistGroups(core.snapshot(), before, before), /其他操作修改/); assert.equal(state.writes.length, 0);
});
