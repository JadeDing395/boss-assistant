/* claude-boss 1.1.0
 * DOM 选择器容错 helper（不替换原选择器，仅作为新代码可选工具）
 *
 * 用法：
 *   const el = window.__bossClaudeQuerySafe(['selectorA', 'selectorB']);
 *   const list = window.__bossClaudeQueryAllSafe(['selectorA', 'selectorB'], 50);
 *
 * 设计原则：
 * - 出错绝不抛异常，最多返回 null / []
 * - 接受字符串数组，依次尝试，命中即返回（容忍 Boss 改 className）
 * - 不修改原 boss_content.js 的任何选择器；旧逻辑保持原样
 * - 仅在 zhipin.com 域注入（manifest 已限定）
 */
(function attachQuerySafeHelpers() {
  if (window.__bossClaudeQuerySafe) return; // 防止重复注入

  function querySafe(selectors, root) {
    const r = root || document;
    if (!r) return null;
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      if (typeof sel !== 'string' || !sel) continue;
      try {
        const el = r.querySelector(sel);
        if (el) return el;
      } catch (_) {
        // 非法选择器静默跳过
      }
    }
    return null;
  }

  function queryAllSafe(selectors, limit, root) {
    const r = root || document;
    if (!r) return [];
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
    const out = [];
    const seen = new WeakSet();
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      if (typeof sel !== 'string' || !sel) continue;
      let nodes = null;
      try { nodes = r.querySelectorAll(sel); } catch (_) { continue; }
      if (!nodes) continue;
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!el || seen.has(el)) continue;
        seen.add(el);
        out.push(el);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  function waitForSafe(selectors, timeoutMs, intervalMs) {
    const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 4000;
    const step = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 120;
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const el = querySafe(selectors);
        if (el) return resolve(el);
        if (Date.now() - start >= t) return resolve(null);
        setTimeout(tick, step);
      };
      tick();
    });
  }

  window.__bossClaudeQuerySafe = querySafe;
  window.__bossClaudeQueryAllSafe = queryAllSafe;
  window.__bossClaudeWaitForSafe = waitForSafe;
})();
