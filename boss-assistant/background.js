// MV3 service worker

const EXPECTED_CONTENT_VERSION = 'v3-sidepanel';

// 1.1.0 调整：仅在 Boss 页面允许打开 side panel
// 关键点：manifest 里的 side_panel.default_path 会让面板对所有 tab“全局可用”。
// 我们在启动时把全局默认改为 enabled:false，然后只对 Boss tab 显式 enable。
async function disableSidePanelGlobally() {
  if (!chrome.sidePanel?.setOptions) return;
  try {
    // 不带 tabId = 设置全局默认；设为 enabled:false 后，
    // 任何未被显式启用的 tab 都拿不到这个面板。
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch {}
}

async function syncAllOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of (tabs || [])) {
      updateSidePanelForTab(t.id, t.url).catch(() => {});
    }
  } catch {}
}

chrome.runtime.onInstalled?.addListener?.(() => {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  } catch {}
  (async () => {
    await disableSidePanelGlobally();
    await syncAllOpenTabs();
  })().catch(() => {});
});

chrome.runtime.onStartup?.addListener?.(() => {
  (async () => {
    await disableSidePanelGlobally();
    await syncAllOpenTabs();
  })().catch(() => {});
});

// 新建 tab 时先确保面板对它是关的（默认就是关，但保险起见再 setOptions 一次）
chrome.tabs.onCreated?.addListener?.((tab) => {
  if (!tab?.id) return;
  // 新 tab 的 url 在创建瞬间常为空；先 disable，等 onUpdated 拿到真实 URL 再决定
  chrome.sidePanel?.setOptions?.({ tabId: tab.id, enabled: false }).catch(() => {});
});

chrome.tabs.onActivated?.addListener?.(({ tabId }) => {
  try {
    chrome.tabs.get(tabId, (tab) => {
      updateSidePanelForTab(tabId, tab?.url).catch(() => {});
    });
  } catch {}
});

chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo, tab) => {
  // URL 变化时同步开关（避免面板出现在非 Boss 页面）
  if (!changeInfo?.url && !tab?.url) return;
  updateSidePanelForTab(tabId, changeInfo.url || tab.url).catch(() => {});
});

// tab 被关时不需要单独清理：tabId 随 tab 一起消失

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ENSURE_CONTENT_SCRIPT') {
    const tabId = message.tabId;
    ensureContentScripts(tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'AI_CALL') {
    handleAiCall(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    handleCaptureVisibleTab(message, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'OPEN_POPUP') {
    chrome.action.openPopup().then(
      () => sendResponse({ success: true }),
      (err) => sendResponse({ success: false, error: err?.message || String(err) }),
    );
    return true;
  }

  if (message?.type === 'OPEN_HANG_WINDOW') {
    // 兼容旧入口：改为显示网页悬浮面板
    (async () => {
      const tabId = message?.tabId;
      if (!tabId) throw new Error('缺少 tabId');
      const tab = await chrome.tabs.get(tabId);
      if (!isBossUrl(tab?.url)) throw new Error('仅支持在 Boss 页面显示悬浮面板');
      await ensureContentScripts(tabId);
      await chrome.storage.local.set({ bossAssistPanelHidden: false }).catch(() => {});
      await chrome.tabs.sendMessage(tabId, { type: 'BOSS_ASSIST_SHOW_PANEL' }, { frameId: 0 });
      sendResponse({ success: true });
    })().catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }

  // UI 兜底入口：由后台定位 Boss tab，再转发给内容脚本
  if (message?.type === 'BOSS_UI_START' || message?.type === 'BOSS_UI_STOP') {
    (async () => {
      const tab = await pickBossTabForUi(sender, message?.tabId).catch(() => null);
      if (!tab?.id) throw new Error('未找到 Boss 标签页：请先打开并登录 Boss（*.zhipin.com）');
      await ensureContentScripts(tab.id);
      const type = message?.type === 'BOSS_UI_STOP' ? 'BOSS_ASSIST_STOP' : 'BOSS_ASSIST_START';
      const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};
      const resp = await chrome.tabs.sendMessage(tab.id, { type, ...payload }, { frameId: 0 });
      sendResponse({ success: true, tabId: tab.id, resp: resp || null });
    })().catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
    return true;
  }
});

