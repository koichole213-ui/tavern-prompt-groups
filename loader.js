// 更新时只修改下面的版本号，保存并重新启用脚本。
// 填写已经发布的版本，例如 5.1.0；已有分组仍保存在原预设里。
const VERSION = '5.1.0';

(() => {
  const host = window.parent && window.parent !== window ? window.parent : window;
  let stopped = false;
  let cleanup;
  const stop = () => { stopped = true; cleanup?.(); };
  window.addEventListener('pagehide', stop, { once: true });
  function report(message) {
    if (stopped) return;
    if (typeof host.toastr?.warning === 'function') host.toastr.warning(message, '词条分组管理器');
    else {
      const node = host.document.createElement('div');
      node.textContent = message; node.setAttribute('role', 'alert');
      node.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:1000000;max-width:90vw;padding:14px;border-radius:8px;background:#302820;color:#f3ded5;font-size:14px';
      host.document.body.appendChild(node); setTimeout(() => node.remove(), 8000);
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
    report('版本号格式不正确，请填写类似 5.1.0 的已发布版本。');
    return;
  }
  const path = `koichole213-ui/tavern-prompt-groups@v${VERSION}/prompt-groups.module.js`;
  const urls = [`https://cdn.jsdelivr.net/gh/${path}`, `https://fastly.jsdelivr.net/gh/${path}`];
  async function download(url) {
    let timer;
    try {
      return await Promise.race([
        import(url),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 15000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  (async () => {
    for (const url of urls) {
      if (stopped) return;
      let module;
      try { module = await download(url); }
      catch { continue; }
      if (stopped) return;
      if (module.version !== VERSION || typeof module.default !== 'function') continue;
      try { cleanup = module.default(); }
      catch { report(`v${VERSION} 启动失败，请重新启用脚本或使用离线版。`); }
      return;
    }
    report(`v${VERSION} 加载失败。请检查网络及版本是否已发布，再重新启用。已有分组不会删除；也可导入离线版。`);
  })();
})();
