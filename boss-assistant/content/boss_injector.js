// 在 document_start 注入 Boss API 拦截器（页面上下文）
(function injectBossInterceptor() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/boss_interceptor.js');
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
    script.onerror = () => console.error('[BossAssistant] interceptor inject failed');
  } catch (e) {
    console.error('[BossAssistant] injector error', e);
  }
})();

