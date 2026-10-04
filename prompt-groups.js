// 预设词条分组管理器 v5.1.1
// 分组名单永久保存到对应预设；词条开关仅在当前预设生效。
(() => {
  'use strict';
  const VERSION = '5.1.1';
  const CONFIG_KEY = 'prompt_groups';
  const ROOT_ID = 'pgm-root';
  let panel = null;
  let writing = false;
  let presetEpoch = 0;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const copy = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function normalizeGroups(value) {
    const groups = Object.create(null);
    if (value === undefined) return groups;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分组数据格式异常，已停止操作。请先备份预设，不会用空数据覆盖。');
    for (const [name, ids] of Object.entries(value)) {
      if (!name.trim() || !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) {
        throw new Error('分组数据格式异常，已停止操作。请先备份预设，不会用空数据覆盖。');
      }
      groups[name] = [...new Set(ids)];
    }
    return groups;
  }
  function groupsOf(preset) { return normalizeGroups(preset.extensions?.[CONFIG_KEY]); }
  function snapshot() {
    if (typeof getLoadedPresetName !== 'function') throw new Error('酒馆助手版本不支持预设识别，请先更新酒馆助手。');
    const name = getLoadedPresetName();
    if (!name || name === 'in_use') throw new Error('请先选择一个已保存的聊天补全预设。');
    const preset = getPreset('in_use');
    promptData(preset);
    return { name, epoch: presetEpoch, ids: promptIds(preset) };
  }
  function promptData(preset) {
    if (!Array.isArray(preset.prompts) || !Array.isArray(preset.prompts_unused)) throw new Error('预设词条格式异常，已停止操作。');
    return { prompts: preset.prompts, prompts_unused: preset.prompts_unused };
  }
  function promptIds(preset) {
    const data = promptData(preset);
    return Object.fromEntries(Object.entries(data).map(([key, prompts]) => [key, prompts.map(p => p.id)]));
  }
  function assertContext(context) {
    if (getLoadedPresetName() !== context.name || presetEpoch !== context.epoch) throw new Error('预设已经切换，旧窗口已停止写入。请重新打开分组管理。');
    if (!equal(promptIds(getPreset('in_use')), context.ids)) throw new Error('预设词条已经增删或调整顺序，请重新打开分组管理后再操作。');
  }
  function listPrompts(preset) { return preset.prompts.filter(p => isPresetNormalPrompt(p) || isPresetSystemPrompt(p)); }

  // updater 抛出异常才是真正中止；返回原对象仍然会触发酒馆助手保存。
  async function guardedUpdate(target, context, change, { groupsOnly = false } = {}) {
    assertContext(context);
    const before = getPreset(target);
    const beforePrompts = copy(promptData(before));
    let expected;
    await updatePresetWith(target, preset => {
      assertContext(context);
      if (!equal(promptData(preset), beforePrompts)) throw new Error('更新前检测到词条变化或缺失，已中止写入。');
      change(preset);
      if (groupsOnly && !equal(promptData(preset), beforePrompts)) throw new Error('保存分组不应修改词条，已中止写入。');
      if (!equal(promptIds(preset), promptIds(before))) throw new Error('检测到词条增删，已中止写入。');
      expected = copy(preset);
      return preset;
    }, { render: target === 'in_use' && !groupsOnly ? 'immediate' : 'none' });
    assertContext(context);
    const after = getPreset(target);
    if (!equal(promptData(after), promptData(expected)) || !equal(groupsOf(after), groupsOf(expected))) {
      throw new Error('保存后的核对未通过，不能确认操作成功。请检查预设；不会自动覆盖或回滚其他修改。');
    }
    return after;
  }

  async function persistGroups(context, beforeGroups, groups) {
    assertContext(context);
    const next = normalizeGroups(groups);
    if (!equal(groupsOf(getPreset('in_use')), beforeGroups)) throw new Error('分组已被其他操作修改，请重新打开后再保存。');
    // 只将扩展数据写回具名预设，保留它原本的词条、顺序和生成参数。
    await guardedUpdate(context.name, context, preset => {
      preset.extensions ||= {};
      preset.extensions[CONFIG_KEY] = copy(next);
    }, { groupsOnly: true });
    try {
      await guardedUpdate('in_use', context, preset => {
        if (!equal(groupsOf(preset), beforeGroups)) throw new Error('当前分组已发生变化。');
        preset.extensions ||= {};
        preset.extensions[CONFIG_KEY] = copy(next);
      }, { groupsOnly: true });
    } catch (error) {
      throw new Error(`分组名单已保存到「${context.name}」，但当前界面同步失败。请重新加载该预设。${error.message}`);
    }
    return next;
  }

  async function setGroupState(context, groupName, state) {
    assertContext(context);
    const preset = getPreset('in_use');
    const groups = groupsOf(preset);
    if (!own(groups, groupName)) throw new Error('该分组已不存在，请重新打开。');
    const eligible = new Map(listPrompts(preset).map(p => [p.id, p]));
    const ids = groups[groupName].filter(id => eligible.has(id));
    if (!ids.length) throw new Error('这个分组没有可操作的词条，请先编辑分组。');
    const enabled = state === 'toggle' ? !ids.some(id => eligible.get(id).enabled) : state;
    await guardedUpdate('in_use', context, current => {
      if (!equal(groupsOf(current), groups)) throw new Error('分组名单已变化，请重新打开后再操作。');
      const selected = new Set(ids);
      current.prompts.forEach(p => { if (selected.has(p.id)) p.enabled = enabled; });
    });
    return { enabled, count: ids.length, missing: groups[groupName].length - ids.length };
  }

  const STYLE = `
    #pgm-root { position:fixed; inset:0; z-index:999999; background:rgba(0,0,0,.15); display:flex; justify-content:center; align-items:flex-start; padding:max(60px,8vh) 0 12px; box-sizing:border-box; font-family:var(--mainFontFamily,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif); }
    #pgm-root * { box-sizing:border-box; }
    #pgm-root [hidden] { display:none !important; }
    #pgm-root .pgm-modal { background:var(--SmartThemeBlurTintColor,rgba(20,18,15,.95)); color:var(--SmartThemeBodyColor,#ccc); width:94vw; max-width:640px; max-height:min(80vh,calc(100dvh - max(60px,8vh) - 12px)); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,.4); border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.12)); backdrop-filter:blur(12px); }
    #pgm-root .pgm-top { padding:13px 16px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.1)); flex-shrink:0; }
    #pgm-root h2 { margin:0; font-size:16px; color:inherit; }
    #pgm-root .pgm-version { font-size:11px; opacity:.7; font-weight:400; margin-left:8px; }
    #pgm-root .pgm-x { background:none; border:0; padding:0; font-size:24px; color:inherit; cursor:pointer; min-width:36px; min-height:36px; }
    #pgm-root .pgm-bar { padding:10px 14px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.1)); flex-shrink:0; }
    #pgm-root select,#pgm-root input[type=search],#pgm-root input[type=text] { min-height:36px; padding:7px 10px; border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.2)); border-radius:8px; font:inherit; font-size:13px; background:var(--SmartThemeBlurTintColor,#28251f); color:inherit; min-width:0; }
    #pgm-root select { flex:1 1 180px; width:100%; }
    #pgm-root .pgm-search { width:100%; margin:3px 0; }
    #pgm-root button { font-family:inherit; margin:0; }
    #pgm-root .pgm-b { padding:7px 12px; min-height:36px; border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.18)); border-radius:8px; font-size:12px; cursor:pointer; white-space:nowrap; background:transparent; color:inherit; }
    #pgm-root .pgm-primary { background:#6e967a; color:#fff; border-color:transparent; }
    #pgm-root .pgm-danger { background:rgba(192,100,90,.7); color:#fff; border-color:transparent; }
    #pgm-root button:disabled,#pgm-root select:disabled { opacity:.4; cursor:default; }
    #pgm-root button:active:not(:disabled) { opacity:.75; }
    #pgm-root :focus-visible { outline:2px solid #91b49a; outline-offset:2px; }
    #pgm-root .pgm-hint { width:100%; margin:3px 0 0; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
    #pgm-root .pgm-error { color:#f0a59a; }
    #pgm-root .pgm-meta { width:100%; font-size:11px; opacity:.8; line-height:1.5; overflow-wrap:anywhere; }
    #pgm-root .pgm-list { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:4px 8px; -webkit-overflow-scrolling:touch; }
    #pgm-root .pgm-item { display:flex; align-items:center; padding:9px 10px; margin:1px 0; border-radius:8px; cursor:pointer; font-size:13px; user-select:none; color:inherit; }
    #pgm-root .pgm-item.pgm-ck { background:rgba(110,150,122,.15); }
    #pgm-root input[type=checkbox] { width:18px; height:18px; margin:0 9px 0 0; accent-color:#6e967a; flex-shrink:0; }
    #pgm-root .pgm-dot { width:8px; height:8px; border-radius:50%; margin-right:7px; flex-shrink:0; background:#c08070; }
    #pgm-root .pgm-on { background:#6e967a; }
    #pgm-root .pgm-name { line-height:1.4; overflow-wrap:anywhere; min-width:0; }
    #pgm-root .pgm-bot { padding:11px 14px; border-top:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.1)); display:flex; flex-wrap:wrap; align-items:center; gap:8px; flex-shrink:0; }
    #pgm-root .pgm-cnt { font-size:12px; flex:1 1 130px; }
    #pgm-root .pgm-save { white-space:normal; overflow-wrap:anywhere; max-width:100%; }
    #pgm-root .pgm-empty { padding:22px 10px; text-align:center; font-size:13px; opacity:.8; }
    #pgm-root .pgm-quick-row { padding:10px; border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.1)); display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
    #pgm-root .pgm-quick-title { flex:1 1 180px; min-width:0; font-size:13px; overflow-wrap:anywhere; }
    #pgm-root .pgm-quick-state { display:block; font-size:11px; opacity:.8; margin-top:4px; }
    #pgm-root .pgm-dialog-shade { position:absolute; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:16px; }
    #pgm-root .pgm-dialog { width:100%; max-width:390px; padding:18px; border-radius:12px; background:var(--SmartThemeBlurTintColor,#27241f); color:var(--SmartThemeBodyColor,#ddd); border:1px solid var(--SmartThemeBorderColor,#665b4c); box-shadow:0 8px 30px #0006; }
    #pgm-root .pgm-dialog p { font-size:14px; line-height:1.6; margin:0 0 14px; white-space:pre-wrap; overflow-wrap:anywhere; }
    #pgm-root .pgm-dialog input { width:100%; margin-bottom:12px; }
    #pgm-root .pgm-dialog-actions { display:flex; justify-content:flex-end; gap:8px; }
    @media(max-height:480px) { #pgm-root { padding:10px 0; } #pgm-root .pgm-modal { max-height:calc(100dvh - 20px); } }
    @media(max-width:400px) { #pgm-root .pgm-bar { padding:8px 10px; } #pgm-root .pgm-b { padding:7px 9px; } #pgm-root .pgm-bot { padding:9px 10px; } }
  `;

  function message(view, text, error = false) {
    if (!view.root.isConnected) return;
    view.hint.textContent = text;
    view.hint.classList.toggle('pgm-error', error);
  }
  function dialog(view, text, { input = false, value = '', confirm = '确认', danger = false } = {}) {
    if (view.dialogPending) return Promise.resolve(null);
    view.dialogPending = true;
    const doc = view.root.ownerDocument;
    const previous = doc.activeElement;
    const shade = doc.createElement('div');
    shade.className = 'pgm-dialog-shade';
    shade.innerHTML = `<div class="pgm-dialog" role="dialog" aria-modal="true" aria-label="${input ? '输入分组名称' : '确认操作'}"><p></p>${input ? '<input type="text" maxlength="100" aria-label="分组名称" autocomplete="off">' : ''}<div class="pgm-dialog-actions"><button class="pgm-b" data-cancel>取消</button><button class="pgm-b ${danger ? 'pgm-danger' : 'pgm-primary'}" data-ok>${esc(confirm)}</button></div></div>`;
    shade.querySelector('p').textContent = text;
    view.root.appendChild(shade);
    // 直接创建 DOM 弹窗，名称从不拼入 /buttons、/echo 等命令。
    const field = shade.querySelector('input');
    if (field) field.value = value;
    view.modal.inert = true;
    return new Promise(resolve => {
      const finish = result => {
        shade.remove(); view.modal.inert = false; view.dialogPending = false; view.finishDialog = null;
        if (previous?.isConnected) previous.focus();
        resolve(result);
      };
      view.finishDialog = () => finish(null);
      const accept = () => {
        if (field && !field.value.trim()) { field.setCustomValidity('请输入分组名称'); field.reportValidity(); return; }
        finish(field ? field.value.trim() : true);
      };
      shade.querySelector('[data-cancel]').onclick = () => finish(null);
      shade.querySelector('[data-ok]').onclick = accept;
      shade.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
        if (event.key === 'Enter') { event.preventDefault(); accept(); }
        if (event.key === 'Tab') trapFocus(shade, event);
      });
      if (field) field.addEventListener('input', () => field.setCustomValidity(''));
      (field || shade.querySelector('[data-cancel]')).focus();
      if (field) field.select();
    });
  }
  function trapFocus(root, event) {
    const elements = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(el => !el.closest('[hidden]') && el.getClientRects().length);
    if (!elements.length) return;
    const first = elements[0], last = elements[elements.length - 1];
    if (event.shiftKey && root.ownerDocument.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && root.ownerDocument.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  async function discardAllowed(view) {
    return !view.dirty || !!await dialog(view, '勾选的分组成员还没有保存，确定放弃这次修改吗？', { confirm: '放弃修改', danger: true });
  }
  function destroy(view) {
    view.finishDialog?.();
    clearInterval(view.timer);
    view.root.remove();
    if (view.previousFocus?.isConnected) view.previousFocus.focus();
    if (panel === view) panel = null;
  }
  function controls(view) {
    const blocked = writing || view.stale;
    view.root.querySelectorAll('[data-write]').forEach(el => { el.disabled = blocked || (el.hasAttribute('data-needs-group') && !view.currentGroup); });
    view.root.querySelectorAll('[data-edit]').forEach(el => { el.disabled = blocked; });
    view.root.querySelectorAll('[data-close]').forEach(el => { el.disabled = writing; });
    if (view.select) view.select.disabled = blocked;
    if (view.save) view.save.disabled = blocked || !view.currentGroup;
  }
  async function operate(view, action) {
    if (writing || view.stale || !view.root.isConnected) return;
    writing = true; controls(view);
    try { assertContext(view.context); await action(); }
    catch (error) { message(view, error.message || '操作失败，请检查预设后重试。', true); }
    finally { writing = false; if (view.root.isConnected) { watch(view); controls(view); } }
  }
  function watch(view) {
    if (!view.root.isConnected) { clearInterval(view.timer); return; }
    try { assertContext(view.context); }
    catch (error) { view.stale = true; message(view, error.message, true); controls(view); }
  }

  async function openPanel(mode = 'manager') {
    if (writing || panel?.dialogPending) return;
    if (panel && !await discardAllowed(panel)) return;
    if (panel) destroy(panel);
    let context, groups, preset;
    try { context = snapshot(); preset = getPreset('in_use'); groups = groupsOf(preset); }
    catch (error) { notify(error.message); return; }
    const doc = parent.document;
    const existing = doc.getElementById(ROOT_ID);
    if (existing) { notify('已有分组管理窗口，请先关闭旧版窗口或停用重复脚本。'); return; }
    const root = doc.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `<style>${STYLE}</style><section class="pgm-modal" role="dialog" aria-modal="true" aria-labelledby="pgm-title"><header class="pgm-top"><h2 id="pgm-title">${mode === 'manager' ? '词条分组管理' : '分组开关'}<span class="pgm-version">v${VERSION}</span></h2><button class="pgm-x" data-close aria-label="关闭">&times;</button></header><div class="pgm-bar"><div class="pgm-meta"></div><div class="pgm-hint" role="status" aria-live="polite"></div></div><div class="pgm-list"></div><footer class="pgm-bot"><span class="pgm-cnt"></span><button class="pgm-b" data-close>关闭</button></footer></section>`;
    const view = { root, context, groups, mode, currentGroup: '', dirty: false, stale: false, dialogPending: false, previousFocus: doc.activeElement };
    view.modal = root.querySelector('.pgm-modal');
    view.hint = root.querySelector('.pgm-hint');
    view.list = root.querySelector('.pgm-list');
    view.count = root.querySelector('.pgm-cnt');
    root.querySelector('.pgm-meta').textContent = `预设：${context.name} · 分组名单永久保存；开关当前生效`;
    doc.body.appendChild(root); panel = view;
    const close = async () => { if (!writing && !view.dialogPending && await discardAllowed(view)) destroy(view); };
    root.querySelectorAll('[data-close]').forEach(button => { button.onclick = close; });
    root.addEventListener('click', event => { if (event.target === root) close(); });
    root.addEventListener('keydown', event => {
      if (view.dialogPending) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') trapFocus(view.modal, event);
    });
    if (mode === 'manager') buildManager(view, preset);
    else renderQuick(view);
    view.timer = setInterval(() => watch(view), 800);
    (view.select || root.querySelector('[data-close]')).focus();
  }

  function refreshOptions(view) {
    view.select.innerHTML = '<option value="">-- 选择分组 --</option>';
    for (const [name, ids] of Object.entries(view.groups)) {
      const option = view.root.ownerDocument.createElement('option');
      option.value = name; option.textContent = `${name} (${ids.length}个)`; view.select.appendChild(option);
    }
    view.select.value = view.currentGroup;
  }
  function selectedIds(view) { return [...view.list.querySelectorAll('input:checked')].map(el => el.value); }
  function updateCount(view) {
    const selected = selectedIds(view);
    const visible = [...view.list.querySelectorAll('.pgm-item')].filter(el => !el.hidden).length;
    view.count.textContent = `已选 ${selected.length} 个 · 显示 ${visible}/${view.prompts.length}${view.dirty ? ' · 未保存' : ''}`;
    view.list.querySelectorAll('.pgm-item').forEach(el => el.classList.toggle('pgm-ck', el.querySelector('input').checked));
    view.save.textContent = view.currentGroup ? '保存分组' : '请先选择分组';
    controls(view);
  }
  function markDirty(view) { view.dirty = !equal([...selectedIds(view)].sort(), [...view.baseline].sort()); updateCount(view); }
  function selectGroup(view, name) {
    view.currentGroup = name;
    view.select.value = name;
    const ids = name && own(view.groups, name) ? view.groups[name] : [];
    view.list.querySelectorAll('input').forEach(el => { el.checked = ids.includes(el.value); });
    view.baseline = selectedIds(view); view.dirty = false;
    const missing = ids.length - view.baseline.length;
    message(view, name ? `正在编辑「${name}」。勾选修改后点保存。${missing ? `其中 ${missing} 个成员已不在当前列表，保存时会移除。` : ''}` : '选择已有分组，或点「+ 新建」。');
    updateCount(view);
  }
  function syncDots(view) {
    const prompts = new Map(getPreset('in_use').prompts.map(p => [p.id, p]));
    view.list.querySelectorAll('.pgm-item').forEach(el => {
      const enabled = !!prompts.get(el.querySelector('input').value)?.enabled;
      const dot = el.querySelector('.pgm-dot');
      dot.classList.toggle('pgm-on', enabled); dot.title = enabled ? '当前开启' : '当前关闭';
    });
  }
  function buildManager(view, preset) {
    const doc = view.root.ownerDocument;
    const bar = view.root.querySelector('.pgm-bar');
    const actions = doc.createElement('div');
    actions.style.cssText = 'display:contents';
    actions.innerHTML = `<select aria-label="选择分组"></select><button class="pgm-b pgm-primary" data-new data-write>+ 新建</button><button class="pgm-b" data-rename data-write data-needs-group>重命名</button><button class="pgm-b pgm-danger" data-delete data-write data-needs-group>删除</button><input class="pgm-search" type="search" placeholder="搜索词条名称…" aria-label="搜索词条"><button class="pgm-b" data-all data-edit>全选</button><button class="pgm-b" data-none data-edit>取消全选</button><button class="pgm-b" data-on data-write data-needs-group>全部开启</button><button class="pgm-b" data-off data-write data-needs-group>全部关闭</button>`;
    bar.insertBefore(actions, view.hint);
    view.select = actions.querySelector('select');
    view.search = actions.querySelector('input[type=search]');
    view.prompts = listPrompts(preset);
    view.baseline = [];
    view.list.innerHTML = view.prompts.map(p => `<label class="pgm-item"><input type="checkbox" data-edit value="${esc(p.id)}"><span class="pgm-dot ${p.enabled ? 'pgm-on' : ''}" title="${p.enabled ? '当前开启' : '当前关闭'}"></span><span class="pgm-name">${esc(p.name)}</span></label>`).join('') + '<div class="pgm-empty" hidden>没有匹配的词条</div>';
    view.save = doc.createElement('button');
    view.save.className = 'pgm-b pgm-primary pgm-save'; view.save.setAttribute('data-write', '');
    view.root.querySelector('.pgm-bot').appendChild(view.save);
    refreshOptions(view); selectGroup(view, '');
    view.list.addEventListener('change', () => markDirty(view));
    view.search.oninput = () => {
      const text = view.search.value.trim().toLocaleLowerCase(); let visible = 0;
      view.list.querySelectorAll('.pgm-item').forEach(el => { el.hidden = !el.querySelector('.pgm-name').textContent.toLocaleLowerCase().includes(text); if (!el.hidden) visible++; });
      view.list.querySelector('.pgm-empty').hidden = visible > 0;
      actions.querySelector('[data-all]').textContent = text ? '全选搜索结果' : '全选';
      actions.querySelector('[data-none]').textContent = text ? '取消搜索结果' : '取消全选';
      updateCount(view);
    };
    view.select.onchange = async () => {
      const next = view.select.value; view.select.value = view.currentGroup;
      if (view.dialogPending) return;
      if (await discardAllowed(view)) selectGroup(view, next);
    };
    for (const [selector, checked] of [['[data-all]', true], ['[data-none]', false]]) {
      actions.querySelector(selector).onclick = () => { view.list.querySelectorAll('.pgm-item').forEach(el => { if (!el.hidden) el.querySelector('input').checked = checked; }); markDirty(view); };
    }
    actions.querySelector('[data-new]').onclick = async () => {
      if (view.dialogPending || !await discardAllowed(view)) return;
      const name = await dialog(view, '请输入新分组名称（最多 100 个字符）', { input: true, confirm: '新建' });
      if (name === null) return;
      await operate(view, async () => {
        const current = groupsOf(getPreset('in_use'));
        if (own(current, name)) { view.groups = current; refreshOptions(view); selectGroup(view, name); message(view, `「${name}」已存在，已选中该分组。`); return; }
        const next = normalizeGroups(current); next[name] = [];
        view.groups = await persistGroups(view.context, current, next);
        refreshOptions(view); selectGroup(view, name); message(view, `已创建「${name}」。勾选词条后点保存。`);
      });
    };
    actions.querySelector('[data-rename]').onclick = async () => {
      const oldName = view.currentGroup;
      if (!oldName || view.dialogPending || !await discardAllowed(view)) return;
      const name = await dialog(view, '请输入新的分组名称', { input: true, value: oldName, confirm: '重命名' });
      if (name === null || name === oldName) return;
      await operate(view, async () => {
        const current = groupsOf(getPreset('in_use'));
        if (!own(current, oldName)) throw new Error('原分组已不存在，请重新打开。');
        if (own(current, name)) throw new Error('已有同名分组，请使用另一个名称。');
        const next = Object.create(null);
        for (const key of Object.keys(current)) next[key === oldName ? name : key] = current[key];
        view.groups = await persistGroups(view.context, current, next);
        view.currentGroup = name; refreshOptions(view); selectGroup(view, name); message(view, `已重命名为「${name}」。`);
      });
    };
    actions.querySelector('[data-delete]').onclick = async () => {
      const name = view.currentGroup;
      if (!name || view.dialogPending) return;
      if (!await dialog(view, `确定删除分组「${name}」吗？${view.dirty ? '\n未保存的勾选也会放弃。' : ''}\n只删除分组名单，不会删除词条。`, { confirm: '删除分组', danger: true })) return;
      await operate(view, async () => {
        const current = groupsOf(getPreset('in_use'));
        const next = normalizeGroups(current); delete next[name];
        view.groups = await persistGroups(view.context, current, next);
        view.currentGroup = ''; refreshOptions(view); selectGroup(view, ''); message(view, `已删除「${name}」。`);
      });
    };
    view.save.onclick = async () => {
      const name = view.currentGroup;
      const ids = selectedIds(view);
      if (!name || view.dialogPending) return;
      if (!ids.length && !await dialog(view, `确定清空「${name}」的成员吗？词条本身不会删除。`, { confirm: '清空成员', danger: true })) return;
      await operate(view, async () => {
        const current = groupsOf(getPreset('in_use'));
        if (!own(current, name) || !equal(current[name], view.groups[name])) throw new Error('这个分组已被其他操作修改，请重新打开后再保存。');
        const next = normalizeGroups(current); next[name] = ids;
        view.groups = await persistGroups(view.context, current, next);
        refreshOptions(view); view.baseline = ids; view.dirty = false; updateCount(view);
        message(view, `已永久保存「${name}」（${ids.length} 个词条）。`);
      });
    };
    for (const [selector, enabled] of [['[data-on]', true], ['[data-off]', false]]) {
      actions.querySelector(selector).onclick = () => operate(view, async () => {
        if (view.dirty) throw new Error('成员勾选尚未保存，请先保存后再开关分组。');
        const result = await setGroupState(view.context, view.currentGroup, enabled);
        syncDots(view); message(view, stateMessage(view.currentGroup, result));
      });
    }
    controls(view);
  }
  function stateMessage(name, result) {
    return `已${result.enabled ? '全部开启' : '全部关闭'}「${name}」（${result.count} 个词条）。${result.missing ? `另有 ${result.missing} 个失效成员未操作。` : ''}开关当前生效；长期保留开关状态需点酒馆的预设保存。`;
  }
  function renderQuick(view) {
    const preset = getPreset('in_use'); view.groups = groupsOf(preset);
    const eligible = new Map(listPrompts(preset).map(p => [p.id, p]));
    view.list.replaceChildren();
    for (const [name, ids] of Object.entries(view.groups)) {
      const valid = ids.filter(id => eligible.has(id));
      const on = valid.filter(id => eligible.get(id).enabled).length;
      const row = view.root.ownerDocument.createElement('div'); row.className = 'pgm-quick-row';
      row.innerHTML = `<div class="pgm-quick-title"><span class="pgm-name"></span><span class="pgm-quick-state"></span></div><button class="pgm-b" data-write>切换</button><button class="pgm-b pgm-primary" data-write>全部开启</button><button class="pgm-b" data-write>全部关闭</button>`;
      row.querySelector('.pgm-name').textContent = name;
      row.querySelector('.pgm-quick-state').textContent = `${on}/${valid.length} 开启${ids.length > valid.length ? ` · ${ids.length - valid.length} 个失效` : ''}`;
      [...row.querySelectorAll('button')].forEach((button, index) => {
        if (!valid.length) { button.disabled = true; button.removeAttribute('data-write'); }
        button.onclick = () => operate(view, async () => {
          const result = await setGroupState(view.context, name, ['toggle', true, false][index]);
          const scroll = view.list.scrollTop; renderQuick(view); view.list.scrollTop = scroll;
          message(view, stateMessage(name, result));
        });
      });
      view.list.appendChild(row);
    }
    if (!Object.keys(view.groups).length) view.list.innerHTML = '<div class="pgm-empty">还没有分组，请先打开「分组管理」创建。</div>';
    view.count.textContent = `共 ${Object.keys(view.groups).length} 个分组`;
    message(view, '切换：有任意成员开启就全部关闭，否则全部开启。不同分组可同时开启，共用词条会一起受影响。');
    controls(view);
  }
  function notify(text) {
    // textContent 防止名称被当成 HTML 或命令解析。
    const doc = parent.document;
    const toast = doc.createElement('div');
    toast.setAttribute('role', 'alert'); toast.textContent = text;
    toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:1000000;max-width:90vw;padding:14px;border-radius:8px;background:#302820;color:#f3ded5;white-space:pre-wrap;font-size:14px';
    doc.body.appendChild(toast); setTimeout(() => toast.remove(), 7000);
  }
  const subscriptions = [];
  subscriptions.push(eventOn(getButtonEvent('分组管理'), () => { openPanel('manager').catch(error => notify(error.message)); }));
  subscriptions.push(eventOn(getButtonEvent('切换分组'), () => { openPanel('quick').catch(error => notify(error.message)); }));
  if (typeof tavern_events !== 'undefined' && tavern_events.OAI_PRESET_CHANGED_BEFORE) {
    subscriptions.push(eventOn(tavern_events.OAI_PRESET_CHANGED_BEFORE, () => { presetEpoch++; if (panel) watch(panel); }));
  }
  function stop() {
    if (panel) destroy(panel);
    subscriptions.forEach(subscription => subscription?.stop());
    window.removeEventListener('pagehide', stop);
  }
  window.addEventListener('pagehide', stop);
  return stop;
})();
