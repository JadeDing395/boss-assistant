// 小池-boss智能助手 - 内容脚本（支持 iframe：推荐牛人/搜索页在 frame 内）

const __BOSS_ASSIST_VERSION__ = 'v3-sidepanel';
// 1.1.2：从硬编码常量改为运行时函数，由 settings.riskMode 决定
// 默认仍是低风险（即使 settings 还没加载完）
const LOCAL_JOB_KEYWORD_PRESETS_PATH = 'local_job_keyword_presets.json';

if (window.__bossAssistLoaded__ && window.__bossAssistVersion__ === __BOSS_ASSIST_VERSION__) {
  // 防止重复注册
} else {
  window.__bossAssistLoaded__ = true;
  window.__bossAssistVersion__ = __BOSS_ASSIST_VERSION__;

  const STORAGE_KEYS = {
    settings: 'bossAssistSettings',
    logs: 'bossAssistLogs',
    processedOutreach: 'bossAssistProcessedOutreach',
    replyRunResults: 'bossAssistReplyRunResults',  // 1.1.x：自动回复每处理一会话写一条，给 popup 显示卡片
    repliedThreads: 'bossAssistRepliedThreads',
    manualReviewQueue: 'bossAssistManualReviewQueue',
    runState: 'bossAssistRunState',
    jobs: 'bossAssistJobs',
    jobKeywordOverrides: 'bossAssistJobKeywordOverrides',
    pendingStart: 'bossAssistPendingStart',
    panelHidden: 'bossAssistPanelHidden',
    aiUsage: 'bossAssistAiUsage',
  };

  const DEFAULT_SETTINGS = {
    enableOutreach: true,
    enableAutoReply: false,
    autoReplySummaryOnly: false,
    autoReplyJobKey: '',
    positionName: '',
    jdText: '',
    outreachListMode: 'recommend',
    outreachTemplate: '你好 ${name}，我们在招 ${position}，看你背景很匹配，方便聊聊吗？',
    autoReplyTemplate: '你好，我看了你的信息。我们这边在招 ${position}，方便发下简历/聊聊你的期望吗？',
    replyCommonPhrase: '',
    autoReplyPassMode: '',
    autoReplyPassTemplate: '',
    autoReplyPassCommonPhrase: '',
    autoReplyCandidateRejectMode: 'template',
    autoReplyCandidateRejectTemplate: '期待未来有机会合作。',
    autoReplyCandidateRejectCommonPhrase: '',
    autoReplyOurRejectMode: 'template',
    autoReplyOurRejectTemplate: '感谢回复，结合当前岗位要求，本次先不继续推进，祝你顺利。',
    autoReplyOurRejectCommonPhrase: '',
    autoReplyClickNotFit: true,
    maxPerRun: 30,
    delayMinMs: 1200,
    delayMaxMs: 2600,
    freqBackoffSec: 25,
    // 年龄硬过滤：支持区间；minAge/maxAge 任一为 0 表示不启用该边界
    minAge: 0,
    // 年龄硬过滤：例如 35 表示 36 岁及以上直接跳过；0=不启用
    maxAge: 0,
    // 学历/院校硬过滤：支持 3/4/5/6 与 985/211/art
    minEdu: '0',
    replyCooldownMin: 120,
    allowOutreachWithoutAI: false,
    keywordsAndMode: false,
    requiredKeywords: '',
    includeKeywords: '',
    excludeKeywords: '',
    aiNiceKeywords: '',
    ai: {
      baseUrl: '',
      apiKey: '',
      model: '',
    },
    aiPrompts: {
      stage1: '你是一名资深招聘专家。你会根据岗位要求和候选人的基本信息，判断是否值得继续查看其完整简历并沟通。请只输出 JSON。',
      stage2: '你是一名简历筛选助手。请根据岗位名称、岗位要求和候选人简历判断是否匹配；允许基于同义词、近义岗位名、典型项目名和等价职责做语义判断；岗位名权重最高，项目经验默认按强弱扣分而不是硬性一票否决，公司/平台背景可作为加分项；排除项命中需要重扣分，尤其当目标岗位/实际岗位/最近岗位直接命中排除项时，通常应判定为不通过，除非其他证据特别强；禁止基于猜测、疑似风险或单纯“未提及”做过度扣分。请只输出 JSON。',
    },
    thresholds: {
      passScore: 60
    }
  };

  let settings = { ...DEFAULT_SETTINGS };
  let running = false;
  let stopping = false;
  // 1.1.2：风险模式运行时判断
  // 默认 low；只有 settings.riskMode === 'auto' 时才启用 1.0.3 自动打招呼路径
  function isLowRiskMode() {
    try {
      return String(settings && settings.riskMode || 'low') !== 'auto';
    } catch (_) {
      return true;
    }
  }
  // 1.1.2：humanizer 运行期状态
  let humanizerRunStartTs = 0;          // 当前运行启动时间
  let humanizerNextRestAt = 0;          // 下次"休息期"触发的时间戳
  let humanizerActionsSinceLastScroll = 0; // 距离上次"假装滚动看看"的动作数

  let heartbeatTimer = null;
  let heartbeatLastTs = 0;
  let latestGeekList = [];
  let latestGeekByName = new Map();
  let latestGeekById = new Map();
  let latestGeekByEncryptId = new Map();
  let jobsCache = new Map(); // key -> job
  let jobsCacheNormalizedOnce = false;
  let jobKeywordOverrides = {};
  let localJobKeywordPresets = [];
  let frameRole = detectFrameRole();
  let pendingStartBusy = false;
  let featuredPropCardConsent = null;
  let candidateRuntimeStates = new Map();
  let autoReplyLoopToken = 0;
  let lastResumeExtractMeta = { source: 'unknown', length: 0, note: '' };
  let lastLatestIframeResumeFingerprint = { candidateKey: '', hash: '' };
  let pendingManualHighlightTimer = null;

  const LEGACY_AI_PROMPTS = {
    stage1: new Set([
      '你是一名资深招聘专家。你会根据岗位要求和候选人的基本信息，判断是否值得继续查看其完整简历并沟通。请只输出 JSON。',
    ]),
    stage2: new Set([
      '你是一名简历筛选助手。请根据岗位要求判断候选人简历是否匹配。请只输出 JSON。',
      '你是一名简历筛选助手。请根据岗位要求判断候选人简历是否匹配，并允许基于同义词、近义岗位名和等价职责做语义判断。请只输出 JSON。',
      '你是一名简历筛选助手。请根据岗位要求判断候选人简历是否匹配，并允许基于同义词、近义岗位名和等价职责做语义判断；禁止基于猜测、疑似风险或单纯“未提及”做过度扣分。请只输出 JSON。',
      '你是一名简历筛选助手。请根据岗位名称、岗位要求和候选人简历判断是否匹配；允许基于同义词、近义岗位名、典型项目名和等价职责做语义判断；岗位名权重最高，项目经验默认按强弱扣分而不是硬性一票否决，公司/平台背景可作为加分项；禁止基于猜测、疑似风险或单纯“未提及”做过度扣分。请只输出 JSON。',
    ]),
  };

  const SCHOOL_GROUPS = {
    '985': [
      '北京大学', '中国人民大学', '清华大学', '北京航空航天大学', '北京理工大学', '中国农业大学', '北京师范大学', '中央民族大学',
      '南开大学', '天津大学', '大连理工大学', '东北大学', '吉林大学', '哈尔滨工业大学', '复旦大学', '同济大学',
      '上海交通大学', '华东师范大学', '南京大学', '东南大学', '浙江大学', '中国科学技术大学', '厦门大学', '山东大学',
      '中国海洋大学', '武汉大学', '华中科技大学', '湖南大学', '中南大学', '国防科技大学', '中山大学', '华南理工大学',
      '四川大学', '电子科技大学', '重庆大学', '西安交通大学', '西北工业大学', '西北农林科技大学', '兰州大学',
    ],
    '211': [
      '北京大学', '中国人民大学', '清华大学', '北京交通大学', '北京工业大学', '北京航空航天大学', '北京理工大学', '北京科技大学',
      '北京化工大学', '北京邮电大学', '中国农业大学', '北京林业大学', '北京中医药大学', '北京师范大学', '北京外国语大学', '中国传媒大学',
      '中央财经大学', '对外经济贸易大学', '北京体育大学', '中央音乐学院', '中央民族大学', '中国政法大学', '华北电力大学',
      '南开大学', '天津大学', '天津医科大学', '河北工业大学', '太原理工大学', '内蒙古大学', '辽宁大学', '大连理工大学',
      '东北大学', '大连海事大学', '吉林大学', '延边大学', '东北师范大学', '哈尔滨工业大学', '哈尔滨工程大学', '东北农业大学',
      '东北林业大学', '复旦大学', '同济大学', '上海交通大学', '华东理工大学', '东华大学', '华东师范大学', '上海外国语大学',
      '上海财经大学', '上海大学', '海军军医大学', '第二军医大学', '南京大学', '苏州大学', '东南大学', '南京航空航天大学',
      '南京理工大学', '中国矿业大学', '河海大学', '江南大学', '南京农业大学', '中国药科大学', '南京师范大学', '浙江大学',
      '安徽大学', '中国科学技术大学', '合肥工业大学', '厦门大学', '福州大学', '南昌大学', '山东大学', '中国海洋大学',
      '中国石油大学', '郑州大学', '武汉大学', '华中科技大学', '中国地质大学', '武汉理工大学', '华中农业大学', '华中师范大学',
      '中南财经政法大学', '湖南大学', '中南大学', '湖南师范大学', '国防科技大学', '中山大学', '暨南大学', '华南理工大学',
      '华南师范大学', '广西大学', '海南大学', '四川大学', '西南交通大学', '电子科技大学', '四川农业大学', '西南财经大学',
      '重庆大学', '西南大学', '贵州大学', '云南大学', '西藏大学', '西北大学', '西安交通大学', '西北工业大学',
      '西安电子科技大学', '长安大学', '西北农林科技大学', '陕西师范大学', '空军军医大学', '第四军医大学', '兰州大学', '青海大学',
      '宁夏大学', '新疆大学', '石河子大学',
    ],
    art: [
      '中央美术学院', '中国美术学院', '清华大学美术学院', '鲁迅美术学院', '天津美术学院',
      '广州美术学院', '湖北美术学院', '西安美术学院', '四川美术学院',
      '中国传媒大学', '北京电影学院',
    ],
  };

  const ART_MAJOR_KEYWORDS = [
    '美术学院', '中国画', '绘画', '油画', '版画', '壁画', '雕塑',
    '艺术设计', '视觉传达', '工艺美术', '美术学', '动画', '插画',
    '服装设计', '产品设计', '环境设计', '数字媒体艺术',
  ];

  init();

  function isChatIndexPath(pathname) {
    const p = String(pathname || '');
    return p.includes('/web/chat/index') || p.includes('/web/chat/im');
  }

  function isOnChatIndexPage() {
    // 重要：不要用 body[data-pv] 判断“沟通页”
    // Boss 的 pv 可能在 /web/chat/job/list 仍显示为 /web/chat/index，导致误判。
    const path = String(location.pathname || '');
    if (isChatIndexPath(path)) return true;

    // DOM 兜底：你提供的沟通页标识（某些 SPA 路由还未更新时可用）
    const pageName = String(document.querySelector?.('.page-name')?.textContent || '').replace(/\s+/g, ' ').trim();
    if (pageName && pageName.includes('沟通')) return true;

    // href 兜底（包含 query/hash）
    const href = String(location.href || '');
    if (href.includes('/web/chat/index')) return true;
    return false;
  }

  async function init() {
    await loadSettings();
    await loadJobsCache();
    listenGeekListIntercept();
    listenPopupMessages();
    listenFrameDispatch();
    if (frameRole.isTop) startJobDomScraper();
    if (frameRole.isTop) startPendingStartWatcher();
    if (frameRole.isTop && isLowRiskMode()) startPendingManualHighlightWatcher();
    if (frameRole.isTop) {
      // 口径：关闭“网页悬浮面板”功能，避免干扰与“点 X 关不掉”等问题。
      await setPanelHidden(true).catch(() => {});
      forceRemovePanels(8000);
      consumePendingStart().catch(() => {});
      // 1.1.x：popup 跳转到推荐牛人页时把目标候选人写到 storage，这里负责消费并定位
      consumePendingLocateTargetIfAny().catch(() => {});
      logInfo('内容脚本已加载');
    }
  }

  async function isPanelHidden() {
    const r = await chrome.storage.local.get([STORAGE_KEYS.panelHidden]);
    return !!r?.[STORAGE_KEYS.panelHidden];
  }

  async function setPanelHidden(v) {
    await chrome.storage.local.set({ [STORAGE_KEYS.panelHidden]: !!v }).catch(() => {});
  }

  function forceRemovePanels(durationMs = 10000) {
    const end = Date.now() + Math.max(500, durationMs);
    const timer = setInterval(() => {
      try {
        const nodes = Array.from(document.querySelectorAll('#boss-assist-panel-root'));
        for (const n of nodes) {
          try { n.remove(); } catch {}
        }
      } catch {}
      if (Date.now() > end) clearInterval(timer);
    }, 260);
  }

  function schedulePendingManualHighlightRefresh(delayMs = 120) {
    if (!isLowRiskMode() || !frameRole.isTop) return;
    try { if (pendingManualHighlightTimer) clearTimeout(pendingManualHighlightTimer); } catch {}
    pendingManualHighlightTimer = setTimeout(() => {
      pendingManualHighlightTimer = null;
      applyPersistedPendingManualHighlights().catch(() => {});
    }, delayMs);
  }

  async function applyPersistedPendingManualHighlights() {
    if (!isLowRiskMode() || !frameRole.isTop) return;
    if (!isOutreachContextReady()) return;
    const processed = await getProcessedOutreachPruned();
    if (!processed || typeof processed !== 'object') return;
    // 1.1.x：仅高亮"当前选中岗位"下的待人工记录；不同岗位的待人工卡片不再误亮蓝边
    const currentJobKey = String(settings?.selectedJobKey || '').trim();
    const cards = findCandidateCards();
    for (const card of cards) {
      try {
        const name = getCandidateName(card);
        // 1.1.3：用所有可能 key 查
        const item = findAndCanonicalizeProcessed(processed, name, card);
        if (!item?.pendingManualContact) continue;
        if (!isProcessedHitForCurrentJob(item, currentJobKey)) continue;
        applyCandidateRuntimeState(card, getCandidateRuntimeStateStyle('manual_pending'));
      } catch {}
    }
  }

  function startPendingManualHighlightWatcher() {
    schedulePendingManualHighlightRefresh(60);
    const mo = new MutationObserver(() => {
      schedulePendingManualHighlightRefresh(120);
    });
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  }

  function listenPanelToggleHotkey() {
    // Alt+Shift+B：显示/隐藏悬浮面板（只在顶层页面）
    if (window.__bossAssistPanelHotkey__) return;
    window.__bossAssistPanelHotkey__ = true;
    window.addEventListener('keydown', async (e) => {
      try {
        if (!e.altKey || !e.shiftKey) return;
        const key = String(e.key || '').toLowerCase();
        if (key !== 'b') return;
        e.preventDefault();
        const root = document.getElementById('boss-assist-panel-root');
        if (root) {
          root.remove();
          await setPanelHidden(true);
          return;
        }
        await setPanelHidden(false);
        mountInpagePanel();
      } catch {}
    }, { capture: true });
  }

  async function consumePendingStart() {
    // 跨路由自动续跑：用于“点开始 → 自动跳推荐牛人 → 自动继续”
    if (pendingStartBusy) return;
    const r = await chrome.storage.local.get([STORAGE_KEYS.pendingStart]);
    const p = r?.[STORAGE_KEYS.pendingStart];
    if (!p || typeof p !== 'object') return;
    const ts = Number(p.ts || 0);
    if (!Number.isFinite(ts) || Date.now() - ts > 3 * 60 * 1000) {
      await chrome.storage.local.remove([STORAGE_KEYS.pendingStart]).catch(() => {});
      return;
    }
    if (!isPendingStartReady(p)) return;
    pendingStartBusy = true;
    try {
      if (String(p.kind || '').trim() === 'outreach') {
        const ready = await waitForOutreachReadyDom(15000).catch(() => false);
        if (!ready) return;
      }
      await chrome.storage.local.remove([STORAGE_KEYS.pendingStart]).catch(() => {});
      // 等页面稳定一点再启动
      await sleep(600);
      startRun().catch(() => {});
    } finally {
      pendingStartBusy = false;
    }
  }

  function isPendingStartReady(pending) {
    const kind = String(pending?.kind || '').trim();
    if (kind === 'reply') {
      return isOnChatIndexPage();
    }

    const pv = String(document.body?.getAttribute?.('data-pv') || '');
    const path = String(location.pathname || '');
    const hasRecommendDomStrong = () => {
      const list = queryAnyDoc('#recommend-list');
      if (!list) return false;
      return !!queryAnyDoc('#recommend-list .candidate-card-wrap') || !!queryAnyDoc('.recommend-wrap .candidate-card-wrap');
    };
    return (
      path.includes('/web/chat/recommend')
      || pv.includes('/web/chat/recommend')
      || !!queryAnyDoc('iframe[name="recommendFrame"], iframe[src*="/web/frame/recommend-v2/"]')
      || hasRecommendDomStrong()
    );
  }

  function startPendingStartWatcher() {
    if (window.__bossAssistPendingStartWatcher__) return;
    window.__bossAssistPendingStartWatcher__ = true;
    setInterval(() => {
      if (running || stopping || pendingStartBusy) return;
      consumePendingStart().catch(() => {});
    }, 900);
  }

  function isOnRecommendRouteNow() {
    const pv = String(document.body?.getAttribute?.('data-pv') || '');
    const path = String(location.pathname || '');
    return path.includes('/web/chat/recommend') || pv.includes('/web/chat/recommend');
  }

  function hasRecommendFrame() {
    return !!queryAnyDoc('iframe[name="recommendFrame"], iframe[src*="/web/frame/recommend-v2/"]');
  }

  function hasRecommendListRoot() {
    return !!(
      queryAnyDoc('#recommend-list')
      || queryAnyDoc('.recommend-wrap')
      || queryAnyDoc('[class*="recommend-list"]')
      || queryAnyDoc('[class*="candidate-list"]')
    );
  }

  function hasRecommendReadyDom() {
    return !!(
      queryAnyDoc('.job-selecter-wrap .ui-dropmenu-label')
      || queryAnyDoc('.candidate-head .job-selecter-wrap .ui-dropmenu-label')
    );
  }

  function hasRecommendDomStrong() {
    const list = queryAnyDoc('#recommend-list');
    if (!list) return false;
    return !!queryAnyDoc('#recommend-list .candidate-card-wrap') || !!queryAnyDoc('.recommend-wrap .candidate-card-wrap');
  }

  function isOutreachLikeContext() {
    const role = detectFrameRole();
    return (
      role.isRecommendFrame
      || role.isSearchFrame
      || isOnRecommendRouteNow()
      || hasRecommendFrame()
      || hasRecommendDomStrong()
    );
  }

  function isOutreachContextReady() {
    return isOutreachLikeContext() && (
      hasRecommendReadyDom()
      || hasRecommendListRoot()
      || findCandidateCards().length > 0
      || !!queryAnyDoc('.candidate-card-wrap')
    );
  }

  async function waitForOutreachReadyDom(timeoutMs = 15000) {
    return !!await waitFor(() => {
      if (!isOutreachLikeContext()) return null;
      if (isOutreachContextReady()) return true;
      return null;
    }, timeoutMs).catch(() => false);
  }

  function detectFrameRole() {
    const isTop = window.top === window;
    const name = String(window.name || '');
    const path = String(location.pathname || '');
    const pv = document.body?.getAttribute?.('data-pv') || '';

    const isRecommendFrame = name === 'recommendFrame' || path.startsWith('/web/frame/recommend-v2/');
    const isSearchFrame = path.startsWith('/web/frame/') && /search/i.test(path);
    // 顶层推荐牛人路由（参考 goodHR）：/web/chat/recommend
    const isOutreachTop = isTop && (path.includes('/web/chat/recommend') || pv.includes('/web/chat/recommend'));
    // 沟通页（严格）：只以 path / DOM 为准（不要用 pv）
    const isChatPage = isTop && isOnChatIndexPage();
    const isJobPage = isTop && (/job/i.test(pv) || /job/i.test(path));

    return {
      isTop,
      name,
      path,
      pv,
      isRecommendFrame,
      isSearchFrame,
      isOutreachFrame: isRecommendFrame || isSearchFrame || isOutreachTop,
      isChatPage,
      isJobPage,
    };
  }

  function listenFrameDispatch() {
    // 顶层页面负责把“主动寻访”转发到推荐牛人/搜索 iframe 中执行
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== 'boss-assistant-ui') return;
      // 注意：iframe 内收到 parent.postMessage 时，event.source === window.parent（不是 window）
      // 这里不要用 event.source === window 的判断，否则 iframe 永远收不到 START/STOP
      if (window.top !== window) {
        // iframe：只接受来自同源父页面（Boss 自己页面）的指令
        try {
          if (event.origin && event.origin !== location.origin) return;
        } catch {}
      }
      if (data.type === 'START') startRun().catch(() => {});
      if (data.type === 'STOP') stopRun();
      if (data.type === 'UPDATE_SETTINGS') loadSettings().catch(() => {});
    });
  }

  function dispatchToOutreachFrames(type, { target = 'all' } = {}) {
    try {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      let sent = 0;
      for (const iframe of iframes) {
        const src = iframe.getAttribute('src') || '';
        const win = iframe.contentWindow;
        if (!win) continue;
        // 推荐牛人 / 搜索 frame
        const name = String(iframe.getAttribute('name') || '');
        const isRecommend =
          name === 'recommendFrame'
          || src.includes('/web/frame/recommend-v2/')
          || src.toLowerCase().includes('recommend');
        const isSearch = (src.includes('/web/frame/') && /search/i.test(src));
        const shouldSend =
          target === 'recommend' ? isRecommend
            : target === 'search' ? isSearch
              : (isRecommend || isSearch);
        if (shouldSend) {
          // 同源页面：尽量用明确 origin，避免某些浏览器策略丢消息
          try {
            win.postMessage({ source: 'boss-assistant-ui', type }, location.origin);
          } catch {
            win.postMessage({ source: 'boss-assistant-ui', type }, '*');
          }
          sent++;
        }
      }
      if (type === 'START' && sent === 0) {
        logWarn(target === 'recommend'
          ? '主动寻访：未找到可转发的推荐牛人 iframe（如果页面结构更新，请把 iframe 的 src 发我）'
          : '主动寻访：未找到可转发的推荐牛人/搜索 iframe（如果页面结构更新，请把 iframe 的 src 发我）');
      }
    } catch {
      // ignore
    }
  }

  function startJobDomScraper() {
    // 职位管理 DOM 兜底：从列表里拿到岗位名 + encryptJobId（data-id）
    const tick = async () => {
      try {
        const jobs = scrapeJobsFromDom();
        if (jobs.length) await upsertJobs(jobs);
      } catch {}
    };
    tick();
    setInterval(tick, 4000);
  }

  function scrapeJobsFromDom() {
    const items = getAllDocs().flatMap((d) => Array.from(d.querySelectorAll?.('li.job-jobInfo-warp[data-id]') || []));
    if (!items.length) return [];
    const out = [];

    // 职位管理页有“开放中/已关闭”tab（你提供的：.tab-btn.cur）
    // 若每条岗位没有明确状态，则用当前 tab 作为该列表内岗位的统一状态。
    const tabTextRaw = String(
      queryAnyDoc('.job-filter-container .tab-box .tab-btn.cur')?.textContent
      || queryAnyDoc('.tab-box .tab-btn.cur')?.textContent
      || queryAnyDoc('.tab-btn.cur')?.textContent
      || ''
    ).replace(/\s+/g, ' ').trim();
    const tabIsOpen = /开放中/.test(tabTextRaw) ? true : /已关闭|关闭中|已暂停|暂停中|已下线|下线/.test(tabTextRaw) ? false : null;

    for (const li of items) {
      const encryptJobId = li.getAttribute('data-id');
      const name = li.querySelector('.job-title a')?.textContent?.trim() || '';
      if (!encryptJobId || !name) continue;

      const statusText = String(
        li.querySelector('.status-box')?.textContent
        || li.querySelector('.job-status-wrapper')?.textContent
        || ''
      ).replace(/\s+/g, ' ').trim();
      const isOpenByClass = !!li.querySelector('.status-opening');
      const isClosedByText = /已关闭|关闭中|已暂停|暂停中|已下线|下线/.test(statusText);
      const isOpenByText = /开放中/.test(statusText);
      let isOpen = isClosedByText ? false : (isOpenByClass || isOpenByText ? true : null);
      if (isOpen == null && tabIsOpen != null) isOpen = tabIsOpen;

      out.push({
        key: `encryptJobId:${encryptJobId}`,
        encryptJobId,
        name,
        jdText: '',
        isOpen,
        statusText: statusText || tabTextRaw || '',
        sourceUrl: tabIsOpen === true ? 'dom:job-management:open' : 'dom:job-management',
      });
    }
    return out;
  }

  async function refreshJobsNow() {
    if (!frameRole.isTop) throw new Error('请在顶层页面刷新岗位列表');
    const ok = await goToJobListAndWait();
    if (!ok) throw new Error('未找到岗位列表（请打开“职位管理”页后重试）');
    const jobs = scrapeJobsFromDom();
    if (jobs.length) await upsertJobs(jobs);
    return jobs.length;
  }

  async function loadJobsCache() {
    const result = await chrome.storage.local.get([STORAGE_KEYS.jobs]);
    const arr = Array.isArray(result?.[STORAGE_KEYS.jobs]) ? result[STORAGE_KEYS.jobs] : [];
    const merged = new Map();
    let normalizedChanged = false;
    for (const j of arr) {
      if (!j) continue;
      const normalized = normalizeStoredJobState(j);
      const key = canonicalJobKey(j);
      if (!key) continue;
      const prev = merged.get(key);
      merged.set(key, { ...(prev || {}), ...normalized, key, updatedAt: Math.max(prev?.updatedAt || 0, normalized.updatedAt || 0, Date.now()) });
      if (
        normalized.isOpen !== j.isOpen
        || String(normalized.statusText || '') !== String(j.statusText || '')
        || String(normalized.sourceUrl || '') !== String(j.sourceUrl || '')
      ) {
        normalizedChanged = true;
      }
    }
    jobsCache = merged;

    // 只在本次脚本生命周期里归一化写回一次，避免频繁写 storage
    if (!jobsCacheNormalizedOnce) {
      jobsCacheNormalizedOnce = true;
      if (merged.size !== arr.length || normalizedChanged) {
        const out = Array.from(merged.values())
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, 200);
        await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: out }).catch(() => {});
        logInfo(`岗位去重合并：${arr.length} → ${out.length}`);
      }
    }
  }

  function canonicalJobKey(job) {
    const encryptJobId = job?.encryptJobId || null;
    const jobId = job?.jobId || null;
    if (encryptJobId) return `encryptJobId:${String(encryptJobId)}`;
    if (jobId) return `jobId:${String(jobId)}`;
    const key = String(job?.key || '');
    return key || '';
  }

  function inferJobOpenState(job) {
    const current = job?.isOpen;
    if (current === true || current === false) return current;
    const statusText = String(job?.statusText || '').replace(/\s+/g, ' ').trim();
    if (/开放中/.test(statusText)) return true;
    if (/已关闭|关闭中|已暂停|暂停中|已下线|下线/.test(statusText)) return false;
    const sourceUrl = String(job?.sourceUrl || '');
    if (sourceUrl.includes('dom:job-management:open')) return true;
    return null;
  }

  function normalizeStoredJobState(job) {
    const next = { ...(job || {}) };
    const inferred = inferJobOpenState(next);
    if (inferred === true || inferred === false) next.isOpen = inferred;
    if (!String(next.statusText || '').trim()) delete next.statusText;
    if (!String(next.sourceUrl || '').trim()) delete next.sourceUrl;
    return next;
  }

  function listenGeekListIntercept() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'boss-assistant') return;

      if (data.type === 'job-api') {
        try {
          const jobs = extractJobsFromApi(data.url, data.data);
          if (jobs.length > 0) {
            upsertJobs(jobs).catch(() => {});
          }
        } catch (e) {
          // ignore
        }
        return;
      }
      if (data.type !== 'geek-list') return;

      const list = data?.data?.zpData?.geekList || data?.data?.zpData?.geeks || data?.data?.zpData?.list || null;
      if (!Array.isArray(list)) return;
      latestGeekList = list;
      latestGeekByName = new Map();
      latestGeekById = new Map();
      latestGeekByEncryptId = new Map();

      for (const item of list) {
        const name = item?.geekCard?.geekName || item?.geekName || '';
        const geekId = item?.geekCard?.geekId || item?.geekId || null;
        const encryptGeekId = item?.encryptGeekId || item?.geekCard?.encryptGeekId || item?.geekCard?.encryptId || null;

        if (name) latestGeekByName.set(String(name).trim(), item);
        if (geekId) latestGeekById.set(String(geekId), item);
        if (encryptGeekId) latestGeekByEncryptId.set(String(encryptGeekId), item);
      }
    });
  }

  async function upsertJobs(jobs) {
    let changed = false;
    for (const j of jobs) {
      if (!j) continue;
      const key = canonicalJobKey(j);
      if (!key) continue;

      // 如果缓存里同时存在 jobId:xxx 与 encryptJobId:yyy（同一岗位），统一合并到 encryptJobId key
      let prev = jobsCache.get(key);
      if (!prev && j?.key && j.key !== key) {
        prev = jobsCache.get(j.key) || null;
      }

      // 防止“岗位列表 API（无 JD）”把已有 JD 覆盖成空
      const incoming = { ...(j || {}) };
      {
        const jd = String(incoming.jdText || '').trim();
        if (!jd) delete incoming.jdText;
        else incoming.jdText = jd;
      }
      {
        const name = String(incoming.name || '').trim();
        if (!name) delete incoming.name;
        else incoming.name = name;
      }
      {
        const inferredOpen = inferJobOpenState(incoming);
        if (inferredOpen === true || inferredOpen === false) incoming.isOpen = inferredOpen;
        else delete incoming.isOpen;
      }
      {
        const status = String(incoming.statusText || '').trim();
        if (!status) delete incoming.statusText;
        else incoming.statusText = status;
      }
      {
        const source = String(incoming.sourceUrl || '').trim();
        if (!source) delete incoming.sourceUrl;
        else incoming.sourceUrl = source;
      }

      // 只要有新字段（特别是 jdText）就覆盖；没有的新字段则保留 prev
      const merged = { ...(prev || {}), ...incoming, key, updatedAt: Date.now() };
      const jdChanged = (merged.jdText || '') !== (prev?.jdText || '');
      const nameChanged = (merged.name || '') !== (prev?.name || '');
      const openChanged = (merged.isOpen ?? null) !== (prev?.isOpen ?? null);
      const statusChanged = String(merged.statusText || '') !== String(prev?.statusText || '');
      const sourceChanged = String(merged.sourceUrl || '') !== String(prev?.sourceUrl || '');
      if (!prev || jdChanged || nameChanged || openChanged || statusChanged || sourceChanged) {
        jobsCache.set(key, merged);
        if (j?.key && j.key !== key) jobsCache.delete(j.key);
        changed = true;
      }
    }
    if (!changed) return;

    const arr = Array.from(jobsCache.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 200);
    await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: arr });
    logInfo(`已更新岗位缓存：${arr.length} 个`);
  }

  function extractJobsFromApi(url, payload) {
    // Boss API 通常是 { code, message, zpData: {...} }
    const root = payload?.zpData || payload?.data || payload || {};
    const found = [];

    // 深度遍历：找“岗位列表”或“岗位详情”
    const stack = [root];
    const visited = new Set();

    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (visited.has(cur)) continue;
      visited.add(cur);

      if (Array.isArray(cur)) {
        for (const item of cur) stack.push(item);
        // 如果像岗位数组，尝试直接解析
        const sample = cur[0];
        if (sample && typeof sample === 'object' && looksLikeJob(sample)) {
          for (const item of cur) {
            const job = normalizeJob(item, url);
            if (job) found.push(job);
          }
        }
        continue;
      }

      if (looksLikeJob(cur)) {
        const job = normalizeJob(cur, url);
        if (job) found.push(job);
      }

      for (const v of Object.values(cur)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }

    // 去重
    const map = new Map();
    for (const j of found) map.set(j.key, j);
    return Array.from(map.values());
  }

  function looksLikeJob(obj) {
    const hasId = obj.jobId || obj.encryptJobId || obj.job?.jobId || obj.job?.encryptJobId;
    const hasName = obj.jobName || obj.positionName || obj.name || obj.title || obj.job?.jobName || obj.job?.positionName;
    return !!(hasId && hasName);
  }

  function normalizeJob(obj, url) {
    const jobId = obj.jobId || obj.job?.jobId || null;
    const encryptJobId = obj.encryptJobId || obj.job?.encryptJobId || null;
    const name =
      obj.positionName ||
      obj.jobName ||
      obj.name ||
      obj.title ||
      obj.job?.positionName ||
      obj.job?.jobName ||
      '';

    const jdText =
      obj.jobDesc ||
      obj.jobDescription ||
      obj.positionDesc ||
      obj.positionDescription ||
      obj.postDesc ||
      obj.postDescription ||
      obj.jobContent ||
      obj.jobRequirement ||
      obj.requirementDesc ||
      obj.duty ||
      obj.responsibility ||
      obj.description ||
      obj.requirement ||
      obj.detail ||
      obj.content ||
      obj.job?.jobDesc ||
      obj.job?.positionDesc ||
      obj.job?.positionDescription ||
      obj.job?.postDesc ||
      obj.job?.postDescription ||
      obj.job?.jobContent ||
      obj.job?.jobRequirement ||
      obj.job?.requirementDesc ||
      obj.job?.duty ||
      obj.job?.responsibility ||
      obj.job?.description ||
      '';

    // 统一用 encryptJobId 做唯一 key（避免与 DOM 列表的 encryptJobId key 产生重复）
    const key = encryptJobId ? `encryptJobId:${encryptJobId}` : jobId ? `jobId:${jobId}` : '';
    if (!key || !name) return null;

    const statusText =
      obj.statusDesc ||
      obj.jobStatusDesc ||
      obj.statusName ||
      obj.job?.statusDesc ||
      obj.job?.jobStatusDesc ||
      '';
    const statusStr = String(statusText || '').replace(/\s+/g, ' ').trim();
    const isClosedByText = /已关闭|关闭中|已暂停|暂停中|已下线|下线/.test(statusStr);
    const isOpenByText = /开放中/.test(statusStr);
    const isOpen = isClosedByText ? false : (isOpenByText ? true : null);

    return {
      key,
      jobId: jobId ? String(jobId) : null,
      encryptJobId: encryptJobId ? String(encryptJobId) : null,
      name: String(name).trim(),
      jdText: jdText ? String(jdText).trim() : '',
      isOpen,
      statusText: statusStr,
      sourceUrl: String(url || ''),
    };
  }

  function listenPopupMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'BOSS_ASSIST_PING') {
        sendResponse({ ok: true, version: window.__bossAssistVersion__ || __BOSS_ASSIST_VERSION__ });
        return;
      }

      if (message?.type === 'BOSS_ASSIST_SYNC_JOB_JD') {
        syncJobJdToCache(message.jobKey, { force: !!message?.force })
          .then((jdText) => sendResponse({ success: true, jdText }))
          .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_REFRESH_JOBS') {
        refreshJobsNow()
          .then((count) => sendResponse({ success: true, count }))
          .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_FETCH_COMMON_PHRASES') {
        (async () => {
          frameRole = detectFrameRole();
          if (!frameRole.isTop) throw new Error('请在 Boss 顶层页面执行（沟通页）');
          const phrases = await fetchBossCommonPhrasesFromUi();
          return { success: true, phrases };
        })()
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_FETCH_CHAT_JOBS') {
        (async () => {
          frameRole = detectFrameRole();
          if (!frameRole.isTop) throw new Error('请在 Boss 顶层页面执行（沟通页）');
          const jobs = await fetchChatJobsFromTopBar();
          return { success: true, jobs };
        })()
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_LOCATE_CANDIDATE') {
        // 1.1.x：根据候选人 id/姓名，在推荐牛人页找到对应卡片，滚到视图中央并高亮几秒
        // 因为 Boss 没有"按 id 直接打开简历"的稳定 URL，这里只做"定位 + 提示"，
        // 让用户手动点开候选人查看简历。
        (async () => {
          try {
            frameRole = detectFrameRole();
            if (!frameRole.isTop) return sendResponse({ success: false, error: '请在 Boss 顶层页面执行' });
            const target = {
              encryptGeekId: String(message.encryptGeekId || '').trim(),
              geekId:        String(message.geekId || '').trim(),
              name:          String(message.name || '').trim(),
              // 1.1.x：当时筛选的岗位 —— 切错岗位时推荐列表里根本没有这个候选人，必须先切回去
              jobKey:        String(message.jobKey || '').trim(),
              jobName:       String(message.jobName || '').trim(),
            };
            // 1) 不在推荐牛人页：先存 storage 兜底（应付硬刷新），同时主动跳转 + 等 SPA 切完路由再直接定位
            //    背景：Boss 是 SPA，location.href 切到 recommend 经常不触发整页 reload，
            //    content script 留在原 frame 不重新 init → consumePendingLocateTargetIfAny 不会被调用。
            //    这里改成：触发跳转 → waitFor URL 切到 recommend → 给点渲染时间 → 直接调 locate。
            if (!isOnRecommendRouteNow()) {
              try {
                await chrome.storage.local.set({
                  bossAssistLocateTarget: { ...target, ts: Date.now() },
                });
              } catch {}
              try { location.href = '/web/chat/recommend?ka=menu-geek-recommend'; } catch {}
              // 等 URL 切到推荐页（SPA 路由通常 1-2 秒内完成；硬 reload 此处会断开 listener，无影响）
              const onRecommend = await waitFor(() => isOnRecommendRouteNow() ? true : null, 8000).catch(() => false);
              if (!onRecommend) {
                // 没等到（可能正在硬 reload），交给 storage 接力
                return sendResponse({ success: true, navigated: true });
              }
              // 给推荐列表一点渲染时间
              await sleep(1000);
              // 已经接管处理，把 storage 里的目标清掉避免 init 时再触发一遍
              try { await chrome.storage.local.remove(['bossAssistLocateTarget']); } catch {}
              const r = await locateAndHighlightCandidate(target).catch((e) => ({ ok: false, error: e?.message || String(e) }));
              return sendResponse({ success: !!r?.ok, ...r });
            }
            // 2) 已经在推荐牛人页：直接定位
            const r = await locateAndHighlightCandidate(target).catch((e) => ({ ok: false, error: e?.message || String(e) }));
            return sendResponse({ success: !!r?.ok, ...r });
          } catch (e) {
            return sendResponse({ success: false, error: e?.message || String(e) });
          }
        })();
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_GO_CHAT') {
        (async () => {
          frameRole = detectFrameRole();
          if (!frameRole.isTop) {
            throw new Error('请在 Boss 顶层页面执行跳转');
          }
          const nav = await ensureChatPage({ startAfter: false });
          // 等到“真的进了沟通页”再返回 success，避免误报
          const ok = await waitFor(() => {
            return isOnChatIndexPage() ? true : null;
          }, 8000).catch(() => false);
          if (!ok) {
            throw new Error(`跳转沟通页失败（pv=${document.body?.getAttribute?.('data-pv') || ''} path=${location.pathname}）`);
          }
          return { success: true, nav };
        })()
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_TOGGLE_INPAGE_PANEL') {
        (async () => {
          if (!frameRole.isTop) return;
          const root = document.getElementById('boss-assist-panel-root');
          if (root) {
            try { root.remove(); } catch {}
            await setPanelHidden(true);
            sendResponse({ success: true, hidden: true });
            return;
          }
          await setPanelHidden(false);
          try { mountInpagePanel(); } catch {}
          sendResponse({ success: true, hidden: false });
        })().catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_HIDE_PANEL') {
        setPanelHidden(true).then(() => {
          forceRemovePanels(12000);
          sendResponse({ success: true });
        }).catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_SHOW_PANEL') {
        // 口径：网页悬浮面板已关闭，不再支持主动显示
        setPanelHidden(true).then(() => {
          forceRemovePanels(12000);
          sendResponse({ success: false, error: '网页悬浮面板功能已关闭' });
        }).catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_START') {
        frameRole = detectFrameRole();
        // 当前 frame 自己也尝试执行（只会在“合适页面”里真正跑）
        startRun({ restart: !!message?.restart, mode: message?.mode })
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
        return true;
      }

      if (message?.type === 'BOSS_ASSIST_STOP') {
        if (frameRole.isTop) {
          dispatchToOutreachFrames('STOP');
        }
        stopRun();
        sendResponse({ success: true });
        return;
      }

      if (message?.type === 'BOSS_ASSIST_UPDATE_SETTINGS') {
        if (frameRole.isTop) {
          dispatchToOutreachFrames('UPDATE_SETTINGS');
        }
        loadSettings().then(() => sendResponse({ success: true }));
        return true;
      }
    });
  }

  async function syncJobJdToCache(jobKey, { force = false } = {}) {
    if (!frameRole.isTop) {
      throw new Error('请在“职位管理”页（顶层页面）执行 JD 同步');
    }
    if (!jobKey) throw new Error('缺少 jobKey');

    await loadJobsCache();
    const job = jobsCache.get(jobKey);
    if (!force && job?.jdText && String(job.jdText).trim()) {
      return job.jdText;
    }

    // 0.5) 如果当前就在“岗位编辑页”（例如 /web/chat/job/edit），则在本页等待 textarea 加载后直接抓取
    // 注意：job/edit 页面可能不是你选中的那个岗位，避免串 JD。
    // 只有当能从 URL/DOM 识别出当前正在编辑的 jobId/encryptJobId 且与 jobKey 匹配时，才允许在此页抓取。
    if (isOnJobEditPage()) {
      const desired = parseJobKey(jobKey, job);
      const current = getCurrentEditingJobIdentifiers();
      const matches = isSameJob(desired, current);

      if (matches) {
        const ta = await waitFor(() => pickJdTextarea({ allowInvisible: true }), 15000);
        if (ta) {
          await waitFor(() => {
            const v = String(ta.value || '').trim();
            return v.length >= 20 ? v : null;
          }, 25000);
        }
        const jdNow = extractJdFromCurrentJobDetail();
        if (jdNow && String(jdNow).trim()) {
          const merged = {
            ...(job || {}),
            key: jobKey,
            encryptJobId: desired.encryptJobId || job?.encryptJobId || null,
            jobId: desired.jobId || job?.jobId || null,
            name: job?.name || '',
            jdText: String(jdNow).trim(),
            updatedAt: Date.now(),
            sourceUrl: `dom:job-edit:${location.pathname}`,
          };
          await upsertJobs([merged]);
          await loadJobsCache();
          return merged.jdText;
        }
      }
      // 不匹配：继续走“职位管理列表”流程，避免抓错岗位 JD
    }

    // 如果当前不在职位管理列表，尝试自动跳转到“职位管理”
    if (!queryAnyDoc('li.job-jobInfo-warp[data-id]') && !queryAnyDoc('[data-id][class*="job"]')) {
      const ok = await goToJobListAndWait();
      if (!ok) {
        // 有些入口（如 /web/chat/job/edit）本来就没有岗位列表
        throw new Error(`未进入职位管理页：未找到岗位列表（当前 pv=${document.body?.getAttribute('data-pv') || ''} path=${location.pathname}）。请先打开「职位管理」列表页后重试。`);
      }
    }

    // 支持 key: encryptJobId:xxx / jobId:xxx
    const encryptJobId = job?.encryptJobId || (jobKey.startsWith('encryptJobId:') ? jobKey.slice('encryptJobId:'.length) : null);
    const jobId = job?.jobId || (jobKey.startsWith('jobId:') ? jobKey.slice('jobId:'.length) : null);

    // 1) 用 ID 在“任意岗位列表页”里找到该岗位并点击（兼容 /web/chat/job/list 与 职位管理）
    const target = findJobListItem({ encryptJobId, jobId });
    if (!target) {
      throw new Error('未找到该岗位条目：请确保岗位列表已加载完成，或把该页面的岗位条目 outerHTML 发我以补选择器');
    }
    // 更稳：优先点标题链接，再点整行
    const titleLink =
      target.querySelector?.('.job-title a')
      || target.querySelector?.('a')
      || null;
    if (titleLink) simulateClick(titleLink);
    simulateClick(target);

    // 1.5) 尝试进入编辑态（你的 JD 在 textarea 里）
    await sleep(300);
    const editBtn =
      target?.querySelector?.('a.position-edit') ||
      target?.querySelector?.('a[class*="edit"]') ||
      document.querySelector('a.position-edit') ||
      findButtonByText('编辑') ||
      findElementByTextIncludes(['编辑']);
    if (editBtn) simulateClick(editBtn);

    // 2) 等待 textarea 出现且有 value
    const ta = await waitFor(() => pickJdTextarea({ allowInvisible: true }), 15000);
    if (ta) {
      // JD textarea 通常是异步填充：只要非空就抓（避免“JD较短/加载慢”导致一直等待）
      await waitFor(() => {
        const v = String(ta.value || '').trim();
        return v.length >= 20 ? v : null;
      }, 25000);
    }

    // 3) 提取 JD
    const jdText = extractJdFromCurrentJobDetail();
    if (!jdText || !String(jdText).trim()) {
      const dbg = collectJdDebugInfo();
      throw new Error(`未抓到 JD：可能未进入编辑页或 textarea 未加载。\n调试信息：${JSON.stringify(dbg).slice(0, 600)}`);
    }

    const merged = {
      ...(job || {}),
      key: jobKey,
      encryptJobId: encryptJobId || job?.encryptJobId || null,
      jobId: jobId || job?.jobId || null,
      name: job?.name || '',
      jdText: String(jdText).trim(),
      updatedAt: Date.now(),
      sourceUrl: 'dom:job-detail',
    };

    await upsertJobs([merged]);
    await loadJobsCache();
    return merged.jdText;
  }

  function extractJdFromCurrentJobDetail() {
    // 目标：在职位管理页的“岗位详情/编辑表单”里抓到真正的 JD（职位描述/岗位职责/任职要求）
    // 0) 最强规则：优先读编辑态 textarea.value（你给的结构就是 textarea）
    const ta = pickJdTextarea({ allowInvisible: true });
    if (ta) {
      const v = String(ta.value || '').trim();
      const p = String(ta.getAttribute('placeholder') || '');
      const isJdField = p.includes('请勿填写QQ') || p.includes('微信') || p.includes('电话');
      // placeholder 命中的 textarea 就是 JD 字段：只要非空就返回（避免误判/过严校验）
      if (isJdField && v.length >= 10) return v.replace(/\n{3,}/g, '\n\n').slice(0, 12000);
      if (v && (v.length >= 80 || looksLikeJd(v))) return v.replace(/\n{3,}/g, '\n\n').slice(0, 12000);
    }

    // 1) 强规则：优先从表单行 `.form-row` 中按 title 精确匹配
    const jdTitles = [
      '职位描述', '岗位描述', '岗位职责', '工作职责', '工作内容',
      '任职要求', '岗位要求', '职位要求', '职位信息',
    ];

    const rows = getAllDocs()
      .flatMap((d) => Array.from(d.querySelectorAll?.('.form-row, [class*="form-row"]') || []))
      .filter(isVisible);
    let best = '';
    let bestScore = -Infinity;

    for (const row of rows) {
      const titleEl = row.querySelector('.title, [class*="title"]');
      const contentEl = row.querySelector('.content, [class*="content"]') || row;
      const title = (titleEl?.innerText || titleEl?.textContent || '').trim();
      if (!title) continue;
      if (!jdTitles.some((t) => title.includes(t))) continue;

      const t = (contentEl.innerText || contentEl.textContent || '').trim();
      const score = scoreJdCandidate(title, t);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }

    // 2) 次规则：找明显的描述编辑器/展示块（有时不在 form-row）
    if (!best || best.length < 120) {
      const selectors = [
        '[class*="job-desc"]',
        '[class*="jobDesc"]',
        '[class*="position-desc"]',
        '[class*="positionDesc"]',
        '[class*="job-detail"]',
        '[class*="jobDetail"]',
        '[class*="rich"]',
        '[contenteditable="true"]',
        'textarea',
      ];

      for (const sel of selectors) {
        const els = getAllDocs()
          .flatMap((d) => Array.from(d.querySelectorAll?.(sel) || []))
          .filter(isVisible);
        for (const el of els) {
          const t = el.tagName === 'TEXTAREA'
            ? String(el.value || '').trim()
            : (el.innerText || el.textContent || '').trim();
          const score = scoreJdCandidate('', t);
          if (score > bestScore) {
            bestScore = score;
            best = t;
          }
        }
      }
    }

    // 3) label fallback：找“职位描述/任职要求”标题附近的一块区域
    if (!best || best.length < 120) {
      const label = findElementByTextIncludes(jdTitles);
      if (label) {
        const block = label.closest('.form-row') || label.closest('section') || label.closest('div');
        const t = (block?.innerText || '').trim();
        const score = scoreJdCandidate('', t);
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
    }

    if (!best) return '';
    const cleaned = best.replace(/\n{3,}/g, '\n\n').trim();

    // 最后一层校验：避免抓到类似“是否驻外”这种短字段
    if (!looksLikeJd(cleaned)) return '';
    return cleaned.slice(0, 12000);
  }

  function pickJdTextarea() {
    const candidates = getAllDocs()
      .flatMap((d) => Array.from(d.querySelectorAll?.('textarea') || []))
      .filter((ta) => !!ta);
    if (!candidates.length) return null;

    // 你的 textarea 有很长的 placeholder，优先按 placeholder 识别
    const byPlaceholder = candidates.find((x) => {
      const p = String(x.getAttribute('placeholder') || '');
      return p.includes('请勿填写QQ') || p.includes('微信') || p.includes('电话');
    });
    if (byPlaceholder) return byPlaceholder;

    // 次优：找 value 最长的 textarea
    let best = null;
    let bestLen = -1;
    for (const ta of candidates) {
      const len = String(ta.value || '').trim().length;
      if (len > bestLen) {
        bestLen = len;
        best = ta;
      }
    }
    return bestLen > 0 ? best : null;
  }

  function collectJdDebugInfo() {
    const pv = document.body?.getAttribute('data-pv') || '';
    const listCount = document.querySelectorAll('li.job-jobInfo-warp[data-id]').length;
    const editCount = document.querySelectorAll('a.position-edit').length;
    const tas = Array.from(document.querySelectorAll('textarea'));
    const placeholderHit = tas.filter((x) => {
      const p = String(x.getAttribute('placeholder') || '');
      return p.includes('请勿填写QQ') || p.includes('微信') || p.includes('电话');
    }).length;
    let maxLen = 0;
    for (const ta of tas) {
      maxLen = Math.max(maxLen, String(ta.value || '').trim().length);
    }
    return { pv, path: location.pathname, listCount, editCount, textareaCount: tas.length, placeholderHit, maxTextareaValueLen: maxLen };
  }

  function scoreJdCandidate(title, text) {
    const t = String(text || '').trim();
    if (!t) return -1e9;
    const len = t.length;
    let score = Math.min(2000, len);
    const bonusWords = ['职责', '要求', '任职', '岗位', '工作内容', '加分', '优先', '能力', '经验', '技能'];
    for (const w of bonusWords) {
      if (t.includes(w)) score += 120;
    }
    if (title) score += 200;
    // 明显短字段降权
    if (len < 80) score -= 800;
    if (len < 30) score -= 2000;
    return score;
  }

  function looksLikeJd(text) {
    const t = String(text || '').trim();
    if (t.length < 120) {
      // textarea 场景：有些JD较短但仍合理，放宽到 80
      if (t.length < 80) return false;
    }
    // 至少包含一些“JD常见词”
    const must = ['职责', '要求', '任职', '岗位', '工作'];
    if (must.some((w) => t.includes(w))) return true;
    // 或者包含较多行（结构化JD）
    const lines = t.split('\n').filter((x) => x.trim().length > 0);
    return lines.length >= 6;
  }

  function findElementByTextIncludes(keys) {
    const all = Array.from(document.querySelectorAll('div,span,h1,h2,h3,dt,dd,label,p'));
    for (const el of all) {
      const t = (el.innerText || el.textContent || '').trim();
      if (!t) continue;
      if (keys.some((k) => t.includes(k))) return el;
    }
    return null;
  }

  function cssEscape(s) {
    try { return CSS.escape(String(s)); } catch { return String(s).replace(/"/g, '\\"'); }
  }

  async function goToJobListAndWait() {
    // 你提供的侧边栏入口：/web/chat/job/list?ka=menu-manager-job
    const targetHref = '/web/chat/job/list?ka=menu-manager-job';

    // 1) 如果已经在 job/list 路由，直接等列表
    if (String(location.pathname || '').includes('/web/chat/job/list')) {
      return !!(await waitFor(() => queryAnyDoc('li.job-jobInfo-warp[data-id]') || queryAnyDoc('[data-id][class*="job"]'), 20000));
    }

    // 2) 优先点击侧边栏 link（最不侵入）
    const link =
      document.querySelector(`a[href^="${cssEscape('/web/chat/job/list')}"]`)
      || document.querySelector(`a[href="${cssEscape(targetHref)}"]`)
      || findElementByTextIncludes(['职位管理'])?.closest?.('a');

    if (link) {
      simulateClick(link);
    } else {
      // 3) 兜底：直接跳转路由（可能会触发整页刷新，但最稳）
      try {
        location.href = targetHref;
      } catch {}
    }

    // 4) 等路由切换/列表渲染
    await waitFor(() => String(location.pathname || '').includes('/web/chat/job/list') || queryAnyDoc('li.job-jobInfo-warp[data-id]'), 20000);
    return !!(await waitFor(() => queryAnyDoc('li.job-jobInfo-warp[data-id]') || queryAnyDoc('[data-id][class*="job"]'), 20000));
  }

  function findJobListItem({ encryptJobId, jobId }) {
    // 你给的职位管理页：li.job-jobInfo-warp[data-id="<encryptJobId>"]
    if (encryptJobId) {
      const exact =
        queryAnyDoc(`li.job-jobInfo-warp[data-id="${cssEscape(encryptJobId)}"]`)
        || queryAnyDoc(`[data-id="${cssEscape(encryptJobId)}"]`);
      if (exact) return exact.closest?.('li') || exact;
    }

    // 有些页面可能用 data-job-id/jobId
    if (jobId) {
      const exact =
        queryAnyDoc(`li.job-jobInfo-warp[data-job-id="${cssEscape(jobId)}"]`)
        || queryAnyDoc(`[data-job-id="${cssEscape(jobId)}"]`)
        || queryAnyDoc(`[data-jobid="${cssEscape(jobId)}"]`);
      if (exact) return exact.closest?.('li') || exact;
    }

    return null;
  }

  function getAllDocs() {
    const out = [];
    const seen = new Set();
    const add = (d) => {
      if (!d || seen.has(d)) return;
      seen.add(d);
      out.push(d);
    };

    add(document);

    // 如果在 iframe 内，尽量把顶层 document 也纳入（同源时可访问）
    if (window.top && window.top !== window) {
      try { add(window.top.document); } catch {}
    }

    // BFS 扫描同源 iframe 的 contentDocument（限制规模，避免极端情况卡死）
    for (let i = 0; i < out.length && out.length < 25; i++) {
      const d = out[i];
      let iframes = [];
      try { iframes = Array.from(d.querySelectorAll?.('iframe') || []); } catch {}
      for (const iframe of iframes) {
        try {
          const cd = iframe.contentDocument;
          if (cd) add(cd);
        } catch {
          // cross-origin iframe: ignore
        }
      }
    }
    return out;
  }

  function queryAnyDoc(selector) {
    const docs = getAllDocs();
    for (const d of docs) {
      try {
        const el = d.querySelector(selector);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  function isRecommendContextDoc(doc) {
    if (!doc) return false;
    try {
      const win = doc.defaultView || null;
      const path = String(win?.location?.pathname || '');
      const name = String(win?.name || '');
      const pv = String(doc.body?.getAttribute?.('data-pv') || '');
      if (name === 'recommendFrame' || path.startsWith('/web/frame/recommend-v2/')) return true;
      if (win && win.top === win && (path.includes('/web/chat/recommend') || pv.includes('/web/chat/recommend'))) return true;
      const hasRecommendRoot = !!doc.querySelector?.('#recommend-list, .recommend-wrap, [class*="recommend-list"], [class*="candidate-list"]');
      const hasRecommendTabs = !!doc.querySelector?.('.candidate-head .tab-wrap .tab-item, .candidate-head .tab-list .tab-item');
      const hasRecommendJobSel = !!doc.querySelector?.('.job-selecter-wrap .ui-dropmenu-label, .candidate-head .job-selecter-wrap .ui-dropmenu-label');
      return hasRecommendRoot || hasRecommendTabs || hasRecommendJobSel;
    } catch {
      return false;
    }
  }

  function getRecommendContextDocs() {
    const docs = getAllDocs();
    const recommendDocs = docs.filter((d) => isRecommendContextDoc(d));
    return recommendDocs.length > 0 ? recommendDocs : docs;
  }

  function queryAnyRecommendDoc(selector) {
    const docs = getRecommendContextDocs();
    for (const d of docs) {
      try {
        const el = d.querySelector(selector);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  function queryAllRecommendDoc(selector, limit = 80) {
    const out = [];
    const seen = new Set();
    const docs = getRecommendContextDocs();
    for (const d of docs) {
      let arr = [];
      try { arr = Array.from(d.querySelectorAll?.(selector) || []); } catch {}
      for (const el of arr) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        out.push(el);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  function isOnJobEditPage() {
    const path = String(location.pathname || '');
    if (path.includes('/job/edit')) return true;
    // 兜底：只要页面存在 JD 的 textarea placeholder，就当作 job edit/detail 页
    const ta = Array.from(document.querySelectorAll('textarea')).find((x) => {
      const p = String(x.getAttribute('placeholder') || '');
      return p.includes('请勿填写QQ') || p.includes('微信') || p.includes('电话');
    });
    return !!ta;
  }

  function parseJobKey(jobKey, job) {
    const encryptJobId = job?.encryptJobId || (jobKey.startsWith('encryptJobId:') ? jobKey.slice('encryptJobId:'.length) : null);
    const jobId = job?.jobId || (jobKey.startsWith('jobId:') ? jobKey.slice('jobId:'.length) : null);
    return { encryptJobId: encryptJobId ? String(encryptJobId) : null, jobId: jobId ? String(jobId) : null };
  }

  function getCurrentEditingJobIdentifiers() {
    const url = new URL(location.href);
    const sp = url.searchParams;
    const jobId =
      sp.get('jobId') || sp.get('job_id') || sp.get('jid') || sp.get('id') || null;
    const encryptJobId =
      sp.get('encryptJobId') || sp.get('encrypt_job_id') || sp.get('eid') || null;

    // DOM 兜底：有时会把 encryptJobId 放在某些 data-* 上
    let domEncrypt = null;
    const any = document.querySelector('[data-id],[data-job-id],[data-jobid]');
    if (any) {
      const v = any.getAttribute('data-id') || any.getAttribute('data-job-id') || any.getAttribute('data-jobid');
      if (v && String(v).length >= 10) domEncrypt = String(v);
    }

    return {
      jobId: jobId ? String(jobId) : null,
      encryptJobId: (encryptJobId || domEncrypt) ? String(encryptJobId || domEncrypt) : null,
      href: location.href,
    };
  }

  function isSameJob(desired, current) {
    if (!desired) return false;
    if (desired.encryptJobId && current?.encryptJobId) {
      return desired.encryptJobId === current.encryptJobId;
    }
    if (desired.jobId && current?.jobId) {
      return desired.jobId === current.jobId;
    }
    return false;
  }

  async function loadSettings() {
    const result = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.jobKeywordOverrides]);
    const saved = result?.[STORAGE_KEYS.settings] || {};
    settings = normalizeSettingsWithPromptMigration(saved);
    const ov = result?.[STORAGE_KEYS.jobKeywordOverrides];
    jobKeywordOverrides = ov && typeof ov === 'object' && !Array.isArray(ov) ? ov : {};
    await loadLocalJobKeywordPresets();
  }

  async function loadLocalJobKeywordPresets() {
    try {
      const url = chrome.runtime.getURL(LOCAL_JOB_KEYWORD_PRESETS_PATH);
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      localJobKeywordPresets = Array.isArray(json) ? json : [];
    } catch {
      localJobKeywordPresets = [];
    }
  }

  function normalizePresetMatchText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[（）()【】\[\]\-—_·•,，.。:：;；/\s]+/g, '');
  }

  function getLocalPresetOverrideForJobName(jobName) {
    const normJobName = normalizePresetMatchText(jobName);
    if (!normJobName) return null;
    for (const preset of localJobKeywordPresets) {
      const includes = Array.isArray(preset?.matchIncludes) ? preset.matchIncludes : [];
      if (!includes.length) continue;
      const matched = includes.every((part) => {
        const normPart = normalizePresetMatchText(part);
        return normPart ? normJobName.includes(normPart) : false;
      });
      if (matched && preset?.override && typeof preset.override === 'object') {
        return preset.override;
      }
    }
    return null;
  }

  function getEffectiveJobKeywordOverride(jobKey, jobName = '') {
    const key = String(jobKey || '').trim();
    if (key && jobKeywordOverrides?.[key]) return jobKeywordOverrides[key];
    const cachedName =
      String(jobName || '').trim()
      || String(jobsCache.get(key)?.name || jobsCache.get(key)?.positionName || '').trim();
    return getLocalPresetOverrideForJobName(cachedName);
  }

  function stopRun() {
    stopping = true;
    running = false;
    stopHeartbeat();
    logWarn('收到停止指令，正在停止...');
    chrome.storage.local.set({ [STORAGE_KEYS.runState]: { running: false, stopping: true, ts: Date.now() } }).catch(() => {});
  }

  async function startRun(opts = {}) {
    const restart = !!opts?.restart;
    const uiModeRaw = String(opts?.mode || '').trim().toLowerCase(); // reply / outreach / auto / both
    await loadSettings();
    frameRole = detectFrameRole();
    featuredPropCardConsent = null;
    const outreachListMode = normalizeOutreachListMode(settings.outreachListMode);

    // 口径：按 UI 指定模式启动（避免“自动回复开始后跳推荐牛人”）
    // - reply：只跑自动回复（保持沟通页）
    // - outreach：只跑主动寻访（跳推荐牛人）
    // - auto/空：按开关决定
    let runOutreach = !!settings.enableOutreach;
    let runReply = !!settings.enableAutoReply;
    if (uiModeRaw === 'reply') {
      runOutreach = false;
      runReply = true;
    } else if (uiModeRaw === 'outreach') {
      runOutreach = true;
      runReply = false;
    } else if (uiModeRaw === 'both') {
      runOutreach = true;
      runReply = true;
    }

    // 同时启用两种模式时：按当前页面运行，避免来回导航闪屏
    if (runOutreach && runReply && frameRole.isTop) {
      if (isOnChatIndexPage()) {
        runOutreach = false;
      } else {
        runReply = false;
      }
      logWarn('检测到同时启用“主动寻访 + 自动回复”：本次按当前页面只运行一个模式（避免跳转冲突）');
    }

    if (!runOutreach && !runReply) {
      logWarn('未开启任何模式（主动寻访/自动回复），已退出');
      return;
    }
    const hasAiConfig = !!(settings.ai?.baseUrl && settings.ai?.apiKey && settings.ai?.model);
    // 自动回复：按每个会话自己的“沟通职位”去命中 JD，不再强制要求先填写全局岗位/JD
    if (runReply) {
      if (!hasAiConfig) {
        const missing = getMissingAiFields(settings);
        throw new Error(`自动回复：请先配置 AI（缺少 ${missing.join(' / ') || 'baseUrl / apiKey / model'}）`);
      }
    }
    if (runOutreach) {
      if (!settings.jdText?.trim()) {
        throw new Error('请先填写岗位要求（JD）');
      }
      const hasJob = !!(String(settings.selectedJobKey || '').trim() || String(settings.positionName || '').trim());
      if (!hasJob) {
        throw new Error('请先选择岗位（岗位下拉/岗位名称）后再开始主动寻访');
      }
    }
    const requestedMode = String(settings.outreachMode || 'auto');
    const effectiveMode = requestedMode === 'auto'
      ? (hasAiConfig ? 'ai' : (settings.allowOutreachWithoutAI ? 'noai' : 'ai'))
      : requestedMode;

    const useAi = runOutreach && effectiveMode === 'ai';
    if (runOutreach && effectiveMode === 'ai' && !hasAiConfig) {
      throw new Error('当前选择了「AI 模式」，但 AI 配置不完整：请填写 baseUrl / apiKey / model');
    }
    if (runOutreach && effectiveMode === 'noai') {
      logWarn('主动寻访已进入无AI模式：将按关键词（或不筛选）进行处理');
    }
    if (runOutreach && effectiveMode === 'ai') {
      logInfo('主动寻访已进入 AI 模式：将用大模型对“简历 vs JD”评分');
    }
    if (runOutreach) {
      logInfo(`主动寻访列表：${getOutreachListModeLabel(outreachListMode)}${outreachListMode === 'recommend' ? '（沿用当前成熟流程）' : '（已接入页内切换）'}`);
    }
    if (running) {
      // 有时页面/脚本异常会导致 running 卡住；允许“自动重启”修复
      const rs = await chrome.storage.local.get([STORAGE_KEYS.runState]).catch(() => ({}));
      const prev = rs?.[STORAGE_KEYS.runState] || {};
      const age = Date.now() - (Number(prev?.ts) || 0);
      const stale = age > 15000; // 15s 内没有心跳就认为卡住

      if (restart || stale) {
        logWarn(`检测到${stale ? '卡住的' : ''}运行状态，自动重启中...`);
        stopRun();
        await sleep(650);
        stopping = false;
        running = false;
      } else {
        logWarn('已在运行中');
        return;
      }
    }

    // 先处理“顶层只负责导航/转发”的情况：此时不把本 frame 标记为 running
    // Boss 是 SPA：不要用“岗位下拉”来判定推荐牛人（职位管理等页面也可能出现类似下拉）。
    // “能否寻访”以“候选人卡片”或“推荐牛人 iframe/路由”作为准入条件。
    // 关键硬规则（用户要求）：只要不在推荐牛人路由，就必须先跳转到推荐牛人页，
    // 不能在 /web/chat/job/list 之类页面“看到了卡片就直接跑”。
    if (runOutreach && frameRole.isTop && !isOnRecommendRouteNow()) {
      logInfo('主动寻访 第1步：先跳转到推荐牛人的「推荐」页面');
      const nav = await ensureOutreachFrameAndStart();
      if (nav === 'navigating') return;
      if (nav === 'frame') {
        logInfo('主动寻访：已转发到推荐牛人/搜索 frame 执行（等待 iframe 响应）');
        return;
      }
      // 如果 nav 返回 top/false，继续往下（但后续仍会依据 canOutreachHere 决定是否开跑）
    }

    if (runOutreach && frameRole.isTop && isOnRecommendRouteNow()) {
      await waitForOutreachReadyDom(15000).catch(() => false);
      frameRole = detectFrameRole();
    }

    // 自动回复：若只开自动回复（未开主动寻访），则必须先跳到“沟通”页再跑
    const pvChat0 = String(document.body?.getAttribute?.('data-pv') || '');
    const pathChat0 = String(location.pathname || '');
    const isOnChatRoute = () => (
      isChatIndexPath(pathChat0)
    );
    if (runReply && !runOutreach && frameRole.isTop && !isOnChatRoute()) {
      const nav = await ensureChatPage({ startAfter: true });
      if (nav === 'navigating') return;
      frameRole = detectFrameRole();
    }
    let canOutreachHere = isOutreachContextReady();
    // 自动回复：只要已经在沟通页，就允许启动。
    // 之前这里还强依赖“会话列表/输入框 DOM 已经出现”，但沟通页是 SPA，
    // 刚切到 /web/chat/index 时经常还没渲染完，导致误判“本页已跳过”。
    const canReplyHere = frameRole.isTop && isOnChatIndexPage();

    if (runOutreach && !canOutreachHere && frameRole.isTop) {
      const nav = await ensureOutreachFrameAndStart();
      if (nav === 'navigating') {
        // 页面即将跳转；续跑由 pendingStart 负责
        return;
      }
      if (nav === 'frame') {
        logInfo('主动寻访：已转发到推荐牛人/搜索 frame 执行（等待 iframe 响应）');
        return;
      }
      frameRole = detectFrameRole();
      if (frameRole.isTop && isOnRecommendRouteNow()) {
        await waitForOutreachReadyDom(15000).catch(() => false);
        frameRole = detectFrameRole();
      }
      canOutreachHere = isOutreachContextReady();
    }

    stopping = false;
    running = true;
    candidateRuntimeStates = new Map();
    // 1.1.2：每次开始前重置 humanizer 计时器
    humanizerOnRunStart();
    await chrome.storage.local.set({ [STORAGE_KEYS.runState]: { running: true, stopping: false, ts: Date.now() } }).catch(() => {});
    startHeartbeat();
    if (isLowRiskMode()) {
      logInfo('开始运行（🛡 低风险模式：仅生成草稿，不自动操作）');
    } else {
      const intensity = String((settings.humanizer && settings.humanizer.intensity) || 'strong');
      const intensityLabel = intensity === 'weak' ? '弱' : intensity === 'med' ? '中' : '强';
      logWarn(`开始运行（⚠ 自动打招呼模式 / humanizer=${intensityLabel}）— 账号有封号风险，留意页面与日志`);
    }

    const tasks = [];
    if (runOutreach && canOutreachHere) tasks.push(runOutreachLoop({ useAi }));
    if (runReply && canReplyHere) tasks.push(runAutoReplyLoop());

    if (runOutreach && !canOutreachHere && frameRole.isTop) {
      logWarn('主动寻访：未检测到推荐牛人/搜索页面（可先手动打开一次推荐牛人页）');
    }
    if (runReply && !canReplyHere) {
      logWarn('自动回复：请在「沟通」页面运行（本页已跳过）');
    }
    await Promise.allSettled(tasks);

    running = false;
    stopping = false;
    stopHeartbeat();
    await chrome.storage.local.set({ [STORAGE_KEYS.runState]: { running: false, stopping: false, ts: Date.now() } }).catch(() => {});
    logInfo('运行结束');
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatLastTs = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!running) return;
      const now = Date.now();
      // 避免过于频繁写 storage
      if (now - heartbeatLastTs < 4500) return;
      heartbeatLastTs = now;
      chrome.storage.local
        .set({ [STORAGE_KEYS.runState]: { running: true, stopping: !!stopping, ts: now } })
        .catch(() => {});
    }, 5000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      try { clearInterval(heartbeatTimer); } catch {}
      heartbeatTimer = null;
    }
  }

  async function runOutreachLoop({ useAi } = {}) {
    // 硬门禁：主动寻访只在“推荐牛人/搜索”页运行，避免在沟通页误扫
    // 注意：不要用“岗位下拉 label”判定推荐牛人（职位管理等页面也可能出现类似下拉，容易误判）。
    const pv = String(document.body?.getAttribute?.('data-pv') || '');
    const path = String(location.pathname || '');
    const hasRecommendDomStrong = () => {
      const list = queryAnyDoc('#recommend-list');
      if (!list) return false;
      return !!queryAnyDoc('#recommend-list .candidate-card-wrap') || !!queryAnyDoc('.recommend-wrap .candidate-card-wrap');
    };
    const isRecommendLike =
      path.includes('/web/chat/recommend')
      || pv.includes('/web/chat/recommend')
      || !!queryAnyDoc('iframe[src*="recommend-v2"], iframe[src*="recommend"]')
      || hasRecommendDomStrong();
    if (!isRecommendLike) {
      logWarn(`主动寻访：当前页不是推荐牛人/搜索页，已跳过（pv=${document.body?.getAttribute('data-pv') || ''} path=${location.pathname}）`);
      return;
    }
    logInfo('主动寻访：启动');
    let contacted = 0;
    const max = clampInt(settings.maxPerRun, 1, 500);
    const outreachListMode = normalizeOutreachListMode(settings.outreachListMode);
    const outreachListLabel = getOutreachListModeLabel(outreachListMode);
    let featuredResumeAnchor = null;

    // 1.1.x：读取时顺便剪掉超出保留期的旧记录，避免本地评分历史无限累积
    const processed = await getProcessedOutreachPruned();
    const outreachJobKey = String(settings.selectedJobKey || '').trim();
    const outreachJob = jobsCache.get(outreachJobKey) || null;
    const outreachJobContext = {
      jobKey: outreachJobKey,
      positionName: String(outreachJob?.name || settings.positionName || '').trim(),
      jdText: String(outreachJob?.jdText || settings.jdText || '').trim(),
      jobId: String(outreachJob?.jobId || '').trim(),
      encryptJobId: String(outreachJob?.encryptJobId || '').trim(),
    };
    // 1.1.x：每条历史记录都会带上这两个字段，便于跨岗位区分 + 历史查看
    const processedJobTag = {
      jobKey: outreachJobContext.jobKey || '',
      jobName: outreachJobContext.positionName || '',
    };
    const outreachFilters = getJobScopedReplyFilters(outreachJobContext);
    // 1.1.x：本轮跳过的"上一轮已筛选"候选人计数，跑完时一次性 log 出来，方便确认 token 节省
    let skippedExistingCount = 0;
    {
      const hasDesired = !!(String(settings.selectedJobKey || '').trim() || String(settings.positionName || '').trim());
      if (hasDesired) logInfo('主动寻访 第2步：在右上角切换到你选择的岗位');
      const switched = await ensureRecommendJobSelected().catch(() => false);
      if (hasDesired && !switched) {
        logWarn('推荐牛人：岗位切换未成功，已暂停主动寻访（请先确认右上角岗位已切到你选择的岗位）');
        return;
      }
      if (hasDesired && switched) {
        logInfo('主动寻访：岗位已切换，等待当前页面候选人列表刷新完成...');
        await prepareCandidateListAfterJobSwitch().catch(() => {});
      }
    }

    if (outreachListMode !== 'recommend' || getCurrentOutreachListMode() !== 'recommend') {
      logInfo(`主动寻访 第3步：切换到「${outreachListLabel}」列表`);
      const listReady = await ensureOutreachListModeSelected(outreachListMode).catch(() => false);
      if (!listReady) {
        logWarn(`主动寻访：未能切到「${outreachListLabel}」列表，已暂停本次运行`);
        return;
      }
    }

    logInfo(`主动寻访 第4步：在当前${outreachListLabel}列表页面开始匹配并筛选简历`);
    clearCandidateCardRuntimeState();
    await waitForFirstCandidateReady(8000).catch(() => {});
    const markProcessedCardsDoneInCurrentView = () => {
      const cardsNow = findCandidateCards();
      for (const candidateCard of cardsNow) {
        try {
          const candidateName = getCandidateName(candidateCard);
          // 1.1.3：用候选人所有可能 key 同时查找，避免 ID 类型变化导致的 miss
          const processedInfo = findAndCanonicalizeProcessed(processed, candidateName, candidateCard);
          if (!processedInfo) continue;
          // 1.1.x：仅当上次评分发生在"同一岗位"时才视为已完成；不同岗位的旧记录不影响当前岗位的筛选
          if (!isProcessedHitForCurrentJob(processedInfo, outreachJobKey)) continue;
          candidateCard.dataset.bossAssistDone = '1';
          // 1.1.1：根据存储的判定结果，把视觉边框一并恢复，
          // 让用户重启后能直观看到"哪些已经看过、跳过哪些"
          let stateName = null;
          if (processedInfo?.pendingManualContact) {
            stateName = 'manual_pending';                   // 蓝框：通过+待人工
          } else if (processedInfo?.stage2?.decision === true) {
            stateName = 'contacted';                         // 绿框（兼容旧数据）
          } else if (processedInfo?.stage2?.decision === false) {
            stateName = 'skipped';                           // 灰框：未通过/硬过滤
          } else {
            stateName = 'skipped';                           // 兜底
          }
          const style = getCandidateRuntimeStateStyle(stateName);
          if (style) applyCandidateRuntimeState(candidateCard, style);
        } catch {}
      }
    };
    // 1.1.1：当前可见卡片全是已处理时，主动下滑加载，避免视觉跳回顶部已处理的那张
    const scrollDownToLoadMoreOnce = async () => {
      const root =
        queryAnyDoc('#recommend-list')
        || queryAnyDoc('.recommend-wrap')
        || queryAnyDoc('[class*="recommend-list"]')
        || queryAnyDoc('[class*="candidate-list"]')
        || null;
      try {
        if (root) {
          root.scrollTo?.({ top: (root.scrollHeight || 0), behavior: 'auto' });
        } else {
          window.scrollBy(0, Math.max(600, window.innerHeight || 600));
        }
      } catch {}
      await sleep(450);
    };
    const getFirstPendingCandidateCard = () => {
      markProcessedCardsDoneInCurrentView();
      const cardsNow = findCandidateCards();
      // 1.1.1：找不到 pending 时返回 null，由调用方决定是否下滑加载，
      // 避免 fallback 到 cards[0] 把视图滚回去那张"已经处理过的"
      return cardsNow.find((candidateCard) => !candidateCard?.dataset?.bossAssistDone) || null;
    };
    const focusPendingCandidateCard = async () => {
      // 1.1.1：先尝试当前视图；若全是已处理，最多下滑 6 次找下一个未处理的
      let firstPending = getFirstPendingCandidateCard();
      let scrollTries = 0;
      while (!firstPending && scrollTries < 6) {
        await scrollDownToLoadMoreOnce();
        markProcessedCardsDoneInCurrentView();
        firstPending = getFirstPendingCandidateCard();
        scrollTries++;
      }
      if (firstPending) {
        try { firstPending.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'auto' }); } catch {}
        if (scrollTries > 0) {
          logInfo(`已跳过 ${scrollTries} 屏已处理候选人，定位到下一位未处理`);
        }
      }
    };
    // 1.1.1：初次定位需要 await，等下滑加载完再读 firstVisibleCandidate
    await focusPendingCandidateCard();
    applyRememberedCandidateRuntimeStates();
    markProcessedCardsDoneInCurrentView();
    let firstVisibleCandidate = getFirstPendingCandidateCard();
    let firstVisibleAnchor = buildCandidateAnchor(firstVisibleCandidate);
    let firstVisibleHandled = !firstVisibleAnchor;
    const refreshTopCandidateAnchor = ({ announce = false } = {}) => {
      firstVisibleCandidate = getFirstPendingCandidateCard();
      firstVisibleAnchor = buildCandidateAnchor(firstVisibleCandidate);
      firstVisibleHandled = !firstVisibleAnchor;
      if (announce && firstVisibleCandidate) {
        const topName = getCandidateName(firstVisibleCandidate);
        const label = topName || firstVisibleAnchor?.fallback || '未识别姓名';
        logInfo(`主动寻访：重新定位当前页第一位未筛选候选人为「${label}」`);
      }
    };
    const getOrderedCardsForCurrentPass = () => {
      const currentCards = findCandidateCards();
      if (outreachListMode !== 'featured' || !featuredResumeAnchor) return currentCards;
      const idx = currentCards.findIndex((card) => isSameCandidateAnchor(featuredResumeAnchor, card));
      if (idx < 0) {
        featuredResumeAnchor = null;
        return currentCards;
      }
      const target = currentCards[idx] || null;
      try { target?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'auto' }); } catch {}
      if (idx === 0) return currentCards;
      return currentCards.slice(idx).concat(currentCards.slice(0, idx));
    };
    const announceFeaturedResumeTargetIfAny = () => {
      if (outreachListMode !== 'featured' || !featuredResumeAnchor) return false;
      const cardsNow = findCandidateCards();
      const target = cardsNow.find((card) => isSameCandidateAnchor(featuredResumeAnchor, card)) || null;
      if (!target) return false;
      const name = getCandidateName(target);
      const label = name || featuredResumeAnchor?.fallback || '未识别姓名';
      logInfo(`精选页：已按顺序定位到下一位候选人「${label}」`);
      return true;
    };
    if (firstVisibleCandidate) {
      const firstName = getCandidateName(firstVisibleCandidate);
      const label = firstName || firstVisibleAnchor?.fallback || '未识别姓名';
      logInfo(`主动寻访：当前页第一位未筛选候选人已定位为「${label}」`);
    }

    // 防止空页面一直转：最多尝试滚动加载若干次
    let idleRounds = 0;

    while (running && !stopping && contacted < max) {
      applyRememberedCandidateRuntimeStates();
      markProcessedCardsDoneInCurrentView();
      const cards = getOrderedCardsForCurrentPass();
      let shouldRequeryCards = false;
      if (cards.length === 0 && idleRounds === 0) {
        const pv = document.body?.getAttribute('data-pv') || '';
        logWarn(`主动寻访：未找到候选人卡片（pv=${pv} path=${location.pathname}）。如果你肉眼能看到卡片，说明卡片在 iframe/子文档中，我会继续尝试滚动加载；若仍不行再补选择器。`);
      }
      const unprocessed = cards.filter((el) => !el.dataset.bossAssistDone);

      if (unprocessed.length === 0) {
        idleRounds++;
        if (idleRounds === 1) {
          logInfo('主动寻访：当前批次已处理完，正在尝试滚动加载更多候选人...');
        }
        const loadedMore = await tryLoadMoreCandidates({ previousCards: cards, attempts: 3 }).catch(() => false);
        if (loadedMore) {
          idleRounds = 0;
          applyRememberedCandidateRuntimeStates();
          logInfo('主动寻访：已滚动加载更多候选人，继续筛选');
          continue;
        }
        if (outreachListMode === 'latest' || outreachListMode === 'recommend') {
          const refreshedList = await tryRefreshCandidateListByButton({ previousCards: cards }).catch(() => false);
          if (refreshedList) {
            idleRounds = 0;
            applyRememberedCandidateRuntimeStates();
            logInfo(`主动寻访：${getOutreachListModeLabel(outreachListMode)}列表已刷新，继续筛选`);
            continue;
          }
        }
        if (idleRounds > 10) {
          logWarn('主动寻访：未找到更多候选人，停止');
          break;
        }
        window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
        await sleep(900);
        continue;
      }

      idleRounds = 0;

      for (const card of unprocessed) {
        if (!running || stopping || contacted >= max) break;
        const currentIndex = cards.indexOf(card);
        const nextVisibleAnchor = buildCandidateAnchor(cards[currentIndex + 1] || null);
        if (outreachListMode === 'featured' && !card.isConnected) {
          if (nextVisibleAnchor) featuredResumeAnchor = nextVisibleAnchor;
          logInfo('精选页：候选人列表已重绘，重新抓取当前页候选人后继续');
          await waitForCandidateListStable(5000).catch(() => {});
          applyRememberedCandidateRuntimeStates();
          let resumed = announceFeaturedResumeTargetIfAny();
          if (!resumed) {
            scrollCandidateListToTop();
          }
          await waitForFirstCandidateReady(5000).catch(() => {});
          if (!resumed) {
            resumed = announceFeaturedResumeTargetIfAny();
          }
          if (!resumed) {
            focusPendingCandidateCard();
            refreshTopCandidateAnchor({ announce: true });
          }
          applyRememberedCandidateRuntimeStates();
          markProcessedCardsDoneInCurrentView();
          shouldRequeryCards = true;
          break;
        }

        const isFirstVisibleCandidate = !firstVisibleHandled && isSameCandidateAnchor(firstVisibleAnchor, card);
        if (isFirstVisibleCandidate) firstVisibleHandled = true;
        const name = getCandidateName(card);
        if (!name) {
          if (isFirstVisibleCandidate) {
            const label = String(firstVisibleAnchor?.fallback || '').trim() || '未识别姓名';
            logWarn(`主动寻访：当前页第一位候选人姓名未识别，已先跳过这张卡（${label}）`);
          }
          card.dataset.bossAssistDone = '1';
          continue;
        }

        const idInfo = getCandidateIdInfo(name, card);
        const key = idInfo.key;
        // 1.1.3：用候选人所有可能 key 同时查找，避免不同运行 ID 类型变化导致的 miss + 重复 AI 打分
        // 1.1.x：仅当上一次评分发生在"同一岗位"时才跳过；切换到其他岗位时同一候选人会重新评分
        const prevHit = findAndCanonicalizeProcessed(processed, name, card);
        if (prevHit && isProcessedHitForCurrentJob(prevHit, outreachJobKey)) {
          if (outreachListMode === 'featured' && isFirstVisibleCandidate) {
            logInfo(`精选页：第一页第一位候选人「${name}」已筛过（同岗位），继续处理下一位`);
          } else {
            logInfo(`已跳过 ${name}（同岗位上一轮已筛选 score:${prevHit?.stage2?.score ?? '-'}）`);
          }
          // 1.1.x：每次跳过也补做一次 cross-link，把当前 idInfo 的所有 key 都指向旧记录
          //        这样下次再以任何 ID 类型出现都不会丢失（彻底解决"刷新后 AI 又跑一遍"）
          crossLinkProcessedToAllKeys(processed, name, card, prevHit?.candidate?.key || key);
          await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
          skippedExistingCount++;
          card.dataset.bossAssistDone = '1';
          continue;
        }
        if (prevHit) {
          // 同一候选人在其他岗位筛过 → 本次按当前岗位重新评分；用 info 日志让用户知情
          const otherJob = String(prevHit?.jobName || prevHit?.jobKey || '其他岗位').trim();
          logInfo(`重新评分：${name}（曾在「${otherJob}」筛过 score:${prevHit?.stage2?.score ?? '-'}，本次按当前岗位重打分）`);
        }

        // 硬过滤：年龄区间（第一优先级；不在区间直接跳过）
        {
          const minAge = clampInt(outreachFilters.minAge, 0, 70);
          const maxAge = clampInt(outreachFilters.maxAge, 0, 70);
          if (minAge > 0 || maxAge > 0) {
            const age = extractAgeFromText(card.innerText || card.textContent || '');
            if (age && minAge > 0 && age < minAge) {
              const stage2 = { decision: false, score: 0, reason: `年龄过滤：${age}岁 < ${minAge}岁` };
              processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1: { decision: true, score: 0, reason: '年龄硬过滤' }, stage2 };
              crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
              card.dataset.bossAssistDone = '1';
              highlight(card, '#f5f5f5', '#bdbdbd');
              rememberCandidateRuntimeState(card, 'skipped');
              logInfo(`跳过：${name}（${stage2.reason}）`);
              await jitterDelay();
              continue;
            }
            if (age && maxAge > 0 && age > maxAge) {
              const stage2 = { decision: false, score: 0, reason: `年龄过滤：${age}岁 > ${maxAge}岁` };
              processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1: { decision: true, score: 0, reason: '年龄硬过滤' }, stage2 };
              crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
              card.dataset.bossAssistDone = '1';
              highlight(card, '#f5f5f5', '#bdbdbd');
              rememberCandidateRuntimeState(card, 'skipped');
              logInfo(`跳过：${name}（${stage2.reason}）`);
              await jitterDelay();
              continue;
            }
          }
        }

        // 硬过滤：最低学历（低于则跳过）
        {
          const minEdu = normalizeEduRequirement(outreachFilters.minEdu);
          if (isDegreeEduRequirement(minEdu)) {
            const edu = extractEduLevelFromText(card.innerText || card.textContent || '');
            if (edu && edu < minEdu) {
              const stage2 = { decision: false, score: 0, reason: `学历过滤：${eduLabel(edu)} < ${eduLabel(minEdu)}` };
              processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1: { decision: true, score: 0, reason: '学历硬过滤' }, stage2 };
              crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
              card.dataset.bossAssistDone = '1';
              highlight(card, '#f5f5f5', '#bdbdbd');
              rememberCandidateRuntimeState(card, 'skipped');
              logInfo(`跳过：${name}（${stage2.reason}）`);
              await jitterDelay();
              continue;
            }
          }
        }

        card.dataset.bossAssistProcessing = '1';
        highlight(card, '#fff3e0', '#ffa726');
        rememberCandidateRuntimeState(card, 'processing');

        const simpleInfo = buildSimpleCandidateInfo(name, card);
        // 需求口径：AI 模式以“简历 vs JD”作为主判定。
        // 为避免卡片初筛误伤（卡片信息不全），AI 模式这里跳过 stage1。
        const stage1 = useAi
          ? ({ decision: true, score: 0, reason: 'AI模式：跳过卡片初筛' })
          : ({ decision: true, score: 0, reason: '无AI：跳过初筛' });

        if (!stage1.decision) {
          card.dataset.bossAssistDone = '1';
          card.dataset.bossAssistProcessing = '';
          highlight(card, '#f5f5f5', '#bdbdbd');
          rememberCandidateRuntimeState(card, 'skipped');
          logInfo(`跳过：${name}（${stage1.reason || '不通过'}）`);
          await jitterDelay();
          continue;
        }

        // 先点开候选人简历（不先打招呼）
        const resumeOpened = await openCandidateResume(card);
        if (!resumeOpened) {
          card.dataset.bossAssistDone = '1';
          card.dataset.bossAssistProcessing = '';
          highlight(card, '#ffebee', '#ef5350');
          rememberCandidateRuntimeState(card, 'failed');
          logWarn(`打开简历失败：${name}`);
          await jitterDelay();
          continue;
        }

        await sleep(450);

        let resumeText = await extractResumeText();

        if (outreachListMode === 'latest') {
          const source = String(lastResumeExtractMeta?.source || '');
          const trimmedResumeText = String(resumeText || '').trim();
          const resumeHash = trimmedResumeText ? hashText(trimmedResumeText.slice(0, 4000)) : '';
          const cleanName = String(name || '').trim();
          const canCheckName = cleanName && !cleanName.includes('*');

          if (source === 'iframe' && canCheckName && trimmedResumeText && !trimmedResumeText.includes(cleanName)) {
            logWarn(`简历正文：iframe 未命中当前候选人姓名「${cleanName}」，疑似沿用了上一份简历`);
            lastResumeExtractMeta = { source: 'iframe-stale', length: trimmedResumeText.length, note: 'name-mismatch' };
            resumeText = '';
          } else if (
            source === 'iframe'
            && resumeHash
            && lastLatestIframeResumeFingerprint.hash
            && lastLatestIframeResumeFingerprint.hash === resumeHash
            && lastLatestIframeResumeFingerprint.candidateKey
            && lastLatestIframeResumeFingerprint.candidateKey !== key
          ) {
            logWarn('简历正文：检测到 iframe 文本与上一位候选人重复，疑似沿用了旧简历');
            lastResumeExtractMeta = { source: 'iframe-stale', length: trimmedResumeText.length, note: 'repeated' };
            resumeText = '';
          }

          if (String(lastResumeExtractMeta?.source || '') === 'iframe' && resumeHash) {
            lastLatestIframeResumeFingerprint = { candidateKey: key, hash: resumeHash };
          }
        }

        if (outreachListMode === 'latest') {
          const resumeLen = String(resumeText || '').trim().length;
          const source = String(lastResumeExtractMeta?.source || '');
          if (resumeLen < 180 || source === 'empty' || source === 'rightbar' || source === 'iframe-stale') {
            const latestCardFallback = pickLatestCardFallbackText(card);
            if (latestCardFallback) {
              resumeText = [String(resumeText || '').trim(), '[最新列表卡片补充]', latestCardFallback]
                .filter(Boolean)
                .join('\n\n')
                .slice(0, 12000);
              logInfo(`简历正文：已追加最新列表卡片补充（${latestCardFallback.length}字）`);
            }
          }
        }

        logInfo(`简历正文来源：${lastResumeExtractMeta.source}（${lastResumeExtractMeta.length}字${lastResumeExtractMeta.note ? `，${lastResumeExtractMeta.note}` : ''}）`);

        if (useAi && String(resumeText || '').trim().length < 80) {
          logWarn(`简历正文提取偏短：${name}（${String(resumeText || '').trim().length}字），AI判断可能偏严`);
        }
        // 若卡片上没显示年龄，简历文本里能提取到时也做一次硬过滤（区间）
        {
          const minAge = clampInt(outreachFilters.minAge, 0, 70);
          const maxAge = clampInt(outreachFilters.maxAge, 0, 70);
          if (minAge > 0 || maxAge > 0) {
            const age2 = extractAgeFromText(resumeText);
            if (age2 && minAge > 0 && age2 < minAge) {
              card.dataset.bossAssistDone = '1';
              card.dataset.bossAssistProcessing = '';
              highlight(card, '#f5f5f5', '#bdbdbd');
              rememberCandidateRuntimeState(card, 'skipped');
              const stage2 = { decision: false, score: 0, reason: `年龄过滤：${age2}岁 < ${minAge}岁` };
              processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1, stage2 };
              crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
              logInfo(`不匹配：${name}（${stage2.reason}）`);
              await closePopupsIfAny();
              await closeResumePanelIfAny();
              await jitterDelay();
              continue;
            }
            if (age2 && maxAge > 0 && age2 > maxAge) {
              card.dataset.bossAssistDone = '1';
              card.dataset.bossAssistProcessing = '';
              highlight(card, '#f5f5f5', '#bdbdbd');
              rememberCandidateRuntimeState(card, 'skipped');
              const stage2 = { decision: false, score: 0, reason: `年龄过滤：${age2}岁 > ${maxAge}岁` };
              processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1, stage2 };
              crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
              logInfo(`不匹配：${name}（${stage2.reason}）`);
              await closePopupsIfAny();
              await closeResumePanelIfAny();
              await jitterDelay();
              continue;
            }
          }
        }

        // 若卡片上没显示学历，简历文本里能提取到时也做一次硬过滤
        {
          const minEdu = normalizeEduRequirement(outreachFilters.minEdu);
          if (minEdu !== '0') {
            const eduResult = evaluateEduRequirement(resumeText, minEdu);
            if (!eduResult.pass) {
              card.dataset.bossAssistDone = '1';
              card.dataset.bossAssistProcessing = '';
              highlight(card, '#f5f5f5', '#bdbdbd');
              rememberCandidateRuntimeState(card, 'skipped');
              const stage2 = { decision: false, score: 0, reason: eduResult.reason };
              processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1, stage2 };
              crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
              logInfo(`不匹配：${name}（${stage2.reason}）`);
              await closePopupsIfAny();
              await closeResumePanelIfAny();
              await jitterDelay();
              continue;
            }
          }
        }

        // 1.1.x：硬过滤——最近 gap 月数超过阈值则淘汰（今天 - 上一份工作结束 > maxRecentGapMonths）
        {
          const maxGap = clampInt(outreachFilters.maxRecentGapMonths, 0, 240, 0);
          if (maxGap > 0) {
            const gap = extractCurrentGapMonthsFromText(`${simpleInfo}\n\n${resumeText}`);
            if (gap > maxGap) {
              card.dataset.bossAssistDone = '1';
              card.dataset.bossAssistProcessing = '';
              highlight(card, '#f5f5f5', '#bdbdbd');
              rememberCandidateRuntimeState(card, 'skipped');
              const stage2 = { decision: false, score: 0, reason: `Gap过滤：当前 gap ≈ ${gap} 个月 > ${maxGap} 个月` };
              processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1: { decision: true, score: 0, reason: 'Gap硬过滤' }, stage2 };
              crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
              logInfo(`不匹配：${name}（${stage2.reason}）`);
              await closePopupsIfAny();
              await closeResumePanelIfAny();
              await jitterDelay();
              continue;
            }
          }
        }

        const stage2 = useAi
          ? await aiDecideStage2(resumeText, outreachJobContext, outreachFilters).catch((e) => ({ decision: false, score: 0, reason: `AI失败:${e.message}`, usage: null }))
          : keywordDecide(`${simpleInfo}\n\n${resumeText}`, outreachFilters);

        if (useAi) {
          const u = stage2?.usage;
          const tokenMsg = u ? ` tokens(p=${u.prompt_tokens ?? ''},c=${u.completion_tokens ?? ''},t=${u.total_tokens ?? ''})` : '';
          logInfo(`AI评分：${stage2.score} 分${tokenMsg}，原因：${stage2.reason || ''}`.trim());
          if (u) recordAiUsage(u).catch(() => {});
        } else {
          logInfo(`关键词判定：${stage2.decision ? '通过' : '不通过'}，原因：${stage2.reason || ''}`);
        }

        if (!stage2.decision) {
          // 1.1.x：AI/关键词判定不通过的也写到 processed，让历史/统计页看得到淘汰原因
          processed[key] = { ts: Date.now(), ...processedJobTag, candidate: idInfo, stage1, stage2 };
          crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
          card.dataset.bossAssistDone = '1';
          card.dataset.bossAssistProcessing = '';
          highlight(card, '#f5f5f5', '#bdbdbd');
          rememberCandidateRuntimeState(card, 'skipped');
          logInfo(`不匹配：${name}（${stage2.reason || '不通过'}）`);
          await closePopupsIfAny();
          await closeResumePanelIfAny();
          await jitterDelay();
          continue;
        }

        const msg = renderTemplate(settings.outreachTemplate, {
          name,
          position: settings.positionName || '该岗位',
          score: String(stage2.score ?? ''),
          reason: stage2.reason || '',
        });

        if (isLowRiskMode()) {
          contacted++;
          processed[key] = {
            ts: Date.now(),
            ...processedJobTag,
            candidate: idInfo,
            stage1,
            stage2,
            pendingManualContact: true,
            draftText: msg,
          };
          crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
          card.dataset.bossAssistDone = '1';
          card.dataset.bossAssistProcessing = '';
          highlight(card, '#e3f2fd', '#1e88e5');
          rememberCandidateRuntimeState(card, 'manual_pending');
          logSuccess(`待人工打招呼 [${contacted}/${max}]：${name}${idInfo.display ? `（${idInfo.display}）` : ''}（score:${stage2.score}）`);
          if (outreachListMode === 'featured') {
            featuredResumeAnchor = nextVisibleAnchor || null;
            await waitForCandidateListStable(5000).catch(() => {});
            applyRememberedCandidateRuntimeStates();
            let resumed = announceFeaturedResumeTargetIfAny();
            if (!resumed) {
              scrollCandidateListToTop();
            }
            await waitForFirstCandidateReady(5000).catch(() => {});
            if (!resumed) {
              resumed = announceFeaturedResumeTargetIfAny();
            }
            if (!resumed) {
              focusPendingCandidateCard();
              refreshTopCandidateAnchor({ announce: true });
            }
            applyRememberedCandidateRuntimeStates();
            markProcessedCardsDoneInCurrentView();
            logInfo('精选页：候选人列表可能已刷新，已按顺序继续定位下一位');
            shouldRequeryCards = true;
          }
        } else {
          // 1.1.2 humanizer：定期休息 + 偶尔上下滚动 + 阅读停顿 + 强模式随机跳过
          await maybeRestPeriod();
          if (!running || stopping) return;
          await maybeHumanScrollBetween();
          if (maybeRandomSkip()) {
            logInfo(`[humanizer] 随机跳过 ${name}（打破规律性，本次不打招呼）`);
            card.dataset.bossAssistDone = '1';
            card.dataset.bossAssistProcessing = '';
            highlight(card, '#f5f5f5', '#bdbdbd');
            rememberCandidateRuntimeState(card, 'skipped');
            noteHumanizerActed();
            continue;
          }
          await humanReadingPause();
          // 命中后才点击“打招呼”
          const greetState = await greetCandidate(card, { outreachListMode });
          if (greetState?.stopRequested) {
            card.dataset.bossAssistProcessing = '';
            highlight(card, '#fff8e1', '#ffb300');
            rememberCandidateRuntimeState(card, 'warning');
            await closePopupsIfAny();
            await closeResumePanelIfAny();
            logWarn(greetState.reason || '主动寻访已停止');
            return;
          }
          // 1.1.3：等候空闲超时 → 跳过这位但不暂停整批
          if (greetState?.skipCandidate) {
            card.dataset.bossAssistProcessing = '';
            highlight(card, '#fff8e1', '#ffb300');
            rememberCandidateRuntimeState(card, 'warning');
            await closePopupsIfAny();
            await closeResumePanelIfAny();
            logInfo(`跳过 ${name}（${greetState.reason || '本机空闲超时'}），继续下一位`);
            continue;
          }
          // 若能定位到输入框，则发送自定义模板；否则依赖平台“打招呼”默认发送
          const sentCustom = greetState.composerReady ? await sendChatMessage(msg) : false;
          const sent = sentCustom || greetState.established;
          await closeFeaturedSuccessDialogIfAny({ timeout: 800 }).catch(() => false);
          await closePopupsIfAny();
          await closeResumePanelIfAny();

          if (sent) {
            contacted++;
            processed[key] = {
              ts: Date.now(),
              ...processedJobTag,
              candidate: idInfo,
              stage1,
              stage2,
            };
            crossLinkProcessedToAllKeys(processed, name, card, key); await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: processed }).catch(() => {});
            card.dataset.bossAssistDone = '1';
            card.dataset.bossAssistProcessing = '';
            highlight(card, '#e8f5e9', '#4caf50');
            rememberCandidateRuntimeState(card, 'contacted');
            logSuccess(`已联系 [${contacted}/${max}]：${name}${idInfo.display ? `（${idInfo.display}）` : ''}${sentCustom ? '' : '（平台打招呼）'}（score:${stage2.score}）`);
            noteHumanizerActed();
            if (outreachListMode === 'featured') {
              featuredResumeAnchor = nextVisibleAnchor || null;
              await waitForCandidateListStable(5000).catch(() => {});
              applyRememberedCandidateRuntimeStates();
              let resumed = announceFeaturedResumeTargetIfAny();
              if (!resumed) {
                scrollCandidateListToTop();
              }
              await waitForFirstCandidateReady(5000).catch(() => {});
              if (!resumed) {
                resumed = announceFeaturedResumeTargetIfAny();
              }
              if (!resumed) {
                focusPendingCandidateCard();
                refreshTopCandidateAnchor({ announce: true });
              }
              applyRememberedCandidateRuntimeStates();
              markProcessedCardsDoneInCurrentView();
              logInfo('精选页：候选人列表可能已刷新，已按顺序继续定位下一位');
              shouldRequeryCards = true;
            }
          } else {
            card.dataset.bossAssistDone = '1';
            card.dataset.bossAssistProcessing = '';
            highlight(card, '#ffebee', '#ef5350');
            rememberCandidateRuntimeState(card, 'failed');
            logWarn(`发送失败：${name}`);
          }
        }

        await jitterDelay();
        if (shouldRequeryCards) break;
      }

      if (shouldRequeryCards) {
        continue;
      }
    }

    const skippedHint = skippedExistingCount > 0 ? `，跳过同岗位已评过的 ${skippedExistingCount} 人（节省了 ${skippedExistingCount} 次 AI 调用）` : '';
    logInfo(`主动寻访：结束（已联系 ${contacted}/${max}${skippedHint}）`);
  }

  async function openCandidateResume(card) {
    await closePopupsIfAny().catch(() => {});
    await closeResumePanelIfAny().catch(() => {});
    const root = getCandidateActionRoot(card) || card;

    // 推荐牛人：点卡片主体通常会在右侧打开简历面板
    const tryExtraClicks = () => {
      // 有些卡片把可点击区域放在 a/button 上
      const more = [
        root.matches?.('a[data-geekid], a[data-eid]') ? root : null,
        root.querySelector('a'),
        root.querySelector('a[href]'),
        root.querySelector('[role="button"]'),
        root.querySelector('.button-chat-wrap, .button-chat, [class*="button-chat"]'),
        root.querySelector('.search-geek-avatar'),
        root.querySelector('.avatar-wrap'),
        root.querySelector('.card-inner.new-geek-wrap[data-geek]'),
        root.querySelector('.col-2'),
        root.querySelector('.name-label'),
        root.querySelector('.name'),
        root.querySelector('.name-wrap'),
        root.querySelector('.geek-info-detail'),
        root.querySelector('.geek-info-basic'),
      ].filter(Boolean);
      for (const el of more) simulateClick(el);
    };

    const clickTargets = [
      root.matches?.('a[data-geekid], a[data-eid]') ? root : null,
      root.querySelector('.card-container'),
      root.querySelector('.card-inner.new-geek-wrap[data-geek]'),
      root.querySelector('.card-inner.common-wrap'),
      root.querySelector('.card-inner'),
      root.querySelector('.search-geek-avatar'),
      root.querySelector('.avatar-wrap'),
      root.querySelector('img.avatar'),
      root.querySelector('.col-2'),
      root.querySelector('.name-label'),
      root.querySelector('.geek-info-detail'),
      root.querySelector('.geek-info-basic'),
      root.querySelector('.name-wrap'),
      root.querySelector('.name'),
      root,
    ].filter(Boolean);

    for (let attempt = 0; attempt < 3; attempt++) {
      const t = clickTargets[Math.min(attempt, clickTargets.length - 1)];
      simulateClick(t);
      // 有些场景点击一次不触发，补点几下不同区域更稳
      if (attempt === 1) tryExtraClicks();
      // 打开简历也可能触发频控 toast
      await backoffIfTooFrequent('打开简历');
      const ok = await waitFor(() => {
        return (
          queryAnyDoc('.resume-detail-wrap') ||
          queryAnyDoc('.resume-detail') ||
          queryAnyDoc('[class*="resume-detail"]') ||
          queryAnyDoc('.geek-base-info-wrap') ||
          queryAnyDoc('[class*="resume-section"]') ||
          queryAnyDoc('[encrypt-geek-id]') ||
          queryAnyDoc('[class*="geek-base-info"]')
        );
      }, 12000);
      if (ok) return true;
      await sleep(350);
    }
    return false;
  }

  function isElementDisabledLike(el) {
    if (!el) return true;
    if (el.disabled) return true;
    const aria = String(el.getAttribute?.('aria-disabled') || '').toLowerCase();
    if (aria === 'true') return true;
    const cls = String(el.className || '').toLowerCase();
    return /\b(disabled|forbid|ban|stop|is-disabled)\b/.test(cls);
  }

  function findFeaturedRightsButton(card = null) {
    const root = getCandidateActionRoot(card);
    if (root) {
      const scoped =
        root.querySelector?.('button.btn-v2.position-rights.btn-sure-v2')
        || root.querySelector?.('button.position-rights.btn-sure-v2')
        || root.querySelector?.('button.position-rights')
        || root.closest?.('li.geek-info-card')?.querySelector?.('button.position-rights');
      if (scoped && isVisible(scoped)) return scoped;
    }
    return queryAnyDoc('.geek-info-card a[data-geekid] button.btn-v2.position-rights.btn-sure-v2')
      || queryAnyDoc('.geek-info-card a[data-geekid] button.position-rights.btn-sure-v2')
      || queryAnyDoc('.geek-info-card a[data-geekid] button.position-rights')
      || queryAnyDoc('button.btn-v2.position-rights.btn-sure-v2')
      || queryAnyDoc('button.position-rights.btn-sure-v2')
      || queryAnyDoc('button.position-rights')
      || null;
  }

  function findFeaturedPropCardButton(card = null) {
    const root = getCandidateActionRoot(card);
    if (root) {
      const scoped =
        root.querySelector?.('button.prop-card-chat[ka="resume_anonymous_usePropCardChat"]')
        || root.querySelector?.('button.prop-card-chat')
        || root.querySelector?.('[ka="resume_anonymous_usePropCardChat"]');
      if (scoped && isVisible(scoped)) return scoped;
    }
    return queryAnyDoc('button.prop-card-chat[ka="resume_anonymous_usePropCardChat"]')
      || queryAnyDoc('button.prop-card-chat')
      || queryAnyDoc('[ka="resume_anonymous_usePropCardChat"]')
      || null;
  }

  function findFeaturedChatModeArrow(card = null) {
    const rightsBtn = findFeaturedRightsButton(card);
    const propBtn = findFeaturedPropCardButton(card);
    const aroundRights = rightsBtn?.parentElement?.querySelector?.('.arrow') || rightsBtn?.closest?.('[class*="chat"], [class*="greet"], [class*="operate"]')?.querySelector?.('.arrow');
    if (aroundRights && isVisible(aroundRights)) return aroundRights;
    const aroundProp = propBtn?.parentElement?.querySelector?.('.arrow') || propBtn?.closest?.('[class*="chat"], [class*="greet"], [class*="operate"]')?.querySelector?.('.arrow');
    if (aroundProp && isVisible(aroundProp)) return aroundProp;
    const any = queryAnyDoc('.arrow');
    return any && isVisible(any) ? any : null;
  }

  function getFeaturedCheckedChatMode(card = null) {
    const checked = queryAnyDoc('.chat-modes .chat-mode.checked');
    const text = String(checked?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.includes('账号权益')) return 'rights';
    if (text.includes('畅聊卡')) return 'prop';
    if (findFeaturedRightsButton(card) && !findFeaturedPropCardButton(card)) return 'rights';
    if (findFeaturedPropCardButton(card) && !findFeaturedRightsButton(card)) return 'prop';
    return '';
  }

  async function ensureFeaturedChatMode(mode, card = null) {
    const target = mode === 'prop' ? 'prop' : 'rights';
    if (getFeaturedCheckedChatMode(card) === target) return true;

    const arrow = findFeaturedChatModeArrow(card);
    if (!arrow) {
      if (target === 'rights') return !!findFeaturedRightsButton(card);
      return !!findFeaturedPropCardButton(card);
    }

    simulateClick(arrow);
    const opened = await waitFor(() => queryAnyDoc('.chat-modes .chat-mode'), 4000).catch(() => false);
    if (!opened) return false;

    const option = Array.from(queryAllAnyDoc('.chat-modes .chat-mode', 20))
      .find((el) => {
        const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        return target === 'rights' ? text.includes('账号权益') : text.includes('畅聊卡');
      }) || null;
    if (!option) return false;

    simulateClick(option);
    const ok = await waitFor(() => {
      if (getFeaturedCheckedChatMode(card) === target) return true;
      if (target === 'rights' && findFeaturedRightsButton(card)) return true;
      if (target === 'prop' && findFeaturedPropCardButton(card)) return true;
      return null;
    }, 5000).catch(() => false);
    return !!ok;
  }

  function parseButtonQuotaInfo(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    const m = raw.match(/\((\d+)\s*\/\s*(\d+)\)/);
    return {
      text: raw,
      usedOrRemain: m ? Number(m[1]) : null,
      total: m ? Number(m[2]) : null,
    };
  }

  function isFeaturedRightsQuotaExhausted(btn) {
    if (!btn) return true;
    if (isElementDisabledLike(btn)) return true;
    const info = parseButtonQuotaInfo(btn.textContent || '');
    const lower = info.text.toLowerCase();
    if (/(已用完|已达上限|权益不足|额度不足|今日上限|已达今日上限)/.test(lower)) return true;
    if (Number.isFinite(info.usedOrRemain) && Number.isFinite(info.total) && info.total > 0 && info.usedOrRemain >= info.total) return true;
    return false;
  }

  function detectQuotaExhaustedHintText() {
    const patterns = [
      '权益已用完',
      '账号权益已用完',
      '沟通权益已用完',
      '额度已用完',
      '额度不足',
      '权益不足',
      '今日已达上限',
      '今日沟通已达上限',
      '已达上限',
      '畅聊卡不足',
    ];
    const candidates = queryAllAnyDoc(
      '.ui-toast, .toast, [class*="toast"], [class*="Toast"], [role="alert"], [role="dialog"], .ui-dialog, [class*="dialog"], [class*="Dialog"], .ui-message, [class*="message"], [class*="Message"]',
      120
    );
    for (const el of candidates) {
      try {
        if (!isVisible(el)) continue;
        const t = String(el.innerText || el.textContent || '').trim();
        if (!t) continue;
        if (patterns.some((p) => t.includes(p))) return t.slice(0, 120);
      } catch {}
    }
    return null;
  }

  function askUserConfirm(message) {
    try {
      if (window.top && typeof window.top.confirm === 'function') return window.top.confirm(message);
    } catch {}
    try {
      if (typeof window.confirm === 'function') return window.confirm(message);
    } catch {}
    return false;
  }

  async function askSwitchToFeaturedPropCard({ rightsText = '', propText = '' } = {}) {
    if (featuredPropCardConsent === true) return true;
    if (featuredPropCardConsent === false) return false;
    const msg = [
      '精选列表的账号权益额度已用完。',
      rightsText ? `账号权益按钮：${rightsText}` : '',
      propText ? `畅聊卡按钮：${propText}` : '',
      '是否切换到“畅聊卡模式”继续沟通？',
    ].filter(Boolean).join('\n');
    const ok = askUserConfirm(msg);
    featuredPropCardConsent = ok;
    return ok;
  }

  function findFeaturedSuccessDialog() {
    const dialogs = queryAllAnyDoc('.boss-popup__wrapper, .boss-dialog__wrapper, .boss-dialog, [class*="boss-dialog"]', 20);
    return dialogs.find((el) => {
      if (!isVisible(el)) return false;
      const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return text.includes('开聊成功');
    }) || null;
  }

  async function closeFeaturedSuccessDialogIfAny({ timeout = 0, logClosed = false } = {}) {
    let target = findFeaturedSuccessDialog();
    if (!target && timeout > 0) {
      target = await waitFor(() => findFeaturedSuccessDialog() || null, timeout).catch(() => null);
    }
    if (!target) return false;

    const closeBtn =
      target.querySelector?.('.boss-popup__close')
      || Array.from(target.querySelectorAll?.('.boss-dialog__button, button, a, [role="button"]') || [])
        .find((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() === '关闭')
      || null;
    if (!closeBtn) return false;
    simulateClick(closeBtn);
    await waitFor(() => {
      return isVisible(target) ? null : true;
    }, 3000).catch(() => false);
    if (logClosed) {
      logInfo('精选页：检测到“开聊成功”弹窗，已自动关闭并继续下一位');
    }
    await sleep(180);
    return true;
  }

  async function clickFeaturedGreetButton(kind, card) {
    const btn = kind === 'prop' ? findFeaturedPropCardButton(card) : findFeaturedRightsButton(card);
    if (!btn || isElementDisabledLike(btn)) return { composerReady: false, established: false, clicked: false };
    simulateClick(btn);
    await backoffIfTooFrequent(kind === 'prop' ? '畅聊卡打招呼' : '账号权益打招呼');
    let successClosed = await closeFeaturedSuccessDialogIfAny({ timeout: 3500, logClosed: true }).catch(() => false);
    let quotaHint = detectQuotaExhaustedHintText();
    const established = successClosed ? true : await waitFor(() => isConversationEstablished(btn) ? true : null, 8000);
    const composer = successClosed ? null : await waitFor(() => locateChatComposer(), 3000);
    if (!established && !composer && !successClosed) {
      successClosed = await closeFeaturedSuccessDialogIfAny({ timeout: 1800, logClosed: true }).catch(() => false);
    }
    if (!quotaHint) quotaHint = detectQuotaExhaustedHintText();
    return {
      composerReady: !!composer,
      established: !!(established || successClosed),
      clicked: true,
      quotaHint,
      successClosed: !!successClosed,
    };
  }

  async function greetCandidateInFeatured(card) {
    const rightsBtn0 = findFeaturedRightsButton(card);
    const propBtn0 = findFeaturedPropCardButton(card);
    const rightsInfo0 = parseButtonQuotaInfo(rightsBtn0?.textContent || '');
    const propInfo0 = parseButtonQuotaInfo(propBtn0?.textContent || '');

    if (featuredPropCardConsent !== true) {
      await ensureFeaturedChatMode('rights', card).catch(() => false);
      const rightsBtn = findFeaturedRightsButton(card);
      const propBtn = findFeaturedPropCardButton(card);
      const rightsInfo = parseButtonQuotaInfo(rightsBtn?.textContent || '');
      const propInfo = parseButtonQuotaInfo(propBtn?.textContent || '');

      if (rightsBtn && !isFeaturedRightsQuotaExhausted(rightsBtn)) {
        const sent = await clickFeaturedGreetButton('rights', card);
        if (sent.established || sent.composerReady) return sent;
        if (!sent.quotaHint) {
          return { composerReady: false, established: false };
        }
      }

      if (!propBtn) {
        const reason = rightsBtn
          ? `精选页账号权益已不可用，且未找到畅聊卡按钮：${rightsInfo.text || '立即沟通按钮不可用'}`
          : '精选页未找到可用的账号权益/畅聊卡沟通按钮';
        stopRun();
        return { composerReady: false, established: false, stopRequested: true, reason };
      }

      const allowProp = await askSwitchToFeaturedPropCard({
        rightsText: rightsInfo.text || rightsInfo0.text || '',
        propText: propInfo.text || propInfo0.text || '',
      });
      if (!allowProp) {
        const reason = '精选页账号权益已不可用，用户取消切换到畅聊卡模式，本次运行已停止';
        stopRun();
        return { composerReady: false, established: false, stopRequested: true, reason };
      }
    }

    const switched = await ensureFeaturedChatMode('prop', card).catch(() => false);
    if (!switched) {
      const reason = '精选页已同意切换畅聊卡模式，但未能切换成功，本次运行已停止';
      stopRun();
      return { composerReady: false, established: false, stopRequested: true, reason };
    }

    const propBtn = findFeaturedPropCardButton(card);
    const propInfo = parseButtonQuotaInfo(propBtn?.textContent || '');
    if (!propBtn || isElementDisabledLike(propBtn)) {
      const reason = `精选页畅聊卡按钮不可用：${propInfo.text || '未找到畅聊卡按钮'}`;
      stopRun();
      return { composerReady: false, established: false, stopRequested: true, reason };
    }

    const sent = await clickFeaturedGreetButton('prop', card);
    if (sent.established || sent.composerReady) return sent;
    const reason = `精选页已切换到畅聊卡模式，但仍未成功发起沟通：${sent.quotaHint || propInfo.text || '请检查页面状态'}`;
    stopRun();
    return { composerReady: false, established: false, stopRequested: true, reason };
  }

  async function greetCandidate(card, { outreachListMode = 'recommend' } = {}) {
    if (normalizeOutreachListMode(outreachListMode) === 'featured') {
      return greetCandidateInFeatured(card);
    }
    const btn =
      // 你补充的：简历展开面板里的按钮
      queryAnyDoc('button.btn-v2.btn-greet.overdue-tip, button.btn-v2.btn-greet')
      // 卡片里的按钮
      || card.querySelector('button.btn.btn-greet.overdue-tip')
      || card.querySelector('button.btn.btn-greet, .btn.btn-greet, [class*="btn-greet"]')
      || card.querySelector('button.btn.btn-getcontact, .btn.btn-getcontact, [class*="btn-getcontact"]')
      || null;
    if (!btn) {
      logWarn('未找到打招呼按钮（btn-greet）');
      return { composerReady: false, established: false };
    }
    // 1.1.3：auto 模式 + 启用本机点击器时走 OS 级真鼠标
    const cardName = (typeof getCandidateName === 'function') ? getCandidateName(card) : '';
    const cardIdInfo = (typeof getCandidateIdInfo === 'function') ? getCandidateIdInfo(cardName, card) : null;
    const r = await riskyClick(btn, {
      name: cardName,
      candidateId: cardIdInfo?.key || '',
      label: '打招呼',
    });
    if (r === 'cancelled') {
      return { composerReady: false, established: false, stopRequested: true, reason: '本机点击器：用户取消了本次打招呼' };
    }
    if (r === 'idle-timeout') {
      // 用户一直在用电脑：跳过这位但不暂停整批，主循环会处理下一个
      return { composerReady: false, established: false, skipCandidate: true, reason: '等候空闲超时' };
    }
    if (r === 'unreachable') {
      // 不能回退到 dispatchEvent（会触发 isTrusted 风控），整批暂停
      return { composerReady: false, established: false, stopRequested: true, reason: '本机点击器不可达，已暂停（请启动 clicker 或在设置里关闭"启用本机点击器"）' };
    }
    await backoffIfTooFrequent('打招呼');
    const established = await waitFor(() => isConversationEstablished(card) ? true : null, 8000);
    const composer = await waitFor(() => locateChatComposer(), 3000);
    return { composerReady: !!composer, established: !!established };
  }

  function isConversationEstablished(card) {
    // 你给的继续沟通按钮
    const inCard = Array.from(card.querySelectorAll('button, a, [role="button"]'))
      .some((el) => String(el.innerText || el.textContent || '').trim().includes('继续沟通'));
    if (inCard) return true;

    // 简历面板/右侧区域可能出现
    const el =
      queryAnyDoc('button.btn-v2.btn-outline-v2')
      || queryAnyDoc('[class*="btn-outline-v2"]')
      || null;
    if (el) {
      const t = String(el.innerText || el.textContent || '').trim();
      if (t.includes('继续沟通')) return true;
    }

    // 兜底：页面上任意可见按钮文字包含“继续沟通”
    for (const d of getAllDocs()) {
      const btns = Array.from(d.querySelectorAll?.('button, a, [role="button"]') || []).filter(isVisible).slice(0, 200);
      if (btns.some((b) => String(b.innerText || b.textContent || '').trim().includes('继续沟通'))) return true;
    }
    return false;
  }

  // 1.2.x：定位「继续沟通」按钮（boss 沟通页里常见 btn-greet 外观）
  // 用户给的 DOM：<button class="btn-v2 btn-v2-new btn-outline-v2 btn-greet">继续沟通</button>
  function findContinueCommunicationButton() {
    const sels = [
      'button.btn-v2.btn-v2-new.btn-outline-v2.btn-greet',
      'button.btn-v2.btn-outline-v2.btn-greet',
      'button.btn-v2.btn-greet',
      'button.btn.btn-greet',
      'button[class*="btn-greet"]',
      '[class*="btn-greet"]',
    ];
    for (const d of getAllDocs()) {
      for (const sel of sels) {
        let list = [];
        try { list = Array.from(d.querySelectorAll?.(sel) || []); } catch { list = []; }
        const hit = list
          .filter(isVisible)
          .find((b) => String(b.innerText || b.textContent || '').trim().includes('继续沟通'));
        if (hit) return hit;
      }
    }
    return null;
  }

  // 1.2.x：自动回复发送前，先尝试点一次「继续沟通」打开输入框
  // 设计说明：
  //   「继续沟通」是 boss 简历面板里的 UI 视图切换按钮（简历视图→聊天视图），
  //   不是"自动操作 Boss 业务"的高危按钮（不是打招呼/不是发送）。
  //   不点这颗按钮，输入框压根不出现，连草稿都填不进去 —— 所以低风险模式也得点。
  // 模式差异：
  //   - 低风险：simulateClick（dispatchEvent 兜底，老路径）
  //   - 半 / 全自动：riskyClick（启用 clicker 时走 OS 级真鼠标）
  async function ensureContinueCommunicationClicked() {
    const btn = findContinueCommunicationButton();
    if (!btn) {
      return { clicked: false, composerReady: !!locateChatComposer(), skipped: true, reason: '页面未出现“继续沟通”按钮' };
    }
    // 低风险：直接 dispatchEvent，跳过 riskyClick（riskyClick 在低风险下也会走同一兜底，省一层判断）
    if (isLowRiskMode()) {
      try { simulateClick(btn); } catch (e) {
        return { clicked: false, composerReady: false, reason: `dispatchEvent 失败：${e?.message || ''}` };
      }
      const composer = await waitFor(() => locateChatComposer(), 3000).catch(() => null);
      return { clicked: true, composerReady: !!composer, mode: 'low', reason: '低风险 dispatchEvent' };
    }
    // 半 / 全自动：走 riskyClick（开启 clicker 时是 OS 级真鼠标）
    const r = await riskyClick(btn, { label: '继续沟通' });
    if (r === 'cancelled') return { clicked: false, composerReady: false, cancelled: true, reason: '本机点击器：用户取消了“继续沟通”点击' };
    if (r === 'unreachable') return { clicked: false, composerReady: false, unreachable: true, reason: '本机点击器不可达' };
    if (r === 'idle-timeout') return { clicked: false, composerReady: false, idleTimeout: true, reason: '等候空闲超时' };
    try { await backoffIfTooFrequent('继续沟通'); } catch {}
    const composer = await waitFor(() => locateChatComposer(), 3000).catch(() => null);
    return { clicked: true, composerReady: !!composer, mode: r === 'os' ? 'os-mouse' : 'dispatch', reason: '' };
  }

  // 1.2.x：识别「半自动」模式（riskMode=auto 且每次点击需弹确认）
  //   - 半自动：填好文字后留作草稿，由用户人工核对再手动发送
  //   - 全自动：填好文字后自动点发送
  function isSemiAutoClickerMode() {
    try {
      if (isLowRiskMode()) return false;
      const ec = settings && settings.externalClicker;
      return !!ec && ec.perClickConfirm !== false;
    } catch (_) {
      return false;
    }
  }

  async function closeResumePanelIfAny() {
    const tryClick = (sel) => {
      const el = queryAnyDoc(sel);
      if (el) {
        simulateClick(el);
        return true;
      }
      return false;
    };

    // 优先：简历面板自身的关闭按钮
    const clicked =
      // 你补充的关闭按钮：<i class="icon-close"></i>
      (() => {
        const root = queryAnyDoc('.resume-detail-wrap') || queryAnyDoc('[class*="resume-detail"]');
        const el = root?.querySelector?.('i.icon-close, .icon-close') || queryAnyDoc('i.icon-close, .icon-close');
        if (el && isVisible(el)) {
          simulateClick(el);
          return true;
        }
        return false;
      })()
      ||
      tryClick('.resume-detail-wrap .close-btn')
      || tryClick('.resume-detail-wrap .close-btn .iboss-close')
      || tryClick('.video-resume-other .close-btn')
      || tryClick('.video-resume-other .close-btn .iboss-close')
      || tryClick('.resume-custom-close')
      || tryClick('.boss-popup__close');

    if (!clicked) return false;

    await waitFor(() => {
      const still =
        queryAnyDoc('.resume-detail-wrap')
        || queryAnyDoc('[class*="resume-detail"]');
      return still ? null : true;
    }, 2500);
    return true;
  }

  async function ensureOutreachFrameAndStart() {
    // Boss SPA 现状：有时“推荐牛人”真实内容会挂在 /web/chat/job/list 之类路由下，
    // 仅靠 pathname/data-pv 会误判。这里用更强的 DOM 特征兜底（同时避免职位管理页误命中）。
    const hasRecommendDomStrong = () => {
      // 你提供的推荐页结构：.recommend-wrap + #recommend-list + .candidate-card-wrap
      const list = queryAnyDoc('#recommend-list');
      if (!list) return false;
      const wrap = queryAnyDoc('.recommend-wrap');
      const hasCards =
        !!queryAnyDoc('#recommend-list .candidate-card-wrap')
        || !!queryAnyDoc('.recommend-wrap .candidate-card-wrap');
      if (wrap && hasCards) return true;
      // 兜底：某些版本没有 .recommend-wrap，但 #recommend-list + 岗位下拉 + 卡片仍可确认
      const hasJobSel =
        !!queryAnyDoc('.candidate-head .job-selecter-wrap .ui-dropmenu-label')
        || !!queryAnyDoc('.job-selecter-wrap .ui-dropmenu-label');
      return !!hasCards && !!hasJobSel;
    };

    // 当前版本口径：推荐/精选/最新 都只应在推荐牛人页执行，不转发到搜索页 frame
    const hasFrame = () => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      return iframes.some((f) => {
        const src = String(f.getAttribute('src') || '');
        const name = String(f.getAttribute('name') || '');
        return name === 'recommendFrame'
          || src.includes('/web/frame/recommend-v2/')
          || src.toLowerCase().includes('recommend');
      });
    };

    const pv = String(document.body?.getAttribute?.('data-pv') || '');
    const path = String(location.pathname || '');
    // 用户要求：必须“跳到推荐牛人路由”让人肉眼可见，因此这里仅用路由/pv 判定。
    const onRecommendRoute =
      path.includes('/web/chat/recommend')
      || pv.includes('/web/chat/recommend');

    // 需求：让用户“看得见它在操作” -> 不在推荐牛人路由就强制跳过去
    // 否则 frame 可能处于隐藏状态，点卡片无法打开简历面板。
    if (!onRecommendRoute) {
      // 防止 SPA 判断不准导致“反复跳转闪屏”：8 秒内只允许导航一次
      try {
        const r = await chrome.storage.local.get([STORAGE_KEYS.pendingStart]).catch(() => ({}));
        const prev = r?.[STORAGE_KEYS.pendingStart] || null;
        const age = Date.now() - (Number(prev?.ts) || 0);
        if (prev?.kind === 'outreach' && Number.isFinite(age) && age >= 0 && age < 8000) {
          return 'navigating';
        }
      } catch {}

      await chrome.storage.local.set({ [STORAGE_KEYS.pendingStart]: { ts: Date.now(), kind: 'outreach' } }).catch(() => {});
      try {
        const entry = findRecommendEntry();
        if (entry) {
          logInfo('主动寻访：正在打开推荐牛人的「推荐」页面...');
          simulateClick(entry);
          // Boss SPA 有时会吞点击：短暂等待后若仍未进入推荐牛人，则强制跳转
          await sleep(260);
          const pv2 = String(document.body?.getAttribute?.('data-pv') || '');
          const path2 = String(location.pathname || '');
          const already =
            path2.includes('/web/chat/recommend')
            || pv2.includes('/web/chat/recommend')
            || false;
          if (!already) {
            try { location.href = '/web/chat/recommend?ka=menu-geek-recommend'; } catch {}
          }
        } else {
          logInfo('主动寻访：未找到侧栏入口，改用推荐页直链跳转');
          location.href = '/web/chat/recommend?ka=menu-geek-recommend';
        }
      } catch {
        try { location.href = '/web/chat/recommend?ka=menu-geek-recommend'; } catch {}
      }
      return 'navigating';
    }

    // 已在推荐牛人路由：等页面就绪（候选人卡片/岗位下拉出现）
    // 关键口径：第一步一定要“到推荐牛人页 → 切到目标岗位 → 再开始筛选”。
    //
    // 实测：推荐牛人常以 iframe 渲染，但顶层页面同源可直接操作 iframe DOM（queryAnyDoc + simulateClick）。
    // 为提升稳定性：只要顶层能看到候选人卡片/岗位下拉，就在顶层直接执行，不依赖 postMessage 转发。
    // 只有在顶层无法访问 DOM 时，才转发到 iframe 执行。
    const ok = await waitFor(() => {
      if (queryAnyDoc('.candidate-card-wrap') || queryAnyDoc('.job-selecter-wrap .ui-dropmenu-label')) return 'top';
      if (hasFrame()) return 'frame';
      return null;
    }, 20000);

    if (!ok) {
      logWarn('主动寻访：已进入推荐牛人页但未检测到候选人卡片（可能还在加载/需要手动滚动一下）');
      return false;
    }

    if (ok === 'frame') {
      logWarn('主动寻访：检测到推荐牛人 iframe，但顶层尚未读取到卡片DOM，尝试仅向推荐牛人 iframe 转发执行');
      dispatchToOutreachFrames('START', { target: 'recommend' });
      return 'frame';
    }
    // ok === 'top'：顶层可见 DOM，直接在顶层执行（更稳）
    return 'top';
  }

  function findRecommendEntry() {
    // 0) 最稳：精确 ka（你提供的 DOM）
    const byKa = document.querySelector('a[ka="menu-geek-recommend"]');
    if (byKa) return byKa;

    // 1) 明确的文案（侧边栏没折叠时最稳）
    const byText = findElementByTextIncludes(['推荐牛人']);
    const textEntry = byText?.closest?.('a,button,[role="menuitem"],.menu-item-content,li,div') || null;
    if (textEntry) return textEntry;

    // 2) 侧边栏可能只显示 icon：用 svg icon 名称猜（recommend/geek）
    const iconUse =
      document.querySelector('use[xlink\\:href*="recommend"], use[xlink\\:href*="geek"], use[xlink\\:href*="talent"]')
      || document.querySelector('use[href*="recommend"], use[href*="geek"], use[href*="talent"]');
    const iconEntry = iconUse?.closest?.('a,button,[role="menuitem"]') || null;
    if (iconEntry) return iconEntry;

    // 3) 扫描所有链接：按 href/ka/text 评分
    const links = Array.from(document.querySelectorAll('a[href], [ka]')).slice(0, 600);
    let best = null;
    let bestScore = -Infinity;
    for (const el of links) {
      const a = el.tagName === 'A' ? el : el.closest?.('a');
      const href = String(a?.getAttribute?.('href') || el.getAttribute?.('href') || '');
      const ka = String(el.getAttribute?.('ka') || a?.getAttribute?.('ka') || '');
      const text = String((a?.textContent || el.textContent || '')).trim();

      const score = scoreRecommendLink({ href, ka, text, el: a || el });
      if (score > bestScore) {
        bestScore = score;
        best = a || el;
      }
    }
    return bestScore >= 8 ? best : null;
  }

  function scoreRecommendLink({ href, ka, text, el }) {
    let score = 0;
    const h = href.toLowerCase();
    const k = ka.toLowerCase();
    const t = String(text || '');

    if (t.includes('推荐牛人')) score += 50;
    if (t.includes('推荐') && t.includes('牛人')) score += 35;
    if (t.includes('牛人')) score += 15;
    if (t.includes('推荐')) score += 10;

    if (h.includes('recommend')) score += 25;
    if (h.includes('geek') || h.includes('talent')) score += 10;
    if (h.includes('/web/chat/')) score += 6;

    if (k.includes('recommend')) score += 18;
    if (k.includes('geek') || k.includes('talent')) score += 8;

    // 排除显然不是导航的链接
    if (h.startsWith('javascript:')) score -= 10;
    if (h.includes('job/list') || h.includes('job/edit')) score -= 6;

    // 更偏好可见的菜单项
    if (el && isVisible(el)) score += 6;
    return score;
  }

  async function ensureChatPage({ startAfter } = {}) {
    // 重要：不要用 .friend-list-item 判定“沟通页”，因为很多 Boss 页面左侧也会渲染沟通列表，
    // 会导致误判，从而不跳转。沟通页以路由/path + data-pv 为准。
    const onChat = isOnChatIndexPage();

    if (onChat) return 'ok';

    // 防止 SPA 判断不准导致“反复跳转闪屏”：8 秒内只允许导航一次
    if (startAfter) {
      try {
        const r = await chrome.storage.local.get([STORAGE_KEYS.pendingStart]).catch(() => ({}));
        const prev = r?.[STORAGE_KEYS.pendingStart] || null;
        const age = Date.now() - (Number(prev?.ts) || 0);
        if (prev?.kind === 'reply' && Number.isFinite(age) && age >= 0 && age < 8000) {
          return 'navigating';
        }
      } catch {}
      await chrome.storage.local.set({ [STORAGE_KEYS.pendingStart]: { ts: Date.now(), kind: 'reply' } }).catch(() => {});
    }

    // 你提供的沟通入口：ka="menu-im"
    const targetHref = '/web/chat/index?ka=menu-im';
    try {
      const entry = findChatEntry();
      if (entry) {
        // 优先点真实入口；若 Boss SPA 吞点击，再强制 href
        simulateClick(entry.closest?.('dt,li,div,a,button') || entry);
        // 等一下路由变化（比固定 sleep 更稳）
        const ok = await waitFor(() => {
          return isOnChatIndexPage() ? true : null;
        }, 2500).catch(() => false);
        if (!ok) {
          try { location.href = targetHref; } catch {}
        }
      } else {
        location.href = targetHref;
      }
    } catch {
      try { location.href = targetHref; } catch {}
    }
    return 'navigating';
  }

  function findChatEntry() {
    // 0) 最稳：精确 ka（若 Boss 提供）
    const byKa = document.querySelector('a[ka="menu-im"], a[ka="menu-geek-chat"]');
    if (byKa) return byKa;

    // 1) 明确文案（侧边栏没折叠时）
    const byText = findElementByTextIncludes(['沟通', '消息']);
    const textEntry = byText?.closest?.('a,button,[role="menuitem"],.menu-item-content,li,div') || null;
    if (textEntry) return textEntry;

    // 2) 扫描所有链接：按 href/ka/text 评分
    const links = Array.from(document.querySelectorAll('a[href], [ka]')).slice(0, 600);
    let best = null;
    let bestScore = -Infinity;
    for (const el of links) {
      const a = el.tagName === 'A' ? el : el.closest?.('a');
      const href = String(a?.getAttribute?.('href') || el.getAttribute?.('href') || '');
      const ka = String(el.getAttribute?.('ka') || a?.getAttribute?.('ka') || '');
      const text = String((a?.textContent || el.textContent || '')).trim();
      const score = scoreChatLink({ href, ka, text, el: a || el });
      if (score > bestScore) {
        bestScore = score;
        best = a || el;
      }
    }
    return bestScore >= 8 ? best : null;
  }

  function scoreChatLink({ href, ka, text, el }) {
    let score = 0;
    const h = String(href || '').toLowerCase();
    const k = String(ka || '').toLowerCase();
    const t = String(text || '');

    if (t.includes('沟通')) score += 50;
    if (t.includes('消息')) score += 18;
    if (h.includes('/web/chat/index')) score += 25;
    if (h.includes('/web/chat/')) score += 6;
    if (k.includes('chat')) score += 12;
    if (k.includes('message')) score += 10;

    if (h.startsWith('javascript:')) score -= 10;
    if (el && isVisible(el)) score += 6;
    return score;
  }

  // ====== In-page floating panel (persistent on Boss pages) ======

  function mountInpagePanel() {
    try {
      const existing = document.getElementById('boss-assist-panel-root');
      if (existing) return;

      const host = document.createElement('div');
      host.id = 'boss-assist-panel-root';
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';

      const shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; }
        .panel {
          width: 430px;
          max-height: 78vh;
          background: rgba(11,18,32,0.92);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 14px;
          color: rgba(255,255,255,0.92);
          font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;
          box-shadow: 0 16px 50px rgba(0,0,0,0.35);
          backdrop-filter: blur(10px);
          overflow: hidden;
        }
        .hdr{
          display:flex;align-items:center;justify-content:space-between;
          padding:10px 10px 8px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.10);
          cursor: move;
          user-select:none;
        }
        .title{font-size:13px;font-weight:800;letter-spacing:.2px}
        .sub{font-size:11px;color:rgba(255,255,255,0.58);margin-top:2px}
        .hdrLeft{display:flex;flex-direction:column}
        .hdrBtns{display:flex;gap:6px}
        .closeBtn{
          width:28px;height:28px;border-radius:10px;
          border:1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.86);
          cursor:pointer;font-weight:900;
        }
        .iconBtn{
          width:28px;height:28px;border-radius:10px;
          border:1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.86);
          cursor:pointer;font-weight:800;
        }
        .body{padding:0;overflow:hidden;max-height:calc(78vh - 54px);background: rgba(0,0,0,0.10);}
        .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
        label{font-size:12px;color:rgba(255,255,255,0.86);display:flex;gap:8px;align-items:center}
        input[type="checkbox"]{transform: translateY(1px);}
        .label{font-size:11px;color:rgba(255,255,255,0.58);margin:8px 0 6px;}
        .input,.ta,select{
          width:100%;
          border-radius:10px;
          border:1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.05);
          color: rgba(255,255,255,0.92);
          padding:8px 10px;
          outline:none;
          font-size:12px;
        }
        .ta{resize:vertical;min-height:62px;}
        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
        .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;}
        .btn{
          height:34px;border-radius:10px;border:1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);color:rgba(255,255,255,0.92);
          cursor:pointer;font-weight:800;font-size:12px;
        }
        .btn.primary{background: linear-gradient(180deg, rgba(99,102,241,0.95), rgba(99,102,241,0.75));border-color: rgba(99,102,241,0.65);}
        .pill{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.62);}
        .pill.running{color: rgba(34,197,94,0.95);border-color: rgba(34,197,94,0.35);}
        .pill.stopping{color: rgba(245,158,11,0.95);border-color: rgba(245,158,11,0.35);}
        .log{margin-top:10px;border:1px solid rgba(255,255,255,0.12);border-radius:12px;background: rgba(0,0,0,0.18);padding:8px;}
        .logBox{height:170px;overflow:auto;font-size:11px;line-height:1.35;color:rgba(255,255,255,0.70);white-space:pre-wrap;}
        .line{margin-bottom:6px;}
        .ts{color:rgba(255,255,255,0.38);margin-right:6px;}
        .success{color: rgba(34,197,94,0.95);}
        .warn{color: rgba(245,158,11,0.95);}
        .muted{color: rgba(255,255,255,0.58);}
        .mini .body{display:none;}
        iframe{
          width:100%;
          height:calc(78vh - 54px);
          border:0;
          display:block;
          background: transparent;
        }
      `;

      const wrap = document.createElement('div');
      wrap.className = 'panel';
      wrap.innerHTML = `
        <div class="hdr">
          <div class="hdrLeft">
            <div class="title">小池-boss智能助手</div>
            <div class="sub">悬浮面板 · 完整功能（与原面板一致）</div>
          </div>
          <div class="hdrBtns">
            <button class="iconBtn" id="btnMini" title="最小化">—</button>
            <button class="closeBtn" id="btnClose" title="关闭（Alt+Shift+B 可再打开）">×</button>
          </div>
        </div>
        <div class="body">
          <div class="row">
            <label><input id="p_enableOutreach" type="checkbox"/>主动寻访</label>
            <label><input id="p_allowNoAi" type="checkbox"/>无AI也寻访</label>
          </div>
          <div class="label">岗位（自动读取职位管理）</div>
          <select id="p_jobSelect"></select>
          <div class="label">岗位名称（用于右上角岗位切换匹配）</div>
          <input id="p_positionName" class="input" placeholder="例如：3D动作设计师"/>
          <div class="grid2">
            <div>
              <div class="label">每次最多联系人数</div>
              <input id="p_maxPerRun" class="input" type="number" min="1" max="500" step="1"/>
            </div>
            <div>
              <div class="label">延迟范围（ms）</div>
              <input id="p_delayMinMs" class="input" type="number" min="0" max="60000" step="100"/>
              <input id="p_delayMaxMs" class="input" type="number" min="0" max="60000" step="100"/>
            </div>
          </div>
          <div class="label">岗位要求（JD）</div>
          <textarea id="p_jdText" class="ta" rows="4"></textarea>
          <div class="row" style="margin-top:8px;">
            <label class="muted"><input id="p_andMode" type="checkbox"/>AND（全部命中）</label>
            <span class="pill" id="p_runState">未运行</span>
          </div>
          <div class="label">包含关键词（每行一个）</div>
          <textarea id="p_include" class="ta" rows="3"></textarea>
          <div class="label">排除关键词（每行一个）</div>
          <textarea id="p_exclude" class="ta" rows="2"></textarea>
          <div class="actions">
            <button class="btn primary" id="p_start">开始（跳推荐牛人）</button>
            <button class="btn" id="p_stop">停止</button>
          </div>
          <div class="log">
            <div class="row" style="margin-bottom:6px;">
              <div class="muted">运行日志</div>
              <button class="iconBtn" id="p_clear" title="清空">C</button>
            </div>
            <div class="logBox" id="p_logBox"></div>
          </div>
        </div>
      `;

      shadow.appendChild(style);
      shadow.appendChild(wrap);
      document.documentElement.appendChild(host);

      // 提供“强制隐藏面板”的兜底开关（用于用户反馈“关不掉”）
      try {
        window.__bossAssistHidePanel = async () => {
          try { await setPanelHidden(true); } catch {}
          try { host.remove(); } catch {}
        };
        window.__bossAssistShowPanel = async () => {
          try { await setPanelHidden(false); } catch {}
          try { mountInpagePanel(); } catch {}
        };
      } catch {}

      const $ = (id) => shadow.getElementById(id);
      const els = {
        mini: $('btnMini'),
        close: $('btnClose'),
        enableOutreach: $('p_enableOutreach'),
        allowNoAi: $('p_allowNoAi'),
        jobSelect: $('p_jobSelect'),
        positionName: $('p_positionName'),
        maxPerRun: $('p_maxPerRun'),
        delayMinMs: $('p_delayMinMs'),
        delayMaxMs: $('p_delayMaxMs'),
        jdText: $('p_jdText'),
        andMode: $('p_andMode'),
        include: $('p_include'),
        exclude: $('p_exclude'),
        start: $('p_start'),
        stop: $('p_stop'),
        clear: $('p_clear'),
        runState: $('p_runState'),
        logBox: $('p_logBox'),
      };

      const state = {
        minimized: false,
        jobs: [],
        logs: [],
        drag: { x: 0, y: 0, dx: 0, dy: 0, dragging: false },
      };

      function setMinimized(v) {
        state.minimized = !!v;
        wrap.classList.toggle('mini', state.minimized);
        els.mini.textContent = state.minimized ? '+' : '—';
      }

      function renderRunState(rs) {
        const running2 = !!rs?.running;
        const stopping2 = !!rs?.stopping;
        els.runState.textContent = running2 ? (stopping2 ? '停止中' : '运行中') : '未运行';
        els.runState.className = 'pill ' + (running2 ? (stopping2 ? 'stopping' : 'running') : '');
      }

      function renderJobsSelect() {
        const current = settings.selectedJobKey || '';
        const opts = [];
        opts.push(`<option value="">（不选择，手动填写）</option>`);
        for (const j of state.jobs) {
          const hasJd = j.jdText && String(j.jdText).trim().length > 0;
          const label = `${j.name}${hasJd ? '' : '（无JD）'}`;
          opts.push(`<option value="${escapeAttr(j.key)}">${escapeHtml(label)}</option>`);
        }
        els.jobSelect.innerHTML = opts.join('');
        els.jobSelect.value = current && state.jobs.some((j) => j.key === current) ? current : '';
      }

      function renderFromSettings() {
        els.enableOutreach.checked = !!settings.enableOutreach;
        els.allowNoAi.checked = !!settings.allowOutreachWithoutAI;
        els.positionName.value = settings.positionName || '';
        els.maxPerRun.value = String(settings.maxPerRun ?? 30);
        els.delayMinMs.value = String(settings.delayMinMs ?? 1200);
        els.delayMaxMs.value = String(settings.delayMaxMs ?? 2600);
        els.jdText.value = settings.jdText || '';
        els.andMode.checked = !!settings.keywordsAndMode;
        els.include.value = settings.includeKeywords || '';
        els.exclude.value = settings.excludeKeywords || '';
        renderJobsSelect();
      }

      function collectToSettings() {
        const s = mergeDeep(DEFAULT_SETTINGS, settings);
        s.enableOutreach = !!els.enableOutreach.checked;
        s.allowOutreachWithoutAI = !!els.allowNoAi.checked;
        s.selectedJobKey = String(els.jobSelect.value || '');
        s.positionName = String(els.positionName.value || '').trim();
        s.maxPerRun = clampInt(els.maxPerRun.value, 1, 500, 30);
        s.delayMinMs = clampInt(els.delayMinMs.value, 0, 60000, 1200);
        s.delayMaxMs = clampInt(els.delayMaxMs.value, 0, 60000, 2600);
        if (s.delayMaxMs < s.delayMinMs) s.delayMaxMs = s.delayMinMs;
        s.jdText = String(els.jdText.value || '');
        s.keywordsAndMode = !!els.andMode.checked;
        s.includeKeywords = String(els.include.value || '');
        s.excludeKeywords = String(els.exclude.value || '');
        return s;
      }

      let saveTimer = null;
      function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          settings = collectToSettings();
          await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
          try { dispatchToOutreachFrames('UPDATE_SETTINGS'); } catch {}
        }, 200);
      }

      function renderLogs(entries) {
        const last = Array.isArray(entries) ? entries.slice(-180) : [];
        const html = last.map((e) => {
          const ts = new Date(e.ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
          const cls = e.level === 'success' ? 'success' : e.level === 'warn' ? 'warn' : '';
          return `<div class="line ${cls}"><span class="ts">[${ts}]</span>${escapeHtml(e.message || '')}</div>`;
        }).join('');
        els.logBox.innerHTML = html || '<div class="muted">暂无日志</div>';
        els.logBox.scrollTop = els.logBox.scrollHeight;
      }

      // events
      els.mini.addEventListener('click', () => setMinimized(!state.minimized));
      // 关闭/最小化按钮在拖拽标题栏里，必须阻止拖拽捕获吞掉点击
      for (const b of [els.close, els.mini]) {
        b?.addEventListener('pointerdown', (e) => { try { e.stopPropagation(); } catch {} }, { capture: true });
      }
      els.close.addEventListener('click', async () => {
        try { await setPanelHidden(true); } catch {}
        // 强制清理：避免某些情况下（渲染/观察器/页面重绘）被重新插回
        try { forceRemovePanels(12000); } catch {}
        try { host.remove(); } catch {}
      });

      [
        els.enableOutreach, els.allowNoAi, els.jobSelect, els.positionName,
        els.maxPerRun, els.delayMinMs, els.delayMaxMs, els.jdText,
        els.andMode, els.include, els.exclude,
      ].forEach((el) => {
        el.addEventListener('input', scheduleSave);
        el.addEventListener('change', scheduleSave);
      });

      els.jobSelect.addEventListener('change', async () => {
        // 切岗位：回填 JD
        const key = String(els.jobSelect.value || '');
        const job = state.jobs.find((j) => j.key === key);
        if (job) {
          if (job.name) els.positionName.value = job.name;
          els.jdText.value = String(job.jdText || '');
        } else {
          els.jdText.value = '';
        }
        scheduleSave();

        // 若 JD 为空：自动同步
        if (key && (!job || !String(job.jdText || '').trim())) {
          try {
            logInfo('面板：正在同步 JD...');
            const jd = await syncJobJdToCache(key);
            els.jdText.value = jd || '';
            scheduleSave();
            logSuccess('面板：JD 同步成功');
          } catch (e) {
            logWarn(`面板：JD 同步失败：${e?.message || String(e)}`);
          }
        }
      });

      els.start.addEventListener('click', async () => {
        settings = collectToSettings();
        await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
        startRun().catch((e) => logWarn(`开始失败：${e?.message || String(e)}`));
      });
      els.stop.addEventListener('click', async () => {
        stopRun();
        try { dispatchToOutreachFrames('STOP'); } catch {}
      });
      els.clear.addEventListener('click', async () => {
        await chrome.storage.local.set({ [STORAGE_KEYS.logs]: [] });
      });

      setMinimized(false);

      // drag
      const hdr = shadow.querySelector('.hdr');
      hdr.addEventListener('pointerdown', (ev) => {
        // 点击在按钮上就不进入拖拽
        const t = ev.target;
        if (t && (t.id === 'btnClose' || t.id === 'btnMini' || t.closest?.('#btnClose,#btnMini'))) return;
        state.drag.dragging = true;
        state.drag.x = ev.clientX;
        state.drag.y = ev.clientY;
        const rect = host.getBoundingClientRect();
        state.drag.dx = rect.left;
        state.drag.dy = rect.top;
        hdr.setPointerCapture?.(ev.pointerId);
      });
      hdr.addEventListener('pointermove', (ev) => {
        if (!state.drag.dragging) return;
        const nx = state.drag.dx + (ev.clientX - state.drag.x);
        const ny = state.drag.dy + (ev.clientY - state.drag.y);
        host.style.left = `${Math.max(8, nx)}px`;
        host.style.top = `${Math.max(8, ny)}px`;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      });
      hdr.addEventListener('pointerup', () => { state.drag.dragging = false; });

      // storage bindings
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[STORAGE_KEYS.settings]) {
          settings = normalizeSettingsWithPromptMigration(changes[STORAGE_KEYS.settings].newValue || {});
          renderFromSettings();
        }
        if (changes[STORAGE_KEYS.jobKeywordOverrides]) {
          const v = changes[STORAGE_KEYS.jobKeywordOverrides].newValue;
          jobKeywordOverrides = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        }
        if (changes[STORAGE_KEYS.jobs]) {
          state.jobs = Array.isArray(changes[STORAGE_KEYS.jobs].newValue) ? changes[STORAGE_KEYS.jobs].newValue : [];
          renderJobsSelect();
        }
        if (changes[STORAGE_KEYS.logs]) {
          state.logs = Array.isArray(changes[STORAGE_KEYS.logs].newValue) ? changes[STORAGE_KEYS.logs].newValue : [];
          renderLogs(state.logs);
        }
        if (changes[STORAGE_KEYS.runState]) {
          renderRunState(changes[STORAGE_KEYS.runState].newValue);
        }
      });

      // initial load
      chrome.storage.local.get([STORAGE_KEYS.jobs, STORAGE_KEYS.logs, STORAGE_KEYS.runState]).then((r) => {
        state.jobs = Array.isArray(r?.[STORAGE_KEYS.jobs]) ? r[STORAGE_KEYS.jobs] : [];
        state.logs = Array.isArray(r?.[STORAGE_KEYS.logs]) ? r[STORAGE_KEYS.logs] : [];
        renderFromSettings();
        renderLogs(state.logs);
        renderRunState(r?.[STORAGE_KEYS.runState] || { running: false, stopping: false });
      }).catch(() => {
        renderFromSettings();
      });

      // keep alive: if page rerender removes host, re-append
      const mo = new MutationObserver(async () => {
        try {
          const hidden = await isPanelHidden().catch(() => false);
          if (hidden) return;
          if (!document.documentElement.contains(host)) {
            try { document.documentElement.appendChild(host); } catch {}
          }
        } catch {}
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      // ignore
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str || '');
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str || '').replace(/"/g, '&quot;');
  }

  function normalizeForMatch(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[（(].*?[)）]/g, '') // 去掉括号里的编号/补充，提升命中率
      .trim()
      .toLowerCase();
  }

  function normalizeForMatchLoose(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .trim()
      .toLowerCase();
  }

  function extractMjCode(s) {
    const m = String(s || '').match(/\b(MJ\d{6,})\b/i);
    return m ? m[1].toUpperCase() : '';
  }

  async function ensureRecommendJobSelected(override) {
    // 只允许在“推荐牛人”路由/推荐牛人 iframe 中切岗，避免在职位管理等页面误判“切岗成功”
    const pv = String(document.body?.getAttribute?.('data-pv') || '');
    const path = String(location.pathname || '');
    const hasRecommendDomStrong = () => {
      const list = queryAnyRecommendDoc('#recommend-list');
      if (!list) return false;
      const hasCards = !!queryAnyRecommendDoc('#recommend-list .candidate-card-wrap') || !!queryAnyRecommendDoc('.recommend-wrap .candidate-card-wrap');
      const hasJobSel = !!queryAnyRecommendDoc('.job-selecter-wrap .ui-dropmenu-label');
      return !!hasCards && !!hasJobSel;
    };
    const isRecommendCtx =
      path.includes('/web/chat/recommend')
      || pv.includes('/web/chat/recommend')
      || !!queryAnyRecommendDoc('iframe[name="recommendFrame"], iframe[src*="/web/frame/recommend-v2/"]')
      || hasRecommendDomStrong();
    if (!isRecommendCtx) return false;

    const label = queryAnyRecommendDoc('.job-selecter-wrap .ui-dropmenu-label');
    if (!label) return false;

    await loadJobsCache().catch(() => {});
    // 1.1.x：override 用于"按历史记录里的岗位临时切换"场景（不修改用户当前选中岗位的设置）
    let selectedKey, selectedJob, desiredEncryptJobId, desiredName;
    if (override && (override.jobKey || override.jobName || override.encryptJobId)) {
      selectedKey = String(override.jobKey || '').trim();
      selectedJob = selectedKey ? jobsCache.get(selectedKey) : null;
      desiredEncryptJobId = String(override.encryptJobId || '').trim()
        || selectedJob?.encryptJobId
        || (selectedKey.startsWith('encryptJobId:') ? selectedKey.slice('encryptJobId:'.length) : null);
      desiredName = String(override.jobName || selectedJob?.name || '').trim();
    } else {
      selectedKey = String(settings.selectedJobKey || '').trim();
      selectedJob = selectedKey ? jobsCache.get(selectedKey) : null;
      desiredEncryptJobId = selectedJob?.encryptJobId || (selectedKey.startsWith('encryptJobId:') ? selectedKey.slice('encryptJobId:'.length) : null);
      desiredName = String(settings.positionName || selectedJob?.name || '').trim();
    }
    if (!desiredName && !desiredEncryptJobId) return false;

    const cur = normalizeForMatch(label.textContent || '');
    const curLoose = normalizeForMatchLoose(label.textContent || '');
    const curMj = extractMjCode(label.textContent || '');
    const want = normalizeForMatch(desiredName);
    const wantLoose = normalizeForMatchLoose(desiredName);
    const wantMj = extractMjCode(desiredName);
    const wantScore = want || normalizeForMatch(wantLoose);
    if ((cur && want && cur.includes(want)) || (curLoose && wantLoose && curLoose.includes(wantLoose)) || (wantMj && curMj && wantMj === curMj)) return true;
    if (!want && desiredEncryptJobId) {
      // 没有 name 的情况下不做“已切换”判定，继续走精确 value 点击
    } else {
      logInfo(`推荐牛人：准备切换岗位（当前="${String(label.textContent || '').trim().slice(0, 50)}" 目标="${desiredName}"）`);
    }

    // 打开下拉菜单（推荐牛人：job-selecter-wrap）
    const opener = label.closest?.('.job-selecter-wrap')?.querySelector?.('.ui-dropmenu-label') || label;
    simulateClick(opener);
    await waitFor(() => queryAnyRecommendDoc('.job-selecter-wrap .ui-dropmenu-list') || queryAnyRecommendDoc('.ui-dropmenu-list'), 3000).catch(() => {});
    await sleep(150);

    // 如果有搜索框，先过滤一下（避免列表太大找不到）
    const searchAny = queryAnyRecommendDoc('input.chat-job-search') || queryAnyRecommendDoc('.job-selecter-wrap .ui-dropmenu-search input') || queryAnyRecommendDoc('.ui-dropmenu-search input');
    if (searchAny && (desiredName || wantMj)) {
      await simulateInput(searchAny, desiredName || wantMj).catch(() => {});
      await sleep(250);
    }

    const pickOption = () => {
      // 你给的结构：.job-selecter-wrap.expanding .ui-dropmenu-list ul.job-list > li.job-item[value] > span.label
      const root =
        queryAnyRecommendDoc('.job-selecter-wrap .ui-dropmenu-list')
        || queryAnyRecommendDoc('.ui-dropmenu-list');
      if (!root) return null;

      // 0) 最稳：按 value=encryptJobId 精准点选（你给的 li.job-item[value]）
      if (desiredEncryptJobId) {
        const exact = root.querySelector?.(`li.job-item[value="${cssEscape(desiredEncryptJobId)}"]`) || null;
        if (exact) return exact.querySelector?.('span.label') || exact;
      }

      const items = Array.from(root.querySelectorAll('li.job-item[value], li.job-item, [class*="job-item"]'))
        .filter(isVisible)
        .map((li) => {
          const text = String(li.querySelector?.('.label')?.textContent || li.textContent || '').trim();
          return { el: li, text };
        })
        .filter((x) => {
          if (!x.text) return false;
          const t = x.text;
          const tn = normalizeForMatch(t);
          const tl = normalizeForMatchLoose(t);
          const tmj = extractMjCode(t);
          if (wantMj && tmj && tmj === wantMj) return true;
          if (want && tn.includes(want)) return true;
          if (wantLoose && tl.includes(wantLoose)) return true;
          return false;
        });

      if (items.length === 0) return null;
      items.sort((a, b) => scoreJobOption(b.el, b.text, wantScore) - scoreJobOption(a.el, a.text, wantScore));
      // 更稳：点 span.label（避免 li 上有别的点击拦截）
      return items[0]?.el?.querySelector?.('span.label') || items[0]?.el || null;
    };

    const option = await waitFor(() => pickOption(), 8000);
    if (!option) {
      logWarn(`推荐牛人：岗位切换失败（未找到下拉项：${desiredName || desiredEncryptJobId || ''}）`);
      return false;
    }

    simulateClick(option);
    const ok = await waitFor(() => {
      const lab = queryAnyRecommendDoc('.job-selecter-wrap .ui-dropmenu-label') || queryAnyRecommendDoc('.ui-dropmenu-label');
      if (want && normalizeForMatch(lab?.textContent || '').includes(want)) return true;
      if (wantLoose && normalizeForMatchLoose(lab?.textContent || '').includes(wantLoose)) return true;
      if (wantMj && extractMjCode(lab?.textContent || '') === wantMj) return true;
      // 也允许用 curr[value] 校验
      if (desiredEncryptJobId) {
        const root = queryAnyRecommendDoc('.job-selecter-wrap .ui-dropmenu-list') || queryAnyRecommendDoc('.ui-dropmenu-list');
        const curr = root?.querySelector?.('li.job-item.curr[value]') || root?.querySelector?.('li.job-item.curr');
        const v = curr?.getAttribute?.('value') || '';
        if (v && String(v) === String(desiredEncryptJobId)) return true;
      }
      return null;
    }, 12000);
    if (ok) {
      logInfo(`推荐牛人：已切换岗位为「${desiredName || desiredEncryptJobId}」`);
      return true;
    }
    logWarn(`推荐牛人：已点击岗位但未确认切换（目标：${desiredName || desiredEncryptJobId}）`);
    return false;
  }

  function scoreJobOption(el, text, want) {
    let score = 0;
    const t = normalizeForMatch(text);
    if (t === want) score += 50;
    if (t.includes(want)) score += 25;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'LI') score += 8;
    if (tag === 'A' || tag === 'BUTTON') score += 6;
    if (String(el.className || '').includes('ui-drop')) score += 6;
    // 越短越像“岗位标题行”
    score += Math.max(0, 20 - Math.min(20, String(text || '').length / 3));
    // 排除很长的容器文本
    if (String(text || '').length > 120) score -= 10;
    return score;
  }

  function getManualReviewSourceLabel(source) {
    return String(source || '') === 'reply_to_outreach' ? '回复我的招呼' : '候选人主动招呼';
  }

  async function addManualReviewSummary(item = {}) {
    const source = String(item.source || '').trim();
    const candidateKey = String(item.candidateKey || '').trim();
    const candidateName = String(item.candidateName || '').trim();
    const action = String(item.action || 'manual_review').trim() || 'manual_review';
    const positionName = String(item.positionName || '').trim();
    const entryId = `${candidateKey || candidateName || 'unknown'}::${action}`;
    await upsertManualReviewQueueItem({
      id: entryId,
      candidateKey,
      candidateName,
      positionName,
      source,
      sourceLabel: String(item.sourceLabel || getManualReviewSourceLabel(source)).trim(),
      action,
      actionLabel: String(item.actionLabel || '待人工处理').trim(),
      tagClass: String(item.tagClass || 'info').trim() || 'info',
      reason: String(item.reason || '').trim(),
      draftText: String(item.draftText || '').trim(),
      lastInboundText: String(item.lastInboundText || '').trim(),
      lastMeText: String(item.lastMeText || '').trim(),
      materials: String(item.materials || '').trim(),
      ts: Number(item.ts || Date.now()) || Date.now(),
    });
  }

  function isSummaryOnlyAutoReplyMode() {
    return false;
  }

  async function processCurrentConversationForSummaryOnly(replied, seenNamesThisRun = new Set()) {
    const selected = getSelectedThreadItem();
    const globalChatList =
      queryAnyDoc('.chat-message-list')
      || queryAnyDoc('[class*="chat-message-list"]');
    const headerName = String(getCurrentConversationHeaderName() || '').trim();
    const threadName = String(getThreadName(selected) || '').trim();
    const currentJobNameFallback = String(getCurrentReplyJobName() || getCurrentConversationPositionName() || '').trim();
    if (!globalChatList) {
      logWarn('自动回复：本地汇总模式未检测到右侧聊天记录，请先手动打开一个候选人会话');
      return false;
    }
    const lastMsg = await waitFor(() => {
      const msg = getLastChatMessageMetaFromChatList(globalChatList);
      if (!msg?.text) return null;
      return msg;
    }, 1500).catch(() => getLastChatMessageMetaFromChatList(globalChatList));
    const lastText = String(lastMsg?.text || '').trim();
    const lastDir = String(lastMsg?.direction || '');
    if (!lastText || lastDir !== 'other') {
      logWarn('自动回复：本地汇总模式未识别到候选人最新消息，请先手动打开一个真实会话');
      return false;
    }

    const name = String(headerName || threadName || '').trim() || '当前会话';
    const key =
      String(getThreadKey(selected) || '').trim()
      || `summary:${hashText(`${currentJobNameFallback || 'unknown'}::${lastText.slice(0, 200)}`)}`;
    if (!name && !currentJobNameFallback) {
      logWarn('自动回复：本地汇总模式未识别到当前会话信息，请先手动打开一个候选人会话');
      return false;
    }

    const jobCtx = await resolveJobContextForCurrentConversation().catch(() => null);
    const currentJobName = String(jobCtx?.positionName || currentJobNameFallback || '').trim();

    const prev = replied[key] || null;
    const inboundHash = String(lastMsg?.inboundHash || '');
    if (String(prev?.lastInboundHash || '') && String(prev?.lastInboundHash || '') === inboundHash && prev?.summaryQueued) {
      logInfo(`自动回复：当前会话最新消息已在本地汇总中，无需重复记录（${name || key}）`);
      return true;
    }

    const convoFlow = getCurrentConversationFlowMeta();
    logInfo(`自动回复：${name || key} 会话来源=${convoFlow.label}`);
    const convoCtx = getCurrentConversationContextSummary();
    const intentContext = getConversationIntentContext();
    const contextSkipReason = getAutoReplyContextSkipReason(convoFlow, convoCtx, intentContext);
    if (contextSkipReason) {
      await addManualReviewSummary({
        candidateKey: key,
        candidateName: name || key,
        positionName: currentJobName,
        source: convoFlow.source,
        action: 'context_skip',
        actionLabel: '无需重复处理',
        tagClass: 'info',
        reason: contextSkipReason,
        lastInboundText: lastText,
        lastMeText: String(intentContext?.lastMeTextBeforeLastInbound || '').trim(),
      });
      replied[key] = {
        ...(prev || {}),
        ts: Date.now(),
        skipped: true,
        source: convoFlow.source,
        summaryQueued: true,
        lastInboundHash: inboundHash,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
      if (name) seenNamesThisRun.add(name);
      logInfo(`自动回复：已写入本地汇总（${name || key}；${contextSkipReason}）`);
      return true;
    }

    const intent = await classifyCandidateReplyIntent(lastText, currentJobName, intentContext);
    logInfo(`自动回复：${name || key} 消息判断为「${intent.label}」${intent.reason ? `（${intent.reason}）` : ''}`);
    const commonSummaryBase = {
      candidateKey: key,
      candidateName: name || key,
      positionName: currentJobName,
      source: convoFlow.source,
      lastInboundText: lastText,
      lastMeText: String(intentContext?.lastMeTextBeforeLastInbound || '').trim(),
    };

    if (intent.intent === 'reject') {
      const replyPreview = buildAutoReplyPreviewByDirection('candidateReject', {
        name,
        position: currentJobName,
        reason: intent.reason || '对方明确拒绝当前岗位',
      });
      await addManualReviewSummary({
        ...commonSummaryBase,
        action: 'candidate_reject',
        actionLabel: '对方已拒绝',
        tagClass: 'info',
        reason: intent.reason || '对方明确拒绝当前岗位',
        draftText: String(replyPreview.preview || '').trim(),
      });
      replied[key] = {
        ...(prev || {}),
        ts: Date.now(),
        candidateDeclined: true,
        replyIntent: 'reject',
        summaryQueued: true,
        lastInboundHash: inboundHash,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
      if (name) seenNamesThisRun.add(name);
      logSuccess(`自动回复：已写入本地汇总（${name || key}；对方已拒绝）`);
      return true;
    }

    if (String(convoFlow?.source || '') === 'reply_to_outreach') {
      if (intent.intent === 'neutral') {
        await addManualReviewSummary({
          ...commonSummaryBase,
          action: 'manual_review',
          actionLabel: '待人工判断',
          tagClass: 'neutral',
          reason: intent.reason || '中性回复，建议人工查看上下文后处理',
        });
        replied[key] = {
          ...(prev || {}),
          ts: Date.now(),
          skipped: true,
          replyIntent: 'neutral',
          source: convoFlow.source,
          pendingManualReview: true,
          summaryQueued: true,
          lastInboundHash: inboundHash,
        };
        await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
        if (name) seenNamesThisRun.add(name);
        logInfo(`自动回复：已写入本地汇总（${name || key}；待人工判断）`);
        return true;
      }

      const materialsReq = await decideReplyMaterialsForJob(currentJobName, jobCtx?.jdText || '').catch(() => ({
        type: 'resume_only',
        label: '简历',
        reason: '默认按简历处理',
      }));
      const preview = buildAutoReplyPreviewByDirection('pass', {
        name,
        position: currentJobName,
        reason: intent.reason || '对方回复有意向',
        materialsType: String(materialsReq?.type || 'resume_only'),
        materials: String(materialsReq?.label || '简历').trim(),
        materialsHint: buildMaterialsHintText(materialsReq, { short: true }),
      });
      await addManualReviewSummary({
        ...commonSummaryBase,
        action: 'pass_followup',
        actionLabel: '待手动推进',
        tagClass: 'pass',
        reason: `${intent.reason || '对方回复有意向'}${materialsReq?.reason ? `；${materialsReq.reason}` : ''}`,
        draftText: String(preview.preview || '').trim(),
        materials: String(materialsReq?.label || '简历').trim(),
      });
      replied[key] = {
        ...(prev || {}),
        ts: Date.now(),
        replyIntent: intent.intent,
        source: convoFlow.source,
        summaryQueued: true,
        lastInboundHash: inboundHash,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
      if (name) seenNamesThisRun.add(name);
      logSuccess(`自动回复：已写入本地汇总（${name || key}；待手动推进）`);
      return true;
    }

    if (intent.intent === 'neutral') {
      await addManualReviewSummary({
        ...commonSummaryBase,
        action: 'manual_review',
        actionLabel: '待人工判断',
        tagClass: 'neutral',
        reason: intent.reason || '候选人表达不够明确，建议人工查看上下文后处理',
      });
      replied[key] = {
        ...(prev || {}),
        ts: Date.now(),
        skipped: true,
        replyIntent: 'neutral',
        source: convoFlow.source,
        pendingManualReview: true,
        summaryQueued: true,
        lastInboundHash: inboundHash,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
      if (name) seenNamesThisRun.add(name);
      logInfo(`自动回复：已写入本地汇总（${name || key}；待人工判断）`);
      return true;
    }

    let passed = true;
    let reason = '';
    let score = null;
    let threshold = null;
    let needManualResumeConfirm = false;
    const quickResumeCardText = getChatResumeCardText();
    const quickPrefilterText = [quickResumeCardText, getReplyConversationPrefilterText()]
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .join('\n');
    const quickHardFilter = screenReplySummaryAgainstFilters(quickPrefilterText, jobCtx);
    if (!quickHardFilter.pass) {
      passed = false;
      reason = String(quickHardFilter.why || '聊天摘要硬过滤不通过');
    }
    if (passed && quickResumeCardText) {
      const quick = await quickScreenChatResumeCardAgainstJd(quickResumeCardText, jobCtx).catch(() => ({ skip: false, reason: '' }));
      if (quick?.skip) {
        passed = false;
        reason = String(quick.reason || '聊天简历卡预判不匹配');
      } else if (!queryAnyDoc('.resume-detail.resume-detail-chat,.resume-detail')) {
        needManualResumeConfirm = true;
        reason = '本地汇总模式未自动打开完整简历，请人工确认最终匹配结果';
      }
    } else if (passed) {
      needManualResumeConfirm = true;
      reason = '本地汇总模式未读取到聊天简历摘要，请人工打开完整简历后确认';
    }
    if (passed && queryAnyDoc('.resume-detail.resume-detail-chat,.resume-detail')) {
      const visibleResumeText = await extractResumeText().catch(() => '');
      if (visibleResumeText) {
        const result = await screenResumeAgainstJdForReply(String(visibleResumeText || ''), jobCtx).catch(() => ({ pass: false, why: '读取完整简历筛选失败' }));
        passed = !!result.pass;
        reason = String(result.why || reason || '');
        score = Number.isFinite(Number(result.score)) ? Number(result.score) : null;
        threshold = Number.isFinite(Number(result.threshold)) ? Number(result.threshold) : null;
      }
    }

    if (!passed) {
      const preview = buildAutoReplyPreviewByDirection('ourReject', {
        name,
        position: currentJobName,
        reason,
      });
      await addManualReviewSummary({
        ...commonSummaryBase,
        action: 'our_reject',
        actionLabel: '待手动婉拒',
        tagClass: 'reject',
        reason,
        draftText: String(preview.preview || '').trim(),
      });
      replied[key] = {
        ...(prev || {}),
        ts: Date.now(),
        notFit: true,
        skipped: true,
        source: convoFlow.source,
        summaryQueued: true,
        lastInboundHash: inboundHash,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
      if (name) seenNamesThisRun.add(name);
      logInfo(`自动回复：已写入本地汇总（${name || key}；待手动婉拒）`);
      return true;
    }

    const materialsReq = await decideReplyMaterialsForJob(currentJobName, jobCtx?.jdText || '').catch(() => ({
      type: 'resume_only',
      label: '简历',
      reason: '默认按简历处理',
    }));
    const preview = buildAutoReplyPreviewByDirection('pass', {
      name,
      position: currentJobName,
      reason,
      materialsType: String(materialsReq?.type || 'resume_only'),
      materials: String(materialsReq?.label || '简历').trim(),
      materialsHint: buildMaterialsHintText(materialsReq, { short: true }),
    });
    const reasonText = [
      needManualResumeConfirm ? reason : '',
      score != null ? `匹配评分=${score}${threshold != null ? ` / 通过线=${threshold}` : ''}` : '',
      materialsReq?.reason || '',
    ].filter(Boolean).join('；');
    await addManualReviewSummary({
      ...commonSummaryBase,
      action: 'pass_followup',
      actionLabel: '待手动推进',
      tagClass: 'pass',
      reason: reasonText || '岗位与候选人背景匹配，建议继续推进',
      draftText: String(preview.preview || '').trim(),
      materials: String(materialsReq?.label || '简历').trim(),
    });
    replied[key] = {
      ...(prev || {}),
      ts: Date.now(),
      source: convoFlow.source,
      summaryQueued: true,
      lastInboundHash: inboundHash,
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
    if (name) seenNamesThisRun.add(name);
    logSuccess(`自动回复：已写入本地汇总（${name || key}；待手动推进）`);
    return true;
  }

  /**
   * 1.1.x：往 replyRunResults storage 追加一条自动回复处理记录
   *   字段对齐 buildCandidateCardDiv 能识别的 schema，让 popup 直接渲染卡片
   *   @param {Object} info  { name, jobName, decision, decisionLabel, reason, draftPrepared, sent, source }
   */
  async function recordReplyRunResult(info = {}) {
    try {
      const r = await chrome.storage.local.get([STORAGE_KEYS.replyRunResults]);
      const arr = Array.isArray(r?.[STORAGE_KEYS.replyRunResults]) ? r[STORAGE_KEYS.replyRunResults] : [];
      const cand = {
        name: String(info.name || '').trim(),
        // 沟通页线程没有 encryptGeekId / geekId，存 candidateKey 当 id 兜底
        id: String(info.candidateKey || info.threadKey || info.name || '').trim(),
        type: 'replyThread',
      };
      const tag = info.decisionLabel || (info.sent ? '已发送' : (info.draftPrepared ? '草稿已填' : '已跳过'));
      const decision = (info.decision === true || info.decision === false) ? info.decision : (info.sent || info.draftPrepared ? true : false);
      const newRec = {
        ts: Date.now(),
        jobKey: '',
        jobName: String(info.jobName || '').trim(),
        candidate: cand,
        stage1: { decision: true, score: 0, reason: '自动回复' },
        stage2: {
          decision,
          score: 0,
          reason: String(info.reason || '').trim(),
        },
        source: 'reply',                 // 1.1.x：popup 端识别这是自动回复来源
        replyTag: tag,                    // 显示在卡片上的小标签：已发送 / 草稿已填 / 已跳过
        draftPrepared: !!info.draftPrepared,
        sent: !!info.sent,
        threadKey: String(info.threadKey || info.candidateKey || ''),
      };
      arr.push(newRec);
      // 只留最近 200 条
      const trimmed = arr.length > 200 ? arr.slice(arr.length - 200) : arr;
      await chrome.storage.local.set({ [STORAGE_KEYS.replyRunResults]: trimmed });
    } catch {}
  }

  async function runAutoReplyLoop() {
    const loopToken = ++autoReplyLoopToken;
    logInfo('自动回复：启动');
    const replied = await getObjectMap(STORAGE_KEYS.repliedThreads);
    const seenNamesThisRun = new Set();
    let lastScanLogTs = 0;
    let lastScanCount = -1;
    let threadListWarmed = false;
    const scopedAutoReplyJobKey = String(settings.autoReplyJobKey || '').trim();
    const tempSkipMs = 5 * 60 * 1000;
    const markReplyThreadTempSkip = async (key, patch = {}) => {
      replied[key] = {
        ...(replied[key] || {}),
        ts: Date.now(),
        skipped: true,
        tempSkipUntil: Date.now() + tempSkipMs,
        ...patch,
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
    };

    // 1) 沟通页顶部岗位筛选切到“全部职位”，避免多岗位未读会话被漏掉
    try {
      const switched = await ensureChatJobScopeForAutoReply();
      if (!switched) logWarn('自动回复：未能切换沟通页岗位筛选到“全部职位”（将按当前页面继续）');
      await sleep(280);
    } catch {}

    // 1.5) 顶部会话分组切到“全部”，避免停留在其他分组导致未读列表不完整
    try {
      const allTab = await ensureChatAllLabelForAutoReply();
      if (!allTab) logWarn('自动回复：未能切换顶部会话分组到“全部”（将按当前分组继续）');
      await sleep(180);
    } catch {}

    // 2) 消息列表切到“未读”，直接在全部里处理未读会话
    try {
      const unread = await ensureChatUnreadFilterForAutoReply();
      if (!unread) logWarn('自动回复：未能切换消息筛选到“未读”（将按当前列表继续）');
      await sleep(220);
    } catch {}

    try {
      const settled = await waitForThreadListSettle(3200);
      threadListWarmed = !!settled;
      if (!settled) logWarn('自动回复：未读列表首条仍在刷新，将边跑边重试');
    } catch {}

    while (running && !stopping && autoReplyLoopToken === loopToken) {
      if (await stopIfVerificationNeeded('自动回复轮询')) break;
      const items = findThreadsForAutoReply();
      const nowTs = Date.now();
      const coolingItems = items.filter((item) => {
        try {
          const key = getThreadKey(item);
          const prev = replied[key] || null;
          return Number(prev?.tempSkipUntil || 0) > nowTs;
        } catch {
          return false;
        }
      });
      const actionableItems = items.filter((item) => {
        try {
          const key = getThreadKey(item);
          const name = getThreadName(item) || '';
          if (name && seenNamesThisRun.has(name)) return false;
          const prev = replied[key] || null;
          if (Number(prev?.tempSkipUntil || 0) > nowTs) return false;
          if (prev?.askedResume || prev?.requestedPortfolio || prev?.notFit || prev?.candidateDeclined) return false;
          return true;
        } catch {
          return true;
        }
      });
      // 轻量心跳：避免用户误以为“没工作”
      {
        const now = Date.now();
        const shouldLog = (actionableItems.length !== lastScanCount) || (now - lastScanLogTs > 20000);
        if (shouldLog) {
          lastScanLogTs = now;
          lastScanCount = actionableItems.length;
          if (actionableItems.length === 0) {
            if (scopedAutoReplyJobKey) {
              logInfo('自动回复：当前岗位页面已处理完毕');
            } else {
              logInfo('自动回复：当前列表未读均已处理，继续等待...');
            }
          }
          else logInfo(`自动回复：发现 ${actionableItems.length} 个未读候选人，开始处理...`);
        }
      }
      if (actionableItems.length === 0 && scopedAutoReplyJobKey) {
        if (coolingItems.length) {
          await sleep(3500);
          continue;
        }
        running = false;
        break;
      }
      if (actionableItems.length === 0) {
        if (coolingItems.length) {
          await sleep(3500);
          continue;
        }
        await sleep(3500);
        continue;
      }
      let shouldRescanAfterItem = false;
      for (const item of actionableItems) {
        if (!running || stopping || autoReplyLoopToken !== loopToken) break;
        await loadSettings().catch(() => {});

        // 1.1.x：每次切到下一个会话之前，先把上一个候选人的简历面板关掉
        // 避免 boss 沟通页面切到新候选人后直接弹出新人的简历，挡住对话框
        try { await closeResumePanelIfPossible(); } catch {}
        try { await closeResumePanelIfAny(); } catch {}

        const key = getThreadKey(item);
        const name = getThreadName(item) || '';
        if (name && seenNamesThisRun.has(name)) {
          await jitterDelay();
          continue;
        }
        // 新招呼逻辑：不判断“最后一条是谁发的”
        // 口径：新招呼列表下默认都是“对方发起招呼且我未回复”，因此只做简历vsJD匹配，匹配就求简历，不匹配就不合适。

        // 已处理过的线程：直接跳过（避免反复点开）
        const prev = replied[key] || null;
        if (prev?.askedResume || prev?.requestedPortfolio || prev?.notFit || prev?.candidateDeclined) {
          if (!isLowRiskMode() && (prev?.askedResume || prev?.requestedPortfolio)) {
            const agreedExistingAttachment = await clickAttachmentResumeAgreeBestEffort().catch(() => false);
            if (agreedExistingAttachment) {
              logInfo(`自动回复：已点击附件简历“同意”按钮（${name || key}）`);
              replied[key] = {
                ...(replied[key] || {}),
                attachmentAccepted: true,
                attachmentAcceptedAt: Date.now(),
              };
              await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
              if (name) seenNamesThisRun.add(name);
              await sleep(180);
            }
          }
          await jitterDelay();
          continue;
        }

        const beforeSwitchMessage = getLastChatMessageMeta();
        const beforeConversation = {
          headerName: getCurrentConversationHeaderName(),
          positionName: getCurrentConversationPositionName(),
        };
        // 等待“当前会话真的切到这位候选人”后再继续，避免把动作打到上一位身上
        let readyState = await tryOpenThreadConversation(item, {
          targetName: name,
          targetKey: key,
          beforeMessage: beforeSwitchMessage,
          beforeConversation,
        });
        if (!readyState && !threadListWarmed) {
          await humanPause(380, 860);
          await waitForThreadListSettle(2600).catch(() => null);
          threadListWarmed = true;
          const warmedItem = findThreadsForAutoReply({ maxItems: 80 }).find((el) => {
            try {
              if (getThreadKey(el) === key) return true;
              return !!(name && getThreadName(el) === name);
            } catch {
              return false;
            }
          }) || null;
          if (warmedItem) {
            readyState = await tryOpenThreadConversation(warmedItem, {
              targetName: name,
              targetKey: key,
              beforeMessage: beforeSwitchMessage,
              beforeConversation,
            });
          }
        }
        if (!readyState) {
          const latestItem = findThreadsForAutoReply({ maxItems: 80 }).find((el) => {
            try {
              if (getThreadKey(el) === key) return true;
              return !!(name && getThreadName(el) === name);
            } catch {
              return false;
            }
          }) || null;
          if (latestItem) {
            readyState = await tryOpenThreadConversation(latestItem, {
              targetName: name,
              targetKey: key,
              beforeMessage: beforeSwitchMessage,
              beforeConversation,
            });
          }
        }
        if (!readyState) {
          await markReplyThreadTempSkip(key, {
            tempSkipReason: '点开会话后未确认切到当前候选人会话',
            tempSkipStep: 'open-thread',
          });
          logWarn(`自动回复跳过：点开会话后未确认切到当前候选人会话（${name || key}）`);
          await jitterDelay();
          shouldRescanAfterItem = true;
          break;
        }
        if (!readyState.composerReady) {
          logInfo(`自动回复：当前会话未检测到输入区，将继续做岗位匹配/简历判断（${name || key}）`);
        }
        await sleep(220);

        const jobCtx = await resolveJobContextForCurrentConversation().catch(() => null);
        const currentJobName = String(jobCtx?.positionName || getCurrentReplyJobName() || '').trim();
        const lastMsg = await waitFor(() => {
          const msg = getLastChatMessageMeta();
          if (!msg?.text) return null;
          return msg;
        }, 2500).catch(() => getLastChatMessageMeta());
        const lastText = String(lastMsg?.text || '').trim();
        const lastDir = String(lastMsg?.direction || '');
        if (!lastText || lastDir !== 'other') {
          await markReplyThreadTempSkip(key, {
            tempSkipReason: '未识别到候选人最新消息',
            tempSkipStep: 'read-last-message',
          });
          logWarn(`自动回复跳过：未识别到候选人最新消息（${name || key}；${debugChatMessageState()}）`);
          await jitterDelay();
          shouldRescanAfterItem = true;
          break;
        }
        if (prev?.skipped && String(prev?.lastInboundHash || '') && String(prev.lastInboundHash) === String(lastMsg?.inboundHash || '')) {
          await jitterDelay();
          continue;
        }

        const convoFlow = getCurrentConversationFlowMeta();
        logInfo(`自动回复：${name || key} 会话来源=${convoFlow.label}`);

        const convoCtx = getCurrentConversationContextSummary();
        const intentContext = getConversationIntentContext();
        const contextSkipReason = getAutoReplyContextSkipReason(convoFlow, convoCtx, intentContext);
        if (contextSkipReason) {
          replied[key] = {
            ...(replied[key] || {}),
            ts: Date.now(),
            skipped: true,
            source: convoFlow.source,
            contextSkip: true,
            contextSkipReason,
            attachmentAccepted: !!replied[key]?.attachmentAccepted,
            lastInboundHash: String(lastMsg?.inboundHash || ''),
          };
          if (name) seenNamesThisRun.add(name);
          await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
          logInfo(`自动回复跳过：${contextSkipReason}（${name || key}）`);
          await jitterDelay();
          shouldRescanAfterItem = true;
          break;
        }

        const intent = await classifyCandidateReplyIntent(lastText, currentJobName, intentContext);
        logInfo(`自动回复：${name || key} 消息判断为「${intent.label}」${intent.reason ? `（${intent.reason}）` : ''}`);

        if (intent.intent === 'reject') {
          await loadSettings().catch(() => {});
          const replyResult = await sendAutoReplyByDirection('candidateReject', {
            name,
            position: currentJobName,
            reason: intent.reason || '对方明确拒绝当前岗位',
          }).catch(() => ({ sent: false, mode: 'template', preview: '' }));
          const sent = !!replyResult.sent;
          const draftPrepared = !!replyResult.draftPrepared;
          if (sent) {
            logSuccess(`已按“对方拒绝我们的回复”发送消息（${name || key}）`);
          } else if (draftPrepared) {
            logSuccess(`已生成“对方拒绝我们的回复”草稿（${name || key}；请人工发送）`);
          } else if (String(replyResult.mode || '') === 'none') {
            logInfo(`自动回复：已按“对方拒绝我们的回复”配置为不发送（${name || key}）`);
          } else {
            logWarn(`自动回复失败：${name || key}（未能发送“对方拒绝我们的回复”）`);
          }
          replied[key] = {
            ts: Date.now(),
            skipped: true,
            candidateDeclined: true,
            replyIntent: 'reject',
            replyText: String(replyResult.preview || ''),
            replySent: !!sent,
            replyDraftPrepared: !!draftPrepared,
            replyMode: String(replyResult.mode || ''),
            notFit: false,
            lastInboundHash: String(lastMsg?.inboundHash || ''),
          };
          if (name) seenNamesThisRun.add(name);
          await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
          // 1.1.x：写一条 replyRunResults 卡片记录
          recordReplyRunResult({
            name, candidateKey: key, threadKey: key,
            jobName: currentJobName,
            decision: false,
            decisionLabel: sent ? '已回复·候选人拒绝' : (draftPrepared ? '草稿已填·候选人拒绝' : '已跳过·候选人拒绝'),
            reason: intent.reason || '对方明确拒绝当前岗位',
            draftPrepared, sent,
          }).catch(() => {});
          await jitterDelay();
          shouldRescanAfterItem = true;
          break;
        }

        if (convoFlow.source === 'reply_to_outreach') {
          if (intent.intent === 'neutral') {
            logInfo(`自动回复跳过：中性回复待人工处理（${name || key}）`);
            await addManualReviewSummary({
              candidateKey: key,
              candidateName: name || key,
              positionName: currentJobName,
              source: convoFlow.source,
              action: 'manual_review',
              actionLabel: '待人工判断',
              tagClass: 'neutral',
              reason: intent.reason || '中性回复，建议人工查看上下文后处理',
              lastInboundText: lastText,
              lastMeText: String(intentContext?.lastMeTextBeforeLastInbound || '').trim(),
            });
            replied[key] = {
              ts: Date.now(),
              skipped: true,
              replyIntent: 'neutral',
              source: convoFlow.source,
              pendingManualReview: true,
              lastInboundHash: String(lastMsg?.inboundHash || ''),
            };
            if (name) seenNamesThisRun.add(name);
            await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
            await jitterDelay();
            shouldRescanAfterItem = true;
            break;
          }

          const materialsReq = await decideReplyMaterialsForJob(currentJobName, jobCtx?.jdText || '').catch(() => ({
            type: 'resume_only',
            label: '简历',
            reason: '默认按简历处理',
          }));
          logInfo(`自动回复：${name || key} 材料要求=${materialsReq.label}${materialsReq.reason ? `（${materialsReq.reason}）` : ''}`);

          await loadSettings().catch(() => {});
          const passReply = await sendAutoReplyByDirection('pass', {
            name,
            position: currentJobName,
            reason: intent.reason || '对方回复有意向',
            materialsType: String(materialsReq?.type || 'resume_only'),
            materials: String(materialsReq?.label || '简历').trim(),
            materialsHint: buildMaterialsHintText(materialsReq, { short: true }),
          }).catch(() => ({ sent: false, mode: 'template', preview: '' }));
          const phraseSent = !!passReply.sent;
          const draftPrepared = !!passReply.draftPrepared;
          replied[key] = {
            ts: Date.now(),
            askedResume: false,
            replyIntent: intent.intent,
            commonPhraseSent: !!phraseSent,
            materialsType: String(materialsReq?.type || 'resume_only'),
            materialsHintSent: false,
            requestedPortfolio: String(materialsReq?.type || '') === 'resume_and_portfolio',
            replyDraftPrepared: !!draftPrepared,
            source: convoFlow.source,
            lastInboundHash: String(lastMsg?.inboundHash || ''),
          };
          if (name) seenNamesThisRun.add(name);
          await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
          // 1.1.x：写一条 replyRunResults 卡片记录
          recordReplyRunResult({
            name, candidateKey: key, threadKey: key,
            jobName: currentJobName,
            decision: true,
            decisionLabel: phraseSent ? '已回复·通过' : (draftPrepared ? '草稿已填·通过' : '已跳过·通过'),
            reason: intent.reason || '对方回复有意向',
            draftPrepared, sent: phraseSent,
          }).catch(() => {});
          if (draftPrepared) {
            logSuccess(`已生成通过回复草稿（${name || key}；请人工发送）`);
          } else if (String(passReply.mode || '') === 'none') {
            logInfo(`自动回复：通过，但当前配置为不生成回复草稿（${name || key}）`);
          } else {
            logWarn(`自动回复失败：${name || key}（未能生成通过回复草稿${passReply.errorReason ? `：${passReply.errorReason}` : ''}）`);
          }
          await jitterDelay();
          shouldRescanAfterItem = true;
          break;
        }

        // 3) 候选人主动招呼：按 JD vs 简历筛选
        let passed = true;
        let reason = '';
        let resumeTextForThis = '';
        let resumePanelOpened = false; // 1.2.x：是否成功打开过简历面板（用于决定是否点继续沟通）
        try {
          const quickResumeCardText = getChatResumeCardText();
          const quickPrefilterText = [quickResumeCardText, getReplyConversationPrefilterText()]
            .map((t) => String(t || '').trim())
            .filter(Boolean)
            .join('\n');
          const quickHardFilter = screenReplySummaryAgainstFilters(quickPrefilterText, jobCtx);
          if (!quickHardFilter.pass) {
            passed = false;
            reason = String(quickHardFilter.why || '聊天摘要硬过滤不通过');
          }

          if (!passed) {
            throw new Error(reason || '聊天摘要硬过滤不通过');
          }

          if (quickResumeCardText) {
            const quick = await quickScreenChatResumeCardAgainstJd(quickResumeCardText, jobCtx).catch(() => ({ skip: false, reason: '' }));
            if (quick?.skip) {
              passed = false;
              reason = String(quick.reason || '聊天简历卡预判不匹配');
            }
          }

          if (!passed) {
            throw new Error(reason || '聊天简历卡预判不匹配');
          }

          const opened = await openChatResumePanelBestEffort();
          if (!opened) {
            await markReplyThreadTempSkip(key, {
              tempSkipReason: '未能打开简历',
              tempSkipStep: 'open-resume',
              lastInboundHash: String(lastMsg?.inboundHash || ''),
            });
            logWarn(`自动回复跳过：未能打开简历（${name || key}）`);
            await jitterDelay();
            shouldRescanAfterItem = true;
            break;
          }
          resumePanelOpened = true; // 1.2.x：标记已打开，无论评估成功失败都要在外层点继续沟通
          await sleep(550);

          const resumeText = await extractResumeText();
          resumeTextForThis = String(resumeText || '');
          if (!resumeTextForThis) {
            await markReplyThreadTempSkip(key, {
              tempSkipReason: '未读取到简历文本',
              tempSkipStep: 'extract-resume',
              lastInboundHash: String(lastMsg?.inboundHash || ''),
            });
            logWarn(`自动回复跳过：未读取到简历文本（${name || key}）`);
            await closeResumePanelIfPossible();
            await jitterDelay();
            shouldRescanAfterItem = true;
            break;
          }

          const { pass, why, score, threshold } = await screenResumeAgainstJdForReply(resumeTextForThis, jobCtx);
          passed = !!pass;
          reason = String(why || '');
          if (Number.isFinite(Number(score))) {
            const scoreNum = Number(score);
            const thresholdNum = Number.isFinite(Number(threshold)) ? Number(threshold) : null;
            logInfo(`自动回复：${name || key} 匹配评分=${scoreNum}${thresholdNum != null ? ` / 通过线=${thresholdNum}` : ''}`);
          }
        } catch (e) {
          // 若筛选异常：保守跳过，避免误发
          passed = false;
          reason = e?.message || '筛选异常';
        }

        // 1.2.x：评估完毕（不论成功/失败/抛错），只要简历面板已打开过，就在面板里点一次「继续沟通」
        //   - 把点击挪到 try/catch 之外，避免 AI 评估抛错时被跳过
        //   - 点完后 boss 通常会自动从简历切回聊天态；最后兜底调一次 close 防残留
        if (resumePanelOpened) {
          try {
            logInfo(`自动回复：尝试点击「继续沟通」（${name || key}）`);
            const cc = await ensureContinueCommunicationClicked();
            if (cc?.clicked) logSuccess(`自动回复：已点击「继续沟通」（${name || key}）`);
            else if (cc?.skipped) logInfo(`自动回复：跳过「继续沟通」点击 — ${cc.reason || '未知原因'}`);
            else if (cc?.cancelled || cc?.unreachable || cc?.idleTimeout) {
              logWarn(`自动回复：「继续沟通」点击未生效 — ${cc?.reason || ''}`);
            }
          } catch (e) {
            logWarn(`自动回复：「继续沟通」点击异常 — ${e?.message || ''}`);
          }
        }
        await closeResumePanelIfPossible().catch(() => {});

        if (!passed) {
          logInfo(`自动回复跳过：不匹配（${name || key}${reason ? `；${reason}` : ''}）`);
          await loadSettings().catch(() => {});
          let politeSent = false;
          let draftPrepared = false;
          let rejectReplyMode = '';
          let rejectReplyText = '';
          let rejectReplyError = '';
          let markedNotFit = false;
          let labeledNotMatch = { ok: false, missing: false };
          try {
            const rejectResult = await sendAutoReplyByDirection('ourReject', {
              name,
              position: currentJobName,
              reason,
            });
            politeSent = !!rejectResult.sent;
            draftPrepared = !!rejectResult.draftPrepared;
            rejectReplyMode = String(rejectResult.mode || '');
            rejectReplyText = String(rejectResult.preview || '');
            rejectReplyError = String(rejectResult.errorReason || '');
            await sleep(180);
          } catch {}
          if (politeSent) {
            logSuccess(`已按“我们拒绝对方的回复”发送消息（${name || key}）`);
          } else if (draftPrepared) {
            logSuccess(`已生成“我们拒绝对方的回复”草稿（${name || key}；请人工发送）`);
          } else if (rejectReplyMode === 'none') {
            logInfo(`自动回复：已按“我们拒绝对方的回复”配置为不发送（${name || key}）`);
          } else {
            logWarn(`自动回复失败：${name || key}（未能发送“我们拒绝对方的回复”${rejectReplyError ? `：${rejectReplyError}` : ''}）`);
          }
          const shouldClickNotFit = !isLowRiskMode() && !!settings.autoReplyClickNotFit;
          // 不匹配：是否点“不合适”只由独立开关控制；若不开，则加入“不匹配”分组
          const pickedReason = pickNotFitReasonByWhy(reason);
          if (shouldClickNotFit) {
            try {
              markedNotFit = await clickNotFitBestEffort({ reasonText: pickedReason });
              if (markedNotFit) logSuccess(`已标记不合适（${name || key}；${pickedReason}）`);
              else logWarn(`未能标记不合适（${name || key}）`);
            } catch {}
          } else if (!isLowRiskMode()) {
            labeledNotMatch = await addCurrentConversationToFolderBestEffort('不匹配').catch(() => ({ ok: false, missing: false }));
          }
          replied[key] = {
            ts: Date.now(),
            notFit: shouldClickNotFit ? !!markedNotFit : !!labeledNotMatch.ok,
            notFitReason: pickedReason,
            skipped: true,
            replyIntent: intent.intent,
            politeRejectSent: !!politeSent,
            politeRejectDraftPrepared: !!draftPrepared,
            politeRejectMode: rejectReplyMode,
            politeRejectText: rejectReplyText,
            notFitFoldered: !!labeledNotMatch.ok,
            source: convoFlow.source,
            lastInboundHash: String(lastMsg?.inboundHash || ''),
          };
          if (name) seenNamesThisRun.add(name);
          await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
          // 1.1.x：写一条 replyRunResults 卡片记录（我们拒绝 / 不匹配）
          recordReplyRunResult({
            name, candidateKey: key, threadKey: key,
            jobName: currentJobName,
            decision: false,
            decisionLabel: politeSent ? '已回复·我们拒绝' : (draftPrepared ? '草稿已填·我们拒绝' : '已标不合适·我们拒绝'),
            reason: pickedReason || '简历不匹配岗位要求',
            draftPrepared, sent: politeSent,
          }).catch(() => {});
          if (!shouldClickNotFit && !isLowRiskMode()) {
            if (labeledNotMatch?.ok) logInfo(`自动回复：已加入“不匹配”文件夹（${name || key}）`);
            else if (labeledNotMatch?.missing) logWarn('自动回复：未找到“不匹配”文件夹，请先在沟通页右侧分组里创建');
          }
          await jitterDelay();
          shouldRescanAfterItem = true;
          break;
        }

        const materialsReq = await decideReplyMaterialsForJob(currentJobName, jobCtx?.jdText || '').catch(() => ({
          type: 'resume_only',
          label: '简历',
          reason: '默认按简历处理',
        }));
        logInfo(`自动回复：${name || key} 材料要求=${materialsReq.label}${materialsReq.reason ? `（${materialsReq.reason}）` : ''}`);

        await loadSettings().catch(() => {});
        const passReply = await sendAutoReplyByDirection('pass', {
          name,
          position: currentJobName,
          reason,
          materialsType: String(materialsReq?.type || 'resume_only'),
          materials: String(materialsReq?.label || '简历').trim(),
          materialsHint: buildMaterialsHintText(materialsReq, { short: true }),
        }).catch(() => ({ sent: false, mode: 'template', preview: '' }));
        const phraseSent = !!passReply.sent;
        const draftPrepared = !!passReply.draftPrepared;
        replied[key] = {
          ts: Date.now(),
          askedResume: false,
          replyIntent: intent.intent,
          commonPhraseSent: !!phraseSent,
          materialsType: String(materialsReq?.type || 'resume_only'),
          materialsHintSent: false,
          replyDraftPrepared: !!draftPrepared,
          requestedPortfolio: String(materialsReq?.type || '') === 'resume_and_portfolio',
          source: convoFlow.source,
          lastInboundHash: String(lastMsg?.inboundHash || ''),
        };
        if (name) seenNamesThisRun.add(name);
        await chrome.storage.local.set({ [STORAGE_KEYS.repliedThreads]: replied }).catch(() => {});
        // 1.1.x：写一条 replyRunResults 卡片记录（候选人主动招呼 → 通过）
        recordReplyRunResult({
          name, candidateKey: key, threadKey: key,
          jobName: currentJobName,
          decision: true,
          decisionLabel: phraseSent ? '已回复·主动招呼通过' : (draftPrepared ? '草稿已填·主动招呼通过' : '已跳过·主动招呼通过'),
          reason: reason || '候选人主动招呼且简历匹配',
          draftPrepared, sent: phraseSent,
        }).catch(() => {});
        if (draftPrepared) {
          logSuccess(`已生成通过回复草稿（${name || key}${reason ? `；${reason}` : ''}；请人工发送）`);
        } else if (String(passReply.mode || '') === 'none') {
          logInfo(`自动回复：通过，但当前配置为不生成回复草稿（${name || key}）`);
        } else {
          logWarn(`自动回复失败：${name || key}（未能生成通过回复草稿${passReply.errorReason ? `：${passReply.errorReason}` : ''}）`);
        }

        await jitterDelay();
        shouldRescanAfterItem = true;
        break;
      }

      // 1.1.x：本轮（一个候选人或一批无 actionable）结束后，主动关掉残留的简历面板
      // 这样用户回头查看时看到的是聊天对话框，而不是上一位候选人的简历
      try { await closeResumePanelIfPossible(); } catch {}

      await sleep(shouldRescanAfterItem ? 450 : 3500);
    }

    if (autoReplyLoopToken === loopToken) logInfo('自动回复：结束');
  }

  async function waitForChatLastMessageChange(before, timeoutMs = 6000) {
    const beforeHash = before?.inboundHash || '';
    const beforeText = String(before?.text || '');
    const beforeDir = String(before?.direction || '');
    const res = await waitFor(() => {
      const now = getLastChatMessageMeta();
      if (!now || !now.text) return null;
      // 若之前没有消息，任何现在的消息都算 ready
      if (!beforeHash && !beforeText) return now;
      // 只要任一维度变化，就认为已经切到新会话/新消息区
      if (String(now.inboundHash || '') !== beforeHash) return now;
      if (String(now.text || '') !== beforeText) return now;
      if (String(now.direction || '') !== beforeDir) return now;
      return null;
    }, timeoutMs).catch(() => null);
    // 超时兜底：返回当前（即使没变化），避免永远阻塞
    return res || getLastChatMessageMeta();
  }

  function getCurrentReplyJobName() {
    const conversationName = getCurrentConversationPositionName();
    if (conversationName) return conversationName;

    const picker = pickChatJobDropdown();
    const pickerText = String(picker?.labelEl?.textContent || picker?.text || '').replace(/\s+/g, ' ').trim();
    if (pickerText && pickerText !== '全部职位') return pickerText;

    const wantKey = String(settings.selectedJobKey || '').trim();
    if (wantKey) {
      const job = jobsCache.get(wantKey) || null;
      const name = String(job?.name || '').trim();
      if (name) return name;
    }

    return String(settings.positionName || '').trim();
  }

  function buildNeutralAutoReplyMessage({ name, position } = {}) {
    const tpl = String(settings.autoReplyTemplate || '').trim();
    const fallback = '你好 ${name}，我们这边在招 ${position}，如果你方便的话可以先发我一份${materials}，我也给你详细介绍下岗位。';
    const raw = tpl || fallback;
    return renderTemplate(raw, {
      name: String(name || '').trim(),
      position: String(position || settings.positionName || '').trim(),
      materials: '简历',
      materialsHint: '方便的话发我一份简历',
      score: '',
      reason: '',
    })
      .replace(/\s+/g, ' ')
      .replace(/你好\s*，/g, '你好，')
      .replace(/\s+([，。！？])/g, '$1')
      .trim();
  }

  function normalizeReplySendMode(value, fallback = 'template') {
    const v = String(value || '').trim();
    if (v === 'template' || v === 'commonPhrase' || v === 'none') return v;
    return fallback;
  }

  function getMissingAiFields(settingsLike) {
    const missing = [];
    if (!String(settingsLike?.ai?.baseUrl || '').trim()) missing.push('baseUrl');
    if (!String(settingsLike?.ai?.apiKey || '').trim()) missing.push('apiKey');
    if (!String(settingsLike?.ai?.model || '').trim()) missing.push('model');
    return missing;
  }

  function getDefaultPassReplyMode(source = settings) {
    return String(source?.replyCommonPhrase || '').trim() ? 'commonPhrase' : 'template';
  }

  function getAutoReplyDirectionConfig(direction) {
    if (direction === 'candidateReject') {
      return {
        mode: normalizeReplySendMode(settings.autoReplyCandidateRejectMode, 'template'),
        template: String(settings.autoReplyCandidateRejectTemplate || '').trim() || DEFAULT_SETTINGS.autoReplyCandidateRejectTemplate,
        commonPhrase: String(settings.autoReplyCandidateRejectCommonPhrase || '').trim(),
      };
    }
    if (direction === 'ourReject') {
      return {
        mode: normalizeReplySendMode(settings.autoReplyOurRejectMode, 'template'),
        template: String(settings.autoReplyOurRejectTemplate || '').trim() || DEFAULT_SETTINGS.autoReplyOurRejectTemplate,
        commonPhrase: String(settings.autoReplyOurRejectCommonPhrase || '').trim(),
      };
    }
    return {
      mode: normalizeReplySendMode(settings.autoReplyPassMode, getDefaultPassReplyMode(settings)),
      template: String(settings.autoReplyPassTemplate || settings.autoReplyTemplate || '').trim() || DEFAULT_SETTINGS.autoReplyTemplate,
      commonPhrase: String(settings.autoReplyPassCommonPhrase || settings.replyCommonPhrase || '').trim(),
      portfolioCommonPhrase: String(settings.autoReplyPassPortfolioCommonPhrase || '').trim(),
    };
  }

  function renderAutoReplyTemplateText(direction, context = {}) {
    const cfg = getAutoReplyDirectionConfig(direction);
    const fallback = direction === 'pass'
      ? buildNeutralAutoReplyMessage({ name: context.name, position: context.position })
      : (cfg.template || '');
    const raw = String(cfg.template || fallback || '').trim();
    if (!raw) return '';
    return renderTemplate(raw, {
      name: String(context.name || '').trim(),
      position: String(context.position || '').trim(),
      materials: String(context.materials || '简历').trim(),
      materialsHint: String(context.materialsHint || '').trim(),
      score: String(context.score || '').trim(),
      reason: String(context.reason || '').trim(),
    })
      .replace(/\s+/g, ' ')
      .replace(/你好\s*，/g, '你好，')
      .replace(/\s+([，。！？])/g, '$1')
      .trim();
  }

  function replyMentionsPortfolio(text) {
    const s = String(text || '').replace(/\s+/g, '').trim();
    if (!s) return false;
    return /作品集|作品|附件|案例|demo|portfolio/i.test(s);
  }

  function buildMaterialsHintText(materialsReq, context = {}) {
    const type = String(materialsReq?.type || 'resume_only').trim();
    const short = !!context.short;
    if (type === 'resume_and_portfolio') {
      if (short) return '简历和作品/作品集';
      return '方便的话也发我一份简历和作品集/作品，我一起看下，更方便推进沟通。';
    }
    if (short) return '简历';
    return '方便的话发我一份简历，我看下具体经历。';
  }

  function getJobScopedReplyFilters(jobContext = null) {
    const jobKey = String(jobContext?.jobKey || '').trim();
    const override = getEffectiveJobKeywordOverride(jobKey, String(jobContext?.positionName || '').trim());
    const minAge = override ? clampInt(override.minAge, 0, 70, 0) : 0;
    const maxAge = override ? clampInt(override.maxAge, 0, 70, 0) : 0;
    const minEdu = override ? normalizeEduRequirement(String(override.minEdu || '0')) : '0';
    // 1.1.x：最近 gap 上限（月）；override 优先，没设就回退到全局 settings
    const maxRecentGapMonths =
      clampInt(override?.maxRecentGapMonths ?? settings?.maxRecentGapMonths, 0, 240, 0);
    const requiredKeywords = override ? normalizeKeywordLines(override.requiredKeywords) : [];
    const includeKeywords = override ? normalizeKeywordLines(override.includeKeywords) : [];
    const excludeKeywords = override ? normalizeKeywordLines(override.excludeKeywords) : [];
    const aiNiceKeywords = override ? normalizeKeywordLines(override.aiNiceKeywords) : [];
    const keywordsAndMode = override ? !!override.keywordsAndMode : false;
    return {
      minAge,
      maxAge,
      minEdu,
      maxRecentGapMonths,
      requiredKeywords,
      includeKeywords,
      excludeKeywords,
      aiNiceKeywords,
      keywordsAndMode,
      hasKeywordOverrides: !!(
        requiredKeywords.length
        || includeKeywords.length
        || excludeKeywords.length
        || aiNiceKeywords.length
        || minAge > 0
        || maxAge > 0
        || String(minEdu || '0') !== '0'
        || maxRecentGapMonths > 0
      ),
    };
  }

  async function decideReplyMaterialsForJob(positionName, jdText) {
    const position = String(positionName || '').replace(/\s+/g, ' ').trim();
    const jd = String(jdText || '').replace(/\s+/g, ' ').trim();
    const hasAiConfig = !!(settings.ai?.baseUrl && settings.ai?.apiKey && settings.ai?.model);
    if (hasAiConfig) {
      try {
        const result = await aiDecideReplyMaterialsForJob(position, jd);
        if (result?.usage) await recordAiUsage(result.usage).catch(() => {});
        if (result?.type) return result;
      } catch {}
    }
    return decideReplyMaterialsForJobByRules(position, jd);
  }

  function decideReplyMaterialsForJobByRules(positionName, jdText) {
    const text = normalizeForMatch(`${positionName || ''}\n${jdText || ''}`);
    const portfolioHints = [
      '原画', '美术', '插画', 'ui设计', '视觉设计', '平面设计', '角色设计', '场景设计',
      '美宣', '动画', '3d', '建模', '特效', '地编', '文案', '编剧', '剧情', '叙事', '策划文案',
    ];
    const resumeOnlyHints = [
      '程序', '开发', '工程师', '前端', '后端', '客户端', '服务端', '算法', 'ai', '智能',
      '机器学习', '数据', '测试', '运维', 'pm', '项目经理', '产品经理', '项目管理',
    ];
    const matchedPortfolio = portfolioHints.find((kw) => text.includes(normalizeForMatch(kw)));
    const matchedResumeOnly = resumeOnlyHints.find((kw) => text.includes(normalizeForMatch(kw)));
    if (matchedPortfolio) {
      return {
        type: 'resume_and_portfolio',
        label: '简历+作品',
        reason: `命中岗位特征：${matchedPortfolio}`,
      };
    }
    if (matchedResumeOnly) {
      return {
        type: 'resume_only',
        label: '简历',
        reason: `命中岗位特征：${matchedResumeOnly}`,
      };
    }
    return {
      type: 'resume_only',
      label: '简历',
      reason: '未命中作品型岗位特征，默认按简历处理',
    };
  }

  async function aiDecideReplyMaterialsForJob(positionName, jdText) {
    const position = String(positionName || '').replace(/\s+/g, ' ').trim();
    const jd = String(jdText || '').replace(/\s+/g, ' ').trim();
    const system = [
      '你是招聘聊天助手，负责判断当前岗位在首次回复候选人时，需要索要什么材料。',
      '只允许输出严格 JSON，不要输出额外解释。',
      'type 只能是：resume_only 或 resume_and_portfolio。',
      '判断口径：',
      '- 美术类岗位、设计类岗位、原画/插画/动画/建模/UI/视觉/场景/角色等岗位，通常需要索要简历+作品/作品集。',
      '- 文案策划、编剧、剧情策划、叙事策划等文字创作岗位，通常也需要索要简历+作品/作品集。',
      '- 程序、开发、算法、AI/智能、测试、运维、PM/项目管理/产品等岗位，通常只索要简历。',
      '- 若岗位描述明显偏创意产出、视觉产出、文稿产出，则判为 resume_and_portfolio。',
      '输出 JSON：{"type":"resume_only","reason":"..."}',
    ].join('\n');

    const user = [
      `岗位名称：${position || '(空)'}`,
      '',
      '岗位JD（节选）：',
      jd ? jd.slice(0, 1800) : '(空)',
    ].join('\n');

    const { json, usage } = await callAiJson(system, user, { temperature: 0, max_tokens: 180 });
    const type = String(json?.type || '').trim();
    if (type !== 'resume_only' && type !== 'resume_and_portfolio') {
      throw new Error('AI 返回的材料类型无效');
    }
    return {
      type,
      label: type === 'resume_and_portfolio' ? '简历+作品' : '简历',
      reason: String(json?.reason || '').replace(/\s+/g, ' ').trim(),
      usage: usage || null,
    };
  }

  function buildAutoReplyPreviewByDirection(direction, context = {}) {
    const cfg = getAutoReplyDirectionConfig(direction);
    if (cfg.mode === 'none') {
      return { mode: 'none', preview: '', errorReason: '' };
    }

    let preview = '';
    let mode = String(cfg.mode || 'template');
    if (cfg.mode === 'commonPhrase') {
      if (direction === 'pass' && String(context.materialsType || '') === 'resume_and_portfolio' && cfg.portfolioCommonPhrase) {
        preview = String(cfg.portfolioCommonPhrase || '').trim();
        mode = 'portfolio-commonPhrase';
      } else {
        preview = String(cfg.commonPhrase || '').trim();
        mode = 'commonPhrase';
      }
      if (!preview) {
        return { mode, preview: '', errorReason: mode === 'portfolio-commonPhrase' ? '未配置作品常用语' : '未配置常用语' };
      }
    } else {
      preview = renderAutoReplyTemplateText(direction, context);
      mode = 'template';
      if (!preview) return { mode, preview: '', errorReason: '模板内容为空' };
    }

    if (
      direction === 'pass'
      && String(context.materialsType || '') === 'resume_and_portfolio'
      && preview
      && !replyMentionsPortfolio(preview)
    ) {
      const hint = buildMaterialsHintText({ type: 'resume_and_portfolio' }, { position: context.position, name: context.name });
      if (hint) preview = `${preview}\n${hint}`.trim();
    }

    return { mode, preview, errorReason: '' };
  }

  async function sendAutoReplyByDirection(direction, context = {}) {
    const previewMeta = buildAutoReplyPreviewByDirection(direction, context);

    // 1.2.x：新流程 —— 不论 AI 评估结果 / 是否要发内容，先尝试点一次「继续沟通」打开输入框
    // 半 / 全自动会走 riskyClick；低风险模式安全起见跳过
    try {
      const cc = await ensureContinueCommunicationClicked();
      if (cc?.cancelled) {
        return {
          sent: false,
          draftPrepared: false,
          mode: previewMeta.mode || 'none',
          preview: '',
          errorReason: cc.reason || '本机点击器：用户取消了“继续沟通”点击',
        };
      }
      if (cc?.unreachable) {
        return {
          sent: false,
          draftPrepared: false,
          mode: previewMeta.mode || 'none',
          preview: '',
          errorReason: cc.reason || '本机点击器不可达',
        };
      }
      if (cc?.clicked) logInfo('自动回复：已点击「继续沟通」打开会话');
    } catch (_) {}

    if (previewMeta.mode === 'none') return { sent: false, draftPrepared: false, mode: 'none', preview: '', errorReason: '' };
    if (previewMeta.errorReason || !previewMeta.preview) {
      return {
        sent: false,
        draftPrepared: false,
        mode: previewMeta.mode,
        preview: String(previewMeta.preview || ''),
        errorReason: String(previewMeta.errorReason || '未生成回复内容'),
      };
    }

    const buildDraftOnly = async (label = 'draft') => {
      const draftResult = await fillChatDraftBestEffort(previewMeta.preview).catch(() => ({ ok: false, reason: '填写草稿异常' }));
      return {
        sent: false,
        draftPrepared: !!draftResult?.ok,
        mode: `${previewMeta.mode}-${label}`,
        preview: previewMeta.preview,
        errorReason: String(draftResult?.reason || '未能填写草稿'),
      };
    };

    // 低风险模式：仅生成草稿
    if (isLowRiskMode()) return await buildDraftOnly('draft');

    // 1.2.x：半自动模式 —— 只填好文字留作草稿，不点发送（由用户人工核对后手动发）
    //        然后主循环自然会切到下一个候选人
    if (isSemiAutoClickerMode()) {
      const out = await buildDraftOnly('semiauto-draft');
      if (out.draftPrepared) logInfo('自动回复（半自动）：已填好回复文字，等待人工核对发送');
      return out;
    }

    if (String(previewMeta.mode || '').includes('commonPhrase')) {
      const ok = await sendBossCommonPhrase(previewMeta.preview).catch(() => false);
      if (ok) return { sent: true, draftPrepared: false, mode: previewMeta.mode, preview: previewMeta.preview, errorReason: '' };
      const directResult = await sendChatMessageDetailed(previewMeta.preview).catch(() => ({ ok: false, reason: '直接发送异常' }));
      if (directResult?.ok) return { sent: true, draftPrepared: false, mode: `${previewMeta.mode}-direct`, preview: previewMeta.preview, errorReason: '' };
      return {
        sent: false,
        draftPrepared: false,
        mode: previewMeta.mode,
        preview: previewMeta.preview,
        errorReason: String(directResult?.reason || '未能直接发送常用语'),
      };
    }

    const result = await sendChatMessageDetailed(previewMeta.preview).catch(() => ({ ok: false, reason: '模板发送异常' }));
    if (result?.ok) return { sent: true, draftPrepared: false, mode: 'template', preview: previewMeta.preview, errorReason: '' };
    return {
      sent: false,
      draftPrepared: false,
      mode: 'template',
      preview: previewMeta.preview,
      errorReason: String(result?.reason || '未能发送模板消息'),
    };
  }

  async function classifyCandidateReplyIntent(messageText, positionName, convoIntentContext = null) {
    const hasAiConfig = !!(settings.ai?.baseUrl && settings.ai?.apiKey && settings.ai?.model);
    if (hasAiConfig) {
      try {
        const result = await aiClassifyCandidateReplyIntent(messageText, positionName, convoIntentContext);
        if (result?.usage) await recordAiUsage(result.usage).catch(() => {});
        if (result?.intent) return result;
      } catch (e) {
        logWarn(`自动回复：AI 消息判断失败，已回退规则判断（${e?.message || '未知错误'}）`);
      }
    }
    return classifyCandidateReplyIntentByRules(messageText, positionName, convoIntentContext);
  }

  function classifyCandidateReplyIntentByRules(messageText, positionName, convoIntentContext = null) {
    const raw = String(messageText || '').replace(/\s+/g, ' ').trim();
    const text = normalizeForMatch(raw);
    const pos = normalizeForMatch(String(positionName || '').trim());
    const lastMeText = String(convoIntentContext?.lastMeTextBeforeLastInbound || '').replace(/\s+/g, ' ').trim();
    const lastMeNorm = normalizeForMatch(lastMeText);

    const rejectRules = [
      { re: /(暂不考虑|暂时不考虑|先不考虑|目前不考虑|不考虑机会|暂时不看机会|不看机会|先不看机会)/, reason: '明确表示暂不看机会' },
      { re: /(不换工作|不想换工作|不考虑换工作|目前不打算换|暂时不换)/, reason: '明确表示不换工作' },
      { re: /(没兴趣|不感兴趣|没有兴趣|不太感兴趣|无意向|没有意向)/, reason: '明确表示无意向' },
      { re: /(不了(吧)?谢谢|先不了|算了谢谢|婉拒|抱歉不合适|不太合适)/, reason: '明确表示拒绝当前岗位' },
      { re: /(已入职|已经入职|已找到工作|已经找到工作|offer已定)/, reason: '已确认去向' },
    ];
    for (const rule of rejectRules) {
      if (rule.re.test(text)) return { intent: 'reject', label: '拒绝', reason: rule.reason };
    }

    if (looksLikeClosingMessageByMe(lastMeNorm) && conversationItemLooksLikeAcknowledgement(text)) {
      return { intent: 'neutral', label: '中性', reason: '候选人在确认上一条结束沟通信息' };
    }

    if (
      looksLikeMaterialsRequestByMe(lastMeNorm)
      && (
        /(请查收|请收下|已发送|发给您了|发您邮箱了|已发邮箱|简历已发|作品已发|附件已发)/.test(text)
        || conversationItemLooksLikeAcknowledgement(text)
      )
    ) {
      return { intent: 'neutral', label: '中性', reason: '候选人在确认已发送材料或确认收到上一条索要材料信息' };
    }

    const interestedRules = [
      { re: /(有兴趣|感兴趣|有意向|可以聊聊|可以沟通|方便聊聊|进一步聊聊)/, reason: '明确表达兴趣' },
      { re: /(看机会|看看机会|考虑机会|在看机会|可看机会)/, reason: '明确表示在看机会' },
      { re: /(可以发简历|方便发简历|我发你简历|我把简历发你|可以给您简历|方便给您简历)/, reason: '主动表示可发简历' },
    ];
    for (const rule of interestedRules) {
      if (rule.re.test(text)) return { intent: 'interested', label: '有意向', reason: rule.reason };
    }

    if (
      looksLikeShortAffirmativeReply(text)
      && looksLikeInterestQuestion(lastMeNorm)
      && !looksLikeClosingMessageByMe(lastMeNorm)
      && !looksLikeMaterialsRequestByMe(lastMeNorm)
    ) {
      return { intent: 'interested', label: '有意向', reason: '候选人在回应上一句岗位意向确认' };
    }

    if (pos && text.includes(pos) && /(聊|沟通|看机会|考虑机会|有兴趣|感兴趣)/.test(text)) {
      return { intent: 'interested', label: '有意向', reason: '围绕当前岗位继续沟通' };
    }

    if (/(发我jd|发下jd|发我岗位|发一下岗位|发下岗位|介绍下岗位|介绍一下岗位|想了解|了解一下|可以了解|可以看看|方便了解|什么岗位|岗位介绍)/.test(text)) {
      return { intent: 'neutral', label: '中性', reason: '在询问岗位信息，尚未明确表态' };
    }

    if (/(请查收|请收下|已发送|发给您了|发您邮箱了|已发邮箱|简历已发|作品已发|附件已发)/.test(text)) {
      return { intent: 'neutral', label: '中性', reason: '候选人在确认已发送材料' };
    }

    if (/(好的好的|好的|好哒|ok|okk|收到|收到啦|明白了|了解了|嗯嗯|行的|可以的|好的呢)/.test(text)) {
      return { intent: 'neutral', label: '中性', reason: '确认收到，未提出新问题或新材料' };
    }

    return { intent: 'neutral', label: '中性', reason: '未出现明确拒绝或明确意向' };
  }

  async function aiClassifyCandidateReplyIntent(messageText, positionName, convoIntentContext = null) {
    const inbound = String(messageText || '').replace(/\s+/g, ' ').trim();
    const position = String(positionName || '').replace(/\s+/g, ' ').trim();
    const recentContext = String(convoIntentContext?.recentContextText || '').trim();
    const lastMeText = String(convoIntentContext?.lastMeTextBeforeLastInbound || '').replace(/\s+/g, ' ').trim();

    const system = [
      '你是招聘聊天助手，负责判断候选人在 BOSS 直聘中发来的最后一句话属于哪种沟通意图。',
      '只允许输出严格 JSON，不要输出额外解释。',
      '意图只能是三类：reject / neutral / interested。',
      '必须结合最近几轮对话上下文判断，不能只看最后一句。',
      '定义：',
      '- reject：候选人明确拒绝当前岗位、拒绝换工作、拒绝继续沟通。',
      '- neutral：候选人没有明确接受或拒绝，只是在询问岗位、索要信息、索要邮箱、索要 JD、了解流程。',
      '- interested：候选人明确表示对岗位有兴趣、愿意继续沟通、愿意投递简历/作品、愿意聊机会。',
      '注意：像“发我邮箱，我把简历/作品发你”“方便的话我发简历给你”这类，应判为 interested，而不是 neutral。',
      '注意：若候选人用“有的”“可以”“好的”“行”“嗯嗯”等简短肯定回复，且上一句是招聘方在确认“是否有意向/是否考虑机会/方便聊聊吗/对岗位是否感兴趣”，应判为 interested。',
      '注意：像“好的”“收到”“好的好的”“明白了”这类对上一条的确认回复，如果没有新增问题、没有新增材料、没有新的求职信息，通常应判为 neutral。',
      '注意：像“请查收”“已发送”“发您邮箱了”“简历已发”“作品已发”这类，通常是在确认已发送材料，优先判为 neutral，而不是再次判为 interested。',
      '注意：如果招聘方上一句已经是在结束沟通、婉拒或说明“本次不继续推进/希望未来有机会合作”，候选人只回“好的/收到/明白”，应判为 neutral，不能再当成有意向。',
    ].join('\n');

    const user = [
      `当前岗位：${position || '(未提供)'}`,
      '',
      '最近对话上下文：',
      recentContext || '(空)',
      '',
      `候选人上一条之前，我方最近一条消息：${lastMeText || '(空)'}`,
      '',
      '候选人最后一句：',
      inbound || '(空)',
      '',
      '请输出 JSON：{"intent":"reject|neutral|interested","reason":"不超过30字的中文判断依据"}',
    ].join('\n');

    const { json, usage } = await callAiJson(system, user, { temperature: 0, max_tokens: 220 });
    const intent = String(json?.intent || '').trim();
    const reason = String(json?.reason || '').replace(/\s+/g, ' ').trim();
    if (!['reject', 'neutral', 'interested'].includes(intent)) {
      throw new Error('AI 返回了未知意图');
    }
    return {
      intent,
      label: intent === 'reject' ? '拒绝' : intent === 'interested' ? '有意向' : '中性',
      reason: reason || (intent === 'reject' ? 'AI判断为拒绝' : intent === 'interested' ? 'AI判断为有意向' : 'AI判断为中性'),
      usage: usage || null,
    };
  }

  function pickNotFitReasonByWhy(why) {
    const s = String(why || '').replace(/\s+/g, ' ').trim();
    if (!s) return '过往经历不符';
    if (/年龄/.test(s)) return '年龄不符';
    if (/学历/.test(s)) return '学历不符';
    if (/薪资/.test(s)) return '薪资不符';
    if (/距离/.test(s)) return '距离太远';
    if (/期望/.test(s)) return '期望不符';
    return '过往经历不符';
  }

  async function clickNotFitBestEffort({ reasonText } = {}) {
    // 只在对话框页内执行：按钮文案为“不合适”
    const reason = String(reasonText || '').trim();
    const docs = getAllDocs();
    let btn = docs
      .flatMap((d) => Array.from(d.querySelectorAll?.('.operate-exchange-right .not-fit-wrap .operate-icon-item > .operate-btn, .not-fit-wrap .operate-icon-item > .operate-btn, span.operate-btn, button.operate-btn, a.operate-btn') || []))
      .find((el) => isVisible(el) && /^不合适$/.test(String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()))
      || null;

    if (!btn) {
      const roots = docs.map((d) => d.body).filter(Boolean);
      const cands = [];
      for (const r of roots) {
        try {
          cands.push(...Array.from(r.querySelectorAll('button,a,[role="button"],span,div')).slice(0, 1200));
        } catch {}
      }
      btn = cands.find((el) => {
        if (!isVisible(el)) return false;
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return t === '不合适' || t.endsWith('不合适') || t.includes('不合适');
      }) || null;
    }
    if (!btn) return false;

    await humanApproachElement(btn, { purpose: 'toolbar' });
    simulateClick(btn);
    await humanPause(150, 280);

    const visibleReasonNodes = await waitFor(() => {
      const nodes = getAllDocs()
        .flatMap((d) => Array.from(d.querySelectorAll?.('.not-fit-wrap .reason-item, .reason-item') || []))
        .filter((el) => isVisible(el));
      return nodes.length ? nodes : null;
    }, 1500).catch(() => []);

    if (!visibleReasonNodes.length) {
      const anyReasonNodes = getAllDocs().flatMap((d) => Array.from(d.querySelectorAll?.('.not-fit-wrap .reason-item, .reason-item') || []));
      if (anyReasonNodes.length === 0) return true; // 有些版本点一下就生效
      return false;
    }

    const picked =
      (reason ? visibleReasonNodes.find((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().includes(reason)) : null)
      || visibleReasonNodes.find((el) => String(el.innerText || el.textContent || '').includes('过往经历不符'))
      || visibleReasonNodes[0];
    if (!picked) return false;
    await humanApproachElement(picked, { purpose: 'toolbar' });
    simulateClick(picked);
    await humanPause(180, 320);
    return true;
  }

  async function ensureChatJobSelected() {
    // 仅在沟通页顶层执行
    const pv = String(document.body?.getAttribute?.('data-pv') || '');
    const path = String(location.pathname || '');
    const onChat = isOnChatIndexPage();
    if (!onChat) return false;

    const wantKey = String(settings.selectedJobKey || '').trim();
    if (!wantKey) return true; // 未选择岗位：允许“全部职位”

    await loadJobsCache().catch(() => {});
    const job = jobsCache.get(wantKey) || null;
    const wantName = String(job?.name || settings.positionName || '').trim();
    const wantJobId = String(job?.jobId || (wantKey.startsWith('jobId:') ? wantKey.slice('jobId:'.length) : '') || '').trim();

    const picker = pickChatJobDropdown();
    const labelEl = picker?.labelEl || null;
    const labelText = String(labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
    if (wantName && labelText.includes(wantName)) return true;

    const openBtn = picker?.openBtn || null;
    if (!openBtn) return false;
    simulateClick(openBtn);

    const list = await waitFor(() => queryVisibleChatJobMenu() || null, 8000);
    if (!list) return false;

    const items = getVisibleChatJobOptions();
    if (!items.length) return false;

    let picked = null;
    if (wantJobId) {
      picked = items.find((li) => extractChatJobOptionValue(li) === wantJobId) || null;
    }
    if (!picked && wantName) {
      const want = normalizeForMatch(wantName);
      picked = items.find((li) => normalizeForMatch(li.textContent || '').includes(want)) || null;
    }
    if (!picked) return false;
    await humanApproachElement(picked, { purpose: 'toolbar' });
    simulateClick(picked);
    await humanPause(180, 320);
    try {
      const pickedText = String(picked.innerText || picked.textContent || '').replace(/\s+/g, ' ').trim();
      if (pickedText) logInfo(`自动回复：已切换沟通页岗位为「${pickedText}」`);
    } catch {}
    return true;
  }

  async function ensureChatJobScopeForAutoReply() {
    const onChat = isOnChatIndexPage();
    if (!onChat) return false;

    const wantKey = String(settings.autoReplyJobKey || '').trim();
    await loadJobsCache().catch(() => {});
    const targetJob = wantKey ? (jobsCache.get(wantKey) || null) : null;
    const wantName = String(targetJob?.name || '').trim();
    const wantJobId = String(targetJob?.jobId || (wantKey.startsWith('jobId:') ? wantKey.slice('jobId:'.length) : '') || '').trim();

    const picker = pickChatJobDropdown();
    const labelEl = picker?.labelEl || null;
    const labelText = String(labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!wantKey) {
      if (labelText.includes('全部职位')) return true;
    } else {
      const want = normalizeForMatch(wantName);
      if ((wantName && labelText.includes(wantName)) || (want && normalizeForMatch(labelText).includes(want))) return true;
    }

    const openBtn = picker?.openBtn || null;
    if (!openBtn) return false;
    simulateClick(openBtn);

    const list = await waitFor(() => queryVisibleChatJobMenu() || null, 8000).catch(() => null);
    if (!list) return false;

    const items = getVisibleChatJobOptions();
    if (!items.length) return false;
    let picked = null;
    if (!wantKey) {
      picked =
        items.find((li) => extractChatJobOptionValue(li) === '-1')
        || items.find((li) => /全部职位/.test(String(li.innerText || li.textContent || '').replace(/\s+/g, ' ').trim()))
        || null;
    } else {
      if (wantJobId) {
        picked = items.find((li) => extractChatJobOptionValue(li) === wantJobId) || null;
      }
      if (!picked && wantName) {
        const want = normalizeForMatch(wantName);
        picked = items.find((li) => normalizeForMatch(li.textContent || '').includes(want)) || null;
      }
    }
    if (!picked) return false;

    simulateClick(picked);
    await sleep(260);
    const pickedText = String(picked.innerText || picked.textContent || '').replace(/\s+/g, ' ').trim();
    logInfo(`自动回复：已切换沟通页岗位筛选为「${pickedText || (wantKey ? wantName : '全部职位')}」`);
    return true;
  }

  async function ensureChatUnreadFilterForAutoReply() {
    const onChat = isOnChatIndexPage();
    if (!onChat) return false;

    const tabs = getAllDocs()
      .flatMap((d) => Array.from(d.querySelectorAll?.('.chat-message-filter .chat-message-filter-left span, .chat-message-filter-left span') || []))
      .filter((el) => isVisible(el));
    if (!tabs.length) return false;

    const unreadTab = tabs.find((el) => /未读/.test(String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())) || null;
    if (!unreadTab) return false;
    if (unreadTab.classList?.contains('active')) return true;

    await humanApproachElement(unreadTab, { purpose: 'toolbar' });
    simulateClick(unreadTab);
    const ok = await waitFor(() => unreadTab.classList?.contains('active') ? true : null, 3000).catch(() => false);
    if (ok) logInfo('自动回复：已切换消息筛选为「未读」');
    return !!ok;
  }

  async function waitForThreadListSettle(timeoutMs = 2800) {
    let stableHits = 0;
    let lastSig = '';
    return await waitFor(() => {
      const items = findThreadsForAutoReply({ maxItems: 6 });
      if (!items.length) return null;
      const first = items[0];
      const sig = [
        items.length,
        getThreadKey(first),
        getThreadName(first),
      ].join(' | ');
      if (sig && sig === lastSig) {
        stableHits += 1;
      } else {
        lastSig = sig;
        stableHits = 0;
      }
      if (stableHits >= 2) return { ok: true, firstSig: sig };
      return null;
    }, timeoutMs).catch(() => null);
  }

  async function ensureChatAllLabelForAutoReply() {
    const onChat = isOnChatIndexPage();
    if (!onChat) return false;

    const tabs = getAllDocs()
      .flatMap((d) => Array.from(d.querySelectorAll?.('.chat-label-item, [title="全部"], [title^="全部"]') || []))
      .filter((el) => isVisible(el));
    if (!tabs.length) return false;

    const allTab = tabs.find((el) => {
      const title = String(el.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim();
      const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return title === '全部' || /^全部(\(\d+\))?$/.test(title) || text === '全部';
    }) || null;
    if (!allTab) return false;

    const isActive = !!allTab.querySelector?.('.active') || allTab.classList?.contains('selected');
    if (isActive) return true;

    await humanApproachElement(allTab.querySelector?.('.content') || allTab, { purpose: 'toolbar' });
    simulateClick(allTab.querySelector?.('.content') || allTab);
    const ok = await waitFor(() => {
      const freshTabs = getAllDocs()
        .flatMap((d) => Array.from(d.querySelectorAll?.('.chat-label-item, [title="全部"], [title^="全部"]') || []))
        .filter((el) => isVisible(el));
      const fresh = freshTabs.find((el) => {
        const title = String(el.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim();
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return title === '全部' || /^全部(\(\d+\))?$/.test(title) || text === '全部';
      }) || allTab;
      if (fresh.querySelector?.('.active') || fresh.classList?.contains('selected')) return true;
      return null;
    }, 2500).catch(() => false);
    if (ok) logInfo('自动回复：已切换顶部会话分组为「全部」');
    return !!ok;
  }

  async function addCurrentConversationToFolderBestEffort(folderName) {
    const targetFolderName = String(folderName || '').trim();
    if (!targetFolderName) return { ok: false, missing: false };
    const opener = findAddLabelButton();
    if (!opener) return { ok: false, missing: false };
    await humanApproachElement(opener, { purpose: 'toolbar' });
    simulateClick(opener);
    await humanPause(150, 260);

    const panel = await waitFor(() => findVisibleRightbarLabelPanel() || null, 2200).catch(() => null);
    if (!panel) return { ok: false, missing: false };

    const item = await waitFor(() => findFolderItemByName(targetFolderName, panel) || null, 2200).catch(() => null);
    if (!item) return { ok: false, missing: true };
    if (isFolderItemChecked(item, targetFolderName)) {
      await restoreAutoReplyChatFiltersAfterFolderTag().catch(() => {});
      return { ok: true, missing: false };
    }

    const clickEl = item.querySelector?.('span') || item.querySelector?.('svg') || item;
    await humanApproachElement(clickEl, { purpose: 'toolbar' });
    simulateClick(clickEl);
    await humanPause(150, 260);

    const ok = await waitFor(() => {
      const visiblePanel = findVisibleRightbarLabelPanel() || panel;
      const refreshed = findFolderItemByName(targetFolderName, visiblePanel);
      if (!refreshed) return true;
      return isFolderItemChecked(refreshed, targetFolderName) ? true : null;
    }, 1800).catch(() => false);
    await restoreAutoReplyChatFiltersAfterFolderTag().catch(() => {});
    return { ok: !!ok, missing: false };
  }

  async function addCurrentConversationToUnrepliedFolderBestEffort() {
    const result = await addCurrentConversationToFolderBestEffort('未回复').catch(() => ({ ok: false, missing: false }));
    return !!result?.ok;
  }

  async function restoreAutoReplyChatFiltersAfterFolderTag() {
    await sleep(160);
    await ensureChatJobScopeForAutoReply().catch(() => false);
    await sleep(120);
    await ensureChatAllLabelForAutoReply().catch(() => false);
    await sleep(120);
    await ensureChatUnreadFilterForAutoReply().catch(() => false);
  }

  function findAddLabelButton() {
    const candidates = queryAllAnyDoc('.rightbar-box .rightbar-item.add-to-label .icon, .rightbar-box .rightbar-item.add-to-label svg, .rightbar-box .rightbar-item.add-to-label use', 120)
      .filter((el) => isVisible(el))
      .map((el) => {
        const href = getIconHref(el);
        if (!href.includes('icon-rightbar-add-label')) return null;
        const clickEl =
          el.closest?.('.rightbar-item.add-to-label .icon')
          || el.closest?.('.rightbar-item.add-to-label')
          || el.closest?.('a,button,[role="button"],span,div')
          || el;
        if (!isVisible(clickEl) || isElementDisabledish(clickEl)) return null;
        let score = 120;
        const cls = String(clickEl.className || '').toLowerCase();
        if (/icon/.test(cls)) score += 16;
        if (/add-to-label/.test(String(clickEl.closest?.('.add-to-label')?.className || '').toLowerCase())) score += 30;
        return { el: clickEl, score };
      })
      .filter(Boolean);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function findVisibleRightbarLabelPanel() {
    const panels = queryAllAnyDoc('.rightbar-box .rightbar-tooltip, .rightbar-box .label-list, .rightbar-box .popover-content', 40)
      .filter((el) => isVisible(el));
    return panels[0] || null;
  }

  function findFolderItemByName(name, scope = null) {
    const target = String(name || '').trim();
    if (!target) return null;
    const nodes = (scope
      ? Array.from(scope.querySelectorAll?.('li.item, li, [role="menuitem"], span, div') || [])
      : queryAllAnyDoc('li.item, li, [role="menuitem"], span, div', 800))
      .filter((el) => isVisible(el));
    const matches = [];
    for (const el of nodes) {
      const root = el.closest?.('li.item, li, [role="menuitem"]') || el;
      if (!isVisible(root)) continue;
      const text = String(root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || !text.includes(target)) continue;
      let score = 0;
      if (root.matches?.('li.item')) score += 50;
      if (text === target) score += 30;
      if (text.includes(target)) score += 20;
      if (elementContainsIconHref(root, 'icon-rightbar-label-checked')) score += 20;
      matches.push({ el: root, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches[0]?.el || null;
  }

  function isFolderItemChecked(item, folderName = '') {
    if (!item) return false;
    const activeText = item.querySelector?.('span.active');
    const target = String(folderName || '').replace(/\s+/g, ' ').trim();
    if (activeText) {
      const activeLabel = String(activeText.innerText || activeText.textContent || '').replace(/\s+/g, ' ').trim();
      if (!target || activeLabel === target) return true;
    }
    return elementContainsIconHref(item, 'icon-rightbar-label-checked');
  }

  function elementContainsIconHref(root, token) {
    if (!root || !token) return false;
    const els = [];
    try { els.push(root, ...Array.from(root.querySelectorAll?.('use, svg') || [])); } catch { els.push(root); }
    return els.some((el) => getIconHref(el).includes(token));
  }

  function getIconHref(el) {
    if (!el) return '';
    try {
      if (String(el.tagName || '').toLowerCase() === 'use') {
        return String(el.getAttribute('xlink:href') || el.getAttribute('href') || '').trim();
      }
      const use = el.querySelector?.('use');
      return String(use?.getAttribute?.('xlink:href') || use?.getAttribute?.('href') || '').trim();
    } catch {
      return '';
    }
  }

  function getCurrentConversationPositionName() {
    const nodes = queryAllAnyDoc('.base-info-single-main .position-name, .slide-content-click-content .position-name, .position-content .position-name', 40)
      .filter((el) => isVisible(el));
    if (!nodes.length) return '';

    return nodes
      .map((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)[0] || '';
  }

  function findBestJobFromCacheByConversationTitle(title) {
    const raw = String(title || '').replace(/\s+/g, ' ').trim();
    if (!raw) return null;

    const want = normalizeForMatch(raw);
    const wantLoose = normalizeForMatchLoose(raw);
    const wantMj = extractMjCode(raw);
    const jobs = Array.from(jobsCache.values() || []);
    let best = null;
    let bestScore = -Infinity;

    for (const job of jobs) {
      if (!job) continue;
      const name = String(job.name || '').trim();
      if (!name) continue;

      const norm = normalizeForMatch(name);
      const loose = normalizeForMatchLoose(name);
      const mj = extractMjCode(name);
      let score = 0;

      if (wantMj && mj && wantMj === mj) score += 220;
      if (norm && want && norm === want) score += 120;
      if (loose && wantLoose && loose === wantLoose) score += 90;
      if (norm && want && (norm.includes(want) || want.includes(norm))) score += 50;
      if (loose && wantLoose && (loose.includes(wantLoose) || wantLoose.includes(loose))) score += 25;
      if (String(job.jdText || '').trim()) score += 12;
      if (job.isOpen === true) score += 4;

      if (score > bestScore) {
        bestScore = score;
        best = job;
      }
    }

    if (bestScore < 35 || !best) return null;
    const bestBy = wantMj && extractMjCode(best?.name || '') === wantMj ? 'mj' : 'name';
    return { job: best, score: bestScore, by: bestBy };
  }

  async function resolveJobContextForCurrentConversation() {
    await loadJobsCache().catch(() => {});

    const conversationPositionName = getCurrentConversationPositionName();
    if (conversationPositionName) {
      logInfo(`自动回复：当前会话沟通职位=「${conversationPositionName}」`);
    }

    const matched = conversationPositionName ? findBestJobFromCacheByConversationTitle(conversationPositionName) : null;
    if (matched?.job) {
      const jdText = String(matched.job.jdText || '').trim();
      if (jdText) {
        logInfo(`自动回复：已按会话岗位命中 JD（${matched.by === 'mj' ? 'MJ编号' : '岗位名'}）：「${String(matched.job.name || conversationPositionName || '').trim()}」`);
      } else {
        logWarn(`自动回复：已命中会话岗位「${String(matched.job.name || conversationPositionName || '').trim()}」，但缓存中暂无 JD`);
      }
      return {
        source: 'conversation',
        matchBy: matched.by,
        conversationPositionName,
        positionName: String(matched.job.name || conversationPositionName || '').trim(),
        jdText,
        jobKey: String(matched.job.key || '').trim(),
        jobId: String(matched.job.jobId || '').trim(),
        encryptJobId: String(matched.job.encryptJobId || '').trim(),
      };
    }

    const wantKey = String(settings.autoReplyJobKey || '').trim();
    const fallbackJob = wantKey ? jobsCache.get(wantKey) || null : null;
    const fallbackPosition = String(fallbackJob?.name || settings.positionName || conversationPositionName || '').trim();
    const fallbackJd = String(fallbackJob?.jdText || settings.jdText || '').trim();

    if (!conversationPositionName) {
      if (fallbackPosition || fallbackJd) {
        logInfo(`自动回复：当前会话未读到沟通职位，已回退到插件岗位「${fallbackPosition || '(未命名岗位)'}」`);
      }
      return {
        source: 'settings-fallback',
        matchBy: 'fallback-missing-conversation-position',
        conversationPositionName: '',
        positionName: fallbackPosition,
        jdText: fallbackJd,
        jobKey: String(fallbackJob?.key || wantKey || '').trim(),
        jobId: String(fallbackJob?.jobId || '').trim(),
        encryptJobId: String(fallbackJob?.encryptJobId || '').trim(),
      };
    }

    if (fallbackPosition || fallbackJd) {
      logWarn(`自动回复：未在岗位缓存中找到会话岗位「${conversationPositionName}」，已回退到插件岗位「${fallbackPosition || '(未命名岗位)'}」`);
    } else {
      logWarn(`自动回复：未在岗位缓存中找到会话岗位「${conversationPositionName}」，且插件岗位也未配置 JD`);
    }

    return {
      source: 'settings-fallback',
      matchBy: 'fallback-no-cache-match',
      conversationPositionName,
      positionName: fallbackPosition || conversationPositionName,
      jdText: fallbackJd,
      jobKey: String(fallbackJob?.key || wantKey || '').trim(),
      jobId: String(fallbackJob?.jobId || '').trim(),
      encryptJobId: String(fallbackJob?.encryptJobId || '').trim(),
    };
  }

  async function fetchChatJobsFromTopBar() {
    // 从沟通页顶部岗位筛选下拉获取岗位列表
    const pv = String(document.body?.getAttribute?.('data-pv') || '');
    const path = String(location.pathname || '');
    const onChat = isOnChatIndexPage();
    if (!onChat) {
      throw new Error(`当前不是沟通页（pv=${pv} path=${path}）`);
    }

    const picker = pickChatJobDropdown();
    const openBtn = picker?.openBtn || null;
    if (!openBtn) throw new Error('未找到沟通页岗位下拉按钮（.ui-dropmenu-label）');

    // 打开下拉
    simulateClick(openBtn);
    await sleep(200);

    const ok = await waitFor(() => queryVisibleChatJobMenu() || null, 8000);
    if (!ok) throw new Error('沟通页岗位下拉未展开/未渲染');

    const items = getVisibleChatJobOptions();
    if (!items.length) throw new Error('沟通页岗位列表为空');

    const out = [];
    for (const li of items) {
      const v = extractChatJobOptionValue(li);
      const text = String(li.innerText || li.textContent || '').replace(/\s+/g, ' ').trim();
      if (!v && !text) continue;
      // value=-1 表示“全部职位”，保留但不作为岗位候选（可用于 UI 展示）
      out.push({
        value: v,
        text,
        isAll: v === '-1' || /全部职位/.test(text),
        isActive: li.classList?.contains('active') || li.classList?.contains('curr') || false,
      });
    }

    // 尝试收起下拉（避免挡住页面）
    try { simulateClick(openBtn); } catch {}
    return out.slice(0, 80);
  }

  function pickChatJobDropdown() {
    const nodes = getAllDocs().flatMap((d) => Array.from(d.querySelectorAll?.('.chat-top-job .ui-dropmenu-label, .ui-dropmenu-label') || []));
    if (!nodes.length) return null;

    const cand = nodes
      .map((el) => {
        const labelEl = el.querySelector?.('.chat-select-job, .dropmenu-label') || el;
        const text = String(labelEl?.innerText || labelEl?.textContent || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        let s = 0;
        if (el.closest?.('.chat-top-job')) s += 70;
        if (el.querySelector?.('.chat-select-job')) s += 55;
        if (labelEl?.classList?.contains?.('chat-select-job')) s += 50;
        if (text.includes('全部职位')) s += 36;
        if (text.includes('职位')) s += 20;
        if (isVisible(el)) s += 8;
        if (text.includes('新招呼') || text.includes('沟通')) s -= 50;
        return { openBtn: el, labelEl, text, s };
      })
      .filter((x) => x.s > 20);

    cand.sort((a, b) => b.s - a.s);
    return cand[0] || null;
  }

  function queryVisibleChatJobMenu() {
    const lists = getAllDocs().flatMap((d) => Array.from(d.querySelectorAll?.('.chat-top-job .ui-dropmenu-list, .ui-dropmenu-list') || []));
    const visible = lists.find((el) => {
      const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return isVisible(el) && (text.includes('全部职位') || text.includes('职位') || !!el.querySelector?.('li[value], .job-item, li'));
    });
    return visible || null;
  }

  function getVisibleChatJobOptions() {
    const menu = queryVisibleChatJobMenu();
    if (!menu) return [];
    const options = Array.from(menu.querySelectorAll?.('li[value], .job-item, li') || []);
    return options.filter((el) => {
      const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return !!text;
    });
  }

  function extractChatJobOptionValue(el) {
    if (!el) return '';
    return String(
      el.getAttribute?.('value')
      || el.getAttribute?.('data-value')
      || el.getAttribute?.('data-id')
      || '',
    ).trim();
  }

  async function clickNewGreetTab() {
    // 你截图里的结构：div.chat-label-item[title="新招呼(41)"] 内部有 span.content + em.num
    const items = getAllDocs().flatMap((d) => Array.from(d.querySelectorAll?.('.chat-label-item') || []));
    if (!items.length) return false;

    const cand = items
      .map((el) => {
        const title = String(el.getAttribute?.('title') || '');
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        let s = 0;
        if (title.includes('新招呼')) s += 60;
        if (text.includes('新招呼')) s += 55;
        if (/\(\d+\)/.test(title) || /\(\d+\)/.test(text)) s += 6;
        if (el.classList?.contains('selected')) s -= 3; // 已选中的降一点，但仍可点
        if (isVisible(el)) s += 4;
        return { el, s, title, text };
      })
      .filter((x) => x.s > 30);

    cand.sort((a, b) => b.s - a.s);
    const picked = cand[0]?.el || null;
    if (!picked) return false;

    simulateClick(picked);
    await sleep(180);
    // 等 selected 生效（有些版本会异步切换）
    await waitFor(() => {
      const t = String(picked.getAttribute?.('title') || '') + ' ' + String(picked.innerText || picked.textContent || '');
      if (!t.includes('新招呼')) return true; // DOM 重渲染了也算完成
      return picked.classList?.contains('selected') ? true : null;
    }, 2500).catch(() => {});
    return true;
  }

  async function openChatResumePanelBestEffort() {
    const waitResumePanel = () => waitFor(
      () =>
        queryAnyDoc('.resume-detail-wrap')
        || queryAnyDoc('.resume-detail.resume-detail-chat')
        || queryAnyDoc('.resume-detail')
        || queryAnyDoc('[class*="resume-detail"]')
        || queryAnyDoc('.resume-common-dialog')
        || queryAnyDoc('[class*="resume-common-dialog"]')
        || queryAnyDoc('[class*="search-resume"]')
        || queryAnyDoc('.geek-base-info-wrap'),
      7000,
    ).catch(() => false);

    const tryOpenByElements = async (elements) => {
      const uniq = Array.from(new Set((elements || []).filter(Boolean)));
      for (const el of uniq) {
        if (!isVisible(el)) continue;
        try { el.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch {}
        simulateClick(el);
        await sleep(320);
        const ok = await waitResumePanel();
        if (ok) return true;
      }
      return false;
    };

    const currentChatList =
      queryAllAnyDoc('.chat-message-list, [class*="chat-message-list"]', 20)
        .filter((el) => isVisible(el))
        .sort((a, b) => {
          const ra = a.getBoundingClientRect?.() || { width: 0, height: 0 };
          const rb = b.getBoundingClientRect?.() || { width: 0, height: 0 };
          return (rb.width * rb.height) - (ra.width * ra.height);
        })[0]
      || null;

    // 若已打开简历面板，直接返回
    try {
      const already =
        queryAnyDoc('.resume-detail-wrap')
        || queryAnyDoc('.resume-detail')
        || queryAnyDoc('[class*="resume-detail"]')
        || queryAnyDoc('.resume-common-dialog')
        || queryAnyDoc('[class*="resume-common-dialog"]')
        || queryAnyDoc('[class*="search-resume"]');
      if (already) return true;
    } catch {}

    // 1) 优先点顶部“简历/在线简历/查看简历”
    const cand = queryAllAnyDoc('a,button,[role="button"],div,span', 1200).filter((el) => isVisible(el));
    const keys = ['简历', '在线简历', '查看简历', '个人简历'];
    const hit = cand.find((el) => {
      const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return t && keys.some((k) => t === k || t.includes(k));
    });
    if (hit) {
      const ok = await tryOpenByElements([hit]);
      if (ok) return true;
    }

    // 1.2) 优先在“当前可见聊天消息列表”里点这位候选人的简历卡
    try {
      if (currentChatList) {
        const resumeCardNodes = [
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume .slide-content-click-content') || []),
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume .base-info-single-main') || []),
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume .content') || []),
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume .position-content') || []),
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume .position-name') || []),
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume .experience-content') || []),
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume li') || []),
          ...Array.from(currentChatList.querySelectorAll?.('.item-resume .value') || []),
        ].filter(Boolean);
        if (await tryOpenByElements(resumeCardNodes)) return true;
      }
    } catch {}

    // 1.5) 你提供的入口：对话框里的“简历简介卡片”（content 内有 time-list/detail-list/position-content）
    try {
      const directCards = [
        queryAnyDoc('.base-info-single-main .slide-content-click-content'),
        queryAnyDoc('.slide-content-click-content'),
        queryAnyDoc('.base-info-single-main.slide-content'),
        queryAnyDoc('.base-info-single-main'),
        queryAnyDoc('[class*="slide-content-click-content"]'),
        queryAnyDoc('[class*="base-info-single-main"]'),
      ];
      if (await tryOpenByElements(directCards)) return true;

      const timeList = queryAnyDoc('.experience-content.time-list') || queryAnyDoc('[class*="experience-content"][class*="time-list"]');
      const detailList = queryAnyDoc('.experience-content.detail-list') || queryAnyDoc('[class*="experience-content"][class*="detail-list"]');
      const pos = queryAnyDoc('.position-content') || queryAnyDoc('[class*="position-content"]');
      const card =
        timeList?.closest?.('.slide-content-click-content') ||
        detailList?.closest?.('.slide-content-click-content') ||
        pos?.closest?.('.slide-content-click-content') ||
        timeList?.closest?.('.base-info-single-main') ||
        detailList?.closest?.('.base-info-single-main') ||
        pos?.closest?.('.base-info-single-main') ||
        timeList?.closest?.('.content') ||
        detailList?.closest?.('.content') ||
        pos?.closest?.('.content') ||
        null;
      const posName = queryAnyDoc('.base-info-single-main .position-name, .position-content .position-name');
      const slideIcon = queryAnyDoc('.base-info-single-main .slide-icon, .base-info-single-main .svg-icon.down');
      if (await tryOpenByElements([card, posName, slideIcon])) return true;
    } catch {}

    // 2) 兜底：尝试点聊天头部候选人名字/头像区域
    const head = queryAnyDoc('[class*="chat-header"], .chat-header, [class*="header"]');
    const nameEl = head?.querySelector?.('.name, .geek-name, [class*="name"]') || null;
    if (nameEl) {
      const avatar = head?.querySelector?.('.avatar-content, .figure, img') || null;
      const ok = await tryOpenByElements([nameEl, avatar, head]);
      return !!ok;
    }
    return false;
  }

  async function closeResumePanelIfPossible() {
    // 复用已有关闭逻辑（尽量不报错）
    await closePopupsIfAny().catch(() => {});
    // 简历面板自身关闭按钮
    try {
      const root = queryAnyDoc('.resume-detail-wrap') || queryAnyDoc('[class*="resume-detail"]');
      const el = root?.querySelector?.('i.icon-close, .icon-close') || queryAnyDoc('i.icon-close, .icon-close');
      if (el && isVisible(el)) simulateClick(el);
    } catch {}
    await sleep(120);
  }

  function isElementDisabledish(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute?.('disabled') != null) return true;
    if (String(el.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true') return true;
    const cls = String(el.className || '');
    if (/\bdisabled\b/i.test(cls)) return true;
    return false;
  }

  function findAskResumeButton({ allowDisabled = false } = {}) {
    const roots = getAllDocs().map((d) => d.body).filter(Boolean);
    const cands = [];
    for (const r of roots) {
      try {
        cands.push(...Array.from(r.querySelectorAll('button,a,[role="button"],span,div')).slice(0, 1000));
      } catch {}
    }
    const matches = cands
      .filter((el) => {
        if (!isVisible(el)) return false;
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return t === '求简历' || t.includes('求简历');
      })
      .map((el) => {
        let s = 0;
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const cls = String(el.className || '');
        if (t === '求简历') s += 30;
        if (/operate-btn/i.test(cls)) s += 20;
        if (el.matches?.('button,a,[role="button"]')) s += 10;
        if (!isElementDisabledish(el)) s += 40;
        else s -= 20;
        return { el, s };
      })
      .filter((x) => allowDisabled ? true : !isElementDisabledish(x.el));

    matches.sort((a, b) => b.s - a.s);
    return matches[0]?.el || null;
  }

  async function clickAskResumeButtonBestEffort() {
    let btn = findAskResumeButton();
    if (!btn) {
      const disabledBtn = findAskResumeButton({ allowDisabled: true });
      if (disabledBtn && isElementDisabledish(disabledBtn)) {
        logInfo('自动回复：检测到“求简历”按钮仍为禁用，等待回复生效后再尝试点击');
        await waitFor(() => {
          const readyBtn = findAskResumeButton();
          return readyBtn && !isElementDisabledish(readyBtn) ? readyBtn : null;
        }, 5000).catch(() => null);
        btn = findAskResumeButton();
      }
    }
    if (!btn) return false;
    await humanApproachElement(btn, { purpose: 'toolbar' });
    simulateClick(btn);
    await humanPause(180, 320);
    // 可能有确认弹窗：点 primary
    try {
      const confirm =
        queryAnyDoc('.boss-btn-primary')
        || queryAnyDoc('button.boss-btn-primary')
        || findElementByTextIncludes(['确定', '确认'])?.closest?.('button,a,[role="button"]');
      if (confirm && isVisible(confirm)) {
        await humanApproachElement(confirm, { purpose: 'toolbar' });
        simulateClick(confirm);
      }
    } catch {}
    await backoffIfTooFrequent('求简历');
    return true;
  }

  async function fetchBossCommonPhrasesFromUi() {
    // 需要处于沟通页，且打开任意会话（才能看到输入区工具栏）
    const icon = queryAnyDoc('.toolbar-icon.changyongyu') || document.querySelector('.toolbar-icon.changyongyu');
    // 若尚未打开会话：自动点开第一条会话再试一次
    if (!icon) {
      const first =
        queryAnyDoc('.friend-list-item')
        || document.querySelector('.friend-list-item')
        || queryAnyDoc('.geek-item[data-id], .geek-item')
        || document.querySelector('.geek-item[data-id], .geek-item');
      if (first) {
        simulateClick(first);
        await sleep(650);
      }
    }
    const icon2 = queryAnyDoc('.toolbar-icon.changyongyu') || document.querySelector('.toolbar-icon.changyongyu');
    if (!icon2) throw new Error('未找到“常用语”按钮（请先打开任意会话对话框）');

    // 打开常用语面板/下拉
    simulateClick(icon2);
    await sleep(220);

    // 精确命中你给的结构的稳定特征：li[title] 内包含 span.phrase-send
    {
      const sendBtns = getAllDocs().flatMap((d) => Array.from(d.querySelectorAll?.('span.phrase-send') || []));
      const lis = sendBtns.map((b) => b.closest?.('li[title]') || null).filter(Boolean);
      const texts = lis.map((li) => String(li.getAttribute('title') || '').trim()).filter((t) => t.length >= 2);
      const uniq = Array.from(new Set(texts)).slice(0, 80);
      if (uniq.length) return uniq;
    }

    // 兜底：在所有同源 doc 中找“明显像常用语列表”的可点击项
    const docs = getAllDocs();
    const items = [];
    for (const d of docs) {
      let nodes = [];
      try {
        nodes = Array.from(d.querySelectorAll?.('li, div, span, a, button') || []);
      } catch {}
      for (const el of nodes.slice(0, 1200)) {
        if (!isVisible(el)) continue;
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (t.length < 2 || t.length > 120) continue;
        // 排除明显不是常用语：顶部菜单/岗位/发送按钮等
        if (t === '发送' || t.includes('求简历') || t.includes('新招呼')) continue;
        // 常用语通常是纯文本且可点击
        const clickable = el.closest?.('li,button,a,[role="button"]') || el;
        if (!isVisible(clickable)) continue;
        // 避免把整页文本都扫进来：只收集含有“常用语弹层”痕迹的区域优先
        const cls = String(clickable.className || '');
        if (/phrase|common|changyongyu|popover|dropdown|menu|list/i.test(cls)) {
          items.push(t);
        }
      }
    }

    // 如果没抓到：再放宽一次（直接从 icon 附近弹层扫描）
    if (items.length === 0) {
      const around = icon.closest?.('[class*="tool"],[class*="toolbar"],[class*="editor"],[class*="chat"]') || document.body;
      const nodes = Array.from(around.querySelectorAll?.('li,button,a,[role="button"],div,span') || []);
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (t.length < 2 || t.length > 120) continue;
        if (t === '发送' || t.includes('求简历') || t.includes('新招呼')) continue;
        items.push(t);
      }
    }

    const uniq = Array.from(new Set(items.map((x) => String(x).trim()).filter(Boolean))).slice(0, 60);
    if (uniq.length === 0) throw new Error('未抓到常用语列表（请点一下常用语按钮，确保弹层已展开）');
    return uniq;
  }

  async function sendBossCommonPhrase(phraseText) {
    const phrase = String(phraseText || '').replace(/\s+/g, ' ').trim();
    if (!phrase) return true;

    const icon = queryAnyDoc('.toolbar-icon.changyongyu') || document.querySelector('.toolbar-icon.changyongyu');
    if (!icon) return false;

    simulateClick(icon);
    await sleep(220);

    // 精确命中：按 li[title] 匹配，点它里面的 span.phrase-send
    {
      const sendBtns = getAllDocs().flatMap((d) => Array.from(d.querySelectorAll?.('span.phrase-send') || []));
      const lis = sendBtns.map((b) => b.closest?.('li[title]') || null).filter(Boolean);
      if (lis.length) {
        const want = String(phraseText || '').trim();
        const normWant = normalizeForMatch(want);
        let best = null;
        let bestScore = -Infinity;
        for (const li of lis) {
          const title = String(li.getAttribute('title') || '').trim();
          const normTitle = normalizeForMatch(title);
          let s = 0;
          if (title === want) s += 100;
          if (normTitle === normWant) s += 80;
          if (normTitle.includes(normWant)) s += 55;
          if (normWant.includes(normTitle) && normTitle.length >= 6) s += 18;
          const sendBtn = li.querySelector?.('span.phrase-send') || null;
          if (!sendBtn) s -= 40;
          if (sendBtn && isVisible(sendBtn)) s += 6;
          if (s > bestScore) {
            bestScore = s;
            best = { li, sendBtn, title };
          }
        }
        if (best && bestScore >= 40 && best.sendBtn) {
          simulateClick(best.sendBtn);
          await sleep(180);
          return true; // 点“发送”即视为成功（Boss 会直接发出）
        }
      }
    }

    // 在弹层里找匹配项：优先精确，其次包含
    const docs = getAllDocs();
    const candidates = [];
    for (const d of docs) {
      let nodes = [];
      try { nodes = Array.from(d.querySelectorAll?.('li,button,a,[role="button"],div,span') || []); } catch { nodes = []; }
      for (const el of nodes.slice(0, 1600)) {
        if (!isVisible(el)) continue;
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        let s = 0;
        if (t === phrase) s += 100;
        if (t.includes(phrase)) s += 70;
        if (phrase.includes(t) && t.length >= 4) s += 35;
        const clickEl = el.closest?.('li,button,a,[role="button"]') || el;
        if (/disabled/i.test(String(clickEl.className || ''))) s -= 30;
        if (s > 30) candidates.push({ el: clickEl, s, t });
      }
    }
    candidates.sort((a, b) => b.s - a.s);
    const picked = candidates[0]?.el || null;
    if (!picked) return false;

    simulateClick(picked);
    await sleep(120);

    // Boss 常用语通常会直接发送，部分版本是“插入输入框”——这里统一点一次发送按钮兜底
    const composer = locateChatComposer();
    if (!composer?.sendBtn) return true;
    const before = readInputText(composer.input);
    simulateClick(composer.sendBtn);
    const ok = await waitFor(() => {
      const now = readInputText(composer.input);
      if (!now) return true;
      if (before && now !== before && now.length < 3) return true;
      return null;
    }, 2500).catch(() => false);
    return !!ok;
  }

  async function clickAttachmentResumeAgreeBestEffort() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const direct = findAttachmentResumeAgreeCandidate();
      if (direct?.el) {
        await humanApproachElement(direct.el, { purpose: 'toolbar' });
        simulateClick(direct.el);
        const ok = await waitForAttachmentResumeAgreeApplied(direct.root).catch(() => false);
        if (ok) return true;
      }

      const generic = findGenericAttachmentResumeAgreeCandidate();
      if (generic?.el) {
        await humanApproachElement(generic.el, { purpose: 'toolbar' });
        simulateClick(generic.el);
        const ok = await waitForAttachmentResumeAgreeApplied(generic.root).catch(() => false);
        if (ok) return true;
      }

      await sleep(220);
    }
    return false;
  }

  function findAttachmentResumeAgreeCandidate() {
    const cards = queryAllAnyDoc('.message-card-wrap', 120).filter((card) => {
      if (!isVisible(card)) return false;
      const text = String(card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
      return /对方想发送附件简历给您/.test(text);
    });
    if (!cards.length) return null;

    const scored = cards.map((card) => {
      const buttons = Array.from(card.querySelectorAll?.('.message-card-buttons .card-btn, .card-btn, a, button, [role="button"]') || [])
        .filter((el) => isVisible(el));
      const agree =
        buttons.find((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() === '同意' && !isElementDisabledish(el))
        || null;
      let score = 0;
      if (card.matches?.('.boss-green')) score += 20;
      if (agree) score += 120;
      if (buttons.length >= 2) score += 10;
      return { card, agree, score };
    }).filter((x) => !!x.agree);

    scored.sort((a, b) => b.score - a.score);
    const picked = scored[0] || null;
    return picked ? { el: picked.agree, root: picked.card } : null;
  }

  function findGenericAttachmentResumeAgreeCandidate() {
    const docs = getAllDocs();
    const candidates = [];
    for (const d of docs) {
      let nodes = [];
      try { nodes = Array.from(d.querySelectorAll?.('a,button,[role="button"],span,div') || []); } catch {}
      for (const el of nodes.slice(0, 1200)) {
        if (!isVisible(el)) continue;
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text !== '同意') continue;
        let score = 0;
        const clickEl = el.closest?.('.card-btn, .message-card-buttons .card-btn, a, button, [role="button"]') || el;
        if (isElementDisabledish(clickEl)) continue;
        const root = el.closest?.('.message-card-wrap, .message-item, .item-resume, .chat-message-list, .dialog, .boss-dialog, [class*="dialog"], body') || clickEl;
        const rootText = String(root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
        if (/附件简历|附件|简历|同意查看|查看简历|在线简历/.test(rootText)) score += 80;
        if (/对方想发送附件简历给您/.test(rootText)) score += 60;
        if (clickEl.matches?.('a.btn, button.btn, .btn')) score += 20;
        if (clickEl.matches?.('.card-btn')) score += 25;
        candidates.push({ el: clickEl, score, root });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const picked = candidates[0] || null;
    return picked && picked.score >= 20 ? picked : null;
  }

  async function waitForAttachmentResumeAgreeApplied(root = null) {
    return await waitFor(() => {
      if (root) {
        if (!root.isConnected || !isVisible(root)) return true;
        const rootText = String(root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/对方想发送附件简历给您/.test(rootText)) return true;
      }
      const previewCard = queryAllAnyDoc('.message-card-wrap', 120).some((card) => {
        if (!isVisible(card)) return false;
        const text = String(card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim();
        return /点击预览附件简历|\.pdf\b|附件简历/.test(text);
      });
      if (previewCard) return true;
      return null;
    }, 1800).catch(() => false);
  }

  function getChatResumeCardText() {
    const docs = getAllDocs();
    const nodes = [];
    for (const d of docs) {
      try {
        nodes.push(...Array.from(d.querySelectorAll?.('.chat-message-list .item-resume .content, .chat-message-list .item-resume .base-info-single-main, .chat-message-list .item-resume .slide-content-click-content') || []));
      } catch {}
    }
    const visible = nodes.filter(isVisible);
    const picked = visible[visible.length - 1] || null;
    return String(picked?.innerText || picked?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  async function quickScreenChatResumeCardAgainstJd(cardText, jobContext = null) {
    const text = String(cardText || '').replace(/\s+/g, ' ').trim();
    const position = String(jobContext?.positionName || getCurrentReplyJobName() || '').trim();
    const jd = String(jobContext?.jdText || settings.jdText || '').trim();
    if (!text || !position || !jd) return { skip: false, reason: '' };

    const hasAiConfig = !!(settings.ai?.baseUrl && settings.ai?.apiKey && settings.ai?.model);
    if (!hasAiConfig) return { skip: false, reason: '' };

    const system = [
      '你是招聘聊天助手，负责根据聊天里展示的候选人简历摘要，判断是否已经明显不匹配到可以直接跳过。',
      '只允许输出严格 JSON，不要输出额外解释。',
      '只有在岗位方向、期望岗位、最近经历与目标岗位差异非常明显时，skip 才能为 true。',
      '如果只是信息不完整、可能相关但不确定、仍值得打开完整简历，就必须返回 skip=false。',
      '输出 JSON：{"skip":true,"reason":"..."}',
    ].join('\\n');

    const user = [
      `目标岗位：${position}`,
      '',
      '岗位JD（节选）：',
      jd.slice(0, 1400),
      '',
      '聊天简历摘要：',
      text.slice(0, 1200),
    ].join('\\n');

    const { json, usage } = await callAiJson(system, user, { temperature: 0, max_tokens: 180 });
    if (usage) await recordAiUsage(usage).catch(() => {});
    const skip = !!json?.skip;
    const reason = String(json?.reason || '').replace(/\s+/g, ' ').trim();
    return {
      skip,
      reason: skip ? `聊天摘要预判不匹配；${reason || '岗位方向差异大'}` : '',
    };
  }

  function getReplyConversationPrefilterText() {
    const selectors = [
      '.chat-message-list .item-resume .content',
      '.chat-message-list .item-resume .base-info-single-main',
      '.chat-message-list .item-resume .slide-content-click-content',
      '.base-info-single-main',
      '.slide-content-click-content',
      '.position-content',
      '.experience-content.time-list',
      '.experience-content.detail-list',
    ];
    const chunks = [];
    for (const sel of selectors) {
      const nodes = queryAllAnyDoc(sel, 60).filter((el) => isVisible(el));
      for (const el of nodes) {
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 2) continue;
        chunks.push(text);
      }
    }
    return Array.from(new Set(chunks)).join('\n');
  }

  function screenReplySummaryAgainstFilters(summaryText, jobContext = null) {
    const text = String(summaryText || '').replace(/\s+/g, ' ').trim();
    if (!text) return { pass: true, why: '' };
    const filters = getJobScopedReplyFilters(jobContext);
    const age = extractAgeFromText(text);
    if (age) {
      if (filters.minAge > 0 && age < filters.minAge) return { pass: false, why: `年龄${age}<${filters.minAge}` };
      if (filters.maxAge > 0 && age > filters.maxAge) return { pass: false, why: `年龄${age}>${filters.maxAge}` };
    }
    if (String(filters.minEdu || '0') !== '0') {
      const eduResult = evaluateEduRequirement(text, filters.minEdu);
      if (!eduResult.pass) return { pass: false, why: eduResult.reason };
    }
    return { pass: true, why: '' };
  }

  async function screenResumeAgainstJdForReply(resumeText, jobContext = null) {
    const jd = String(jobContext?.jdText || settings.jdText || '').trim();
    const threshold = clampInt(settings.thresholds?.passScore ?? 60, 0, 100);
    if (!jd) return { pass: false, why: '未填写JD', score: null, threshold };

    // 自动回复使用“当前会话岗位”对应的主动寻访配置；若该岗位未配置，则只按 JD 匹配。
    const filters = getJobScopedReplyFilters(jobContext);
    const age = extractAgeFromText(resumeText);
    if (age) {
      if (filters.minAge > 0 && age < filters.minAge) return { pass: false, why: `年龄${age}<${filters.minAge}`, score: 0, threshold };
      if (filters.maxAge > 0 && age > filters.maxAge) return { pass: false, why: `年龄${age}>${filters.maxAge}`, score: 0, threshold };
    }
    if (String(filters.minEdu || '0') !== '0') {
      const eduResult = evaluateEduRequirement(resumeText, filters.minEdu);
      if (!eduResult.pass) return { pass: false, why: eduResult.reason, score: 0, threshold };
    }

    // AI/无AI：复用当前设置
    const hasAiConfig = !!(settings.ai?.baseUrl && settings.ai?.apiKey && settings.ai?.model);
    const requestedMode = String(settings.outreachMode || 'auto');
    const effectiveMode = requestedMode === 'auto' ? (hasAiConfig ? 'ai' : 'noai') : requestedMode;
    const useAi = hasAiConfig && effectiveMode === 'ai';

    if (useAi) {
      const r = await aiDecideStage2(resumeText, jobContext, filters);
      if (r?.usage) await recordAiUsage(r.usage).catch(() => {});
      return { pass: !!r.decision, why: `AI评分${r.score}${r.reason ? `；${r.reason}` : ''}`, score: Number(r.score), threshold };
    }

    const r2 = keywordDecide(resumeText, filters);
    return {
      pass: !!r2.decision,
      why: r2.reason || (r2.decision ? '关键词通过' : '关键词未通过'),
      score: Number.isFinite(Number(r2.score)) ? Number(r2.score) : null,
      threshold,
    };
  }

  // ====== Boss DOM helpers ======

  function getCandidateActionRoot(card) {
    if (!card) return null;
    return card.matches?.('a[data-geekid], a[data-eid], li.geek-info-card, .candidate-card-wrap, .card-inner.new-geek-wrap[data-geek]')
      ? card
      : card.closest?.('a[data-geekid], a[data-eid], li.geek-info-card, .candidate-card-wrap, .card-inner.new-geek-wrap[data-geek]')
        || card.querySelector?.('a[data-geekid], a[data-eid], .card-inner.new-geek-wrap[data-geek]')
        || card.closest?.('li.geek-info-card')
        || card.closest?.('.candidate-card-wrap')
        || card.querySelector?.('li.geek-info-card')
        || card.querySelector?.('.candidate-card-wrap')
        || card;
  }

  function isLikelyCandidateCard(el) {
    if (!el) return false;
    if (el.matches?.('a[data-geekid], a[data-eid], li.geek-info-card')) {
      return !!el.querySelector?.('.name-label, .geek-info-detail, .search-geek-avatar, .item-operate');
    }
    if (el.matches?.('.candidate-card-wrap, .card-inner.new-geek-wrap[data-geek]')) {
      return !!el.querySelector?.('.name, .name-wrap, .geek-desc, .chat-button-wrap, .btn-greet');
    }
    if (el.matches?.('.card-container, [class*="card-container"]')) {
      return !!el.querySelector?.('.name-label, .geek-info-detail, .search-geek-avatar');
    }
    const hasId = !!(
      el.getAttribute?.('data-geek-id')
      || el.getAttribute?.('data-geekid')
      || el.getAttribute?.('data-geek')
      || el.getAttribute?.('data-id')
      || el.id
    );
    const hasNameEl = !!el.querySelector?.('.name, .geek-name, [class*="name"]');
    const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return hasId || hasNameEl || text.length >= 12;
  }

  function findCandidateCards() {
    const selectors = [
      '.recommend-care-list li.geek-info-card > a[data-geekid]',
      '.recommend-care-list li.geek-info-card > a[data-eid]',
      '.candidate-recommend li.geek-info-card > a[data-geekid]',
      '.candidate-recommend li.geek-info-card > a[data-eid]',
      'li.geek-info-card > a[data-geekid]',
      'li.geek-info-card > a[data-eid]',
      'li.geek-info-card',
      '.card-container.css-type-1',
      '.card-container',
      '[class*="card-container"]',
      '#recommend-list > .candidate-card-wrap',
      '#recommend-list .candidate-card-wrap',
      '.recommend-wrap #recommend-list .candidate-card-wrap',
      '.recommend-wrap .candidate-card-wrap',
      '.candidate-card-wrap',
      '[class*="candidate-card-wrap"]',
      '.geek-item',
      '[class*="geek-item"]',
      '.geek-info-card',
      '[class*="geek-info-card"]',
      '.card-inner',
      '[class*="card-inner"]',
      '[role="listitem"]',
    ];

    const docs = getRecommendContextDocs();

    for (const sel of selectors) {
      const els = docs
        .flatMap((d) => {
          try { return Array.from(d.querySelectorAll?.(sel) || []); } catch { return []; }
        });
      if (els.length > 0) {
        // 防止把“相似经历的牛人”推荐卡片当成候选人卡片；并优先按当前页面可见顺序处理。
        const filtered = els.filter((el) => {
          if (el?.classList?.contains('anonymous-geek-card')) return false;
          if (el?.closest?.('.resume-anonymous-geek-card, .anonymous-geek-card, .dialog-lib-resume, .boss-dialog__wrapper, .boss-dialog, .resume-layout-wrap')) return false;
          if (!isVisible(el)) return false;
          if (!isLikelyCandidateCard(el)) return false;
          if (
            (sel.includes('geek-info-card') || sel.includes('[data-geekid]') || sel.includes('[data-eid]'))
            && !el.closest?.('.recommend-care-list, .candidate-recommend, .candidate-body, .recommend-care, .recommend-wrap')
          ) {
            return false;
          }
          if (
            sel.includes('card-inner')
            && el.closest?.('.card-container, [class*="card-container"]')
          ) {
            return false;
          }
          if (
            (sel.includes('card-container') || sel.includes('card-inner'))
            && !el.closest?.('#recommend-list, .recommend-wrap, .candidate-body, .candidate-recommend, .recommend-care-list, li.geek-info-card, .candidate-card-wrap')
          ) {
            return false;
          }
          if (
            sel.includes('candidate-card-wrap')
            && !el.closest?.('#recommend-list, .recommend-wrap, [class*="recommend-list"], [class*="candidate-list"]')
          ) {
            return false;
          }
          return true;
        });
        if (!filtered.length) continue;
        const uniq = uniqBy(filtered, (el) => el);
        return uniq.sort((a, b) => {
          const ra = a.getBoundingClientRect?.() || { top: 0, left: 0 };
          const rb = b.getBoundingClientRect?.() || { top: 0, left: 0 };
          if (ra.top !== rb.top) return ra.top - rb.top;
          return ra.left - rb.left;
        });
      }
    }
    return [];
  }

  function getCandidateName(card) {
    const root = getCandidateActionRoot(card) || card;
    const nameEl = root.querySelector('.name-label, [class*="name-label"], .name, .geek-name, [class*="geek-name"], [class*="name"]');
    const txt = (nameEl?.textContent || root.textContent || '').trim();
    if (!txt) return '';
    // Boss 卡片通常 name 先出现，取第一行/第一段短文本
    const first = txt.split(/\s|\n/).filter(Boolean)[0] || '';
    return first.length <= 15 ? first : '';
  }

  function extractAgeFromText(text) {
    const s = String(text || '');
    if (!s) return 0;
    const m = s.match(/(\d{2})\s*岁/);
    if (!m?.[1]) return 0;
    const age = parseInt(m[1], 10);
    if (!Number.isFinite(age)) return 0;
    if (age < 16 || age > 70) return 0;
    return age;
  }

  /**
   * 1.1.x：提取"当前 gap 月数" —— 今天 - 最近一段已结束工作的结束日期
   *   - 如果任何一段写的是"至今 / present / now / currently" → 视为在职，返回 0（无 gap）
   *   - 如果识别不到日期范围 → 返回 0（不淘汰，避免误伤）
   *   - 否则返回月数（向下取整）
   * 简历常见格式：
   *   "2023.05 - 2024.11"  "2023/05 - 2024/11"  "2023.05 - 至今"  "2023.05 ~ 2024.11"
   */
  function extractCurrentGapMonthsFromText(text) {
    const s = String(text || '');
    if (!s) return 0;
    const re = /(\d{4})\s*[\.\/\-年]\s*(\d{1,2})\s*月?\s*[-~–—至到]\s*(\d{4}\s*[\.\/\-年]?\s*\d{1,2}|至今|present|now|currently)/gi;
    let m;
    let latestEnd = null;       // {y, mo}
    let stillEmployed = false;
    while ((m = re.exec(s)) !== null) {
      const tail = m[3];
      if (/至今|present|now|currently/i.test(tail)) {
        stillEmployed = true;
        continue;
      }
      const tailM = tail.match(/(\d{4})\s*[\.\/\-年]?\s*(\d{1,2})/);
      if (!tailM) continue;
      const y = parseInt(tailM[1], 10);
      const mo = parseInt(tailM[2], 10);
      if (!y || !mo || mo < 1 || mo > 12) continue;
      if (!latestEnd || y > latestEnd.y || (y === latestEnd.y && mo > latestEnd.mo)) {
        latestEnd = { y, mo };
      }
    }
    if (stillEmployed) return 0;
    if (!latestEnd) return 0;
    const now = new Date();
    const months = (now.getFullYear() - latestEnd.y) * 12 + (now.getMonth() + 1 - latestEnd.mo);
    return Math.max(0, months);
  }

  function extractEduLevelFromText(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (!s) return 0;
    // 由高到低匹配，避免“本科”被“专科/大专”等干扰
    const map = [
      { k: '博士', v: 6 },
      { k: '博士后', v: 6 },
      { k: '硕士', v: 5 },
      { k: '研究生', v: 5 },
      { k: '本科', v: 4 },
      { k: '学士', v: 4 },
      { k: '大专', v: 3 },
      { k: '专科', v: 3 },
      { k: '中专', v: 2 },
      { k: '高中', v: 2 },
      { k: '初中', v: 1 },
    ];
    for (const it of map) {
      if (s.includes(it.k)) return it.v;
    }
    return 0;
  }

  function eduLabel(level) {
    const raw = normalizeEduRequirement(level);
    if (raw === '985') return '985院校';
    if (raw === '211') return '211院校';
    if (raw === 'art') return '八大美院（含中传、北电）';
    const n = parseInt(String(raw || '0'), 10);
    if (n >= 6) return '博士';
    if (n >= 5) return '硕士';
    if (n >= 4) return '本科';
    if (n >= 3) return '大专';
    if (n >= 2) return '高中/中专';
    if (n >= 1) return '初中';
    return '';
  }

  function normalizeEduRequirement(value) {
    const raw = String(value ?? '').trim();
    if (['3', '4', '5', '6', '985', '211', 'art'].includes(raw)) return raw;
    return '0';
  }

  function isDegreeEduRequirement(value) {
    return ['3', '4', '5', '6'].includes(normalizeEduRequirement(value));
  }

  function normalizeSchoolMatchText(text) {
    return String(text || '').replace(/\s+/g, '').replace(/[（(].*?[）)]/g, '');
  }

  function matchSchoolGroup(text, groupKey) {
    const normalized = normalizeSchoolMatchText(text);
    const group = SCHOOL_GROUPS[groupKey] || [];
    for (const name of group) {
      const target = normalizeSchoolMatchText(name);
      if (target && normalized.includes(target)) return name;
    }
    if (groupKey === 'art') {
      const hasTsinghua = normalized.includes(normalizeSchoolMatchText('清华大学'));
      const hasArtHint = ART_MAJOR_KEYWORDS.some((kw) => normalized.includes(normalizeSchoolMatchText(kw)));
      if (hasTsinghua && hasArtHint) return '清华大学美术学院';
    }
    return '';
  }

  function evaluateEduRequirement(text, requirement) {
    const req = normalizeEduRequirement(requirement);
    if (req === '0') return { pass: true, reason: '' };

    if (isDegreeEduRequirement(req)) {
      const edu = extractEduLevelFromText(text);
      if (edu && edu < Number(req)) {
        return { pass: false, reason: `学历过滤：${eduLabel(edu)} < ${eduLabel(req)}` };
      }
      return { pass: true, reason: '' };
    }

    const matched = matchSchoolGroup(text, req);
    if (matched) return { pass: true, reason: '' };
    return { pass: false, reason: `院校过滤：未命中${eduLabel(req)}` };
  }

  /**
   * 1.1.3：列出该候选人所有可能的存储 key
   * 历史 bug：getCandidateIdInfo 在不同运行返回不同 key（API 截到的快慢决定走 geekId 还是 domGeekId），
   * 导致 processed[key] miss → 重复跑 AI。
   * 用 *所有* 可能的 key 同时去查 processed，命中任一即视为同一人。
   */
  function collectAllCandidateKeys(name, card) {
    const out = [];
    try {
      const apiItem = latestGeekByName.get(name);
      const apiGeekId = apiItem?.geekCard?.geekId || apiItem?.geekId || null;
      const apiEid = apiItem?.encryptGeekId || apiItem?.geekCard?.encryptGeekId || null;
      if (apiGeekId) out.push(`geekId:${apiGeekId}`);
      if (apiEid) out.push(`encryptGeekId:${apiEid}`);

      const root = (typeof getCandidateActionRoot === 'function') ? (getCandidateActionRoot(card) || card) : card;
      const sel = 'a[data-geekid], a[data-eid], [data-geekid], [data-eid], [data-geek], [data-geek-id]';
      const dataNode = root?.matches?.(sel)
        ? root
        : root?.querySelector?.(sel) || root?.closest?.(sel) || null;
      const domGeekId =
        dataNode?.getAttribute?.('data-geekid')
        || dataNode?.getAttribute?.('data-geek-id')
        || dataNode?.getAttribute?.('data-geek')
        || null;
      const domEid =
        dataNode?.getAttribute?.('data-eid')
        || dataNode?.getAttribute?.('data-encryptgeekid')
        || null;
      if (domGeekId) out.push(`domGeekId:${domGeekId}`);
      if (domEid) out.push(`domEncryptGeekId:${domEid}`);
      const domId =
        domGeekId
        || domEid
        || root?.getAttribute?.('data-geek-id')
        || root?.getAttribute?.('data-geekid')
        || root?.getAttribute?.('data-geek')
        || root?.getAttribute?.('data-id')
        || root?.id
        || null;
      if (domId && !out.some(k => k.endsWith(`:${domId}`))) out.push(`domId:${domId}`);
      if (name) out.push(`name:${name}`);
    } catch (_) {}
    // 去重保序
    const seen = new Set();
    return out.filter(k => (k && !seen.has(k) && (seen.add(k) || true)));
  }

  /**
   * 1.1.x：写完主 key 后，把同一条记录交叉写到候选人的所有候选 key 下
   *   背景：原写入只存一个主 key（比如 encryptGeekId:xxx）。下次刷新页面 API 还没回来时，
   *        当前 idInfo 只有 domGeekId / name → 找不到 → AI 重复评分浪费 token。
   *   修复：写入完成后立即把同一条记录冗余写到所有 collectAllCandidateKeys 下。
   *        读取 / 显示侧用 dedupeProcessedRecords 去重，所以不会重复展示。
   */
  function crossLinkProcessedToAllKeys(processed, name, card, primaryKey) {
    if (!processed || !primaryKey) return;
    const record = processed[primaryKey];
    if (!record) return;
    const allKeys = collectAllCandidateKeys(name, card);
    for (const k of allKeys) {
      if (k && k !== primaryKey) processed[k] = record;
    }
  }

  /**
   * 1.1.x：判断已处理记录是否属于"当前选中岗位"
   *   - 缺失 jobKey（旧版本写入的记录）→ 视为同岗位，按旧行为照常跳过，避免破坏老用户习惯
   *   - 有 jobKey → 仅当与当前 jobKey 相同时才视为已处理
   * 当前岗位下被命中过的候选人不会被重新筛选；
   * 切换到其他岗位时，同一候选人会被作为新岗位重新评分。
   */
  function isProcessedHitForCurrentJob(prevHit, currentJobKey) {
    if (!prevHit) return false;
    const recordedJobKey = String(prevHit?.jobKey || '').trim();
    if (!recordedJobKey) return true; // 旧数据兼容：没记录岗位 → 仍然算"已处理"
    return recordedJobKey === String(currentJobKey || '').trim();
  }

  /**
   * 用所有可能 key 查 processed 字典；命中后把记录交叉链到所有 key 下，
   * 这样下一次任何一个 key 都能直接命中。
   */
  function findAndCanonicalizeProcessed(processedMap, name, card) {
    if (!processedMap || typeof processedMap !== 'object') return null;
    const keys = collectAllCandidateKeys(name, card);
    if (keys.length === 0) return null;
    let hit = null;
    for (const k of keys) {
      if (processedMap[k]) { hit = processedMap[k]; break; }
    }
    if (!hit) return null;
    // 交叉链：把记录写到所有 alt key 下，下次直接命中
    for (const k of keys) {
      if (!processedMap[k]) processedMap[k] = hit;
    }
    return hit;
  }

  function getCandidateIdInfo(name, card) {
    const apiItem = latestGeekByName.get(name);
    const geekId = apiItem?.geekCard?.geekId || apiItem?.geekId || null;
    const encryptGeekId = apiItem?.encryptGeekId || apiItem?.geekCard?.encryptGeekId || null;
    const root = getCandidateActionRoot(card) || card;
    const dataNode = root.matches?.('a[data-geekid], a[data-eid], [data-geekid], [data-eid], [data-geek]')
      ? root
      : root.querySelector?.('a[data-geekid], a[data-eid], [data-geekid], [data-eid], [data-geek]')
        || root.closest?.('a[data-geekid], a[data-eid], [data-geekid], [data-eid], [data-geek]')
        || null;
    const domGeekId =
      dataNode?.getAttribute?.('data-geekid')
      || dataNode?.getAttribute?.('data-geek-id')
      || dataNode?.getAttribute?.('data-geek')
      || null;
    const domEncryptGeekId =
      dataNode?.getAttribute?.('data-eid')
      || dataNode?.getAttribute?.('data-encryptgeekid')
      || null;

    const domId =
      domGeekId ||
      domEncryptGeekId ||
      root.getAttribute?.('data-geek-id') ||
      root.getAttribute?.('data-geekid') ||
      root.getAttribute?.('data-geek') ||
      root.getAttribute?.('data-id') ||
      root.id ||
      null;

    // 精选/推荐/最新列表里 DOM 自带的候选人 id 最稳定，优先使用；
    // 名字是脱敏的“张**/王**”，不能作为主锚点，API 名字映射只作为兜底。
    // 1.1.1：始终把 name 写进返回值，让调用方（含历史/统计页）能直接用姓名展示
    // 1.1.x：把 geekId / encryptGeekId 冗余写进返回值（无论 type 取哪个），
    //        这样历史/统计页可以直接用 encryptGeekId 构造候选人简历跳转 URL
    const nameStr = String(name || '').trim();
    const extras = {};
    const numericGeekId = geekId || (domGeekId && /^\d+$/.test(String(domGeekId)) ? domGeekId : null);
    if (numericGeekId) extras.geekId = String(numericGeekId);
    const encId = encryptGeekId || (domEncryptGeekId || (domGeekId && !/^\d+$/.test(String(domGeekId)) ? domGeekId : null));
    if (encId) extras.encryptGeekId = String(encId);
    if (domGeekId) return { type: 'domGeekId', id: String(domGeekId), key: `domGeekId:${domGeekId}`, display: `GID:${String(domGeekId).slice(0, 8)}…`, name: nameStr, ...extras };
    if (domEncryptGeekId) return { type: 'domEncryptGeekId', id: String(domEncryptGeekId), key: `domEncryptGeekId:${domEncryptGeekId}`, display: `EID:${String(domEncryptGeekId).slice(0, 8)}…`, name: nameStr, ...extras };
    if (domId) return { type: 'domId', id: String(domId), key: `domId:${domId}`, display: `DOM:${String(domId).slice(0, 12)}`, name: nameStr, ...extras };
    if (geekId) return { type: 'geekId', id: String(geekId), key: `geekId:${geekId}`, display: `ID:${geekId}`, name: nameStr, ...extras };
    if (encryptGeekId) return { type: 'encryptGeekId', id: String(encryptGeekId), key: `encryptGeekId:${encryptGeekId}`, display: `EID:${String(encryptGeekId).slice(0, 6)}…`, name: nameStr, ...extras };
    return { type: 'name', id: nameStr, key: `name:${nameStr}`, display: '', name: nameStr, ...extras };
  }

  function buildCandidateAnchor(card) {
    if (!card) return null;
    const name = getCandidateName(card);
    const idInfo = getCandidateIdInfo(name, card);
    const fallback = String(name || card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return {
      key: String(idInfo?.key || ''),
      fallback,
    };
  }

  function isSameCandidateAnchor(anchor, card) {
    if (!anchor || !card) return false;
    const name = getCandidateName(card);
    const idInfo = getCandidateIdInfo(name, card);
    const key = String(idInfo?.key || '');
    if (anchor.key && key) return anchor.key === key;
    const fallback = String(name || card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return !!fallback && fallback === String(anchor.fallback || '');
  }

  function buildSimpleCandidateInfo(name, card) {
    const apiItem = latestGeekByName.get(name);
    if (apiItem?.geekCard) {
      return formatGeekCardInfo(apiItem.geekCard, apiItem);
    }
    const text = (card.innerText || '').trim().replace(/\n{3,}/g, '\n\n');
    const idInfo = getCandidateIdInfo(name, card);
    const idLine = idInfo.type !== 'name' ? `候选人ID: ${idInfo.id}\n` : '';
    return `姓名: ${name}\n${idLine}\n卡片信息:\n${text}`;
  }

  function pickLatestCardFallbackText(card) {
    if (!card) return '';
    try {
      const clone = card.cloneNode(true);
      for (const sel of [
        '.operate-side',
        '[class*="operate-side"]',
        '.chat-button-wrap',
        '[class*="chat-button-wrap"]',
        '.button-chat-wrap',
        '[class*="button-chat-wrap"]',
        'button',
        '.btn',
        '[class*="btn-"]',
        '.tooltip-wrap',
        '[class*="tooltip-wrap"]',
        '.icon',
        '.svg-icon',
      ]) {
        const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
        for (const n of nodes) {
          try { n.remove(); } catch {}
        }
      }
      const text = String(clone.innerText || clone.textContent || '').trim().replace(/\n{3,}/g, '\n\n');
      if (!text || text.length < 80) return '';
      return text.slice(0, 6000);
    } catch {
      return '';
    }
  }

  function formatGeekCardInfo(gc, raw) {
    const lines = [];
    lines.push(`姓名: ${gc.geekName || ''}`);
    if (gc.geekId) lines.push(`候选人ID: ${gc.geekId}`);
    if (gc.ageDesc) lines.push(`年龄: ${gc.ageDesc}`);
    if (gc.geekWorkYear) lines.push(`工作年限: ${gc.geekWorkYear}`);
    if (gc.geekDegree) lines.push(`学历: ${gc.geekDegree}`);
    if (gc.geekEdu?.school) lines.push(`毕业院校: ${gc.geekEdu.school}`);
    if (gc.geekEdu?.major) lines.push(`专业: ${gc.geekEdu.major}`);
    if (gc.salary) lines.push(`期望薪资: ${gc.salary}`);
    if (gc.expectPositionName) lines.push(`期望职位: ${gc.expectPositionName}`);
    if (gc.expectLocationName) lines.push(`期望地点: ${gc.expectLocationName}`);
    if (gc.applyStatusDesc) lines.push(`状态: ${gc.applyStatusDesc}`);
    if (gc.geekDesc?.content) lines.push(`自我介绍: ${gc.geekDesc.content}`);
    if (Array.isArray(gc.geekWorks) && gc.geekWorks.length) {
      lines.push('\n工作经历:');
      for (const w of gc.geekWorks.slice(0, 5)) {
        lines.push(`- ${w.company || '未知公司'} · ${w.positionName || '未知职位'} (${w.startDate || ''} - ${w.endDate || '至今'})`);
        if (w.responsibility) lines.push(`  职责: ${w.responsibility}`);
        if (w.workTime) lines.push(`  时长: ${w.workTime}`);
      }
    }
    if (Array.isArray(gc.geekEdus) && gc.geekEdus.length) {
      lines.push('\n教育经历:');
      for (const e of gc.geekEdus.slice(0, 3)) {
        lines.push(`- ${e.school || ''} · ${e.major || ''} · ${e.degreeName || ''} (${e.startDate || ''}-${e.endDate || ''})`);
      }
    }
    if (raw?.activeTimeDesc) lines.push(`\n最后活跃: ${raw.activeTimeDesc}`);
    return lines.join('\n');
  }

  async function openCandidateChat(card) {
    // 优先找卡片内“沟通/打招呼”按钮（避免误点收藏/更多）
    const btn =
      card.querySelector('button.btn.btn-greet, .btn.btn-greet, [class*="btn-greet"]')
      || card.querySelector('button.btn.btn-getcontact, .btn.btn-getcontact, [class*="btn-getcontact"]')
      || findClickableInCard(card, ['立即沟通', '继续沟通', '沟通', '打招呼', '发消息', '聊天', '聊聊'])
      || card.querySelector('[ka*="chat"],[ka*="greet"],[ka*="contact"]')
      || null;

    if (!btn) {
      simulateClick(card);
    } else {
      simulateClick(btn);
    }

    const ok = await waitFor(() => {
      // 推荐牛人“打招呼”弹窗/侧栏不一定有固定 id，这里用更通用的“输入区+发送按钮”判定
      const docs = getAllDocs();
      for (const d of docs) {
        const input = d.querySelector('#boss-chat-editor-input') || d.querySelector('[contenteditable="true"]');
        const send = d.querySelector('.submit, button.submit, [class*="submit"]') || Array.from(d.querySelectorAll('button, a, [role="button"]')).find((el) => (el.innerText || el.textContent || '').trim() === '发送');
        if (input && send) return input;
      }
      return null;
    }, 10000);
    return !!ok;
  }

  function findClickableInCard(card, texts) {
    const candidates = Array.from(card.querySelectorAll('button, a, [role="button"], div'))
      .filter((el) => isVisible(el))
      .slice(0, 80);
    for (const el of candidates) {
      const t = String(el.innerText || el.textContent || '').trim();
      if (!t) continue;
      if (texts.some((x) => t.includes(x))) return el;
    }
    return null;
  }

  async function extractResumeText() {
    const getDocs = () => getAllDocs();
    const rememberMeta = (source, text, note = '') => {
      lastResumeExtractMeta = {
        source: String(source || 'unknown'),
        length: String(text || '').trim().length,
        note: String(note || ''),
      };
      return text;
    };

    // 1) 尝试点“在线简历”按钮（如果存在）（在任意同源 doc 里找）
    let clickedOnlineBtn = false;
    for (const d of getDocs()) {
      const onlineBtn = d.querySelector('a.btn.resume-btn-online, a[class*="resume-btn-online"]');
      if (onlineBtn) {
        simulateClick(onlineBtn);
        clickedOnlineBtn = true;
        await sleep(650);
        break;
      }
    }

    const normalize = (t) => String(t || '').trim().replace(/\n{3,}/g, '\n\n');

    function isResumeFrameDoc(doc) {
      if (!doc) return false;
      try {
        const path = String(doc.defaultView?.location?.pathname || '');
        if (path.includes('/web/frame/c-resume/')) return true;
      } catch {}
      try {
        const src = String(doc.defaultView?.frameElement?.getAttribute?.('src') || '');
        if (src.includes('/web/frame/c-resume/') || src.includes('source=new-geek')) return true;
      } catch {}
      return false;
    }

    function pruneSimilarGeekSectionFromElement(rootEl) {
      // 严格口径：不读取“其他相似经历的牛人”模块及其后续内容。
      // 你提供的结构：<p class="title">其他<span class="highlight">相似经历</span>的牛人</p> + <div class="card-container">...</div>
      try {
        const clone = rootEl.cloneNode(true);

        // 沟通页简历底部“免责声明/警告”等：从该节点开始向下都不属于可用简历内容
        // 你提供：<p class="resume-warning">...</p>
        const warn = clone.querySelector?.('p.resume-warning, [class*="resume-warning"]') || null;
        if (warn) {
          let cur = warn;
          while (cur) {
            const next = cur.nextSibling;
            try { cur.remove(); } catch {}
            cur = next;
          }
        }

        // 额外剔除：牛人分析器（不属于简历内容，且容易污染关键词）
        for (const sel of [
          '.resume-detail-competive',
          '[class*="resume-detail-compet"]',
          '[class*="geekAnalysis"]',
          '[class*="job_competitive"]',
          '.J_resume_geekAnalysis_seeAll',
          '.J_job_competitive',
        ]) {
          const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
          for (const n of nodes) {
            try { n.remove(); } catch {}
          }
        }

        // 右侧摘要里的操作按钮、问意向、翻页按钮等都不属于简历正文
        for (const sel of [
          '.dialog-footer',
          '[class*="dialog-footer"]',
          '.communication',
          '[class*="communication"]',
          '.button-list-wrap',
          '[class*="button-list-wrap"]',
          '.intention-tips',
          '[class*="intention-tips"]',
          '.ask-btn',
          '.btns',
          '.btn-text',
          '.btn-report',
          '.btn-coop-forward',
          '.btn-quxiao',
          '.resumeGreet',
          '.call-img',
          '.turn-btn',
          '.boss-popup__close',
          '[class*="boss-popup__close"]',
        ]) {
          const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
          for (const n of nodes) {
            try { n.remove(); } catch {}
          }
        }

        // 无条件剔除：相似牛人卡片容器（即便标题缺失也不应进入匹配）
        for (const sel of ['.resume-anonymous-geek-card', '[class*="resume-anonymous-geek-card"]', '.card-container', '[class*="card-container"]', '.anonymous-geek-card', '[class*="anonymous-geek-card"]']) {
          const nodes = Array.from(clone.querySelectorAll?.(sel) || []);
          for (const n of nodes) {
            try { n.remove(); } catch {}
          }
        }

        const titleNodes = Array.from(clone.querySelectorAll?.('p.title, [class*="title"]') || []);
        for (const tEl of titleNodes) {
          const txt = String(tEl.textContent || '').replace(/\s+/g, '');
          if (!txt) continue;
          const hit =
            (txt.includes('相似经历') && txt.includes('牛人') && (txt.startsWith('其他') || txt.includes('其他相似经历')))
            || /其他.*相似经历.*牛人/.test(txt)
            || (txt.startsWith('其他') && txt.includes('牛人') && (txt.includes('名企大厂经历') || txt.includes('院校') || txt.includes('同类经历') || txt.includes('同方向')));
          if (!hit) continue;

          // 从该 title 开始，把同一父容器后续节点全部删除（含 card-container）
          const parent = tEl.parentElement || clone;
          let cur = tEl;
          while (cur) {
            const next = cur.nextSibling;
            try { cur.remove(); } catch {}
            cur = next;
          }

          // 再兜底删一次：残留的 card-container
          const cards = Array.from(parent.querySelectorAll?.('.card-container, [class*="card-container"]') || []);
          for (const c of cards) {
            try { c.remove(); } catch {}
          }
        }
        return clone;
      } catch {
        return rootEl;
      }
    }

    function stripIrrelevantSections(text) {
      const t = String(text || '');
      if (!t) return '';

      // Boss 推荐牛人简历页会在下方插入“其他相似经历的牛人”等推荐模块，
      // 这部分不属于当前候选人的简历内容，必须截断避免关键词误命中。
      const markers = [
        '其他相似经历的牛人',
        '其他相似经历',
        '相似经历的牛人',
        '相似经历牛人',
        '其他名企大厂经历牛人',
        '名企大厂经历牛人',
        '其他同类经历牛人',
        '其他同方向牛人',
        // 沟通页简历底部声明/分析器（不属于简历内容）
        '为妥善保护牛人',
        '牛人分析器',
      ];
      let cut = -1;
      for (const m of markers) {
        const i = t.indexOf(m);
        if (i >= 0) cut = cut < 0 ? i : Math.min(cut, i);
      }
      // 更宽松的兜底：一行内同时出现“相似经历”和“牛人”
      if (cut < 0) {
        const m = t.match(/其?他\s*.*相似经历\s*.*牛人/);
        if (m?.index != null) cut = m.index;
      }
      // 更强兜底：允许中间有空格/换行/少一个“的”
      if (cut < 0) {
        const m2 = t.match(/其他\s*相似经历\s*(?:的\s*)?牛人/);
        if (m2?.index != null) cut = m2.index;
      }
      // 更宽：容忍中间被高亮 span 打断/有少量插入文本
      if (cut < 0) {
        const m3 = t.match(/其他[\s\S]{0,30}相似经历[\s\S]{0,30}的?\s*牛人/);
        if (m3?.index != null) cut = m3.index;
      }
      if (cut < 0) {
        const m4 = t.match(/其他[\s\S]{0,30}(名企大厂经历|同类经历|同方向)[\s\S]{0,30}牛人/);
        if (m4?.index != null) cut = m4.index;
      }
      const out = (cut >= 0 ? t.slice(0, cut) : t);
      return out.trim().replace(/\n{3,}/g, '\n\n');
    }

    function scoreResumeText(t) {
      const s = String(t || '');
      let score = 0;
      // 1.2.x：长度权重降权（原来 max 200 → 现在 max 80），让"关键词命中"成为主导信号
      score += Math.min(80, s.length / 50);
      const keys = [
        '工作经历', '教育经历', '工作经验', '教育经验', '期望职位', '期望薪资',
        '专业技能', '项目经验', '个人简介', '自我评价', '个人评价',
        '所属公司', '在职时间', '毕业院校', '所学专业', '求职状态',
      ];
      for (const k of keys) if (s.includes(k)) score += 30;
      return score;
    }

    // 1.2.x：硬性闸门 —— 文本是否像"真简历"。防止网页脚本代码 / JSON / 空容器被误当简历送进 AI
    // 触发本闸门只看内容形态，不看 DOM 来源；通过即视为"可送 AI"，否则继续找下一候选
    function looksLikeResume(text) {
      const s = String(text || '');
      if (s.length < 80) return false;

      // 必须包含至少一个典型简历关键词
      const resumeKeys = [
        '工作经历', '教育经历', '工作经验', '教育经验', '项目经验',
        '期望职位', '期望薪资', '求职状态', '专业技能', '个人简介', '自我评价',
        '所属公司', '在职时间', '毕业院校', '所学专业',
        '本科', '硕士', '博士', '大专',
      ];
      const hasResumeKey = resumeKeys.some((k) => s.includes(k));
      if (!hasResumeKey) return false;

      // 反指标 1：JS 代码标记 —— `function` / `var` / `=>` / `return ` 等高频出现 = 多半是脚本
      const jsMarkers = (s.match(/\bfunction\b|\bvar\b|\blet\b|\bconst\b|=>|\breturn\s|\bif\s*\(|\bfor\s*\(/g) || []).length;
      if (jsMarkers > 15) return false;

      // 反指标 2：大括号/分号密度过高（代码 / JSON 特征）
      const codeChars = (s.match(/[{};=]/g) || []).length;
      if (codeChars > s.length / 10) return false;

      // 反指标 3：中文字符比例太低（简历应大量中文）
      const cjk = (s.match(/[一-龥]/g) || []).length;
      if (cjk < Math.max(40, s.length * 0.12)) return false;

      return true;
    }

    function pickResumeTextFromFrameDocs() {
      const candidates = [];
      for (const d of getDocs()) {
        if (!isResumeFrameDoc(d)) continue;
        const frameEl = d.defaultView?.frameElement || null;
        if (frameEl && !isVisible(frameEl)) continue;
        const roots = [
          d.querySelector?.('main'),
          d.querySelector?.('.resume-detail-wrap'),
          d.querySelector?.('[class*="resume-detail"]'),
          d.querySelector?.('.content'),
          d.querySelector?.('[class*="resume-content"]'),
          d.body,
          d.documentElement,
        ].filter(Boolean);
        for (const root of roots) {
          try {
            const pruned = pruneSimilarGeekSectionFromElement(root);
            const t = stripIrrelevantSections(normalize(pruned.innerText || pruned.textContent || ''));
            if (!t || t.length < 40) continue;
            // 1.2.x：硬性闸门 —— 不像简历就跳过，防止脚本代码 / JSON 污染
            if (!looksLikeResume(t)) continue;
            let score = scoreResumeText(t) + 260;
            if (frameEl?.closest?.('.dialog-wrap.active, .boss-dialog__wrapper, .boss-dialog, .dialog-lib-resume')) {
              score += 80;
            }
            candidates.push({ t, score });
          } catch {}
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.t || '';
    }

    function pickResumeContainer() {
      const candidates = [];
      const selectors = [
        // 你补充的简历容器（聊天侧栏）
        '.resume-detail.resume-detail-chat',
        '.resume-content-wrap',
        '.resume-detail-wrap',
        'div.resume-detail',
        '[class*="resume-detail"]',
        '.geek-base-info-wrap',
        '.base-info-single-main',
      ];

      for (const d of getDocs()) {
        for (const sel of selectors) {
          let els = [];
          try { els = Array.from(d.querySelectorAll?.(sel) || []); } catch { els = []; }
          for (const el of els) {
            if (!el) continue;
            if (el.querySelector?.('iframe[src*="/web/frame/c-resume/"], iframe[src*="source=new-geek"]')) continue;
            if (!isVisible(el)) continue;
            const pruned = pruneSimilarGeekSectionFromElement(el);
            const t = stripIrrelevantSections(normalize(pruned.innerText || pruned.textContent || ''));
            if (!t) continue;
            // 1.2.x：硬性闸门 —— 不像简历就跳过
            if (!looksLikeResume(t)) continue;
            candidates.push({ el, t, score: scoreResumeText(t) });
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.t || '';
    }

    function pickRightbarText() {
      for (const d of getDocs()) {
        const right =
          d.querySelector('.resume-summary') ||
          d.querySelector('[class*="resume-summary"]') ||
          d.querySelector('.resume-right-side') ||
          d.querySelector('[class*="resume-right-side"]') ||
          d.querySelector('.resume-simple-box') ||
          d.querySelector('[class*="resume-simple-box"]') ||
          d.querySelector('.resume-item-detail') ||
          d.querySelector('[class*="resume-item-detail"]') ||
          d.querySelector('.rightbar-container') ||
          d.querySelector('[class*="rightbar"]') ||
          null;
        if (!right || !isVisible(right)) continue;
        const pruned = pruneSimilarGeekSectionFromElement(right);
        const t = stripIrrelevantSections(normalize(pruned.innerText || pruned.textContent || ''));
        if (!t) continue;
        // 兜底也必须像“简历文本”
        if (scoreResumeText(t) < 60) continue;
        return t.slice(0, 8000);
      }
      return '';
    }

    function findVisibleResumeCanvas() {
      const hits = [];
      for (const d of getDocs()) {
        let canvases = [];
        try {
          canvases = Array.from(d.querySelectorAll?.('canvas#resume, canvas[id="resume"], .resume-detail-wrap canvas, [class*="resume-detail"] canvas, canvas') || []);
        } catch {
          canvases = [];
        }
        for (const canvas of canvases) {
          if (!canvas || !isVisible(canvas)) continue;
          const rect = canvas.getBoundingClientRect?.();
          const width = Number(rect?.width || canvas.clientWidth || 0);
          const height = Number(rect?.height || canvas.clientHeight || 0);
          if (width < 240 || height < 240) continue;
          let score = width * height;
          if (canvas.id === 'resume') score += 1_000_000;
          if (canvas.closest?.('.resume-detail-wrap, [class*="resume-detail"]')) score += 300_000;
          hits.push({ canvas, score });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      return hits[0]?.canvas || null;
    }

    function getElementRectInTopViewport(el) {
      if (!el?.getBoundingClientRect) return null;
      const base = el.getBoundingClientRect();
      let left = base.left;
      let top = base.top;
      let view = el.ownerDocument?.defaultView || window;
      while (view && view !== view.top) {
        const frame = view.frameElement;
        if (!frame?.getBoundingClientRect) break;
        const fr = frame.getBoundingClientRect();
        left += fr.left;
        top += fr.top;
        view = view.parent;
      }
      return {
        left,
        top,
        width: base.width,
        height: base.height,
      };
    }

    function exportCanvasImageDataUrl(canvas) {
      try {
        const srcW = Math.max(1, Number(canvas.width || canvas.clientWidth || canvas.offsetWidth || 0));
        const srcH = Math.max(1, Number(canvas.height || canvas.clientHeight || canvas.offsetHeight || 0));
        const ratio = Math.min(1, 1400 / Math.max(srcW, srcH));
        const outW = Math.max(1, Math.round(srcW * ratio));
        const outH = Math.max(1, Math.round(srcH * ratio));
        const tmp = document.createElement('canvas');
        tmp.width = outW;
        tmp.height = outH;
        const ctx = tmp.getContext('2d', { alpha: false });
        if (!ctx) return '';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(canvas, 0, 0, outW, outH);
        return tmp.toDataURL('image/jpeg', 0.92);
      } catch {
        return '';
      }
    }

    function loadImageFromDataUrl(dataUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = dataUrl;
      });
    }

    async function cropScreenshotToElement(dataUrl, el, padding = 24) {
      if (!dataUrl || !el) return '';
      const img = await loadImageFromDataUrl(dataUrl);
      const rect = getElementRectInTopViewport(el);
      if (!rect) return '';
      const topWin = window.top || window;
      const viewportW = Math.max(1, Number(topWin.innerWidth || window.innerWidth || 1));
      const viewportH = Math.max(1, Number(topWin.innerHeight || window.innerHeight || 1));
      const scaleX = img.naturalWidth / viewportW;
      const scaleY = img.naturalHeight / viewportH;
      const sx = Math.max(0, Math.floor((rect.left - padding) * scaleX));
      const sy = Math.max(0, Math.floor((rect.top - padding) * scaleY));
      const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.ceil((rect.width + padding * 2) * scaleX)));
      const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.ceil((rect.height + padding * 2) * scaleY)));
      const tmp = document.createElement('canvas');
      tmp.width = sw;
      tmp.height = sh;
      const ctx = tmp.getContext('2d', { alpha: false });
      if (!ctx) return '';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sw, sh);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      return tmp.toDataURL('image/jpeg', 0.92);
    }

    async function captureVisibleTabDataUrl() {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'CAPTURE_VISIBLE_TAB',
          format: 'jpeg',
          quality: 90,
        });
        return resp?.success && resp?.dataUrl ? String(resp.dataUrl) : '';
      } catch {
        return '';
      }
    }

    async function buildResumeCanvasImageDataUrl(canvas) {
      if (!canvas) return '';

      const direct = exportCanvasImageDataUrl(canvas);
      if (direct) return direct;

      const screenshot = await captureVisibleTabDataUrl();
      if (!screenshot) return '';
      return cropScreenshotToElement(screenshot, canvas, 28).catch(() => '');
    }

    async function extractResumeTextFromCanvasViaAi() {
      if (!settings.ai?.baseUrl || !settings.ai?.apiKey || !settings.ai?.model) return '';

      const canvas = findVisibleResumeCanvas();
      if (!canvas) return '';

      const imageDataUrl = await buildResumeCanvasImageDataUrl(canvas);
      if (!imageDataUrl) {
        logWarn('简历正文：检测到 canvas 简历，但未能生成可转写图像');
        return '';
      }
      logInfo('简历正文：检测到 canvas 简历，准备视觉转写');

      try {
        const system = '你是一名简历OCR助手。你的任务是准确提取候选人简历截图中的可见文字，不要总结、不要推断、不要改写，只输出 JSON。';
        const user = [
          {
            type: 'text',
            text: [
              '请从这张 Boss 候选人简历截图中提取当前候选人的简历正文，并按阅读顺序输出。',
              '只保留简历相关内容：姓名、年龄、经验、学历、求职状态、个人概述、期望职位、工作经历、项目经验、教育经历、技能标签。',
              '忽略：其他相似经历的牛人、牛人分析器、免责声明、按钮、图标、非当前候选人的推荐内容。',
              '如果某些字看不清，可以跳过；不要编造。',
              '输出 JSON：{"resume_text":"..."}',
            ].join('\n'),
          },
          {
            type: 'image_url',
            image_url: { url: imageDataUrl },
          },
        ];
        const { json, usage, text } = await callAiJson(system, user, { max_tokens: 1200 });
        if (usage) await recordAiUsage(usage).catch(() => {});
        const parsed = normalize(stripIrrelevantSections(String(json?.resume_text || json?.text || text || '')));
        const lowered = parsed.toLowerCase();
        if (!parsed || parsed.length < 40) {
          logWarn(`canvas简历视觉转写结果过短：${parsed.length}字`);
          return '';
        }
        if (lowered.includes('无法识别') || lowered.includes('无法查看') || lowered.includes('看不清')) {
          logWarn('canvas简历视觉转写无有效正文：模型未识别出可用内容');
          return '';
        }
        logInfo('简历正文：检测到 canvas 简历，已通过视觉转写提取');
        return rememberMeta('canvas-ai', parsed.slice(0, 12000));
      } catch (err) {
        logWarn(`canvas简历视觉转写失败：${err?.message || String(err)}`);
        return '';
      }
    }

    function pickBestResumeTextNow() {
      // 2) 最新页简历正文优先在 c-resume iframe 内，先读 iframe 正文再兜底外层容器
      const framePicked = pickResumeTextFromFrameDocs();
      if (framePicked) return rememberMeta('iframe', stripIrrelevantSections(framePicked).slice(0, 12000));

      // 3) 兜底：只从“简历面板”里提取，避免把页面下方/相似牛人列表的文字混进来
      const picked = pickResumeContainer();
      if (picked) return rememberMeta('container', stripIrrelevantSections(picked).slice(0, 12000));
      return '';
    }

    const immediatePicked = pickBestResumeTextNow();
    if (immediatePicked) return immediatePicked;

    const waitedPicked = await waitFor(() => {
      const t = pickBestResumeTextNow();
      return t && t.length >= 40 ? t : null;
    }, clickedOnlineBtn ? 5200 : 3200);
    if (waitedPicked) return waitedPicked;

    // 最后再做一次 fresh scan，避免 iframe 晚到一个轮询周期时被直接判空
    const finalPicked = pickBestResumeTextNow();
    if (finalPicked) return finalPicked;

    const canvasPicked = await extractResumeTextFromCanvasViaAi();
    if (canvasPicked) return canvasPicked;

    const rightbarPicked = pickRightbarText();
    if (rightbarPicked) {
      logInfo('简历正文：未命中主简历正文，已退回右侧摘要兜底');
      return rememberMeta('rightbar', rightbarPicked, 'fallback');
    }

    // 1.2.x：所有渠道都没拿到"像简历的内容"。诊断日志：是真的没简历，还是被闸门拦了
    try {
      let rawCandidate = '';
      for (const d of getDocs()) {
        for (const sel of ['.resume-detail.resume-detail-chat', '.resume-content-wrap', '.resume-detail-wrap', '[class*="resume-detail"]']) {
          const el = d.querySelector?.(sel);
          if (el && isVisible(el)) {
            const raw = normalize(el.innerText || el.textContent || '').slice(0, 200);
            if (raw && !rawCandidate) rawCandidate = raw;
          }
        }
      }
      if (rawCandidate) {
        logWarn(`简历正文：找到候选 DOM 但未通过"像简历"硬闸门（前 200 字：${rawCandidate.replace(/\s+/g, ' ')}...）`);
      } else {
        logWarn('简历正文：未在页面找到任何简历容器（可能简历面板未加载完成 / 候选人未公开简历）');
      }
    } catch {}

    return rememberMeta('empty', '', 'no-resume-text');
  }

  async function closePopupsIfAny() {
    const selectors = [
      '.boss-popup__close',
      '.resume-custom-close',
      '[class*="boss-popup__close"]',
      '[class*="resume-custom-close"]',
      '[class*="iboss-close"]',
    ];
    for (const d of getAllDocs()) {
      for (const sel of selectors) {
        const els = Array.from(d.querySelectorAll?.(sel) || []);
        for (const el of els) {
          try {
            if (!isVisible(el)) continue;
            if (el.closest?.('.tooltip-wrap.suitable, .geek-info-card, .candidate-recommend, .recommend-care-list')) continue;
            el.click();
          } catch {}
        }
      }
    }
    await sleep(200);
  }

  function findThreadsForAutoReply({ maxItems = 40 } = {}) {
    // 兼容 iframe/子文档：统一从所有同源 doc 扫描
    const all = getAllDocs().flatMap((d) => {
      try {
        const out = [];

        // 1) 旧结构（friend-list-item / geek-item）
        out.push(...Array.from(d.querySelectorAll?.(
          '.friend-list-item, [class*="friend-list-item"], .geek-item, [class*="geek-item"]',
        ) || []));

        // 2) 你截图里的沟通列表结构：.chat-user .user-list.b-scroll-stable
        // 真实可点击条目是：.user-list 内的 div.geek-item[data-id][id]（外层还有 role="listitem" 包裹）
        const lists = Array.from(d.querySelectorAll?.('.chat-user .user-list, .user-container .user-list, .user-list') || []);
        for (const list of lists) {
          const geekItems = Array.from(list.querySelectorAll?.('.geek-item[data-id], .geek-item[id], [class*="geek-item"][data-id], [class*="geek-item"][id]') || []);
          out.push(...geekItems);
        }

        return out;
      } catch {
        return [];
      }
    });
    const uniq = uniqBy(all, (el) => el);
    if (uniq.length === 0) return [];

    const withBadge = uniq.filter((el) => {
      try {
        const badge = el.querySelector?.('.badge-count, [class*="badge-count"]') || null;
        const n = parseInt(String(badge?.textContent || '').trim(), 10);
        return Number.isFinite(n) && n > 0;
      } catch {
        return false;
      }
    });

    // 优先未读；若一个都没有，也取前若干条逐个点开再用“最后一句是否对方”来决定是否处理
    const picked = (withBadge.length ? withBadge : uniq)
      .filter((el) => {
        if (!el) return false;
        // 排除容器本身（user-list/chat-user 等），只保留条目
        const cls = String(el.className || '');
        if (/\buser-list\b/.test(cls)) return false;
        if (/\bchat-user\b/.test(cls)) return false;
        return isVisible(el);
      })
      .slice(0, maxItems);

    return picked;
  }

  // 兼容旧调用：历史代码/分支可能仍使用 findUnreadThreads
  function findUnreadThreads() {
    return findThreadsForAutoReply({ maxItems: 40 }).filter((el) => {
      try {
        const badge = el.querySelector?.('.badge-count, [class*="badge-count"]') || null;
        const n = parseInt(String(badge?.textContent || '').trim(), 10);
        return Number.isFinite(n) && n > 0;
      } catch {
        return false;
      }
    });
  }

  function getThreadKey(item) {
    if (!item) return '';
    const id = item.getAttribute('data-id') || item.id || '';
    const href = item.querySelector('a')?.getAttribute('href') || '';
    const name = getThreadName(item) || '';

    // 尝试从 href 中解析 geekId/encryptGeekId（如果页面提供）
    const mGeekId = href.match(/(?:geekId|geek_id)=([0-9]+)/i);
    if (mGeekId?.[1]) return `geekId:${mGeekId[1]}`;
    const mEncrypt = href.match(/(?:encryptGeekId|encrypt_geek_id)=([A-Za-z0-9]+)/i);
    if (mEncrypt?.[1]) return `encryptGeekId:${mEncrypt[1]}`;

    return id ? `id:${id}` : href ? `href:${href}` : name ? `name:${name}` : `idx:${hashText(item.innerText || '')}`;
  }

  function getThreadName(item) {
    if (!item) return '';
    const el = item.querySelector('.name, .geek-name, [class*="name"]');
    const t = (el?.textContent || '').trim();
    if (t) return t.split(/\s|\n/).filter(Boolean)[0] || '';
    return '';
  }

  function scoreThreadClickTarget(item, target) {
    if (!item || !target) return -Infinity;
    let score = 0;
    try {
      if (target === item) score += 120;
      if (target === item.closest?.('.friend-list-item, .geek-item, [class*="friend-list-item"], [class*="geek-item"]')) score += 110;
      if (target === item.closest?.('[role="listitem"]')) score += 105;
      if (target.matches?.('.friend-list-item, .geek-item, [class*="friend-list-item"], [class*="geek-item"]')) score += 95;
      if (target.matches?.('[role="listitem"]')) score += 90;
      if (target.matches?.('.geek-item-top, .main, .content, .item-content, [class*="item-top"]')) score += 55;
      if (target.matches?.('.name, .geek-name, [class*="name"]')) score += 45;
      if (target.matches?.('.figure, .avatar, [class*="avatar"]')) score += 35;
      if (target.matches?.('a[href]')) score += 20;
      if (target.getAttribute?.('data-id') || target.id) score += 15;
      const rect = target.getBoundingClientRect?.() || null;
      if (rect) {
        const area = Math.max(0, rect.width || 0) * Math.max(0, rect.height || 0);
        score += Math.min(20, Math.floor(area / 6000));
      }
      if (!isVisible(target)) score -= 200;
    } catch {}
    return score;
  }

  function getThreadClickTargets(item) {
    if (!item) return [];
    const targets = [
      item.querySelector?.('a[href]'),
      item.querySelector?.('.name, .geek-name, [class*="name"]'),
      item.querySelector?.('.uid'),
      item.querySelector?.('.figure, .avatar, [class*="avatar"]'),
      item.querySelector?.('.geek-item-top, .main, .content, .item-content, [class*="item-top"]'),
      item.closest?.('[role="listitem"]'),
      item.closest?.('.friend-list-item, .geek-item, [class*="friend-list-item"], [class*="geek-item"]'),
      item,
    ].filter(Boolean);
    return Array.from(new Set(targets))
      .map((target) => ({ target, score: scoreThreadClickTarget(item, target) }))
      .filter((x) => x.score > -100)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.target);
  }

  function isThreadItemSelected(item) {
    if (!item) return false;
    const nodes = [
      item,
      item.closest?.('[role="listitem"]'),
      item.closest?.('.friend-list-item, .geek-item, [class*="friend-list-item"], [class*="geek-item"]'),
    ].filter(Boolean);
    return nodes.some((el) => {
      try {
        if (el.classList?.contains('selected') || el.classList?.contains('active') || el.classList?.contains('curr')) return true;
        if (String(el.getAttribute?.('aria-selected') || '').toLowerCase() === 'true') return true;
      } catch {}
      return false;
    });
  }

  function getSelectedThreadItem() {
    const items = findThreadsForAutoReply({ maxItems: 80 });
    return items.find((el) => isThreadItemSelected(el)) || null;
  }

  function isSelectedThreadMatchTarget(targetName = '', targetKey = '') {
    const selected = getSelectedThreadItem();
    if (!selected) return false;
    try {
      const selectedKey = String(getThreadKey(selected) || '');
      if (targetKey && selectedKey && selectedKey === targetKey) return true;
    } catch {}
    try {
      const selectedName = normalizeForMatchLoose(String(getThreadName(selected) || '').trim());
      const targetNorm = normalizeForMatchLoose(String(targetName || '').trim());
      if (targetNorm && selectedName && (selectedName.includes(targetNorm) || targetNorm.includes(selectedName))) return true;
    } catch {}
    return false;
  }

  function getCurrentConversationHeaderName() {
    const nodes = queryAllAnyDoc(
      '.chat-content .name, .chat-main .name, .base-info-single-main .geek-name, .resume-detail .geek-name, .resume-detail-chat .geek-name',
      80,
    ).filter((el) => isVisible(el));
    const texts = nodes
      .map((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    texts.sort((a, b) => a.length - b.length);
    return texts[0] || '';
  }

  async function waitForThreadConversationReady(item, { targetName = '', targetKey = '', beforeMessage = null, beforeConversation = null, timeoutMs = 5000 } = {}) {
    const targetNorm = normalizeForMatchLoose(String(targetName || '').trim());
    const beforeHash = String(beforeMessage?.inboundHash || '');
    const beforeText = String(beforeMessage?.text || '');
    const beforeDir = String(beforeMessage?.direction || '');
    const beforeHeaderNorm = normalizeForMatchLoose(String(beforeConversation?.headerName || '').trim());
    const beforePositionNorm = normalizeForMatchLoose(String(beforeConversation?.positionName || '').trim());
    return await waitFor(() => {
      const composer = locateChatComposer();
      const composerReady = !!(composer?.input && composer?.sendBtn) || !!document.querySelector('.toolbar-icon.changyongyu');
      const selected = isThreadItemSelected(item);
      const selectedMatched = isSelectedThreadMatchTarget(targetName, targetKey);
      const currentHeaderName = getCurrentConversationHeaderName();
      const currentHeaderNorm = normalizeForMatchLoose(currentHeaderName);
      const nameMatched = !!(targetNorm && currentHeaderNorm && (currentHeaderNorm.includes(targetNorm) || targetNorm.includes(currentHeaderNorm)));
      const currentPositionNorm = normalizeForMatchLoose(String(getCurrentConversationPositionName() || '').trim());
      const headerChanged = !!(currentHeaderNorm && beforeHeaderNorm && currentHeaderNorm !== beforeHeaderNorm);
      const positionChanged = !!(currentPositionNorm && beforePositionNorm && currentPositionNorm !== beforePositionNorm);
      const conversationUiReady = !!(
        queryAnyDoc('.chat-message-list')
        || queryAnyDoc('.base-info-single-main')
        || queryAnyDoc('.resume-detail.resume-detail-chat')
        || queryAnyDoc('.resume-detail')
        || queryAnyDoc('.position-content .position-name')
      );
      const hasConversationPosition = !!String(getCurrentConversationPositionName() || '').trim();

      const now = getLastChatMessageMeta();
      const messageChanged = !!(
        now
        && (
          String(now.inboundHash || '') !== beforeHash
          || String(now.text || '') !== beforeText
          || String(now.direction || '') !== beforeDir
        )
      );

      if (nameMatched) return { composerReady };
      if (selectedMatched && conversationUiReady) return { composerReady };
      if (conversationUiReady && (headerChanged || positionChanged)) return { composerReady };
      if (selected && messageChanged) return { composerReady };
      if (selected && hasConversationPosition) return { composerReady };
      if (selected && conversationUiReady && !beforeHash && !beforeText) return { composerReady };
      return null;
    }, timeoutMs).catch(() => null);
  }

  async function tryOpenThreadConversation(item, {
    targetName = '',
    targetKey = '',
    beforeMessage = null,
    beforeConversation = null,
    timeoutMs = 5000,
  } = {}) {
    const alreadyReady = await waitForThreadConversationReady(item, {
      targetName,
      targetKey,
      beforeMessage,
      beforeConversation,
      timeoutMs: 500,
    }).catch(() => null);
    if (alreadyReady) return alreadyReady;

    const targets = getThreadClickTargets(item);
    for (const target of targets) {
      if (await stopIfVerificationNeeded('切换会话')) return null;
      await humanApproachElement(target, { purpose: 'thread' });
      try { highlight(target, 'rgba(255, 214, 102, 0.20)', 'rgba(255, 214, 102, 0.55)'); } catch {}
      try { simulateClick(target); } catch {}
      const readyState = await waitForThreadConversationReady(item, {
        targetName,
        targetKey,
        beforeMessage,
        beforeConversation,
        timeoutMs,
      }).catch(() => null);
      if (readyState) return readyState;
      await humanPause(240, 620);
    }
    return null;
  }

  async function ensureComposerReadyForCurrentThread(item, targetName = '', attempts = 2, targetKey = '') {
    for (let i = 0; i < attempts; i++) {
      const composer = locateChatComposer();
      if (composer?.input && composer?.sendBtn) return true;
      const before = getLastChatMessageMeta();
      const beforeConversation = {
        headerName: getCurrentConversationHeaderName(),
        positionName: getCurrentConversationPositionName(),
      };
      const readyState = await tryOpenThreadConversation(item, {
        targetName,
        targetKey,
        beforeMessage: before,
        beforeConversation,
        timeoutMs: 3200,
      });
      if (readyState?.composerReady) return true;
      const composerAfter = locateChatComposer();
      if (composerAfter?.input && composerAfter?.sendBtn) return true;
      await sleep(180);
    }
    return false;
  }

  async function sendChatMessage(text) {
    const result = await sendChatMessageDetailed(text);
    return !!result?.ok;
  }

  async function fillChatDraftBestEffort(text) {
    const draft = String(text || '').trim();
    if (!draft) return { ok: false, reason: '草稿为空' };
    if (await stopIfVerificationNeeded('填写回复草稿前')) return { ok: false, reason: '检测到账号验证提示' };
    const composer = locateChatComposer() || getDirectChatComposerFallback();
    if (!composer?.input) return { ok: false, reason: '未找到输入框' };
    await simulateInput(composer.input, draft);
    await humanPause(220, 520);
    const now = readInputText(composer.input);
    if (now && normalizeForMatch(now).includes(normalizeForMatch(draft).slice(0, Math.min(12, draft.length)))) {
      return { ok: true, reason: '' };
    }
    return { ok: false, reason: '输入框未写入草稿' };
  }

  async function sendChatMessageDetailed(text) {
    let lastReason = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await stopIfVerificationNeeded('发送消息前')) return { ok: false, reason: '检测到账号验证提示' };
      const composer = locateChatComposer() || getDirectChatComposerFallback();
      if (!composer?.input) return { ok: false, reason: '未找到输入框' };

      const before = readInputText(composer.input);
      const beforeMeta = getLastChatMessageMeta();

      await simulateInput(composer.input, text);
      await humanPause(260, 720);

      const composer2 = await waitFor(() => {
        const current = locateChatComposer() || getDirectChatComposerFallback() || composer;
        if (current?.sendBtn && !isElementDisabledLike(current.sendBtn)) return current;
        return null;
      }, 1200).catch(() => locateChatComposer() || getDirectChatComposerFallback() || composer);

      let sendTriggered = false;
      if (composer2?.sendBtn && !isElementDisabledLike(composer2.sendBtn)) {
        await humanApproachElement(composer2.sendBtn, { purpose: 'send' });
        sendTriggered = await clickSendButtonBestEffort(composer2.sendBtn);
        if (sendTriggered) {
          await backoffIfTooFrequent('发送消息');
        }
      } else {
        sendTriggered = await tryPressEnterToSend(composer2?.input || composer.input);
      }
      if (!sendTriggered) {
        lastReason = '发送按钮未激活';
        await humanPause(240, 520);
        continue;
      }

      const ok = await waitFor(() => {
        const now = readInputText((composer2 || composer).input);
        if (!now) return true;
        if (before && now !== before && now.length < 3) return true;
        const want = String(text || '').trim();
        if (want && !now.includes(want.slice(0, 12))) return true;
        const lastMeta = getLastChatMessageMeta();
        if (lastMeta && String(lastMeta.direction || '') === 'me') {
          const beforeHash = String(beforeMeta?.inboundHash || '');
          const currentHash = String(lastMeta.inboundHash || '');
          const lastText = String(lastMeta.text || '').trim();
          if (currentHash && currentHash !== beforeHash) return true;
          if (want && lastText && normalizeForMatch(lastText).includes(normalizeForMatch(want).slice(0, 10))) return true;
        }
        return null;
      }, 5500).catch(() => false);

      if (ok) return { ok: true, reason: '' };
      lastReason = '发送后未检测到消息变化';
      await humanPause(260, 560);
    }

    return { ok: false, reason: lastReason || '未检测到发送成功' };
  }

  async function clickSendButtonBestEffort(sendBtn) {
    if (!sendBtn || isElementDisabledLike(sendBtn) || !isVisible(sendBtn)) return false;
    const candidates = Array.from(new Set([
      sendBtn.matches?.('.submit') ? sendBtn : null,
      sendBtn.closest?.('.submit-content'),
      sendBtn.matches?.('.submit-content') ? sendBtn : null,
      sendBtn.querySelector?.('.submit') || null,
      sendBtn,
    ].filter(Boolean))).filter((el) => isVisible(el) && !isElementDisabledLike(el));

    if (!candidates.length) return false;
    for (const el of candidates) {
      await humanApproachElement(el, { purpose: 'send' });
      // 1.1.3：发送按钮也是 isTrusted 检测高危位，auto+启用本机点击器时走 OS 级真鼠标
      const r = await riskyClick(el, { label: '发送' });
      if (r === 'cancelled' || r === 'unreachable') {
        return false; // 由调用方进入 retry / 跳过
      }
      await humanPause(80, 180);
    }
    return true;
  }

  function findExactBossChatComposer(doc) {
    if (!doc) return null;
    const input = doc.querySelector?.('#boss-chat-editor-input.boss-chat-editor-input, #boss-chat-editor-input') || null;
    if (!input || !isVisible(input)) return null;

    const sendBtn =
      input.closest?.('[class*="editor"], [class*="input"], [class*="chat"]')?.querySelector?.('[d-c="61033"] .submit, [d-c="61033"], .submit-content .submit, .submit-content')
      || doc.querySelector?.('[d-c="61033"] .submit, [d-c="61033"], .submit-content .submit, .submit-content')
      || null;

    return {
      doc,
      input,
      sendBtn: sendBtn && isVisible(sendBtn) ? sendBtn : null,
    };
  }

  function findChatInputInDoc(d) {
    if (!d) return null;
    const exact = findExactBossChatComposer(d);
    if (exact?.input) return exact.input;

    const directCandidates = [
      d.querySelector('textarea'),
      d.querySelector('[role="textbox"]'),
      d.querySelector('.ql-editor'),
    ].filter(Boolean);
    const direct = directCandidates.find((el) => isVisible(el)) || null;
    if (direct) return direct;

    const editables = Array.from(d.querySelectorAll?.('[contenteditable="true"]') || []);
    const candidates = editables
      .filter((el) => isVisible(el))
      .map((el) => {
        const cls = String(el.className || '');
        const aria = String(el.getAttribute?.('aria-label') || '');
        const ph = String(el.getAttribute?.('data-placeholder') || el.getAttribute?.('placeholder') || '');
        let s = 0;
        if (/editor|input|chat|textbox/i.test(cls)) s += 12;
        if (/输入|消息|说点|chat|message/i.test(aria + ph)) s += 14;
        if (el.closest?.('.chat-editor, [class*="editor"], [class*="chat"], [class*="input"]')) s += 10;
        return { el, s };
      })
      .sort((a, b) => b.s - a.s);
    return candidates[0]?.el || null;
  }

  function locateChatComposer() {
    const exactInDocument = findExactBossChatComposer(document);
    if (exactInDocument?.input) return exactInDocument;

    const docs = getAllDocs();
    let best = null;
    let bestScore = -Infinity;

    for (const d of docs) {
      const exact = findExactBossChatComposer(d);
      if (exact?.input) {
        const score = scoreComposerCandidate(d, exact.input, exact.sendBtn) + 120;
        if (score > bestScore) {
          bestScore = score;
          best = exact;
        }
        continue;
      }
      const input = findChatInputInDoc(d);
      if (!input) continue;

      const sendBtn = findSendButtonNearInput(d, input);
      const score = scoreComposerCandidate(d, input, sendBtn);
      if (score > bestScore) {
        bestScore = score;
        best = { doc: d, input, sendBtn };
      }
    }

    return bestScore >= 0 ? best : null;
  }

  function getDirectChatComposerFallback() {
    const exact = findExactBossChatComposer(document) || queryAllAnyDoc('#boss-chat-editor-input', 20)
      .map((el) => findExactBossChatComposer(el.ownerDocument || document))
      .find(Boolean);
    if (exact?.input) return exact;

    const input =
      queryAnyDoc('textarea')
      || queryAnyDoc('[role="textbox"]')
      || queryAnyDoc('.ql-editor')
      || queryAnyDoc('[contenteditable="true"]');
    if (!input || !isVisible(input)) return null;
    const doc = input.ownerDocument || document;
    const sendBtn = findSendButtonNearInput(doc, input);
    return { doc, input, sendBtn };
  }

  function findSendButtonNearInput(doc, input) {
    if (String(input?.id || '') === 'boss-chat-editor-input') {
      const exact =
        input.closest?.('[class*="editor"], [class*="input"], [class*="chat"]')?.querySelector?.('[d-c="61033"] .submit, [d-c="61033"], .submit-content .submit, .submit-content')
        || doc.querySelector?.('[d-c="61033"] .submit, [d-c="61033"], .submit-content .submit, .submit-content')
        || null;
      if (exact && isVisible(exact)) return exact;
    }

    const root = input.closest?.('form, .chat-editor, [class*="editor"], [class*="chat"], [class*="input"]') || doc.body;
    const buttons = Array.from(root.querySelectorAll?.('button, a, span[class*="btn"], div[class*="btn"], [class*="submit"], [role="button"]') || []);

    const scored = [];
    for (const el of buttons) {
      if (!isVisible(el)) continue;
      const t = String(el.innerText || el.textContent || '').trim();
      const cls = String(el.className || '');
      const aria = String(el.getAttribute?.('aria-label') || '');

      let s = 0;
      if (t === '发送' || t === '发 送') s += 50;
      if (t.includes('发送')) s += 35;
      if (t.includes('立即沟通') || t.includes('继续沟通')) s -= 10;
      if (/submit|send/i.test(cls)) s += 18;
      if (/primary|btn-primary|boss-btn-primary/i.test(cls)) s += 10;
      if (/发送|send/i.test(aria)) s += 12;
      if (el.getAttribute?.('type') === 'submit') s += 10;
      if (isElementDisabledLike(el)) s -= 45;
      scored.push({ el, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored[0]?.s >= 12 ? scored[0].el : null;
  }

  function isElementDisabledLike(el) {
    if (!el) return false;
    const cls = String(el.className || '').toLowerCase();
    const aria = String(el.getAttribute?.('aria-disabled') || '').toLowerCase();
    const disabledAttr = el.getAttribute?.('disabled');
    const style = getComputedStyle(el);
    if (el.disabled) return true;
    if (disabledAttr != null) return true;
    if (aria === 'true') return true;
    if (/\bdisabled\b|\bis-disabled\b|\bbtn-disabled\b/.test(cls)) return true;
    if (style.pointerEvents === 'none') return true;
    return false;
  }

  async function tryPressEnterToSend(input) {
    if (!input) return false;
    try {
      const doc = input.ownerDocument || document;
      const view = doc.defaultView || window;
      input.focus?.();
      const eventInit = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      };
      input.dispatchEvent(new view.KeyboardEvent('keydown', eventInit));
      input.dispatchEvent(new view.KeyboardEvent('keypress', eventInit));
      input.dispatchEvent(new view.KeyboardEvent('keyup', eventInit));
      await backoffIfTooFrequent('发送消息');
      return true;
    } catch {
      return false;
    }
  }

  function scoreComposerCandidate(doc, input, sendBtn) {
    let s = 0;
    if (doc === document) s += 2;
    const clsI = String(input.className || '');
    const clsS = String(sendBtn?.className || '');
    if (String(input.id || '') === 'boss-chat-editor-input') s += 10;
    if (/editor|chat/i.test(clsI)) s += 6;
    if (/submit|send/i.test(clsS)) s += 6;
    const t = String(sendBtn?.innerText || sendBtn?.textContent || '');
    if (t.includes('发送')) s += 8;
    if (!sendBtn) s -= 4;
    return s;
  }

  function readInputText(input) {
    try {
      if (!input) return '';
      if ('value' in input) return String(input.value || '').trim();
      return String(input.innerText || input.textContent || '').trim();
    } catch {
      return '';
    }
  }

  function findButtonByText(text) {
    const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return els.find((el) => (el.innerText || el.textContent || '').trim() === text) || null;
  }

  // ====== Chat meta (for auto-reply gating) ======

  function getLastChatMessageMeta() {
    // 兼容：对话框/输入区可能在同源 iframe 内，必须跨 doc 查找
    const input =
      queryAnyDoc('#boss-chat-editor-input')
      || queryAnyDoc('[contenteditable="true"]');
    const doc = input?.ownerDocument || document;
    const root = locateChatRoot(input) || doc.body || document.body;
    const container = locateMessageContainer(root) || root;

    const globalChatList =
      queryAnyDoc('.chat-message-list')
      || queryAnyDoc('[class*="chat-message-list"]');
    const strong =
      getLastChatMessageMetaFromChatList(globalChatList)
      || getLastChatMessageMetaFromChatList(container)
      || getLastChatMessageMetaFromChatList(root)
      || getLastChatMessageMetaFromChatList(doc.body)
      || getLastChatMessageMetaFromChatList(document.body);
    if (strong) return strong;

    const messageEls = findChatMessageElements(container);
    if (!messageEls.length) return null;

    for (let i = messageEls.length - 1; i >= 0; i--) {
      const el = messageEls[i];
      const text = extractMessageText(el);
      if (!text) continue;
      const dir = inferMessageDirection(el, container);
      if (!dir) continue;
      return {
        direction: dir,
        text,
        inboundHash: hashText(`${dir}:${text.slice(0, 240)}`),
      };
    }

    return null;
  }

  function debugChatMessageState() {
    try {
      const globalChatList =
        queryAnyDoc('.chat-message-list')
        || queryAnyDoc('[class*="chat-message-list"]');
      if (!globalChatList) return '未找到 .chat-message-list';
      const bubbles = Array.from(globalChatList.querySelectorAll(
        '.item-friend,.item-my,.item-self,[class*="item-friend"],[class*="item-my"],[class*="item-self"]'
      )).filter(isVisible);
      if (!bubbles.length) return '找到聊天列表，但未找到可见消息气泡';
      const last = bubbles[bubbles.length - 1];
      const text = extractMessageText(last);
      const cls = String(last.className || '').trim();
      if (!text) return `找到最后气泡，但正文为空（class=${cls || 'unknown'}）`;
      return `已找到最后气泡（class=${cls || 'unknown'}，正文长度=${text.length}）`;
    } catch (e) {
      return `消息调试异常：${e?.message || String(e)}`;
    }
  }

  function getCurrentConversationFlowMeta() {
    try {
      const globalChatList =
        queryAnyDoc('.chat-message-list')
        || queryAnyDoc('[class*="chat-message-list"]');
      if (!globalChatList) return { source: 'candidate_initiated', label: '候选人主动招呼', meCount: 0, otherCount: 0 };
      const bubbles = Array.from(globalChatList.querySelectorAll(
        '.item-friend,.item-my,.item-self,[class*="item-friend"],[class*="item-my"],[class*="item-self"]'
      )).filter(isVisible);
      let meCount = 0;
      let otherCount = 0;
      for (const bubble of bubbles) {
        const cls = String(bubble.className || '').toLowerCase();
        if (/(item-my|item-self)/.test(cls)) meCount += 1;
        else if (/(item-friend)/.test(cls)) otherCount += 1;
      }
      if (meCount > 0) {
        return { source: 'reply_to_outreach', label: '候选人回复我的招呼', meCount, otherCount };
      }
      return { source: 'candidate_initiated', label: '候选人主动招呼', meCount, otherCount };
    } catch {
      return { source: 'candidate_initiated', label: '候选人主动招呼', meCount: 0, otherCount: 0 };
    }
  }

  function getCurrentConversationContextSummary() {
    try {
      const globalChatList =
        queryAnyDoc('.chat-message-list')
        || queryAnyDoc('[class*="chat-message-list"]');
      if (!globalChatList) {
        return {
          hasAskedMaterialsByMe: false,
          hasCandidateSentMaterialsAfterAsk: false,
          hasAttachmentPreviewAfterAsk: false,
          hasAttachmentConsentAfterAsk: false,
          hasAcknowledgementAfterAsk: false,
          hasClosingMessageByMe: false,
          hasAcknowledgementAfterClosing: false,
          lastInboundText: '',
        };
      }

      const items = Array.from(globalChatList.querySelectorAll('.message-item')).filter(isVisible);
      let lastAskIdx = -1;
      let lastCloseIdx = -1;
      let hasAskedMaterialsByMe = false;
      let hasCandidateSentMaterialsAfterAsk = false;
      let hasAttachmentPreviewAfterAsk = false;
      let hasAttachmentConsentAfterAsk = false;
      let hasAcknowledgementAfterAsk = false;
      let hasClosingMessageByMe = false;
      let hasAcknowledgementAfterClosing = false;
      let lastInboundText = '';

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const text = getConversationItemText(item);
        if (!text) continue;
        const norm = normalizeForMatch(text);
        const dir = inferConversationItemDirection(item);
        if (dir === 'other') lastInboundText = text;

        const isAskMaterialsByMe =
          dir === 'me'
          && /简历|作品|作品集|附件简历|邮箱/.test(norm)
          && /(发|给我|麻烦|请|邮件|邮箱)/.test(norm);
        if (isAskMaterialsByMe) {
          hasAskedMaterialsByMe = true;
          lastAskIdx = i;
          continue;
        }

        const isClosingByMe = dir === 'me' && looksLikeClosingMessageByMe(norm);
        if (isClosingByMe) {
          hasClosingMessageByMe = true;
          lastCloseIdx = i;
          continue;
        }

        if (lastAskIdx < 0 || i <= lastAskIdx) continue;

        if (dir === 'other' && conversationItemLooksLikeMaterialsProvided(item, norm)) {
          hasCandidateSentMaterialsAfterAsk = true;
        }
        if (conversationItemHasAttachmentPreview(item, norm)) {
          hasAttachmentPreviewAfterAsk = true;
        }
        if (conversationItemHasAttachmentConsent(item, norm)) {
          hasAttachmentConsentAfterAsk = true;
        }
        if (dir === 'other' && conversationItemLooksLikeAcknowledgement(norm)) {
          hasAcknowledgementAfterAsk = true;
        }
      }

      if (lastCloseIdx >= 0) {
        for (let i = lastCloseIdx + 1; i < items.length; i++) {
          const item = items[i];
          const text = getConversationItemText(item);
          if (!text) continue;
          const norm = normalizeForMatch(text);
          const dir = inferConversationItemDirection(item);
          if (dir === 'other' && conversationItemLooksLikeAcknowledgement(norm)) {
            hasAcknowledgementAfterClosing = true;
          }
        }
      }

      return {
        hasAskedMaterialsByMe,
        hasCandidateSentMaterialsAfterAsk,
        hasAttachmentPreviewAfterAsk,
        hasAttachmentConsentAfterAsk,
        hasAcknowledgementAfterAsk,
        hasClosingMessageByMe,
        hasAcknowledgementAfterClosing,
        lastInboundText,
      };
    } catch {
      return {
        hasAskedMaterialsByMe: false,
        hasCandidateSentMaterialsAfterAsk: false,
        hasAttachmentPreviewAfterAsk: false,
        hasAttachmentConsentAfterAsk: false,
        hasAcknowledgementAfterAsk: false,
        hasClosingMessageByMe: false,
        hasAcknowledgementAfterClosing: false,
        lastInboundText: '',
      };
    }
  }

  function getConversationIntentContext() {
    try {
      const globalChatList =
        queryAnyDoc('.chat-message-list')
        || queryAnyDoc('[class*="chat-message-list"]');
      if (!globalChatList) {
        return {
          recentTurns: [],
          recentContextText: '',
          lastMeTextBeforeLastInbound: '',
          lastInboundText: '',
        };
      }

      const items = Array.from(globalChatList.querySelectorAll('.message-item')).filter(isVisible);
      const turns = [];
      for (const item of items) {
        const text = getConversationItemText(item);
        const dir = inferConversationItemDirection(item);
        if (!text || dir === 'system') continue;
        turns.push({ direction: dir, text });
      }

      let lastInboundIdx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i]?.direction === 'other') {
          lastInboundIdx = i;
          break;
        }
      }
      const lastInboundText = lastInboundIdx >= 0 ? String(turns[lastInboundIdx]?.text || '') : '';
      let lastMeTextBeforeLastInbound = '';
      if (lastInboundIdx > 0) {
        for (let i = lastInboundIdx - 1; i >= 0; i--) {
          if (turns[i]?.direction === 'me') {
            lastMeTextBeforeLastInbound = String(turns[i]?.text || '');
            break;
          }
        }
      }
      const recentTurns = lastInboundIdx >= 0
        ? turns.slice(Math.max(0, lastInboundIdx - 5), lastInboundIdx + 1)
        : turns.slice(-6);
      const recentContextText = recentTurns
        .map((turn) => `${turn.direction === 'me' ? '我方' : '候选人'}：${String(turn.text || '').replace(/\s+/g, ' ').trim()}`)
        .filter(Boolean)
        .join('\n');

      return {
        recentTurns,
        recentContextText,
        lastMeTextBeforeLastInbound,
        lastInboundText,
      };
    } catch {
      return {
        recentTurns: [],
        recentContextText: '',
        lastMeTextBeforeLastInbound: '',
        lastInboundText: '',
      };
    }
  }

  function getAutoReplyContextSkipReason(convoFlow, convoCtx, intentContext = null) {
    if (convoCtx?.hasAskedMaterialsByMe && (convoCtx.hasCandidateSentMaterialsAfterAsk || convoCtx.hasAttachmentPreviewAfterAsk)) {
      return '检测到对话上下文里已发送简历/作品，无需重复回复';
    }
    if (convoCtx?.hasAskedMaterialsByMe && convoCtx.hasAcknowledgementAfterAsk) {
      return '检测到对方仅确认收到上一条索要材料消息，无需重复回复';
    }
    const lastMeNorm = normalizeForMatch(String(intentContext?.lastMeTextBeforeLastInbound || '').trim());
    const lastInboundNorm = normalizeForMatch(String(intentContext?.lastInboundText || convoCtx?.lastInboundText || '').trim());
    if (
      (convoCtx?.hasClosingMessageByMe && convoCtx?.hasAcknowledgementAfterClosing)
      || (looksLikeClosingMessageByMe(lastMeNorm) && conversationItemLooksLikeAcknowledgement(lastInboundNorm))
    ) {
      return '检测到对方在确认结束沟通，无需继续处理';
    }
    return '';
  }

  function inferConversationItemDirection(item) {
    try {
      const bubble =
        item.querySelector?.('.item-friend,.item-myself,.item-my,.item-self,[class*="item-friend"],[class*="item-myself"],[class*="item-my"],[class*="item-self"]')
        || item.closest?.('.item-friend,.item-myself,.item-my,.item-self,[class*="item-friend"],[class*="item-myself"],[class*="item-my"],[class*="item-self"]');
      if (!bubble) return 'system';
      const cls = String(bubble.className || '').toLowerCase();
      if (/(item-friend)/.test(cls)) return 'other';
      if (/(item-myself|item-my|item-self)/.test(cls)) return 'me';
      return 'system';
    } catch {
      return 'system';
    }
  }

  function getConversationItemText(item) {
    if (!item) return '';
    const root =
      item.querySelector?.('.item-friend,.item-myself,.item-my,.item-self,.item-system,[class*="item-friend"],[class*="item-myself"],[class*="item-my"],[class*="item-self"],[class*="item-system"]')
      || item;
    return String(root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function conversationItemLooksLikeMaterialsProvided(item, normText) {
    if (!item || !normText) return false;
    if (/pan\.baidu\.com|提取码|这是我的简历|这是我的简历和作品|这是我的简历和作品集|简历\+作品|作品集|简历已发|作品已发|附件已发|请查收|已发送|发您邮箱了|已发邮箱/.test(normText)) {
      return true;
    }
    if (conversationItemHasAttachmentPreview(item, normText)) return true;
    return false;
  }

  function conversationItemHasAttachmentPreview(item, normText = '') {
    const text = String(normText || getConversationItemText(item) || '');
    return /点击预览附件简历|附件简历|\.pdf\b/.test(text);
  }

  function conversationItemHasAttachmentConsent(item, normText = '') {
    const text = String(normText || getConversationItemText(item) || '');
    return /对方想发送附件简历给您/.test(text);
  }

  function conversationItemLooksLikeAcknowledgement(normText) {
    return /^(好的好的|好的呢|好的|好哒|ok|okk|收到啦|收到|明白了|了解了|嗯嗯|行的|可以的|请查收|已发送)(～|~|!|！|。)?$/.test(String(normText || ''));
  }

  function looksLikeClosingMessageByMe(normText) {
    return /(不太适合|不太匹配|本次先不继续推进|先不继续推进|暂不继续推进|先不推进|感谢回复|希望未来有机会合作|祝你顺利|不好意思.*不适合|就目前来看.*不太适合)/.test(String(normText || ''));
  }

  function looksLikeMaterialsRequestByMe(normText) {
    return /(简历|作品|作品集|附件简历|邮箱).*(发|给我|麻烦|请)|麻烦.*(简历|作品|作品集)|方便.*(发|给我).*(简历|作品|作品集)/.test(String(normText || ''));
  }

  function looksLikeShortAffirmativeReply(normText) {
    return /^(你好|您好)?[,，]?(有的|有呀|有意向|可以|可以的|可以呀|行|行的|行呀|好的|好的呢|好哒|嗯嗯|嗯|好)(～|~|!|！|。)?$/.test(String(normText || ''));
  }

  function looksLikeInterestQuestion(normText) {
    const s = String(normText || '');
    if (!s) return false;
    return /(有意向|感兴趣|有兴趣|考虑机会|看机会|方便聊聊|方便沟通|愿意聊聊|对这个岗位|对岗位|你有意向么|你有意向吗|是否有意向|是否考虑|想了解|愿意了解|方便发下简历|方便发简历|方便先沟通)/.test(s);
  }

  function getLastChatMessageMetaFromChatList(scope) {
    if (!scope) return null;
    const list =
      scope.matches?.('.chat-message-list,[class*="chat-message-list"]')
        ? scope
        : scope.querySelector?.('.chat-message-list,[class*="chat-message-list"]');
    if (!list) return null;

    const bubbles = Array.from(list.querySelectorAll(
      '.item-friend,.item-my,.item-self,[class*="item-friend"],[class*="item-my"],[class*="item-self"]'
    )).filter(isVisible);
    if (!bubbles.length) return null;

    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      const text = extractMessageText(bubble);
      if (!text) continue;
      const cls = String(bubble.className || '').toLowerCase();
      const dir =
        /(item-friend)/.test(cls) ? 'other'
        : /(item-my|item-self)/.test(cls) ? 'me'
        : inferMessageDirection(bubble, list);
      if (!dir) continue;
      return {
        direction: dir,
        text,
        inboundHash: hashText(`${dir}:${text.slice(0, 240)}`),
      };
    }
    return null;
  }

  function locateChatRoot(inputEl) {
    if (!inputEl) return null;
    let el = inputEl;
    for (let i = 0; i < 10; i++) {
      if (!el) break;
      const count = el.querySelectorAll?.('div,li')?.length || 0;
      if (count > 50) return el;
      el = el.parentElement;
    }
    return inputEl.parentElement;
  }

  function locateMessageContainer(root) {
    if (!root) return null;
    // 目标：定位右侧“对话消息区”，避免误命中左侧 user-list
    const bubbleSel = '.item-friend,.item-my,.item-self,[class*="item-friend"],[class*="item-my"],[class*="item-self"]';
    const candidates = [];
    const selectors = [
      // 更偏向“对话框区域”的容器
      '.chat-conversation',
      '[class*="conversation"]',
      '[class*="dialog"]',
      '[class*="chat-content"]',
      '[class*="msg-list"]',
      '[class*="message-list"]',
      '.chat-message-list',
      '[class*="chat-message-list"]',
      '[role="log"]',
      '[role="list"]',
      '[class*="message"]',
    ];
    for (const sel of selectors) {
      let els = [];
      try { els = Array.from(root.querySelectorAll(sel)); } catch {}
      for (const el of els.slice(0, 80)) {
        if (!el || !isVisible(el)) continue;
        const cls = String(el.className || '');
        // 排除左侧列表容器
        if (/\buser-list\b/.test(cls) || /\bchat-user\b/.test(cls)) continue;
        let score = 0;
        // 含有消息气泡类名直接加大分
        try {
          const bubbles = el.querySelectorAll?.(bubbleSel)?.length || 0;
          if (bubbles) score += 100 + Math.min(80, bubbles);
        } catch {}
        // 子节点多的更像消息区
        try {
          const cnt = el.querySelectorAll?.('div,li')?.length || 0;
          score += Math.min(40, Math.floor(cnt / 30));
        } catch {}
        // 若内部含 user-list，扣分（说明包含左侧列表）
        try {
          if (el.querySelector?.('.user-list,[class*="user-list"]')) score -= 80;
        } catch {}
        // class 命中 message/chat 给一点分
        if (/message|chat|dialog|conversation/i.test(cls)) score += 10;
        candidates.push({ el, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    if (candidates[0]?.score >= 20) return candidates[0].el;
    return root;
  }

  function findChatMessageElements(container) {
    const bubbleSelectors = [
      '.item-friend',
      '.item-my',
      '.item-self',
      '[class*="item-friend"]',
      '[class*="item-my"]',
      '[class*="item-self"]',
    ];
    for (const sel of bubbleSelectors) {
      const els = Array.from(container.querySelectorAll(sel));
      const visible = els.filter(isVisible);
      if (visible.length >= 1) return visible;
    }

    const selectors = [
      // 次一级：整条消息容器
      '.message-item',
      '.chat-message',
      '[class*="message-item"]',
      '[class*="chat-message"]',
      '[class*="msg-item"]',
      'li[role="listitem"]',
    ];
    for (const sel of selectors) {
      const els = Array.from(container.querySelectorAll(sel));
      const visible = els.filter(isVisible);
      if (visible.length >= 2) return visible;
    }
    const els = Array.from(container.querySelectorAll('div,li')).filter(isVisible);
    return els.slice(Math.max(0, els.length - 200));
  }

  function extractMessageText(el) {
    // 优先取“最像正文”的子节点（避免把整段容器/时间戳等当作消息）
    const candidates = [];
    try {
      const nodes = [
        el.querySelector?.('[class*="text"],[class*="content"],pre,p'),
        ...Array.from(el.querySelectorAll?.('[class*="text"],[class*="content"],pre,p,span') || []).slice(0, 50),
      ].filter(Boolean);
      for (const n of nodes) {
        const t = String(n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (t.length > 1000) continue;
        // 过滤明显不是消息正文的短词
        if (t === '发送' || t === '求简历' || t === '不合适') continue;
        candidates.push(t);
      }
    } catch {}
    if (candidates.length) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];
    }
    const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length > 1000) return '';
    return t;
  }

  function inferMessageDirection(el, container) {
    try {
      // 最稳：直接找最近的“气泡节点”
      const bubble =
        el.closest?.('.item-friend,.item-my,.item-self,[class*="item-friend"],[class*="item-my"],[class*="item-self"]')
        || null;
      if (bubble) {
        const clsB = String(bubble.className || '').toLowerCase();
        if (/(item-friend)/.test(clsB)) return 'other';
        if (/(item-my|item-self)/.test(clsB)) return 'me';
      }

      // 兜底：找消息节点
      const msgEl =
        el.closest?.('.message-item,.chat-message,[class*="message-item"],[class*="chat-message"],[class*="msg-item"]')
        || el;
      const cls = String(msgEl.className || '').toLowerCase();

      // Boss 聊天页：常见结构（你截图里就是 item-friend）
      // - 对方：item-friend
      // - 我方：item-my / item-self（不同版本可能略有差异）
      if (/(item-friend)/.test(cls)) return 'other';
      if (/(item-my|item-self)/.test(cls)) return 'me';

      // 再用语义词兜底（不同页面可能有 self/me/right 等命名）
      if (/(me|self|mine|my|right)/.test(cls) && !/(other|opposite|left)/.test(cls)) return 'me';
      if (/(other|opposite|left)/.test(cls) && !/(me|self|mine|my|right)/.test(cls)) return 'other';

      const cRect = container.getBoundingClientRect();
      const rect = msgEl.getBoundingClientRect();
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.width)) return null;
      const centerX = rect.left + rect.width / 2;
      const containerCenterX = cRect.left + cRect.width / 2;
      return centerX > containerCenterX ? 'me' : 'other';
    } catch {
      return null;
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  }

  // ====== AI ======

  async function aiDecideStage1(simpleCandidateInfo) {
    const passScore = clampInt(settings.thresholds?.passScore ?? 60, 0, 100);
    const system = settings.aiPrompts.stage1;
    const user = [
      `岗位要求:\n${settings.jdText}`,
      '',
      `候选人信息:\n${simpleCandidateInfo}`,
      '',
      `请输出 JSON，格式如下（必须严格 JSON，可被 JSON.parse 解析）：`,
      `{"decision": true/false, "score": 0-100, "reason": "<=30字"}`,
      `规则：score >= ${passScore} 视为 decision=true。`,
    ].join('\n');

    const json = await callAiJson(system, user);
    const score = clampInt(json.score ?? 0, 0, 100);
    const decision = typeof json.decision === 'boolean' ? json.decision : score >= passScore;
    return { decision, score, reason: String(json.reason || '') };
  }

  // 1.1.x：当 popup 还没初始化过 settings.aiScoringDimensions 时的默认 4 维（保证内容脚本独立可用）
  //   默认四维均分 25 各 25 分
  const FALLBACK_SCORING_DIMENSIONS = [
    { id: 'jd',         name: 'JD 匹配度',         weight: 25, criteria: ['岗位职责与候选人作品方向是否一致', '作品成熟度是否符合目标级别', '技能栈是否匹配岗位要求', '是否具有相关项目经验'] },
    { id: 'keyword',    name: '关键词匹配度',      weight: 25, criteria: ['必含关键词命中情况', '任意关键词命中情况', '排除关键词是否触发（按语义角色判断）', '加分项（AI 校准方向）命中情况'] },
    { id: 'background', name: '背景经验匹配度',    weight: 25, criteria: ['游戏项目经验（项目名 / 公司 / 上线作品）', '项目类型匹配（二次元、SLG、MMO、卡牌、开放世界、写实等）', '大厂 / 独立工作室 / 外包 经验占比', '初 / 中 / 高级资历与岗位级别匹配'] },
    { id: 'education',  name: '教育与履历完整度',  weight: 25, criteria: ['学历是否满足岗位硬要求', '是否八大美院 / 985 / 211 / 名校（如岗位看重）', '工作连续性（中间是否有过长 Gap）', '履历信息是否完整可信'] },
  ];

  // 1.1.x：根据 settings.aiScoringDimensions 生成 prompt 里的"评分维度与权重"段
  function buildScoringDimensionsHint() {
    let dims = Array.isArray(settings?.aiScoringDimensions) ? settings.aiScoringDimensions : null;
    if (!dims || !dims.length) dims = FALLBACK_SCORING_DIMENSIONS;
    if (!dims.length) return '';
    const total = dims.reduce((s, d) => s + (Number(d.weight) || 0), 0);
    const lines = ['【评分维度与权重（按以下加权汇总，总分应为 100）】'];
    for (const d of dims) {
      const w = Number(d.weight) || 0;
      lines.push(`- ${d.name}（满分 ${w} 分）：`);
      const cri = Array.isArray(d.criteria) ? d.criteria : [];
      for (const c of cri) lines.push(`    · ${c}`);
    }
    lines.push(`总权重 = ${total}（应为 100；不为 100 时按各维度比例归一化）`);
    lines.push('打分时：每维度先单独评 0~满分，最终 score = Σ(各维度得分)，四舍五入到整数。');
    return lines.join('\n');
  }

  async function aiDecideStage2(resumeText, jobContext = null, replyFilters = null) {
    const passScore = clampInt(settings.thresholds?.passScore ?? 60, 0, 100);
    const system = settings.aiPrompts.stage2;
    const scoped = replyFilters || getJobScopedReplyFilters(jobContext);
    const nice = Array.isArray(scoped?.aiNiceKeywords) ? scoped.aiNiceKeywords : [];
    const required = getRequiredKeywords(scoped);
    const include = getIncludeAnyKeywords(scoped);
    const exclude = Array.isArray(scoped?.excludeKeywords) ? scoped.excludeKeywords : [];
    const positionName = String(jobContext?.positionName || settings.positionName || '').trim();
    const jdText = String(jobContext?.jdText || settings.jdText || '').trim();
    const keywordHint = [
        '【关键词组合公式（最重要）】',
        '通过条件 = (所有 required 全部命中) AND (任意一个 include 命中) AND (没有命中任何 exclude)。',
        'nice 不影响通过/不通过，只在已通过的基础上叠加加分。',
        '示例：required=[插画, 二次元]，include=[角色KV, 宣传图, 海报]，则等价于：',
        '  「插画 AND 二次元 AND (角色KV OR 宣传图 OR 海报)」全部满足才算通过。',
        '若某一类为空（如 include 为空），该类不约束。',
        '',
        '【关键词都按"语义概念"理解，不是纯字面匹配】',
        '每个关键词都应按招聘语义做合理扩展，但不能过度联想。',
        '- 同义词 / 近义岗位名 / 上下游职责名 / 常见简称 / 英文表达 / 工具链或项目语境中的等价说法 = 命中。',
        '- 岗位名语义放宽优先于正文散词：',
        '  例：角色原画 ≈ 角色设计 / 原画师 / 角色概念；动作师 ≈ 动画师 / 动作设计 / 角色动画 / 战斗动画；',
        '       地编 ≈ 关卡美术 / 关卡设计 / 场景地编 / Level Art。',
        '- 项目名映射：原神 / 战双 / 崩坏 / 明日方舟 等可视为"二次元 / 二游项目经验"的强证据。',
        '- 加分项的群组性概念要主动展开。例如：',
        '  · "八大美院" = 中央美院 / 中国美院 / 鲁迅美院 / 天津美院 / 四川美院 / 广州美院 / 西安美院 / 湖北美院',
        '   （口径上常额外含 中传、北电、清华美院、上戏、央戏 等顶级艺术院校）',
        '  · "985" / "211" / "C9" / "海外Top50" 也按对应院校清单语义匹配。',
        '  · "大厂" 应映射到具体头部公司，命名相近的子公司同样算。完整白名单（中英文写法都算同一家）：',
        '    互联网/平台：腾讯、网易、阿里巴巴/Alibaba、字节跳动/ByteDance/抖音/TikTok、华为、百度、京东、美团、拼多多、小米、滴滴、快手、',
        '                  哔哩哔哩/Bilibili/B站、知乎、小红书、爱奇艺、优酷、芒果TV',
        '    游戏厂商：米哈游/miHoYo/HoYoverse、完美世界/Perfect World、网易雷火、网易盘古、腾讯天美、腾讯光子、腾讯北极光、',
        '              鹰角网络（明日方舟）、莉莉丝/Lilith、叠纸（恋与/无限暖暖/奇迹暖暖）、朝夕光年、巨人网络/Giant、盛趣/盛大、',
        '              多益网络、三七互娱、FunPlus、4399、心动网络、友谊时光、玩友时代、IGG、龙渊网络、紫龙、青瓷、雷霆、',
        '              畅游、完美、巨人、Garena、SuperCell、Riot/拳头、暴雪/Blizzard、EA、育碧/Ubisoft、CDPR、SE/史克威尔',
        '    动画/影视：彩条屋、追光动画、光线传媒、华强方特、原力动画、若森数字、玄机科技、福煦影视',
        '    其他游戏知名 IP/平台：Steam、Epic、TapTap、Switch、PlayStation/PS、Xbox',
        '    候选人简历里出现这些公司名（含子公司、工作室、当时的曾用名）→ 命中"大厂"加分。',
        '- 不要把过于宽泛的上位词直接视为命中：',
        '  · "美术" 不能等于 "地编"',
        '  · "动画" 在缺少动作 / 游戏语境时不能等于 "动作设计"',
        '',
        '【上下文判断规则（关键，不能机械匹配字符串）】',
        '关键词出现在简历里的"语义角色"决定是否真正命中：',
        '- 候选人的"职位标题 / 期望岗位 / 最近 N 段经历的岗位名"是最强信号。',
        '- 项目描述里"配合 X / 协助 X / 与 X 沟通 / 接到 X 的需求"等表述，',
        '  说明 X 是别人的角色，不是候选人的角色，**这种情况不算候选人就是 X**。',
        '  例：exclude=策划。简历里写"配合策划完成 XX 关卡"——候选人不是策划，不应被排除。',
        '       而简历职位写"游戏策划 / 系统策划"——直接命中，应排除。',
        '- 用户也可能把关键词写成完整短语来明确语义角色，例如：',
        '  · "职位是策划" / "title 是 UI 设计师" / "目标岗位是 TA"',
        '  · 看到这类带"职位 / title / 目标岗位 / 当前岗位"等定语的关键词，',
        '    判定时只看候选人对应字段是否命中，不看零散提及。',
        '- exclude 也按同样规则做语义命中判断；候选人当前 / 最近 / 目标岗位标题命中 exclude → 通常应判为不通过，',
        '  除非有特别强的反向证据。',
        '',
        '【排除词的语义扩展（容易漏判，必须做这些扩展）】',
        'exclude 中的简写 / 概念词必须主动扩展为同义词族 + 风格族 + 题材族 + 工具族，扩展后命中即算命中：',
        '- "欧卡" / "欧美" / "欧美卡通" → 欧美卡通 / 欧美风格 / 美式漫画 / 美漫 / 迪士尼 / 皮克斯 / 梦工厂 / 蓝精灵 / 海绵宝宝 / 西部牛仔 / 卡通 Q 版（明显欧美味）',
        '- "写实" → 写实 / 半写实 / 3A 大作 / 次世代 / 主机游戏 / 影视级 / hyperrealistic / PBR 写实 / 古墓丽影 / 战神 / 巫师 / 使命召唤',
        '- "二次元" 相关排除时 → 含日系 / 萌系 / 美少女 / 立绘类 / 卡牌二游',
        '- "Q 版 / Q 萌" → 含可爱 / chibi / 萌宠 / 三头身',
        '- "国风" → 含古风 / 仙侠 / 玄幻 / 水墨 / 工笔 / 唐卡',
        '- "外包" → 含外包公司 / 接单 / 私单 / 美术外包 / 输出商',
        '只要候选人作品 / 项目 / 公司 / 自我描述里出现以上扩展词，即视为命中对应排除。',
        '风格类排除词命中时，**在作品描述、项目名、合作公司、自述特长里发现都算**，不限于岗位标题。',
        '示例：exclude=[欧卡]，候选人简历写"主要擅长欧美设计 / 卡通风格 / 接 Disney 项目" → 命中欧美卡通 → 应判 decision=false。',
        '',
        '【判断纪律】',
        '- 严禁用"疑似 / 可能 / 风险 / 未排除"等猜测性表述作为扣分依据。',
        '- "未提及"不等于"不具备"：除非属于 JD 明确硬要求或 required 必含项，',
        '  否则只能轻到中度扣分，不能直接判死。',
        '- 如果 JD / 关键词没有要求作品链接 / 作品格式 / 附件说明，',
        '  不允许因为"没写作品链接 / 格式"扣分。',
        '- 项目经验默认不是硬门槛：除非 JD 或 required 明确写成必须条件，',
        '  否则按强弱、相关度、平台体量、职责深度逐项加减分，不一票否决。',
        '- 候选人与岗位方向高度相关、有核心职责 / 项目 / 技能证据、且无明确硬冲突时，应给到通过分。',
        '- 除非存在明确硬冲突，避免因为多个"未提及"叠加把分数压到 40 以下。',
        '',
        '【防幻觉硬规则（违反任何一条都按错误处理）】',
        '- reason 里**只允许引用候选人简历正文中实际出现的项目名 / 公司名 / 关键词原文**。',
        '- **禁止编造**简历里没有的项目名、产品名、公司名（典型错误：把"百词斩"读成"山之子"，把"梦间集"读成"梦境集"）。',
        '- 如果你不确定某段文字属于哪个项目，**直接不引用项目名**，只描述命中的关键词或职能即可。',
        '- 引用前请在心里逐字核对一次：原文里真的有这串字符吗？没有就别写。',
        '',
        '【本次筛选关键词】',
        `- required（必含，AND 全部命中）: ${required.length ? required.join(' / ') : '(空)'}`,
        `- include（任意，OR 命中其一）: ${include.length ? include.join(' / ') : '(空)'}`,
        `- nice（加分项，命中加分但不影响通过）: ${nice.length ? nice.join(' / ') : '(空)'}`,
        `- exclude（排除，按语义角色命中即扣分 / 不通过）: ${exclude.length ? exclude.join(' / ') : '(空)'}`,
        '',
        buildScoringDimensionsHint(),
        '',
        '【输出原因的固定顺序】',
        '先写岗位方向 / 岗位名匹配，再写必含项命中或缺失，再写任意项命中，再写加分项命中，最后写排除项命中。',
      ].join('\n');
    const user = [
      `岗位名称:\n${positionName || '(未填写)'}`,
      '',
      `岗位要求:\n${jdText}`,
      '',
      keywordHint,
      keywordHint ? '' : '',
      `候选人简历（文本提取）:\n${resumeText.slice(0, 12000)}`,
      '',
      `请输出 JSON（严格 JSON）：`,
      `{"decision": true/false, "score": 0-100, "reason": "<=120字，写清楚匹配点/不匹配点（最多3条）"}`,
      `规则：score >= ${passScore} 视为 decision=true。`,
    ].join('\n');

    const { json, usage, text: rawText } = await callAiJson(system, user);
    const repaired = repairStage2AiResult(json, rawText);
    const rawScore = clampInt(repaired.score ?? 0, 0, 100);
    const excludePenalty = scoreResumeExcludePenalty(resumeText, exclude);
    const score = clampInt(rawScore - excludePenalty.penalty, 0, 100);
    const decision = typeof repaired.decision === 'boolean' ? repaired.decision : rawScore >= passScore;
    const finalDecision = !excludePenalty.hardReject && score >= passScore && (decision || rawScore >= passScore);
    let reason = String(repaired.reason || '');
    if (!reason && score === 0) {
      const rawPreview = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      reason = rawPreview ? `AI返回异常：${rawPreview}` : 'AI返回异常：空结果';
    }
    if (excludePenalty.note) {
      reason = reason ? `${reason}；${excludePenalty.note}` : excludePenalty.note;
    }
    if (excludePenalty.hardReject) {
      reason = reason ? `${reason}；命中排除项，直接淘汰` : '命中排除项，直接淘汰';
      return { decision: false, score: 0, reason, usage: usage || null };
    }
    return { decision: finalDecision, score, reason, usage: usage || null };
  }

  function repairStage2AiResult(parsed, rawText) {
    const base = parsed && typeof parsed === 'object' ? parsed : {};
    const out = {
      decision: typeof base.decision === 'boolean' ? base.decision : null,
      score: Number.isFinite(Number(base.score)) ? Number(base.score) : null,
      reason: String(base.reason || '').trim(),
    };
    if (out.decision !== null && out.score !== null && out.reason) return out;

    let raw = String(rawText || '').trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) raw = raw.slice(first, last + 1);

    if (out.decision === null) {
      const m = raw.match(/"decision"\s*:\s*(true|false)/i);
      if (m) out.decision = String(m[1]).toLowerCase() === 'true';
    }
    if (out.score === null) {
      const m = raw.match(/"score"\s*:\s*(-?\d+(?:\.\d+)?)/i);
      if (m) out.score = Number(m[1]);
    }
    if (!out.reason) {
      const m = raw.match(/"reason"\s*:\s*"([\s\S]*)"\s*\}\s*$/i);
      if (m) out.reason = String(m[1] || '').replace(/\\"/g, '"').trim();
    }

    return out;
  }

  function scoreResumeExcludePenalty(text, excludeKeywords) {
    const lines = String(text || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 300);
    const lower = lines.join('\n').toLowerCase();
    const titleLikePattern = /期望|求职|目标|应聘|岗位|职位|方向|工作经历|经历概览|最近岗位|当前岗位/;
    const titleHits = [];
    const directHits = [];

    for (const keyword of excludeKeywords || []) {
      const kw = String(keyword || '').trim().toLowerCase();
      if (!kw) continue;
      const inTitleLikeLine = lines.some((line) => {
        const lineLower = line.toLowerCase();
        return lineLower.includes(kw) && titleLikePattern.test(line);
      });
      if (inTitleLikeLine) {
        titleHits.push(kw);
        continue;
      }
      if (kw.length >= 3 && lower.includes(kw)) directHits.push(kw);
    }

    const uniqTitleHits = Array.from(new Set(titleHits));
    const uniqDirectHits = Array.from(new Set(directHits.filter((kw) => !uniqTitleHits.includes(kw))));

    let penalty = 0;
    if (uniqTitleHits.length) penalty += 28 + Math.max(0, uniqTitleHits.length - 1) * 12;
    if (uniqDirectHits.length) penalty += 18 + Math.max(0, uniqDirectHits.length - 1) * 8;
    penalty = Math.min(60, penalty);

    const parts = [];
    if (uniqTitleHits.length) parts.push(`命中排除岗位:${uniqTitleHits.slice(0, 3).join('/')}`);
    if (uniqDirectHits.length) parts.push(`命中排除项:${uniqDirectHits.slice(0, 3).join('/')}`);

    return {
      penalty,
      hardReject: uniqTitleHits.length > 0 || uniqDirectHits.length > 0,
      note: parts.length ? `AI排除项重扣-${penalty}分（${parts.join('；')}）` : '',
    };
  }

  async function aiGenerateReplyForChat({ inboundText, position, jdText, resumeText, passWhy } = {}) {
    const inbound = String(inboundText || '').replace(/\s+/g, ' ').trim();
    const pos = String(position || '').trim();
    const jd = String(jdText || '').trim();
    const resume = String(resumeText || '').trim();
    const why = String(passWhy || '').trim();

    const system = [
      '你是招聘方的沟通助手，负责在BOSS直聘聊天里进行第一句回复。',
      '目标：礼貌、简短、自然，结合对方上一句话做回应，并引导对方继续沟通/发简历。',
      '严格要求：不要透露任何“打分/筛选/模型/关键词”等内部判断过程。',
      '输出严格 JSON，不要多余文字。',
    ].join('\n');

    const user = [
      `岗位：${pos || '(未提供)'}`,
      '',
      '岗位JD（节选）：',
      jd ? jd.slice(0, 1800) : '(空)',
      '',
      '候选人简历（节选）：',
      resume ? resume.slice(0, 1800) : '(空)',
      '',
      '对方上一句话：',
      inbound ? inbound.slice(0, 400) : '(空)',
      '',
      `筛选结论：已通过（无需复述原因）。${why ? `（内部原因摘要：${why.slice(0, 120)}）` : ''}`,
      '',
      '请生成一句回复（<=80字，中文），语气友好，优先：回应对方+确认岗位+请对方发简历/方便沟通。',
      '输出 JSON：{"reply":"..."}',
    ].join('\n');

    const { json, usage } = await callAiJson(system, user);
    let reply = String(json?.reply || '').replace(/\s+/g, ' ').trim();
    if (reply.length > 120) reply = reply.slice(0, 120);
    return { reply, usage: usage || null };
  }

  async function callAiJson(system, user, options = {}) {
    if (!settings.ai?.baseUrl || !settings.ai?.apiKey || !settings.ai?.model) {
      throw new Error('未配置 AI');
    }
    const messages = Array.isArray(options.messages) && options.messages.length
      ? options.messages
      : [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
    const resp = await chrome.runtime.sendMessage({
      type: 'AI_CALL',
      baseUrl: settings.ai.baseUrl,
      apiKey: settings.ai.apiKey,
      model: settings.ai.model,
      messages,
      temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0,
      max_tokens: clampInt(options.max_tokens ?? 400, 1, 4000),
    });

    if (!resp?.success) throw new Error(resp?.error || 'AI 调用失败');
    const text = String(resp.text || '');
    return { json: safeJsonParse(text), usage: resp.usage || null, text };
  }

  async function recordAiUsage(usage) {
    const u = usage || {};
    const add = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const cur = await chrome.storage.local.get([STORAGE_KEYS.aiUsage]).catch(() => ({}));
    const prev = cur?.[STORAGE_KEYS.aiUsage] || {};
    const next = {
      prompt_tokens: add(prev.prompt_tokens) + add(u.prompt_tokens),
      completion_tokens: add(prev.completion_tokens) + add(u.completion_tokens),
      total_tokens: add(prev.total_tokens) + add(u.total_tokens),
      ts: Date.now(),
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.aiUsage]: next }).catch(() => {});
  }

  function keywordDecide(text, scopedConfig = null) {
    const required = getRequiredKeywords(scopedConfig);
    const include = getIncludeAnyKeywords(scopedConfig);
    const exclude = Array.isArray(scopedConfig?.excludeKeywords)
      ? scopedConfig.excludeKeywords
      : normalizeKeywordLines(settings.excludeKeywords);
    const lower = String(text || '').toLowerCase();

    if (exclude.some((k) => k && lower.includes(k))) {
      return { decision: false, score: 0, reason: '命中排除词' };
    }

    const requiredHit = required.filter((k) => k && lower.includes(k));
    if (required.length > 0 && requiredHit.length !== required.length) {
      return {
        decision: false,
        score: 0,
        reason: `未命中全部必含词（AND）：已命中${requiredHit.join(',') || '无'}`,
      };
    }

    const hit = include.filter((k) => k && lower.includes(k));
    if (required.length === 0 && include.length === 0) {
      // 无关键词：默认通过（由“每次最多联系人数”兜底）
      return { decision: true, score: 60, reason: '无关键词限制：默认通过' };
    }

    if (include.length > 0 && hit.length === 0) {
      return { decision: false, score: 0, reason: '未命中任意关键词（OR）' };
    }

    const parts = [];
    if (requiredHit.length > 0) parts.push(`AND:${requiredHit.slice(0, 3).join(',')}`);
    if (hit.length > 0) parts.push(`OR:${hit.slice(0, 3).join(',')}`);
    const ok = (required.length === 0 || requiredHit.length === required.length) && (include.length === 0 || hit.length > 0);
    const reason = ok ? `命中:${parts.join('；')}` : '关键词未通过';
    return { decision: ok, score: ok ? 70 : 0, reason };
  }

  function getRequiredKeywords(scopedConfig = null) {
    if (scopedConfig) {
      const required = Array.isArray(scopedConfig.requiredKeywords) ? scopedConfig.requiredKeywords : [];
      if (required.length) return required;
      if (scopedConfig.keywordsAndMode) return Array.isArray(scopedConfig.includeKeywords) ? scopedConfig.includeKeywords : [];
      return [];
    }
    const required = normalizeKeywordLines(settings.requiredKeywords);
    if (required.length) return required;
    if (settings.keywordsAndMode) return normalizeKeywordLines(settings.includeKeywords);
    return [];
  }

  function getIncludeAnyKeywords(scopedConfig = null) {
    if (scopedConfig) {
      if (scopedConfig.keywordsAndMode) return [];
      return Array.isArray(scopedConfig.includeKeywords) ? scopedConfig.includeKeywords : [];
    }
    if (settings.keywordsAndMode) return [];
    return normalizeKeywordLines(settings.includeKeywords);
  }

  async function prepareCandidateListAfterJobSwitch() {
    scrollCandidateListToTop();
    clearCandidateCardRuntimeState();
    await sleep(450);
    await waitForCandidateListStable(10000).catch(() => {});
    await waitForFirstCandidateReady(8000).catch(() => {});
    scrollCandidateListToTop();
    focusFirstCandidateCard();
    clearCandidateCardRuntimeState();
    await sleep(250);
  }

  function clearCandidateCardRuntimeState({ resetMemory = true } = {}) {
    if (resetMemory) candidateRuntimeStates = new Map();
    const cards = findCandidateCards();
    for (const card of cards) {
      try {
        delete card.dataset.bossAssistDone;
        delete card.dataset.bossAssistProcessing;
      } catch {}
      try {
        card.style.removeProperty('background');
        card.style.removeProperty('border');
        card.style.removeProperty('box-shadow');
      } catch {}
    }
  }

  function getCandidateRuntimeStateStyle(stateName) {
    if (stateName === 'processing') return { done: false, processing: true, bg: '#fff3e0', border: '#ffa726' };
    if (stateName === 'skipped') return { done: true, processing: false, bg: '#f5f5f5', border: '#bdbdbd' };
    if (stateName === 'rechecked') return { done: true, processing: false, bg: '#e3f2fd', border: '#42a5f5' };
    if (stateName === 'warning') return { done: false, processing: false, bg: '#fff8e1', border: '#ffb300' };
    if (stateName === 'contacted') return { done: true, processing: false, bg: '#e8f5e9', border: '#4caf50' };
    if (stateName === 'manual_pending') return { done: true, processing: false, bg: '#e3f2fd', border: '#1e88e5' };
    if (stateName === 'failed') return { done: true, processing: false, bg: '#ffebee', border: '#ef5350' };
    return null;
  }

  function applyCandidateRuntimeState(card, state) {
    if (!card || !state) return;
    try {
      if (state.done) card.dataset.bossAssistDone = '1';
      else delete card.dataset.bossAssistDone;
    } catch {}
    try {
      if (state.processing) card.dataset.bossAssistProcessing = '1';
      else delete card.dataset.bossAssistProcessing;
    } catch {}
    if (state.bg && state.border) highlight(card, state.bg, state.border);
  }

  function rememberCandidateRuntimeState(card, stateName) {
    const state = getCandidateRuntimeStateStyle(stateName);
    if (!card || !state) return;
    const name = getCandidateName(card);
    const idInfo = getCandidateIdInfo(name, card);
    const key = String(idInfo?.key || '').trim();
    if (!key) return;
    candidateRuntimeStates.set(key, { ...state, stateName, ts: Date.now() });
  }

  function applyRememberedCandidateRuntimeStates() {
    if (!candidateRuntimeStates.size) return;
    const cards = findCandidateCards();
    for (const card of cards) {
      try {
        const name = getCandidateName(card);
        const idInfo = getCandidateIdInfo(name, card);
        const key = String(idInfo?.key || '').trim();
        if (!key) continue;
        const state = candidateRuntimeStates.get(key);
        if (!state) continue;
        applyCandidateRuntimeState(card, state);
      } catch {}
    }
  }

  function scrollCandidateListToTop() {
    const root =
      queryAnyDoc('#recommend-list')
      || queryAnyDoc('.recommend-wrap')
      || queryAnyDoc('[class*="recommend-list"]')
      || queryAnyDoc('[class*="candidate-list"]');
    try { root?.scrollTo?.({ top: 0, behavior: 'auto' }); } catch {}
    try {
      const scroller = root?.closest?.('[class*="scroll"], [class*="list"], [style*="overflow"]') || null;
      scroller?.scrollTo?.({ top: 0, behavior: 'auto' });
    } catch {}
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
  }

  function focusFirstCandidateCard() {
    const first = findCandidateCards()[0];
    try { first?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'auto' }); } catch {}
  }

  async function waitForCandidateListStable(timeoutMs = 8000) {
    let lastSig = '';
    let stableRounds = 0;
    return waitFor(() => {
      const cards = findCandidateCards();
      if (!cards.length) {
        lastSig = '';
        stableRounds = 0;
        return null;
      }
      const sig = buildCandidateListSignature(cards);
      if (sig && sig === lastSig) stableRounds += 1;
      else stableRounds = 0;
      lastSig = sig;
      return stableRounds >= 2 ? true : null;
    }, timeoutMs);
  }

  async function waitForFirstCandidateReady(timeoutMs = 8000) {
    return waitFor(() => {
      const first = findCandidateCards()[0];
      if (!first) return null;
      const name = getCandidateName(first);
      const text = String(first.innerText || first.textContent || '').trim();
      return (name || text.length >= 12) ? true : null;
    }, timeoutMs);
  }

  function buildCandidateListSignature(cards) {
    const list = Array.isArray(cards) ? cards : [];
    const sample = list.slice(0, 5).map((card) => {
      const name = getCandidateName(card);
      const id = card?.getAttribute?.('data-geek-id')
        || card?.getAttribute?.('data-geekid')
        || card?.getAttribute?.('data-geek')
        || card?.querySelector?.('[data-geek]')?.getAttribute?.('data-geek')
        || card?.getAttribute?.('data-id')
        || '';
      return `${name || ''}#${id || ''}`;
    });
    return `${list.length}|${sample.join('|')}`;
  }

  function findScrollableAncestor(el) {
    let cur = el?.parentElement || null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      try {
        const style = getComputedStyle(cur);
        const overflowY = String(style.overflowY || '');
        if (/(auto|scroll|overlay)/i.test(overflowY) && cur.scrollHeight > cur.clientHeight + 20) {
          return cur;
        }
      } catch {}
      cur = cur.parentElement || null;
    }
    return document.scrollingElement || document.documentElement || document.body || null;
  }

  function scrollTargetToBottom(target) {
    if (!target) return;
    try {
      if (target === window) {
        window.scrollTo({ top: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0), behavior: 'auto' });
        return;
      }
      if (target === document.body || target === document.documentElement || target === document.scrollingElement) {
        window.scrollTo({ top: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0), behavior: 'auto' });
        return;
      }
      target.scrollTo?.({ top: target.scrollHeight || 999999, behavior: 'auto' });
      target.scrollTop = target.scrollHeight || 999999;
    } catch {}
  }

  function collectCandidateListScrollTargets(cards = []) {
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    const lastCard = cards[cards.length - 1] || null;
    const roots = [
      lastCard,
      queryAnyDoc('#recommend-list'),
      queryAnyDoc('.recommend-card-list'),
      queryAnyDoc('.recommend-care-list'),
      queryAnyDoc('.candidate-body'),
      queryAnyDoc('.candidate-recommend'),
      queryAnyDoc('.recommend-wrap'),
      queryAnyDoc('.loadmore'),
      queryAnyDoc('[class*="loadmore"]'),
    ].filter(Boolean);
    roots.forEach((root) => {
      push(root);
      push(findScrollableAncestor(root));
    });
    push(window);
    push(document.scrollingElement || document.documentElement || document.body || null);
    return out;
  }

  function dispatchScrollEvent(target) {
    if (!target) return;
    try {
      const evt = new Event('scroll', { bubbles: true, cancelable: false });
      if (target === window) window.dispatchEvent(evt);
      else target.dispatchEvent(evt);
    } catch {}
  }

  async function nudgeScrollTargetToBottom(target) {
    if (!target) return;
    try {
      if (target === window || target === document.body || target === document.documentElement || target === document.scrollingElement) {
        const total = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        const viewport = window.innerHeight || document.documentElement?.clientHeight || 0;
        const nearBottom = Math.max(0, total - viewport - 180);
        window.scrollTo({ top: nearBottom, behavior: 'auto' });
        dispatchScrollEvent(window);
        await sleep(120);
        window.scrollTo({ top: Math.max(total, nearBottom + viewport), behavior: 'auto' });
        dispatchScrollEvent(window);
        return;
      }
      const maxTop = Math.max(0, (target.scrollHeight || 0) - (target.clientHeight || 0));
      const nearBottom = Math.max(0, maxTop - 180);
      target.scrollTop = nearBottom;
      dispatchScrollEvent(target);
      await sleep(120);
      target.scrollTo?.({ top: maxTop, behavior: 'auto' });
      target.scrollTop = maxTop;
      dispatchScrollEvent(target);
    } catch {}
  }

  function buildLoadMoreCandidateSignature(cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) return '0';
    const picks = [...list.slice(0, 3), ...list.slice(-3)];
    const sample = picks.map((card) => {
      const anchor = buildCandidateAnchor(card);
      const name = getCandidateName(card);
      return `${anchor?.key || ''}|${name || anchor?.fallback || ''}`;
    });
    return `${list.length}|${sample.join('|')}`;
  }

  async function tryLoadMoreCandidates({ previousCards = null, attempts = 3 } = {}) {
    const beforeCards = Array.isArray(previousCards) && previousCards.length ? previousCards : findCandidateCards();
    if (!beforeCards.length) return false;
    const beforeSig = buildLoadMoreCandidateSignature(beforeCards);
    const beforeCount = beforeCards.length;
    const beforeTailAnchor = buildCandidateAnchor(beforeCards[beforeCards.length - 1] || null);

    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
      const currentCards = findCandidateCards();
      const tail = currentCards[currentCards.length - 1] || beforeCards[beforeCards.length - 1] || null;
      try { tail?.scrollIntoView?.({ block: 'end', inline: 'nearest', behavior: 'auto' }); } catch {}
      await sleep(180);

      const targets = collectCandidateListScrollTargets(currentCards.length ? currentCards : beforeCards);
      for (const target of targets) {
        if (target === tail) continue;
        await nudgeScrollTargetToBottom(target);
      }
      try {
        window.scrollBy({ top: Math.max(420, Math.round(window.innerHeight * 0.9)), behavior: 'auto' });
        dispatchScrollEvent(window);
      } catch {}

      const changed = await waitFor(() => {
        const cardsNow = findCandidateCards();
        if (!cardsNow.length) return null;
        const sigNow = buildLoadMoreCandidateSignature(cardsNow);
        const tailNow = buildCandidateAnchor(cardsNow[cardsNow.length - 1] || null);
        if (cardsNow.length > beforeCount) return true;
        if (tailNow?.key && beforeTailAnchor?.key && tailNow.key !== beforeTailAnchor.key) return true;
        if (sigNow && sigNow !== beforeSig) return true;
        return null;
      }, 3200).catch(() => false);

      if (changed) {
        await waitForCandidateListStable(5000).catch(() => {});
        return true;
      }
      await sleep(420);
    }
    return false;
  }

  function findCandidateListRefreshButton() {
    const cands = queryAllAnyDoc('button.btn-refresh, .finished-wrap button, button.btn.btn-refresh, button', 120)
      .filter((el) => isVisible(el));
    const scored = cands
      .map((el) => {
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        let score = 0;
        if (text === '刷新') score += 100;
        else if (text.includes('刷新')) score += 70;
        const wrapText = String(el.closest?.('.finished-wrap, .loadmore, [class*="finished"], [class*="loadmore"]')?.innerText || '').replace(/\s+/g, ' ').trim();
        if (wrapText.includes('当前列表没有更多牛人了')) score += 80;
        if (wrapText.includes('刷新获取最新列表')) score += 80;
        if (String(el.className || '').includes('btn-refresh')) score += 20;
        return { el, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.el || null;
  }

  async function tryRefreshCandidateListByButton({ previousCards = null } = {}) {
    const beforeCards = Array.isArray(previousCards) && previousCards.length ? previousCards : findCandidateCards();
    const beforeSig = buildLoadMoreCandidateSignature(beforeCards);
    const beforeFirstCard = beforeCards[0] || null;
    const beforeFirstAnchor = buildCandidateAnchor(beforeFirstCard);
    const beforeLastAnchor = buildCandidateAnchor(beforeCards[beforeCards.length - 1] || null);
    const btn = findCandidateListRefreshButton();
    if (!btn) return false;

    try { btn.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch {}
    simulateClick(btn);
    await sleep(280);

    const changed = await waitFor(() => {
      const cardsNow = findCandidateCards();
      if (!cardsNow.length) return null;
      const sigNow = buildLoadMoreCandidateSignature(cardsNow);
      const firstNow = cardsNow[0] || null;
      const firstAnchorNow = buildCandidateAnchor(firstNow);
      const lastAnchorNow = buildCandidateAnchor(cardsNow[cardsNow.length - 1] || null);
      if (sigNow && sigNow !== beforeSig) return true;
      if (firstNow && beforeFirstCard && firstNow !== beforeFirstCard) return true;
      if (firstAnchorNow?.key && beforeFirstAnchor?.key && firstAnchorNow.key !== beforeFirstAnchor.key) return true;
      if (lastAnchorNow?.key && beforeLastAnchor?.key && lastAnchorNow.key !== beforeLastAnchor.key) return true;
      const stillFinishedTip = !!findCandidateListRefreshButton();
      if (!stillFinishedTip) return true;
      return null;
    }, 8000).catch(() => false);

    if (changed) {
      await waitForCandidateListStable(5000).catch(() => {});
      return true;
    }
    return false;
  }

  function normalizeKeywordLines(s) {
    // 1.1.1：除换行外，也支持半/全角斜杠、逗号、分号、竖线、顿号作为分隔符
    // 例：用户写 "插画/二次元" 等价于两行 "插画" + "二次元"
    return String(s || '')
      .split(/[\n\r\/／,，;；|｜、]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  }

  function normalizeOutreachListMode(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'featured' || v === 'latest') return v;
    return 'recommend';
  }

  function getOutreachListModeLabel(mode) {
    const v = normalizeOutreachListMode(mode);
    if (v === 'featured') return '精选';
    if (v === 'latest') return '最新';
    return '推荐';
  }

  function getCurrentOutreachListMode() {
    const current = queryAnyRecommendDoc('.candidate-head .tab-wrap .tab-item.curr')
      || queryAnyRecommendDoc('.candidate-head .tab-list .tab-item.curr')
      || queryAnyRecommendDoc('li.tab-item.curr, .tab-item.curr, [class*="tab-item"].curr');
    const title = String(current?.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim();
    const text = String(current?.textContent || '').replace(/\s+/g, ' ').trim();
    if (title.includes('精选') || text.includes('精选')) return 'featured';
    if (title.includes('最新') || text.includes('最新')) return 'latest';
    if (title.includes('推荐') || text.includes('推荐')) return 'recommend';
    return 'recommend';
  }

  function findOutreachListModeTab(mode) {
    const targetMode = normalizeOutreachListMode(mode);
    const candidates = queryAllRecommendDoc('.candidate-head .tab-wrap .tab-item, .candidate-head .tab-list .tab-item, li.tab-item, .tab-item, [class*="tab-item"]', 80)
      .filter((el) => isVisible(el))
      .map((el) => {
        const title = String(el.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim();
        const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        const status = String(el.getAttribute?.('data-status') || '').trim();
        let score = -Infinity;
        if (targetMode === 'recommend') {
          if (title.includes('推荐牛人')) score = 100;
          else if (title.includes('推荐')) score = 90;
          else if (text.includes('推荐牛人')) score = 80;
          else if (text.includes('推荐')) score = 70;
        } else if (targetMode === 'featured') {
          if (status === '3' && title.includes('精选牛人')) score = 130;
          else if (title.includes('精选牛人')) score = 120;
          else if (status === '3' && text.includes('精选')) score = 110;
          else if (text.includes('精选牛人')) score = 100;
          else if (text.includes('精选')) score = 90;
        } else if (targetMode === 'latest') {
          if (title.includes('最新')) score = 100;
          else if (text.includes('最新')) score = 90;
        }
        if (String(el.className || '').includes('curr')) score += 8;
        return { el, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length > 0) return candidates[0].el;

    const fallbackByText = (keywords) => {
      const docs = getRecommendContextDocs();
      for (const d of docs) {
        let nodes = [];
        try { nodes = Array.from(d.querySelectorAll?.('li.tab-item, .tab-item, [class*="tab-item"]') || []); } catch {}
        for (const el of nodes) {
          const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
          if (keywords.some((kw) => text.includes(kw))) return el;
        }
      }
      return null;
    };

    if (targetMode === 'recommend') {
      return fallbackByText(['推荐牛人', '推荐']);
    }
    if (targetMode === 'featured') {
      return fallbackByText(['精选牛人', '精选']);
    }
    if (targetMode === 'latest') {
      return fallbackByText(['最新']);
    }
    return null;
  }

  async function ensureOutreachListModeSelected(mode) {
    const targetMode = normalizeOutreachListMode(mode);
    const targetLabel = getOutreachListModeLabel(targetMode);
    if (getCurrentOutreachListMode() === targetMode) return true;

    const tab = findOutreachListModeTab(targetMode);
    if (!tab) {
      if (targetMode === 'featured') {
        logWarn('主动寻访：当前岗位暂无「精选」列表，已停止本次运行');
      } else {
        logWarn(`主动寻访：未找到「${targetLabel}」列表的页内 tab`);
      }
      return false;
    }

    simulateClick(tab);
    const ok = await waitFor(() => {
      return getCurrentOutreachListMode() === targetMode ? true : null;
    }, 10000).catch(() => false);
    if (!ok) {
      if (targetMode === 'featured') {
        logWarn('主动寻访：已尝试切换到「精选」列表，但当前岗位没有可用的精选页，已停止本次运行');
      } else {
        logWarn(`主动寻访：点击了「${targetLabel}」列表，但未确认切换成功`);
      }
      return false;
    }

    await prepareCandidateListAfterJobSwitch().catch(() => {});
    return true;
  }

  function safeJsonParse(text) {
    const t = String(text || '').trim();
    // 尝试直接 parse
    try { return JSON.parse(t); } catch {}

    // 从输出中截取第一个 JSON 对象
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const slice = t.slice(first, last + 1);
      try { return JSON.parse(slice); } catch {}
    }
    return {};
  }

  // ====== UI/Logging ======

  function highlight(el, bg, border) {
    try {
      el.style.setProperty('background-color', bg, 'important');
      el.style.setProperty('outline', `2px solid ${border}`, 'important');
      el.style.setProperty('transition', 'all 0.2s ease', 'important');
    } catch {}
  }

  /**
   * 1.1.x：在推荐牛人页里按 encryptGeekId / geekId / 姓名 找到候选人卡片
   *   - 若 target 带 jobKey/jobName：先切到该岗位（切错岗位时推荐列表里根本没有这个候选人）
   *   - 命中后：滚到视图中央 + 高亮金色描边 4 秒
   *   - 卡片可能在 iframe 子文档里；最多等 8 秒（推荐列表是异步渲染的）
   *   - 没命中（已经被滚出列表 / 已刷新过）→ 返回 ok:false，让上游兜底提示
   */
  async function locateAndHighlightCandidate(target) {
    const wantEid = String(target?.encryptGeekId || '').trim();
    const wantGid = String(target?.geekId || '').trim();
    const wantName = String(target?.name || '').trim();
    const wantJobKey  = String(target?.jobKey || '').trim();
    const wantJobName = String(target?.jobName || '').trim();
    if (!wantEid && !wantGid && !wantName) {
      return { ok: false, error: '没有可用的定位线索（缺 encryptGeekId / geekId / 姓名）' };
    }

    // 1) 先切岗位（仅当历史记录里有岗位信息时）
    if (wantJobKey || wantJobName) {
      try {
        const switched = await ensureRecommendJobSelected({ jobKey: wantJobKey, jobName: wantJobName }).catch(() => false);
        if (switched) {
          logInfo(`定位前已切换岗位为「${wantJobName || wantJobKey}」，等候推荐列表刷新...`);
          // 切岗后推荐列表会重新拉数据，给点时间
          await sleep(1200);
        } else {
          logWarn(`未能自动切换到岗位「${wantJobName || wantJobKey}」，请手动切到该岗位再点定位（候选人可能仅在该岗位下显示）`);
        }
      } catch {}
    }

    const matches = (card) => {
      try {
        const name = getCandidateName(card) || '';
        const idInfo = getCandidateIdInfo(name, card) || {};
        if (wantEid && (idInfo.encryptGeekId === wantEid || idInfo.id === wantEid)) return true;
        if (wantGid && (idInfo.geekId === wantGid || (idInfo.type === 'geekId' && idInfo.id === wantGid)
                                                  || (idInfo.type === 'domGeekId' && idInfo.id === wantGid))) return true;
        // 姓名兜底（脱敏的"张**"在同一批次唯一性高）
        if (wantName && name && name === wantName) return true;
        return false;
      } catch { return false; }
    };

    const tryFindNow = () => {
      const cards = findCandidateCards();
      return cards.find(matches) || null;
    };

    // 1) 当前可见区域里直接找；推荐列表是异步加载的，最多等 6 秒
    let target_card = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      target_card = tryFindNow();
      if (target_card) break;
      await sleep(450);
    }

    // 2) 没找到 → 在当前子页里多滚几次"加载更多"，候选人可能在下面
    if (!target_card) {
      logInfo('未在可视范围内找到，向下滚动加载更多候选人...');
      for (let i = 0; i < 3 && !target_card; i++) {
        const moreLoaded = await tryLoadMoreCandidates({ attempts: 2 }).catch(() => false);
        target_card = tryFindNow();
        if (target_card) break;
        if (!moreLoaded) break; // 已到底
        await sleep(400);
      }
    }

    // 3) 还没找到 → 尝试切到其他子页（推荐 / 精选 / 最新）
    //    Boss 经常把"已查看"的候选人移出当前子页，但其他子页可能还在
    if (!target_card) {
      const currentMode = getCurrentOutreachListMode?.() || '';
      const tryModes = ['recommend', 'featured', 'latest'].filter(m => m !== currentMode);
      for (const m of tryModes) {
        if (target_card) break;
        try {
          logInfo(`未找到，尝试切到「${getOutreachListModeLabel(m)}」列表查找...`);
          const ok = await ensureOutreachListModeSelected(m).catch(() => false);
          if (!ok) continue;
          await sleep(900); // 等列表渲染
          target_card = tryFindNow();
          if (target_card) break;
          // 也滚动加载一下
          for (let i = 0; i < 2 && !target_card; i++) {
            const moreLoaded = await tryLoadMoreCandidates({ attempts: 2 }).catch(() => false);
            target_card = tryFindNow();
            if (target_card || !moreLoaded) break;
            await sleep(300);
          }
        } catch {}
      }
    }

    if (!target_card) {
      return {
        ok: false,
        notFound: true,
        error: '在所有推荐子页里都没有找到该候选人（Boss 可能已把 TA 从推荐流移除；姓名已复制到剪贴板，可在 Boss 站内搜索）',
      };
    }

    try { target_card.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch {}

    // 暂存原 style，4 秒后恢复
    const prev = {
      bg:       target_card.style.getPropertyValue('background-color'),
      bgPrio:   target_card.style.getPropertyPriority('background-color'),
      outline:  target_card.style.getPropertyValue('outline'),
      outPrio:  target_card.style.getPropertyPriority('outline'),
      shadow:   target_card.style.getPropertyValue('box-shadow'),
      shadowPrio: target_card.style.getPropertyPriority('box-shadow'),
    };
    try {
      target_card.style.setProperty('outline', '3px solid #f59e0b', 'important');
      target_card.style.setProperty('box-shadow', '0 0 0 4px rgba(245,158,11,0.25)', 'important');
    } catch {}
    setTimeout(() => {
      try {
        if (prev.outline) target_card.style.setProperty('outline', prev.outline, prev.outPrio || '');
        else target_card.style.removeProperty('outline');
        if (prev.shadow) target_card.style.setProperty('box-shadow', prev.shadow, prev.shadowPrio || '');
        else target_card.style.removeProperty('box-shadow');
      } catch {}
    }, 4000);

    const cardName = getCandidateName(target_card) || wantName || '';
    return { ok: true, name: cardName };
  }

  /**
   * 1.1.x：从 chrome.storage.local 读取上一次的"待定位目标"
   *   - popup 触发跨页跳转时把目标先写进 storage，跳完进入推荐牛人页后这里负责消费
   *   - 30 秒之内有效；超时即作废
   */
  async function consumePendingLocateTargetIfAny() {
    if (!isOnRecommendRouteNow()) return;
    let entry = null;
    try {
      const r = await chrome.storage.local.get(['bossAssistLocateTarget']);
      entry = r?.bossAssistLocateTarget || null;
    } catch { return; }
    if (!entry || typeof entry !== 'object') return;
    // 不论成功失败都先清掉，避免下一次进推荐页又被触发
    try { await chrome.storage.local.remove(['bossAssistLocateTarget']); } catch {}
    const ts = Number(entry.ts || 0);
    if (!ts || Date.now() - ts > 30000) return;
    try {
      // 给推荐列表一点初始化时间
      await sleep(800);
      const r = await locateAndHighlightCandidate(entry).catch(() => null);
      if (r?.ok) {
        logInfo(`已定位候选人「${r.name || entry.name || ''}」，请在卡片处手动点开查看简历`);
      } else {
        logWarn(r?.error || '未在推荐列表中找到该候选人');
      }
    } catch {}
  }

  async function appendLog(entry) {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEYS.logs]);
      const logs = Array.isArray(result?.[STORAGE_KEYS.logs]) ? result[STORAGE_KEYS.logs] : [];
      logs.push(entry);
      const keep = logs.slice(Math.max(0, logs.length - 200));
      await chrome.storage.local.set({ [STORAGE_KEYS.logs]: keep });
    } catch {}
    chrome.runtime.sendMessage({ type: 'BOSS_ASSIST_LOG', entry }).catch(() => {});
  }

  function logInfo(message) { appendLog({ ts: Date.now(), level: 'info', message }); }
  function logWarn(message) { appendLog({ ts: Date.now(), level: 'warn', message }); }
  function logSuccess(message) { appendLog({ ts: Date.now(), level: 'success', message }); }

  // ====== Utils ======

  function renderTemplate(tpl, vars) {
    return String(tpl || '')
      .replace(/\$\{name\}/g, vars.name ?? '')
      .replace(/\$\{position\}/g, vars.position ?? '')
      .replace(/\$\{score\}/g, vars.score ?? '')
      .replace(/\$\{reason\}/g, vars.reason ?? '');
  }

  function clampInt(v, min, max) {
    const n = parseInt(String(v), 10);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function mergeDeep(a, b) {
    if (!b || typeof b !== 'object') return a;
    const out = Array.isArray(a) ? [...a] : { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
        out[k] = mergeDeep(a[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function normalizeSettingsWithPromptMigration(saved) {
    const merged = mergeDeep(DEFAULT_SETTINGS, saved || {});
    merged.aiPrompts = mergeDeep(DEFAULT_SETTINGS.aiPrompts, merged.aiPrompts || {});

    if (!String(merged.autoReplyPassMode || '').trim()) {
      merged.autoReplyPassMode = getDefaultPassReplyMode(merged);
    }
    if (!String(merged.autoReplyPassTemplate || '').trim()) {
      merged.autoReplyPassTemplate = String(merged.autoReplyTemplate || DEFAULT_SETTINGS.autoReplyTemplate);
    }
    if (!String(merged.autoReplyPassCommonPhrase || '').trim()) {
      merged.autoReplyPassCommonPhrase = String(merged.replyCommonPhrase || '');
    }
    merged.autoReplyCandidateRejectMode = normalizeReplySendMode(merged.autoReplyCandidateRejectMode, 'template');
    merged.autoReplyOurRejectMode = normalizeReplySendMode(merged.autoReplyOurRejectMode, 'template');
    if (!String(merged.autoReplyCandidateRejectTemplate || '').trim()) {
      merged.autoReplyCandidateRejectTemplate = DEFAULT_SETTINGS.autoReplyCandidateRejectTemplate;
    }
    if (!String(merged.autoReplyOurRejectTemplate || '').trim()) {
      merged.autoReplyOurRejectTemplate = DEFAULT_SETTINGS.autoReplyOurRejectTemplate;
    }

    const stage1 = String(merged.aiPrompts.stage1 || '').trim();
    if (!stage1 || LEGACY_AI_PROMPTS.stage1.has(stage1)) {
      merged.aiPrompts.stage1 = DEFAULT_SETTINGS.aiPrompts.stage1;
    }

    const stage2 = String(merged.aiPrompts.stage2 || '').trim();
    if (!stage2 || LEGACY_AI_PROMPTS.stage2.has(stage2)) {
      merged.aiPrompts.stage2 = DEFAULT_SETTINGS.aiPrompts.stage2;
    }

    return merged;
  }

  function uniqBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const k = keyFn(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  function hashText(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  async function getObjectMap(key) {
    const result = await chrome.storage.local.get([key]);
    const v = result?.[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  // 1.1.x：保留期 30 天，超过的本地评分历史在每次寻访启动 / popup 加载时被剔除
  const PROCESSED_OUTREACH_RETAIN_DAYS = 30;

  /**
   * 原地剪掉超出保留期的处理记录；返回被删除的条数。
   * 仅删除带有 `ts` 且距今超过 `days` 天的条目；缺失 ts 的旧数据保留以防误删。
   */
  function pruneOldProcessedRecords(map, days = PROCESSED_OUTREACH_RETAIN_DAYS) {
    if (!map || typeof map !== 'object') return 0;
    const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const k of Object.keys(map)) {
      const v = map[k];
      const ts = Number(v?.ts || 0);
      if (ts > 0 && ts < cutoff) {
        delete map[k];
        removed++;
      }
    }
    return removed;
  }

  /**
   * 读取 processedOutreach，并在读取时顺手剪掉超期记录；如有删减则写回存储。
   * 替代直接调用 getObjectMap(STORAGE_KEYS.processedOutreach) 的场景。
   */
  async function getProcessedOutreachPruned() {
    const map = await getObjectMap(STORAGE_KEYS.processedOutreach);
    const removed = pruneOldProcessedRecords(map, PROCESSED_OUTREACH_RETAIN_DAYS);
    if (removed > 0) {
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: map });
      } catch {}
    }
    return map;
  }

  async function getArrayList(key) {
    const result = await chrome.storage.local.get([key]);
    return Array.isArray(result?.[key]) ? result[key] : [];
  }

  function normalizeManualReviewQueueItem(item = {}) {
    return {
      id: String(item.id || '').trim(),
      candidateKey: String(item.candidateKey || '').trim(),
      candidateName: String(item.candidateName || '').trim(),
      positionName: String(item.positionName || '').trim(),
      source: String(item.source || '').trim(),
      sourceLabel: String(item.sourceLabel || '').trim(),
      action: String(item.action || '').trim(),
      actionLabel: String(item.actionLabel || '').trim(),
      tagClass: String(item.tagClass || 'info').trim() || 'info',
      reason: String(item.reason || '').trim(),
      draftText: String(item.draftText || '').trim(),
      lastInboundText: String(item.lastInboundText || '').trim(),
      lastMeText: String(item.lastMeText || '').trim(),
      materials: String(item.materials || '').trim(),
      ts: Number(item.ts || Date.now()) || Date.now(),
    };
  }

  async function upsertManualReviewQueueItem(item = {}) {
    const normalized = normalizeManualReviewQueueItem(item);
    if (!normalized.id) return false;
    const list = await getArrayList(STORAGE_KEYS.manualReviewQueue);
    const next = list.filter((entry) => String(entry?.id || '').trim() !== normalized.id);
    next.unshift(normalized);
    await chrome.storage.local.set({
      [STORAGE_KEYS.manualReviewQueue]: next.slice(0, 200),
    }).catch(() => {});
    return true;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randBetween(min, max) {
    const lo = Number.isFinite(Number(min)) ? Number(min) : 0;
    const hi = Number.isFinite(Number(max)) ? Number(max) : lo;
    return Math.round(lo + Math.random() * Math.max(0, hi - lo));
  }

  async function humanPause(min = 120, max = 320) {
    await sleep(randBetween(min, max));
  }

  function emitHoverSequence(element) {
    try {
      if (!element) return;
      const view = element?.ownerDocument?.defaultView || window;
      const rect = element.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      const x = rect.left + Math.max(5, Math.min(rect.width - 5, rect.width * (0.35 + Math.random() * 0.3)));
      const y = rect.top + Math.max(5, Math.min(rect.height - 5, rect.height * (0.35 + Math.random() * 0.3)));
      const props = {
        bubbles: true,
        cancelable: true,
        view,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      };
      element.dispatchEvent(new view.PointerEvent('pointermove', props));
      element.dispatchEvent(new view.MouseEvent('mousemove', props));
      element.dispatchEvent(new view.PointerEvent('pointerover', props));
      element.dispatchEvent(new view.MouseEvent('mouseover', props));
    } catch {}
  }

  async function humanApproachElement(element, { purpose = 'generic' } = {}) {
    if (!element || !isVisible(element)) return;
    try {
      const block = Math.random() < 0.5 ? 'center' : (Math.random() < 0.75 ? 'nearest' : 'start');
      element.scrollIntoView?.({ behavior: 'smooth', block, inline: 'nearest' });
    } catch {}
    await humanPause(90, 220);
    try {
      const view = element?.ownerDocument?.defaultView || window;
      if (view && typeof view.scrollBy === 'function' && Math.random() < 0.35) {
        const top = purpose === 'thread' ? randBetween(-18, 34) : randBetween(-24, 46);
        view.scrollBy({ top, behavior: 'smooth' });
        await humanPause(60, 150);
      }
    } catch {}
    emitHoverSequence(element);
    await humanPause(50, 130);
    if (Math.random() < 0.1) await humanPause(160, 340);
  }

  async function jitterDelay() {
    const min = clampInt(settings.delayMinMs, 0, 60000);
    const max = clampInt(settings.delayMaxMs, 0, 60000);
    let ms = randBetween(min, max);
    // 1.1.2 humanizer：弱模式 ±10-20% 抖动；中/强模式 ±20-35%
    try {
      if (!isLowRiskMode()) {
        const intensity = String((settings.humanizer && settings.humanizer.intensity) || 'strong');
        const jitterPct = intensity === 'weak' ? 0.15 : (intensity === 'med' ? 0.25 : 0.35);
        const factor = 1 + (Math.random() * 2 - 1) * jitterPct; // 1±jitterPct
        ms = Math.max(50, Math.round(ms * factor));
      }
    } catch (_) {}
    await sleep(ms);
  }

  /* ===== 1.1.2 Humanizer 模块 =====
   * 仅在 settings.riskMode === 'auto' 下生效
   * - humanReadingPause()：模拟阅读简历的停顿
   * - humanScrollAround()：模拟"滑滚一下看看周围"
   * - maybeRestPeriod()：定期插入"假装走神"的休息期
   * - maybeRandomSkip()：强模式下按概率假装漏掉，打破规律
   */
  function humanizerEnabled() {
    return !isLowRiskMode();
  }
  function humanizerCfg() {
    const h = (settings && settings.humanizer) || {};
    return {
      intensity: String(h.intensity || 'strong'),
      restEveryMinMin: Number.isFinite(h.restEveryMinMin) ? h.restEveryMinMin : 25,
      restEveryMinMax: Number.isFinite(h.restEveryMinMax) ? h.restEveryMinMax : 40,
      restDurationSecMin: Number.isFinite(h.restDurationSecMin) ? h.restDurationSecMin : 60,
      restDurationSecMax: Number.isFinite(h.restDurationSecMax) ? h.restDurationSecMax : 180,
      randomSkipPct: Number.isFinite(h.randomSkipPct) ? h.randomSkipPct : 5,
    };
  }
  function humanizerOnRunStart() {
    humanizerRunStartTs = Date.now();
    humanizerActionsSinceLastScroll = 0;
    if (humanizerEnabled()) {
      const c = humanizerCfg();
      const minutes = randBetween(c.restEveryMinMin, c.restEveryMinMax);
      humanizerNextRestAt = Date.now() + minutes * 60 * 1000;
    } else {
      humanizerNextRestAt = 0;
    }
  }
  async function humanReadingPause() {
    if (!humanizerEnabled()) return;
    const intensity = humanizerCfg().intensity;
    if (intensity === 'weak') return;
    // med：1.5-3.5s，strong：2.5-6s
    const [lo, hi] = intensity === 'med' ? [1500, 3500] : [2500, 6000];
    const ms = randBetween(lo, hi);
    await sleep(ms);
  }
  async function humanScrollAround() {
    if (!humanizerEnabled()) return;
    const intensity = humanizerCfg().intensity;
    if (intensity === 'weak') return;
    // 找到候选人列表的滚动容器
    const root =
      queryAnyDoc('#recommend-list')
      || queryAnyDoc('.recommend-wrap')
      || queryAnyDoc('[class*="recommend-list"]')
      || queryAnyDoc('[class*="candidate-list"]')
      || null;
    try {
      const upPx = randBetween(120, 280);
      const downPx = randBetween(160, 360);
      if (root && typeof root.scrollBy === 'function') {
        root.scrollBy({ top: -upPx, behavior: 'auto' });
        await sleep(randBetween(400, 900));
        root.scrollBy({ top: downPx, behavior: 'auto' });
      } else {
        window.scrollBy(0, -upPx);
        await sleep(randBetween(400, 900));
        window.scrollBy(0, downPx);
      }
    } catch (_) {}
    await sleep(randBetween(400, 1100));
  }
  async function maybeRestPeriod() {
    if (!humanizerEnabled()) return false;
    const intensity = humanizerCfg().intensity;
    if (intensity !== 'strong') return false;
    if (humanizerNextRestAt <= 0) return false;
    if (Date.now() < humanizerNextRestAt) return false;
    const c = humanizerCfg();
    const restSec = randBetween(c.restDurationSecMin, c.restDurationSecMax);
    logInfo(`[humanizer] 走神/喝水休息 ${restSec}s（auto 模式 / 强）`);
    // 分段休息，便于响应 stop
    const start = Date.now();
    const targetEnd = start + restSec * 1000;
    while (Date.now() < targetEnd && running && !stopping) {
      await sleep(Math.min(2000, targetEnd - Date.now()));
    }
    // 安排下一次
    const minutes = randBetween(c.restEveryMinMin, c.restEveryMinMax);
    humanizerNextRestAt = Date.now() + minutes * 60 * 1000;
    return true;
  }
  function maybeRandomSkip() {
    if (!humanizerEnabled()) return false;
    const c = humanizerCfg();
    if (c.intensity !== 'strong') return false;
    const pct = clampInt(c.randomSkipPct, 0, 30);
    if (pct <= 0) return false;
    return Math.random() * 100 < pct;
  }
  function noteHumanizerActed() {
    humanizerActionsSinceLastScroll++;
  }
  async function maybeHumanScrollBetween() {
    if (!humanizerEnabled()) return;
    const intensity = humanizerCfg().intensity;
    if (intensity === 'weak') return;
    // 中：每 8-15 个动作；强：每 5-10 个
    const trigger = intensity === 'strong' ? randBetween(5, 10) : randBetween(8, 15);
    if (humanizerActionsSinceLastScroll < trigger) return;
    humanizerActionsSinceLastScroll = 0;
    await humanScrollAround();
  }

  function queryAllAnyDoc(selector, limit = 80) {
    const docs = getAllDocs();
    const out = [];
    for (const d of docs) {
      let list = [];
      try { list = Array.from(d.querySelectorAll(selector) || []); } catch {}
      for (const el of list) {
        out.push(el);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  function detectFrequentHintText() {
    const patterns = [
      '操作频繁',
      '操作太频繁',
      '操作过于频繁',
      '请求频繁',
      '请求过于频繁',
      '请稍后再试',
      '请稍后重试',
      '稍后再试',
      '请休息一下',
      '过于频繁',
      '异常访问行为',
      '完成验证后即可正常使用',
      '账号可能存在异常访问行为',
    ];
    const candidates = queryAllAnyDoc(
      '.ui-toast, .toast, [class*="toast"], [class*="Toast"], [role="alert"], [role="dialog"], .ui-dialog, [class*="dialog"], [class*="Dialog"], .ui-message, [class*="message"], [class*="Message"]',
      120
    );
    for (const el of candidates) {
      try {
        if (!isVisible(el)) continue;
        const t = String(el.innerText || el.textContent || '').trim();
        if (!t) continue;
        const lower = t.toLowerCase();
        if (patterns.some((p) => lower.includes(p))) return t.slice(0, 120);
      } catch {}
    }
    return null;
  }

  function detectVerificationHintText() {
    const patterns = [
      '您的账号可能存在异常访问行为',
      '账号可能存在异常访问行为',
      '完成验证后即可正常使用',
      '完成验证后即可',
      '请完成验证',
      '异常访问行为',
    ];
    const candidates = queryAllAnyDoc(
      'body, .ui-toast, .toast, [class*="toast"], [class*="Toast"], [role="alert"], [role="dialog"], .ui-dialog, [class*="dialog"], [class*="Dialog"], .ui-message, [class*="message"], [class*="Message"]',
      120
    );
    for (const el of candidates) {
      try {
        if (el !== document.body && !isVisible(el)) continue;
        const t = String(el.innerText || el.textContent || '').trim();
        if (!t) continue;
        if (patterns.some((p) => t.includes(p))) return t.slice(0, 120);
      } catch {}
    }
    return null;
  }

  async function stopIfVerificationNeeded(where = '') {
    const hint = detectVerificationHintText();
    if (!hint) return false;
    running = false;
    stopping = true;
    logWarn(`检测到账号验证提示${where ? `（${where}）` : ''}：${hint}。已自动停止，请先完成人工验证后再继续。`);
    return true;
  }

  async function backoffIfTooFrequent(where = '') {
    // 等一小会儿，让 toast 有时间出现
    await sleep(220);
    if (await stopIfVerificationNeeded(where)) return true;
    const hint = detectFrequentHintText();
    if (!hint) return false;
    const sec = clampInt(settings.freqBackoffSec, 3, 600, 25);
    logWarn(`触发频控${where ? `（${where}）` : ''}：${hint}。暂停 ${sec}s 后继续`);
    await sleep(sec * 1000);
    return true;
  }

  async function waitFor(fn, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(120);
    }
    return null;
  }

  // ====== Interaction simulation (borrowed from 大橘版思路) ======

  /* ===== 1.1.3 本机点击器（OS 级真鼠标，绕开 isTrusted 检测） =====
   * 仅在 auto 模式 + settings.externalClicker.enabled 时启用。
   * 把元素中心点在屏幕的绝对坐标算出来，POST 给本机 clicker_server.py
   * 由它通过 macOS Quartz CGEvent 模拟真鼠标点击，事件 isTrusted = true。
   */
  function getElementScreenCenter(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    let cx = rect.left + rect.width / 2;
    let cy = rect.top + rect.height / 2;
    // 累加 iframe 偏移到顶层（推荐牛人列表常在 iframe 内）
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    let safety = 0;
    while (win && win !== window.top && safety < 8) {
      try {
        const fe = win.frameElement;
        if (!fe) break;
        const fr = fe.getBoundingClientRect();
        cx += fr.left;
        cy += fr.top;
        win = fe.ownerDocument && fe.ownerDocument.defaultView;
      } catch (_) { break; }
      safety++;
    }
    // 顶层 window 加 chrome 顶栏偏移（tabs + URL bar + bookmarks bar）
    const top = window.top || window;
    let offsetY = 0;
    try { offsetY = Math.max(0, top.outerHeight - top.innerHeight); } catch (_) {}
    return {
      x: (top.screenX || 0) + cx,
      y: (top.screenY || 0) + offsetY + cy,
    };
  }

  async function clickViaExternalClicker(el, { name = '', candidateId = '', draftMessage = '', label = '点击' } = {}) {
    const cfg = settings && settings.externalClicker;
    if (!cfg || !cfg.enabled) return 'disabled';
    const endpoint = String(cfg.endpoint || 'http://127.0.0.1:12345').replace(/\/+$/, '');
    if (!el) return 'no-element';
    // 先把按钮滚到可见，等浏览器布局稳定再算坐标
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch (_) {}
    await sleep(200);
    const center = getElementScreenCenter(el);
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
      logWarn(`本机点击器：无法计算 ${label} 按钮的屏幕坐标`);
      return 'no-coords';
    }
    try {
      const resp = await fetch(`${endpoint}/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x: center.x,
          y: center.y,
          candidateName: String(name || ''),
          candidateId: String(candidateId || ''),
          draftMessage: String(draftMessage || ''),
          skipConfirm: cfg.perClickConfirm === false,
          // 1.1.3 idle gate
          idleMinSec: Number.isFinite(cfg.idleMinSec) ? cfg.idleMinSec : 0,
          idleMaxWaitSec: Number.isFinite(cfg.idleMaxWaitSec) ? cfg.idleMaxWaitSec : 300,
        }),
      });
      const j = await resp.json().catch(() => ({}));
      if (j && j.cancelled) {
        logInfo(`本机点击器：用户在弹窗里取消了 ${label}（${name || ''}）`);
        return 'cancelled';
      }
      if (j && j.idleTimeout) {
        logInfo(`本机点击器：等候空闲超时（你一直在用电脑），跳过 ${name || ''}`);
        return 'idle-timeout';
      }
      if (!j || j.ok !== true) {
        logWarn(`本机点击器返回失败：${(j && j.error) || '未知'}`);
        return 'failed';
      }
      return 'ok';
    } catch (e) {
      logWarn(`本机点击器无法连接（${endpoint}）：${e?.message || e}。请先运行 claude-boss-clicker。`);
      return 'unreachable';
    }
  }

  /**
   * 高风险按钮点击的统一入口：
   * - auto 模式 + 启用本机点击器 → 走 OS 级真鼠标，事件 isTrusted=true
   * - 其它情况 → 回退到 simulateClick（旧行为）
   * 返回：'os' | 'fallback' | 'cancelled' | 'unreachable'（后者意味着请求中断）
   */
  async function riskyClick(el, info = {}) {
    if (!el) return 'fallback';
    if (isLowRiskMode()) {
      // 低风险模式不应该走到这里（不会自动点）；保险起见 fallback
      simulateClick(el);
      return 'fallback';
    }
    const cfg = settings && settings.externalClicker;
    if (!cfg || !cfg.enabled) {
      // 用户没启用本机点击器 → 还是用 dispatchEvent（即 1.0.3 旧行为，已知会触发 isTrusted 检测）
      simulateClick(el);
      return 'fallback';
    }
    const r = await clickViaExternalClicker(el, info);
    if (r === 'ok') return 'os';
    if (r === 'cancelled') return 'cancelled';
    if (r === 'idle-timeout') return 'idle-timeout';
    // unreachable / failed / no-coords：故意不回退到 dispatchEvent，
    // 否则等于把刚说好的"不再走有指纹的方式"破功了。
    return 'unreachable';
  }

  function simulateClick(element) {
    try {
      const view = element?.ownerDocument?.defaultView || window;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const isHidden = rect.width === 0 && rect.height === 0;
      const commonProps = {
        bubbles: true,
        cancelable: true,
        view,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: 1,
      };

      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!isHidden) {
        element.dispatchEvent(new view.PointerEvent('pointerover', commonProps));
        element.dispatchEvent(new view.MouseEvent('mouseover', commonProps));
        element.dispatchEvent(new view.PointerEvent('pointerenter', commonProps));
        element.dispatchEvent(new view.MouseEvent('mouseenter', commonProps));
        element.dispatchEvent(new view.PointerEvent('pointerdown', commonProps));
        element.dispatchEvent(new view.MouseEvent('mousedown', commonProps));
        element.focus?.();
        element.dispatchEvent(new view.PointerEvent('pointerup', commonProps));
        element.dispatchEvent(new view.MouseEvent('mouseup', commonProps));
      }
      element.click();
    } catch (e) {
      try { element.click(); } catch {}
    }
  }

  async function simulateInput(element, value) {
    const doc = element?.ownerDocument || document;
    const view = doc.defaultView || window;
    const text = String(value ?? '');
    element.focus?.();
    await humanPause(120, 280);

    const chunkSize = text.length > 80 ? randBetween(18, 34) : randBetween(10, 22);
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    const applyValue = (nextText) => {
      if (element.isContentEditable) {
        element.innerHTML = '';
        const lines = String(nextText || '').split('\n');
        lines.forEach((line, i) => {
          element.appendChild(doc.createTextNode(line));
          if (i < lines.length - 1) element.appendChild(doc.createElement('br'));
        });
      } else if ('value' in element) {
        const proto = element.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(element, nextText);
        else element.value = nextText;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };

    if (!chunks.length) {
      applyValue('');
    } else {
      let composed = '';
      for (let i = 0; i < chunks.length; i++) {
        composed += chunks[i];
        applyValue(composed);
        if (i < chunks.length - 1) {
          await humanPause(50, Math.min(220, 80 + chunks[i].length * 8));
        }
      }
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(Math.min(1200, 120 + text.length * 14 + randBetween(60, 220)));
  }
}
