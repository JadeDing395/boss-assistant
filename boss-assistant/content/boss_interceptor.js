// Boss API 拦截器（运行在页面上下文）
(function () {
  'use strict';

  const TARGET_PATTERNS = [
    '/wapi/zprelation/interaction/bossGetGeek',
    '/wapi/zpjob/rec/geek/list',
    '/wapi/zpitem/web/refinedGeek/list',
    '/wapi/zpitem/web/boss/search',
    // 职位/岗位相关（用于弹窗岗位下拉、自动填 JD）
    '/wapi/zpjob/',
  ];

  function isTargetUrl(url) {
    if (!url) return false;
    return TARGET_PATTERNS.some((p) => url.includes(p));
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input] = args;
    const url = typeof input === 'string' ? input : input && input.url;
    const res = await originalFetch.apply(this, args);
    try {
      if (isTargetUrl(url)) {
        const cloned = res.clone();
        const contentType = cloned.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await cloned.json();
          const isJob = cloned.url.includes('/wapi/zpjob/');
          window.postMessage({
            source: 'boss-assistant',
            type: isJob ? 'job-api' : 'geek-list',
            transport: 'fetch',
            url: cloned.url,
            ok: cloned.ok,
            status: cloned.status,
            data,
          }, '*');
        }
      }
    } catch (e) {
      console.error('[BossAssistant] fetch intercept error', e);
    }
    return res;
  };

  const OriginalXHR = window.XMLHttpRequest;
  function WrappedXHR() {
    const xhr = new OriginalXHR();
    let requestUrl = '';

    const open = xhr.open;
    xhr.open = function (method, url, ...rest) {
      requestUrl = url;
      return open.call(xhr, method, url, ...rest);
    };

    xhr.addEventListener('load', function () {
      try {
        if (!isTargetUrl(requestUrl)) return;
        const contentType = xhr.getResponseHeader('content-type') || '';
        if (!contentType.includes('application/json')) return;
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          console.error('[BossAssistant] xhr json parse error', e);
        }
        const isJob = String(requestUrl).includes('/wapi/zpjob/');
        window.postMessage({
          source: 'boss-assistant',
          type: isJob ? 'job-api' : 'geek-list',
          transport: 'xhr',
          url: requestUrl,
          status: xhr.status,
          data,
        }, '*');
      } catch (e) {
        console.error('[BossAssistant] xhr intercept error', e);
      }
    });

    return xhr;
  }
  window.XMLHttpRequest = WrappedXHR;
})();