async function ensureContentScripts(tabId) {
  if (!tabId) throw new Error('缺少 tabId');

  // 先 ping，能通就不注入
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'BOSS_ASSIST_PING' });
    if (resp?.ok && resp?.version === EXPECTED_CONTENT_VERSION) return;
  } catch {}

  // 动态注入（解决：扩展重载后旧页面未自动注入的问题）
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/boss_injector.js', 'content/boss_content.js'],
  });

  // 注入后再 ping 一次
  await chrome.tabs.sendMessage(tabId, { type: 'BOSS_ASSIST_PING' });
}

function isBossUrl(url) {
  try {
    if (!url) return false;
    const u = new URL(String(url));
    return u.hostname === 'zhipin.com' || u.hostname.endsWith('.zhipin.com');
  } catch {
    return false;
  }
}

async function updateSidePanelForTab(tabId, url) {
  if (!tabId) return;
  if (!chrome.sidePanel?.setOptions) return;
  // 注意：某些时刻 tab.url 可能为空（例如切换标签页瞬间/正在加载）。
  // 这时先禁用，后续 onUpdated(url) 会再自动启用。
  if (!url) {
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  const enabled = isBossUrl(url);
  if (enabled) {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: true,
      path: 'popup/popup.html',
    });
  } else {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false,
    });
  }
}

async function pickBossTabForUi(sender, preferredTabId) {
  // 0) 若 UI 显式传了当前 Boss tab，优先使用（避免多个 Boss tab 时误打到旧的搜索页）
  if (preferredTabId) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      if (preferred?.id && isBossUrl(preferred.url)) return preferred;
    } catch {}
  }

  // 1) 若 sender 带 tab 且是 Boss，优先用它（嵌入 iframe 的扩展页有机会带上）
  const st = sender?.tab;
  if (st?.id && isBossUrl(st.url)) return st;

  // 2) 当前激活 tab
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (active?.id && isBossUrl(active.url)) return active;

  // 3) 同窗口找 Boss
  if (active?.windowId != null) {
    const inWin = await chrome.tabs.query({ windowId: active.windowId }).catch(() => []);
    const boss = inWin.filter(t => t?.url && isBossUrl(t.url));
    if (boss.length) {
      boss.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return boss[0];
    }
  }

  // 4) 全局兜底
  const all = await chrome.tabs.query({}).catch(() => []);
  const bossAll = all.filter(t => t?.url && isBossUrl(t.url));
  if (!bossAll.length) return null;
  bossAll.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return bossAll[0];
}

async function handleAiCall({ baseUrl, apiKey, model, messages, temperature = 0, max_tokens = 400 }) {
  if (!baseUrl || !apiKey || !model) {
    throw new Error('AI 配置不完整：请填写 baseUrl / apiKey / model');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('AI_CALL 缺少 messages');
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`AI 请求失败 (${resp.status}): ${errText.slice(0, 240)}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage || null;
    return { success: true, text, usage };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { success: false, error: 'AI 请求超时（60秒），请检查网络或 baseUrl' };
    }
    // TypeError: Failed to fetch (网络/CORS/未授权域名等都会触发，Chrome 往往不给更细原因)
    const msg = String(err?.message || err || '');
    if (/failed to fetch/i.test(msg)) {
      return {
        success: false,
        error: [
          'AI 连接失败：failed to fetch。',
          '常见原因：',
          '1) 这台电脑尚未授权该 AI 网关域名（请在侧边栏 AI 配置处点“保存”，并允许权限提示）。',
          '2) baseUrl 写错（缺少 https、路径不对、或网关不可达）。',
          '3) 网络/代理/公司防火墙拦截，或证书问题。',
        ].join(' '),
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function handleCaptureVisibleTab({ format = 'jpeg', quality = 90 } = {}, sender) {
  const winId = sender?.tab?.windowId;
  const dataUrl = await chrome.tabs.captureVisibleTab(winId, {
    format: format === 'png' ? 'png' : 'jpeg',
    quality: Math.max(1, Math.min(100, Number(quality) || 90)),
  });
  if (!dataUrl) throw new Error('截图失败：未获取到图像数据');
  return { success: true, dataUrl };
}
