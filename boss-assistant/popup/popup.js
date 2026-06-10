const STORAGE_KEYS = {
  settings: 'bossAssistSettings',
  logs: 'bossAssistLogs',
  runState: 'bossAssistRunState',
  jobs: 'bossAssistJobs',
  jobKeywordOverrides: 'bossAssistJobKeywordOverrides',
  aiUsage: 'bossAssistAiUsage',
  uiPage: 'bossAssistUiPage',
  commonPhrases: 'bossAssistCommonPhrases',
  manualReviewQueue: 'bossAssistManualReviewQueue',
  // 1.1.0 新增：复用 content 已写入的评分结果（只读视图）
  processedOutreach: 'bossAssistProcessedOutreach',
  // 1.1.x：自动回复每处理一会话写一条记录，给 popup 显示卡片
  replyRunResults: 'bossAssistReplyRunResults',
};

const LOCAL_JOB_KEYWORD_PRESETS_PATH = 'local_job_keyword_presets.json';

const DEFAULT_SETTINGS = {
  enableOutreach: true,
  enableAutoReply: true,
  selectedJobKey: '',
  autoReplyJobKey: '',
  positionName: '',
  jdText: '',
  outreachListMode: 'recommend',
  // 寻访模式：ai / noai（默认按“是否配置AI”自动选择，兼容旧逻辑）
  outreachMode: 'auto',
  outreachTemplate: '你好 ${name}，我们在招 ${position}，看你背景很匹配，方便聊聊吗？',
  autoReplyTemplate: '你好，我看了你的信息。我们这边在招 ${position}，方便发下简历/聊聊你的期望吗？',
  replyCommonPhrase: '',
  autoReplyPassMode: '',
  autoReplyPassTemplate: '',
  autoReplyPassCommonPhrase: '',
  autoReplyPassPortfolioCommonPhrase: '',
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
  // 1.1.2 新增：风险模式与拟人化
  // riskMode: 'low' = 仅生成草稿，不自动操作（推荐）；'auto' = 主动寻访自动打招呼（=1.0.3 行为）
  riskMode: 'low',
  // 1.1.3：本机点击器（OS 级真鼠标，绕过 isTrusted 检测）
  // useExternalClicker = true 时，auto 模式下「打招呼」按钮的 click 不走扩展 dispatchEvent，
  // 改成把屏幕坐标 POST 给本机 clicker_server.py，由它用 CGEvent 真鼠标点击。
  externalClicker: {
    enabled: false,                       // 默认关；用户在 UI 切到 ON
    endpoint: 'http://127.0.0.1:12345',   // 本机点击器地址
    perClickConfirm: true,                // 每次点击都要本机弹确认（推荐 true）
    // 1.1.3 idle gate：仅在用户空闲 ≥ N 秒时才点击（避免打扰你正在用电脑）
    idleMinSec: 0,                        // 0 = 关闭；典型值 30
    idleMaxWaitSec: 300,                  // 等候超时（秒）；超时跳过当前候选人
  },
  // humanizer 仅在 auto 模式下生效；强度越强越像真人但越慢
  humanizer: {
    intensity: 'strong',           // 'weak' | 'med' | 'strong'
    restEveryMinMin: 25,           // 每隔多少分钟尝试插入一次"休息期"（最小）
    restEveryMinMax: 40,           // 每隔多少分钟尝试插入一次"休息期"（最大）
    restDurationSecMin: 60,        // 休息期最短时长
    restDurationSecMax: 180,       // 休息期最长时长
    randomSkipPct: 5,              // 强度='strong' 时随机跳过的百分比（已通过的也假装漏掉一些）
  },
  minAge: 0,
  maxAge: 0,
  minEdu: '0',
  maxRecentGapMonths: 0,  // 1.1.x：当前 gap（今天 - 上一份工作结束）超过 N 月直接淘汰；0 = 不启用
  // 1.1.x：AI 评分的 6 个维度 + 权重（和必须为 100）；权重可改，子项是说明文字
  aiScoringDimensions: null, // 初始化时通过 ensureDefaultScoringDimensions() 填充
  replyCooldownMin: 120,
  thresholds: { passScore: 60 },
  ai: { baseUrl: '', apiKey: '', model: '' },
  allowOutreachWithoutAI: false,
  keywordsAndMode: false,
  requiredKeywords: '',
  includeKeywords: '',
  excludeKeywords: '',
  // AI 校准方向（仅 AI 模式使用；不影响无AI关键词筛选）
  aiNiceKeywords: '',
  aiPrompts: {
    stage1: '你是一名资深招聘专家。你会根据岗位要求和候选人的基本信息，判断是否值得继续查看其完整简历并沟通。请只输出 JSON。',
    stage2: '你是一名简历筛选助手。请根据岗位名称、岗位要求和候选人简历判断是否匹配；允许基于同义词、近义岗位名、典型项目名和等价职责做语义判断；岗位名权重最高，项目经验默认按强弱扣分而不是硬性一票否决，公司/平台背景可作为加分项；排除项命中需要重扣分，尤其当目标岗位/实际岗位/最近岗位直接命中排除项时，通常应判定为不通过，除非其他证据特别强；禁止基于猜测、疑似风险或单纯“未提及”做过度扣分。请只输出 JSON。',
  },
};

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

const CUSTOM_PRESET_VALUE = '__custom__';
const AI_BASE_URL_PRESETS = [
  { value: 'https://llm-proxy.tapsvc.com/v1', label: 'TapTap LLM Proxy', defaultModel: 'claude-sonnet-4-6' },
  { value: 'https://api.siliconflow.cn/v1', label: 'SiliconFlow', defaultModel: 'deepseek-ai/DeepSeek-V3' },
  { value: 'https://openrouter.ai/api/v1', label: 'OpenRouter', defaultModel: 'deepseek/deepseek-chat-v3-0324:free' },
  { value: 'https://dashscope.aliyuncs.com/compatible-mode/v1', label: '阿里百炼', defaultModel: 'qwen-plus' },
  { value: 'https://ark.cn-beijing.volces.com/api/v3', label: '火山方舟', defaultModel: 'doubao-seed-1-6-250615' },
  { value: 'https://api.moonshot.cn/v1', label: 'Kimi / Moonshot', defaultModel: 'kimi-k2.5' },
  { value: 'https://open.bigmodel.cn/api/paas/v4', label: '智谱 GLM', defaultModel: 'glm-5' },
  { value: 'https://api.anthropic.com/v1', label: 'Claude（Anthropic OpenAI兼容）', defaultModel: 'claude-opus-4-1-20250805' },
];
const AI_MODEL_PRESETS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6（推荐）' },
  { value: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
  { value: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
  { value: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1' },
  { value: 'qwen-plus', label: 'Qwen Plus' },
  { value: 'qwen-max', label: 'Qwen Max' },
  { value: 'Qwen/Qwen3-32B', label: 'Qwen3 32B' },
  { value: 'kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'kimi-k2-thinking', label: 'Kimi K2 Thinking' },
  { value: 'moonshot-v1-32k', label: 'Moonshot v1 32K' },
  { value: 'glm-5', label: 'GLM-5' },
  { value: 'glm-4.7', label: 'GLM-4.7' },
  { value: 'doubao-seed-1-6-250615', label: '豆包 Seed 1.6' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
];

function findAiBaseUrlPreset(value) {
  const v = String(value || '').trim();
  return AI_BASE_URL_PRESETS.find((item) => item.value === v) || null;
}

// 1.1.x：AI 评分的 4 维默认权重 + 描述（用户可在 popup 调权重，描述固定）
//   默认四维均分 25 各 25 分 = 100；用户可自行调整为权重不同
const DEFAULT_SCORING_DIMENSIONS = [
  {
    id: 'jd', name: 'JD 匹配度', weight: 25, color: '#22c55e',
    criteria: [
      '岗位职责与候选人作品方向是否一致',
      '作品成熟度是否符合目标级别',
      '技能栈是否匹配岗位要求',
      '是否具有相关项目经验',
    ],
  },
  {
    id: 'keyword', name: '关键词匹配度', weight: 25, color: '#3b82f6',
    criteria: [
      '必含关键词命中情况',
      '任意关键词命中情况',
      '排除关键词是否触发（按语义角色判断）',
      '加分项（AI 校准方向）命中情况',
    ],
  },
  {
    id: 'background', name: '背景经验匹配度', weight: 25, color: '#f59e0b',
    criteria: [
      '游戏项目经验（项目名 / 公司 / 上线作品）',
      '项目类型匹配（二次元、SLG、MMO、卡牌、开放世界、写实等）',
      '大厂 / 独立工作室 / 外包 经验占比',
      '初 / 中 / 高级资历与岗位级别匹配',
    ],
  },
  {
    id: 'education', name: '教育与履历完整度', weight: 25, color: '#8b5cf6',
    criteria: [
      '学历是否满足岗位硬要求',
      '是否八大美院 / 985 / 211 / 名校（如岗位看重）',
      '工作连续性（中间是否有过长 Gap）',
      '履历信息是否完整可信',
    ],
  },
];

function deepCloneScoringDimensions(src) {
  return JSON.parse(JSON.stringify(src || DEFAULT_SCORING_DIMENSIONS));
}

function ensureDefaultScoringDimensions() {
  if (!Array.isArray(settings.aiScoringDimensions) || settings.aiScoringDimensions.length === 0) {
    settings.aiScoringDimensions = deepCloneScoringDimensions(DEFAULT_SCORING_DIMENSIONS);
    return;
  }
  // 1.1.x 迁移：原 6 维（含 openness / community）→ 新 4 维；丢弃已废弃维度
  //   - name / color / criteria 永远以 DEFAULT 为准（这些不可用户编辑）
  //   - weight 保留用户的（如果该 id 还存在）；新加的维度用 DEFAULT weight
  const validIds = new Set(DEFAULT_SCORING_DIMENSIONS.map(d => d.id));
  const userWeightMap = new Map(
    settings.aiScoringDimensions
      .filter(d => d && validIds.has(d.id) && Number.isFinite(Number(d.weight)))
      .map(d => [d.id, Number(d.weight)])
  );
  // 按 DEFAULT 顺序重建，weight 优先用用户值；name/color/criteria 永远用最新 DEFAULT
  let rebuilt = DEFAULT_SCORING_DIMENSIONS.map(def => ({
    id:       def.id,
    name:     def.name,
    color:    def.color,
    criteria: [...def.criteria],
    weight:   userWeightMap.has(def.id) ? userWeightMap.get(def.id) : def.weight,
  }));
  // 1.1.x：从 6 维迁移到 4 维后，总分可能不是 100（删了 openness=5 + community=15 = 20 分）
  //        老用户切到 4 维时直接重置为新默认（25 各 4）；自定义过权重的用户在控件里仍可改
  const total = rebuilt.reduce((s, d) => s + (Number(d.weight) || 0), 0);
  if (total !== 100) {
    rebuilt = deepCloneScoringDimensions(DEFAULT_SCORING_DIMENSIONS);
  }
  settings.aiScoringDimensions = rebuilt;
}

function getScoringDimensionsTotal() {
  if (!Array.isArray(settings.aiScoringDimensions)) return 0;
  return settings.aiScoringDimensions.reduce((s, d) => s + (Number(d.weight) || 0), 0);
}

// 1.1.x：渲染评分维度卡片 + 进度条 + 总分校验
function renderScoringDimensions() {
  if (!els.scoringDimsGrid || !els.scoringDimsBar || !els.scoringDimsTotal) return;
  ensureDefaultScoringDimensions();
  const dims = settings.aiScoringDimensions;
  const total = getScoringDimensionsTotal();

  // 顶部总分
  els.scoringDimsTotal.textContent = `${total}/100`;
  els.scoringDimsTotal.classList.toggle('bad', total !== 100);
  els.scoringDimsTotal.textContent = total === 100 ? `✓ 100/100` : `⚠ ${total}/100（需 100）`;

  // 进度条 segs
  els.scoringDimsBar.innerHTML = '';
  const barFrag = document.createDocumentFragment();
  for (const d of dims) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.backgroundColor = d.color;
    seg.style.width = `${Math.max(0, (Number(d.weight) || 0))}%`;
    seg.title = `${d.name}：${d.weight} 分`;
    barFrag.appendChild(seg);
  }
  els.scoringDimsBar.appendChild(barFrag);

  // 卡片网格
  els.scoringDimsGrid.innerHTML = '';
  const grid = document.createDocumentFragment();
  for (const d of dims) {
    const item = document.createElement('div');
    item.className = 'scoringDimItem';
    item.style.borderLeftColor = d.color;
    const liHtml = d.criteria.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    item.innerHTML = `
      <div class="scoringDimHead">
        <span class="scoringDimName">${escapeHtml(d.name)}</span>
        <input class="input scoringDimWeightInput" data-dim-id="${escapeHtml(d.id)}" type="number" min="0" max="100" step="1" value="${Number(d.weight) || 0}" />
        <span class="scoringDimSuffix">分</span>
      </div>
      <ul class="scoringDimCriteria">${liHtml}</ul>
    `;
    grid.appendChild(item);
  }
  els.scoringDimsGrid.appendChild(grid);

  // 绑定权重输入变更
  els.scoringDimsGrid.querySelectorAll('.scoringDimWeightInput').forEach((inp) => {
    inp.addEventListener('input', onScoringDimWeightChange);
    inp.addEventListener('change', onScoringDimWeightChange);
  });
}

let scoringDimsSaveTimer = null;
function onScoringDimWeightChange(ev) {
  const id = ev.target.getAttribute('data-dim-id');
  let v = parseInt(ev.target.value, 10);
  if (!Number.isFinite(v)) v = 0;
  v = Math.max(0, Math.min(100, v));
  ev.target.value = String(v);
  const dim = (settings.aiScoringDimensions || []).find(d => d.id === id);
  if (dim) dim.weight = v;
  // 实时更新进度条 + 总分（不重渲染整个网格，避免输入框失焦）
  const total = getScoringDimensionsTotal();
  els.scoringDimsTotal.textContent = total === 100 ? `✓ 100/100` : `⚠ ${total}/100（需 100）`;
  els.scoringDimsTotal.classList.toggle('bad', total !== 100);
  els.scoringDimsBar.innerHTML = '';
  for (const d of settings.aiScoringDimensions) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.backgroundColor = d.color;
    seg.style.width = `${Math.max(0, (Number(d.weight) || 0))}%`;
    seg.title = `${d.name}：${d.weight} 分`;
    els.scoringDimsBar.appendChild(seg);
  }
  // 防抖自动保存
  if (scoringDimsSaveTimer) clearTimeout(scoringDimsSaveTimer);
  scoringDimsSaveTimer = setTimeout(async () => {
    await saveSettings();
    if (els.scoringDimsSavedTag) {
      els.scoringDimsSavedTag.textContent = '✓ 已自动保存';
      els.scoringDimsSavedTag.classList.add('flash');
      setTimeout(() => {
        els.scoringDimsSavedTag.textContent = '已自动保存';
        els.scoringDimsSavedTag.classList.remove('flash');
      }, 1500);
    }
  }, 500);
}

function restoreDefaultScoringDimensions() {
  settings.aiScoringDimensions = deepCloneScoringDimensions(DEFAULT_SCORING_DIMENSIONS);
  renderScoringDimensions();
  saveSettings().catch(() => {});
}

function getDefaultModelForBaseUrl(baseUrl) {
  return String(findAiBaseUrlPreset(baseUrl)?.defaultModel || '').trim();
}

function resolveAiBaseUrlFromUI() {
  const manual = String(els.aiBaseUrl?.value || '').trim();
  if (manual) return manual;
  const preset = String(els.aiBaseUrlPreset?.value || '').trim();
  if (preset && preset !== CUSTOM_PRESET_VALUE) return preset;
  return '';
}

function resolveAiModelFromUI() {
  const manual = String(els.aiModel?.value || '').trim();
  if (manual) return manual;
  const preset = String(els.aiModelPreset?.value || '').trim();
  if (preset && preset !== CUSTOM_PRESET_VALUE) return preset;
  return getDefaultModelForBaseUrl(resolveAiBaseUrlFromUI());
}

const $ = (id) => document.getElementById(id);

const els = {
  enableOutreach: $('enableOutreach'),
  tabOutreach: $('tabOutreach'),
  tabReply: $('tabReply'),
  pageOutreach: $('pageOutreach'),
  pageReply: $('pageReply'),
  jobSelect: $('jobSelect'),
  autoReplyJobSelect: $('autoReplyJobSelect'),
  outreachListModeRecommend: $('outreachListModeRecommend'),
  outreachListModeFeatured: $('outreachListModeFeatured'),
  outreachListModeLatest: $('outreachListModeLatest'),
  passScore: $('passScore'),
  replyPassScore: $('replyPassScore'),
  maxPerRun: $('maxPerRun'),
  replyCommonPhrase: $('replyCommonPhrase'),
  autoReplyPassMode: $('autoReplyPassMode'),
  autoReplyPassCommonPhrase: $('autoReplyPassCommonPhrase'),
  autoReplyPassPortfolioCommonPhrase: $('autoReplyPassPortfolioCommonPhrase'),
  autoReplyPassTemplate: $('autoReplyPassTemplate'),
  autoReplyPassCommonPhraseWrap: $('autoReplyPassCommonPhraseWrap'),
  autoReplyPassTemplateWrap: $('autoReplyPassTemplateWrap'),
  autoReplyCandidateRejectMode: $('autoReplyCandidateRejectMode'),
  autoReplyCandidateRejectCommonPhrase: $('autoReplyCandidateRejectCommonPhrase'),
  autoReplyCandidateRejectTemplate: $('autoReplyCandidateRejectTemplate'),
  autoReplyCandidateRejectCommonPhraseWrap: $('autoReplyCandidateRejectCommonPhraseWrap'),
  autoReplyCandidateRejectTemplateWrap: $('autoReplyCandidateRejectTemplateWrap'),
  autoReplyOurRejectMode: $('autoReplyOurRejectMode'),
  autoReplyOurRejectCommonPhrase: $('autoReplyOurRejectCommonPhrase'),
  autoReplyOurRejectTemplate: $('autoReplyOurRejectTemplate'),
  autoReplyOurRejectCommonPhraseWrap: $('autoReplyOurRejectCommonPhraseWrap'),
  autoReplyOurRejectTemplateWrap: $('autoReplyOurRejectTemplateWrap'),
  autoReplyClickNotFit: $('autoReplyClickNotFit'),
  autoReplyClickNotFitLabel: $('autoReplyClickNotFitLabel'),
  autoReplyClickNotFitHint: $('autoReplyClickNotFitHint'),
  btnRefreshCommonPhrases: $('btnRefreshCommonPhrases'),
  btnSaveReply: $('btnSaveReply'),
  btnClearManualQueue: $('btnClearManualQueue'),
  replyCooldownMin: $('replyCooldownMin'),
  delayMinMs: $('delayMinMs'),
  delayMaxMs: $('delayMaxMs'),
  freqBackoffSec: $('freqBackoffSec'),
  minAge: $('minAge'),
  maxAge: $('maxAge'),
  minEdu: $('minEdu'),
  maxRecentGapMonths: $('maxRecentGapMonths'),
  jdText: $('jdText'),
  btnRefreshJd: $('btnRefreshJd'),
  outreachTemplate: $('outreachTemplate'),
  autoReplyTemplate: $('autoReplyTemplate'),
  aiBaseUrlPreset: $('aiBaseUrlPreset'),
  aiBaseUrl: $('aiBaseUrl'),
  aiApiKey: $('aiApiKey'),
  aiModelPreset: $('aiModelPreset'),
  aiModel: $('aiModel'),
  aiKeyStatus: $('aiKeyStatus'),
  aiTestStatus: $('aiTestStatus'),
  aiUsageTip: $('aiUsageTip'),
  btnSaveAi: $('btnSaveAi'),
  btnToggleAi: $('btnToggleAi'),
  btnCloseAi: $('btnCloseAi'),
  aiConfigPanel: $('aiConfigPanel'),
  // 1.1.x：候选人卡片直接挂到 logBox 当 .logLine 的 sibling；按 ts 排序追加
  runResultsCount: $('runResultsCount'),
  btnClearRunResults: $('btnClearRunResults'),
  // 1.1.x：评分维度与权重
  scoringDimsTotal: $('scoringDimsTotal'),
  scoringDimsBar:   $('scoringDimsBar'),
  scoringDimsGrid:  $('scoringDimsGrid'),
  scoringDimsSavedTag: $('scoringDimsSavedTag'),
  btnRestoreScoringDims: $('btnRestoreScoringDims'),
  // 1.1.x：basicCard 当前岗位高亮
  currentJobBadge: $('currentJobBadge'),
  // 1.1.x：自动回复页"当前运行模式"只读徽章
  replyRunModeBadge: $('replyRunModeBadge'),
  tokenGauge: $('tokenGauge'),
  tgUsed: $('tgUsed'),
  tgQuota: $('tgQuota'),
  tgPct: $('tgPct'),
  tgBarFill: $('tgBarFill'),
  btnClearApiKey: $('btnClearApiKey'),
  outreachModeAI: $('outreachModeAI'),
  outreachModeNoAI: $('outreachModeNoAI'),
  keywordsAndMode: $('keywordsAndMode'),
  modeTip: $('modeTip'),
  aiOnlyBlock: $('aiOnlyBlock'),
  includeKeywordsLabel: $('includeKeywordsLabel'),
  requiredKeywords: $('requiredKeywords'),
  aiNiceKeywords: $('aiNiceKeywords'),
  includeKeywords: $('includeKeywords'),
  excludeKeywords: $('excludeKeywords'),
  btnSaveJobCalib: $('btnSaveJobCalib'),
  btnAiGenKeywords: $('btnAiGenKeywords'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnSave: $('btnSave'),
  btnClearLogs: $('btnClearLogs'),
  btnCollapse: $('btnCollapse'),
  btnCloseHang: $('btnCloseHang'),
  logBox: $('logBox'),
  runState: $('runState'),
  logLevelFilter: $('logLevelFilter'),
  logSearch: $('logSearch'),
  logAutoScroll: $('logAutoScroll'),
  manualReviewSummary: $('manualReviewSummary'),
  // 1.1.0 新增
  tabHistory: $('tabHistory'),
  pageHistory: $('pageHistory'),
  sbRunState: $('sbRunState'),
  sbMode: $('sbMode'),
  sbProcessed: $('sbProcessed'),
  sbPassed: $('sbPassed'),
  sbManual: $('sbManual'),
  sbStopBtn: $('sbStopBtn'),
  // 1.1.2 风险模式
  sbRiskMode: $('sbRiskMode'),
  sbRiskModeWrap: $('sbRiskModeWrap'),
  humanizerIntensity: $('humanizerIntensity'),
  humanizerRestEveryMinMin: $('humanizerRestEveryMinMin'),
  humanizerRestEveryMinMax: $('humanizerRestEveryMinMax'),
  humanizerRestDurationSecMin: $('humanizerRestDurationSecMin'),
  humanizerRestDurationSecMax: $('humanizerRestDurationSecMax'),
  humanizerRandomSkipPct: $('humanizerRandomSkipPct'),
  humanizerHint: $('humanizerHint'),
  // 1.1.3 本机点击器
  externalClickerEnabled: $('externalClickerEnabled'),
  runModeLow: $('runModeLow'),
  runModeSemi: $('runModeSemi'),
  runModeAuto: $('runModeAuto'),
  runModeTip: $('runModeTip'),
  clickerLowRiskWarn: $('clickerLowRiskWarn'),
  externalClickerEndpoint: $('externalClickerEndpoint'),
  externalClickerPerClickConfirm: $('externalClickerPerClickConfirm'),
  externalClickerIdleMinSec: $('externalClickerIdleMinSec'),
  externalClickerIdleMaxWaitSec: $('externalClickerIdleMaxWaitSec'),
  externalClickerHint: $('externalClickerHint'),
  btnTestClicker: $('btnTestClicker'),
  unattendedMode: $('unattendedMode'),
  btnHistoryRefresh: $('btnHistoryRefresh'),
  btnHistoryExportCSV: $('btnHistoryExportCSV'),
  btnHistoryClear: $('btnHistoryClear'),
  historyFilter: $('historyFilter'),
  historyDateRange: $('historyDateRange'),
  historySearch: $('historySearch'),
  historyList: $('historyList'),
  hsTotal: $('hsTotal'),
  hsToday: $('hsToday'),
  hsPassRate: $('hsPassRate'),
  hsAvgScore: $('hsAvgScore'),
  hsPending: $('hsPending'),
  hsHardFiltered: $('hsHardFiltered'),
};

let settings = { ...DEFAULT_SETTINGS };
let saveTimer = null;
let jobs = [];
let jobKeywordOverrides = {};
let collapsed = false;
let isDirty = false;
let isSaving = false;
let activePage = 'outreach';
let commonPhrases = [];
let manualReviewQueue = [];
let savePromise = null;
let localJobKeywordPresets = [];

init();

async function init() {
  await loadAll();
  await loadJobKeywordOverrides();
  await loadLocalJobKeywordPresets();
  await loadCommonPhrases();
  await loadManualReviewQueue();
  bindEvents();
  render();
  await renderAiUsage();
  await loadJobs();
  renderJobsSelect();
  refreshJobsListBestEffort();
  await loadCollapsed();
  applyCollapsed();
  // 1.1.1：折叠区状态恢复 + toggle 持久化
  await bindCollapseSections();
  // 口径：点开助手默认进入「主动寻访」页
  activePage = 'outreach';
  applyPageUI();

  // 悬挂窗口模式：显示右上角 X（仅 hang=1）
  try {
    const isHang = new URLSearchParams(location.search || '').get('hang') === '1';
    if (els.btnCloseHang) els.btnCloseHang.style.display = isHang ? '' : 'none';
  } catch {}

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'BOSS_ASSIST_LOG' && message.entry) {
      appendLogLine(message.entry);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.runState]) {
      renderRunState(changes[STORAGE_KEYS.runState].newValue);
    }
    if (changes[STORAGE_KEYS.jobs]) {
      jobs = Array.isArray(changes[STORAGE_KEYS.jobs].newValue)
        ? changes[STORAGE_KEYS.jobs].newValue.map(normalizeStoredJobStateForPopup)
        : [];
      renderJobsSelect();
    }
    if (changes[STORAGE_KEYS.jobKeywordOverrides]) {
      const v = changes[STORAGE_KEYS.jobKeywordOverrides].newValue;
      jobKeywordOverrides = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
    if (changes[STORAGE_KEYS.aiUsage]) {
      renderAiUsage(changes[STORAGE_KEYS.aiUsage].newValue).catch(() => {});
    }
    if (changes[STORAGE_KEYS.commonPhrases]) {
      commonPhrases = Array.isArray(changes[STORAGE_KEYS.commonPhrases].newValue) ? changes[STORAGE_KEYS.commonPhrases].newValue : [];
      renderCommonPhrasesSelect();
    }
    if (changes[STORAGE_KEYS.manualReviewQueue]) {
      manualReviewQueue = Array.isArray(changes[STORAGE_KEYS.manualReviewQueue].newValue) ? changes[STORAGE_KEYS.manualReviewQueue].newValue : [];
      renderManualReviewSummary();
      refreshStatusBar().catch(() => {});
    }
    if (changes[STORAGE_KEYS.processedOutreach]) {
      // 评分历史变了：刷新状态栏；若历史页可见则一并刷新
      refreshStatusBar().catch(() => {});
      if (activePage === 'history') {
        renderHistoryView().catch(() => {});
      }
      // 1.1.x：主动寻访页的"本次运行"卡片区也实时刷新（不论 activePage 是什么都更新数据）
      refreshRunResultsCards().catch(() => {});
    }
    // 1.1.x：自动回复每处理一会话写一条 replyRunResults，logBox 卡片实时追加
    if (changes[STORAGE_KEYS.replyRunResults]) {
      refreshRunResultsCards().catch(() => {});
    }
  });

  // 启动时先把状态栏渲染出来
  refreshStatusBar().catch(() => {});
}

async function loadCommonPhrases() {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.commonPhrases]);
    commonPhrases = Array.isArray(r?.[STORAGE_KEYS.commonPhrases]) ? r[STORAGE_KEYS.commonPhrases] : [];
  } catch {
    commonPhrases = [];
  }
}

async function loadManualReviewQueue() {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.manualReviewQueue]);
    manualReviewQueue = Array.isArray(r?.[STORAGE_KEYS.manualReviewQueue]) ? r[STORAGE_KEYS.manualReviewQueue] : [];
  } catch {
    manualReviewQueue = [];
  }
}

async function loadUiPage() {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.uiPage]);
    const v = String(r?.[STORAGE_KEYS.uiPage] || '').trim();
    if (v === 'outreach' || v === 'reply' || v === 'history') activePage = v;
  } catch {}
}

async function setActivePage(page, opts = {}) {
  const p = (page === 'outreach' || page === 'reply' || page === 'history') ? page : 'reply';
  activePage = p;
  applyPageUI();
  try { await chrome.storage.local.set({ [STORAGE_KEYS.uiPage]: p }); } catch {}
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}

  if (p === 'reply' && opts?.navigateBossToChat) {
    (async () => {
      await navigateBossToChatBestEffort();
      // 进入沟通页后：从顶部岗位下拉同步岗位列表，补齐岗位缓存
      await refreshChatJobsBestEffort();
    })().catch(() => {});
  }
  if (p === 'history') {
    renderHistoryView().catch(() => {});
  }
}

function applyPageUI() {
  const isOutreach = activePage === 'outreach';
  const isReply = activePage === 'reply';
  const isHistory = activePage === 'history';
  if (els.pageOutreach) els.pageOutreach.style.display = isOutreach ? '' : 'none';
  if (els.pageReply) els.pageReply.style.display = isReply ? '' : 'none';
  if (els.pageHistory) els.pageHistory.style.display = isHistory ? '' : 'none';
  if (els.tabOutreach) els.tabOutreach.classList.toggle('active', isOutreach);
  if (els.tabReply) els.tabReply.classList.toggle('active', isReply);
  if (els.tabHistory) els.tabHistory.classList.toggle('active', isHistory);
  // 1.1.x：小绿灯只点亮"当前选中"的那一个 tab
  if (els.tabOutreach) { isOutreach ? els.tabOutreach.dataset.on = '1' : delete els.tabOutreach.dataset.on; }
  if (els.tabReply)    { isReply    ? els.tabReply.dataset.on    = '1' : delete els.tabReply.dataset.on; }
  if (els.tabHistory)  { isHistory  ? els.tabHistory.dataset.on  = '1' : delete els.tabHistory.dataset.on; }
  // 1.1.x：历史/统计页只显示历史内容，隐藏底部"开始/停止/清空日志"和运行日志框
  document.body.classList.toggle('historyOnly', isHistory);
  // 1.1.x：进 主动寻访 页时刷一遍运行日志里的候选人卡片（保证最新）
  if (isOutreach) refreshRunResultsCards().catch(() => {});
}

function bindEvents() {
  const inputs = [
    'enableOutreach',
    'passScore', 'replyPassScore',
    'maxPerRun', 'replyCooldownMin',
    'autoReplyJobSelect',
    'replyCommonPhrase',
    'autoReplyPassMode', 'autoReplyPassCommonPhrase', 'autoReplyPassPortfolioCommonPhrase', 'autoReplyPassTemplate',
    'autoReplyCandidateRejectMode', 'autoReplyCandidateRejectCommonPhrase', 'autoReplyCandidateRejectTemplate',
    'autoReplyOurRejectMode', 'autoReplyOurRejectCommonPhrase', 'autoReplyOurRejectTemplate', 'autoReplyClickNotFit',
    'delayMinMs', 'delayMaxMs', 'freqBackoffSec', 'minAge', 'maxAge', 'minEdu', 'maxRecentGapMonths',
    'jdText', 'outreachTemplate', 'autoReplyTemplate',
    'aiBaseUrlPreset', 'aiBaseUrl', 'aiApiKey', 'aiModelPreset', 'aiModel',
    'outreachModeAI', 'outreachModeNoAI',
    'requiredKeywords',
    'aiNiceKeywords',
    'includeKeywords', 'excludeKeywords',
    // 1.1.2 humanizer
    'humanizerIntensity', 'humanizerRestEveryMinMin', 'humanizerRestEveryMinMax',
    'humanizerRestDurationSecMin', 'humanizerRestDurationSecMax', 'humanizerRandomSkipPct',
    // 1.1.3 本机点击器
    'externalClickerEnabled', 'externalClickerEndpoint', 'externalClickerPerClickConfirm',
    'externalClickerIdleMinSec', 'externalClickerIdleMaxWaitSec',
  ];

  inputs.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', markDirty);
    el.addEventListener('change', markDirty);
  });

  // 1.2.x：自动回复岗位范围变更 → 实时刷新折叠区 summary 的"当前岗位"提示
  els.autoReplyJobSelect?.addEventListener('change', () => updateAutoReplyScopeHint());

  els.passScore?.addEventListener('input', () => {
    if (els.replyPassScore && els.replyPassScore.value !== els.passScore.value) {
      els.replyPassScore.value = els.passScore.value;
    }
  });
  els.replyPassScore?.addEventListener('input', () => {
    if (els.passScore && els.passScore.value !== els.replyPassScore.value) {
      els.passScore.value = els.replyPassScore.value;
    }
  });

  els.tabOutreach?.addEventListener('click', () => setActivePage('outreach'));
  els.tabReply?.addEventListener('click', () => setActivePage('reply', { navigateBossToChat: true }));
  els.tabHistory?.addEventListener('click', () => setActivePage('history'));

  // 1.1.0：历史/统计 页面交互
  els.btnHistoryRefresh?.addEventListener('click', async () => {
    // 1.1.x：给个明显反馈，否则同样数据看着像没刷新
    const btn = els.btnHistoryRefresh;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await renderHistoryView();
      await refreshStatusBar();
      btn.textContent = '✓ 已刷新';
    } catch {
      btn.textContent = '刷新失败';
    }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 800);
  });
  els.btnHistoryExportCSV?.addEventListener('click', () => { exportHistoryCSV().catch(() => {}); });
  els.btnHistoryClear?.addEventListener('click', async () => {
    if (!confirm('确认清空本地评分历史？此操作不影响 Boss 数据，仅清掉插件本地的 processedOutreach 记录。')) return;
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: {} });
      await renderHistoryView();
      await refreshStatusBar();
    } catch {}
  });
  els.historyFilter?.addEventListener('change', () => { renderHistoryView().catch(() => {}); });
  els.historyDateRange?.addEventListener('change', () => { renderHistoryView().catch(() => {}); });
  els.historySearch?.addEventListener('input', () => { renderHistoryView().catch(() => {}); });

  els.enableOutreach?.addEventListener('change', () => {
    if (els.enableOutreach.checked) setActivePage('outreach');
    else setActivePage('reply');
  });

  els.outreachModeAI?.addEventListener('change', applyModeUI);
  els.outreachModeNoAI?.addEventListener('change', applyModeUI);
  els.aiBaseUrlPreset?.addEventListener('change', () => {
    const v = String(els.aiBaseUrlPreset.value || '');
    if (v && v !== CUSTOM_PRESET_VALUE && els.aiBaseUrl) {
      els.aiBaseUrl.value = v;
      const defaultModel = getDefaultModelForBaseUrl(v);
      const currentModel = String(els.aiModel?.value || '').trim();
      if (defaultModel && els.aiModel && !currentModel) {
        els.aiModel.value = defaultModel;
      }
    }
    syncAiPresetSelectionsFromInputs();
    markDirty();
  });
  els.aiModelPreset?.addEventListener('change', () => {
    const v = String(els.aiModelPreset.value || '');
    if (v && v !== CUSTOM_PRESET_VALUE && els.aiModel) els.aiModel.value = v;
    markDirty();
  });
  els.aiBaseUrl?.addEventListener('input', syncAiPresetSelectionsFromInputs);
  els.aiModel?.addEventListener('input', syncAiPresetSelectionsFromInputs);
  els.autoReplyPassMode?.addEventListener('change', applyAutoReplyDirectionVisibility);
  els.autoReplyCandidateRejectMode?.addEventListener('change', applyAutoReplyDirectionVisibility);
  els.autoReplyOurRejectMode?.addEventListener('change', applyAutoReplyDirectionVisibility);
  bindOutreachListModeButtons();

  els.btnClearApiKey?.addEventListener('click', async () => {
    settings.ai.apiKey = '';
    els.aiApiKey.value = '';
    await saveSettings();
    appendLogLine({ ts: Date.now(), level: 'success', message: '已清空本机保存的 API Key' });
    renderKeyStatus();
  });

  els.jobSelect?.addEventListener('change', async () => {
    // 先把“上一个岗位”的关键词保存下来（否则切换后会被覆盖）
    const prevKey = settings.selectedJobKey || '';
    if (prevKey) {
      await upsertJobKeywordOverride(prevKey, {
        requiredKeywords: els.requiredKeywords?.value || '',
        includeKeywords: els.includeKeywords.value,
        excludeKeywords: els.excludeKeywords.value,
        aiNiceKeywords: els.aiNiceKeywords?.value || '',
        minAge: els.minAge?.value,
        maxAge: els.maxAge?.value,
        minEdu: els.minEdu?.value,
        maxRecentGapMonths: els.maxRecentGapMonths?.value,
      });
    }

    const key = els.jobSelect.value || '';
    settings.selectedJobKey = key;
    // 1.1.x：立即更新 basicCard 顶部"正在筛选 [岗位]" 高亮（不等保存完成）
    updateCurrentJobBadge();
    const job = jobs.find((j) => j.key === key);
    if (job) {
      // 先用缓存 JD 回填；没有就清空，避免“上一个岗位的 JD 残留”
      els.jdText.value = String(job.jdText || '');

      // 切换岗位时：优先回填“该岗位已保存的关键词”；否则才从 JD 自动提炼
      const ov = getEffectiveJobKeywordOverride(key, job?.name || '');
      if (ov) {
        if (els.requiredKeywords) els.requiredKeywords.value = String(ov.requiredKeywords || (ov.keywordsAndMode ? ov.includeKeywords || '' : ''));
        els.includeKeywords.value = String(ov.keywordsAndMode ? '' : ov.includeKeywords || '');
        els.excludeKeywords.value = String(ov.excludeKeywords || '');
        if (els.aiNiceKeywords) els.aiNiceKeywords.value = String(ov.aiNiceKeywords || '');
        if (els.minAge) els.minAge.value = String(clampInt(ov.minAge, 0, 70, 0));
        if (els.maxAge) els.maxAge.value = String(clampInt(ov.maxAge, 0, 70, 0));
        if (els.minEdu) els.minEdu.value = normalizeEduRequirementValue(ov.minEdu);
        if (els.maxRecentGapMonths) els.maxRecentGapMonths.value = String(clampInt(ov.maxRecentGapMonths, 0, 240, 0));
      } else if (job.jdText) {
        if (els.requiredKeywords) els.requiredKeywords.value = '';
        els.excludeKeywords.value = '';
        if (els.aiNiceKeywords) els.aiNiceKeywords.value = '';
        if (els.minAge) els.minAge.value = '0';
        if (els.maxAge) els.maxAge.value = '0';
        if (els.minEdu) els.minEdu.value = '0';
        if (els.maxRecentGapMonths) els.maxRecentGapMonths.value = '0';
        const kw = extractKeywordsFromJd(job.jdText);
        els.includeKeywords.value = kw.join('\n');
      } else {
        // 没有 JD 也没有 override：清空，避免沿用上一个岗位的关键词
        if (els.requiredKeywords) els.requiredKeywords.value = '';
        els.includeKeywords.value = '';
        els.excludeKeywords.value = '';
        if (els.aiNiceKeywords) els.aiNiceKeywords.value = '';
        if (els.minAge) els.minAge.value = '0';
        if (els.maxAge) els.maxAge.value = '0';
        if (els.minEdu) els.minEdu.value = '0';
        if (els.maxRecentGapMonths) els.maxRecentGapMonths.value = '0';
      }
    } else {
      els.jdText.value = '';
      if (els.requiredKeywords) els.requiredKeywords.value = '';
      els.includeKeywords.value = '';
      els.excludeKeywords.value = '';
      if (els.aiNiceKeywords) els.aiNiceKeywords.value = '';
      if (els.minAge) els.minAge.value = '0';
      if (els.maxAge) els.maxAge.value = '0';
      if (els.minEdu) els.minEdu.value = '0';
      if (els.maxRecentGapMonths) els.maxRecentGapMonths.value = '0';
    }
    updateJdSummaryHint();
    // 若 JD 为空，则尝试在“职位管理”页自动点击该岗位并抓取 JD
    if (key && (!job || !String(job.jdText || '').trim())) {
      appendLogLine({ ts: Date.now(), level: 'info', message: '正在从职位管理同步 JD...' });
      try {
        const tab = await getBossJobOpsTab();
        if (!tab) {
          appendLogLine({ ts: Date.now(), level: 'warn', message: '未找到 Boss 标签页：请先打开 Boss（*.zhipin.com）' });
          await saveSettings();
          return;
        }
        await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id });
        // 固定让顶层 frame 执行同步（避免消息被 iframe 接收导致“请在职位管理页(顶层页面)”）
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_SYNC_JOB_JD', jobKey: key }, { frameId: 0 });
        if (resp?.success && resp.jdText) {
          els.jdText.value = resp.jdText;
          updateJdSummaryHint();
          // 若该岗位没有“人工维护的关键词”，才用 JD 自动提炼一次
          if (!jobKeywordOverrides?.[key] && !els.includeKeywords.value.trim()) {
            const filled = await maybeAiFillKeywords({ force: false });
            if (!filled) {
              const kw = extractKeywordsFromJd(resp.jdText);
              els.includeKeywords.value = kw.join('\n');
            }
          }
          appendLogLine({ ts: Date.now(), level: 'success', message: 'JD 同步成功' });
        } else {
          appendLogLine({ ts: Date.now(), level: 'warn', message: `JD 同步失败：${resp?.error || '未抓到 JD'}` });
        }
      } catch (e) {
        appendLogLine({ ts: Date.now(), level: 'warn', message: 'JD 同步失败：无法连接到页面脚本' });
      }
    }
    // AI 模式下：若还没有关键词，则尝试用 AI 生成一次
    await maybeAiFillKeywords({ force: false });
    await saveSettings();
  });

  els.btnStart.addEventListener('click', onStart);
  els.btnStop.addEventListener('click', onStop);
  els.sbStopBtn?.addEventListener('click', onStop);

  // 1.1.1：日志过滤
  els.logLevelFilter?.addEventListener('change', () => rerenderLogBox());
  els.logSearch?.addEventListener('input', () => rerenderLogBox());

  // 1.1.3：本机点击器 — 测试连通按钮 + 启用/端点变更同步徽标
  els.btnTestClicker?.addEventListener('click', async () => {
    const ep = String(els.externalClickerEndpoint?.value || 'http://127.0.0.1:12345').replace(/\/+$/, '');
    appendLogLine({ ts: Date.now(), level: 'info', message: `测试本机点击器：${ep}/health ...` });
    try {
      const r = await fetch(`${ep}/health`, { method: 'GET' });
      const j = await r.json();
      if (j?.ok) {
        appendLogLine({ ts: Date.now(), level: 'success', message: `✓ 本机点击器在线（v${j.version || '?'}，主屏高 ${j.screen_h || '?'}）` });
        if (els.externalClickerHint) {
          els.externalClickerHint.textContent = `已连通 v${j.version || '?'}`;
          els.externalClickerHint.style.color = '#86efac';
        }
      } else {
        appendLogLine({ ts: Date.now(), level: 'warn', message: `本机点击器返回异常：${JSON.stringify(j).slice(0, 120)}` });
      }
    } catch (e) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: `连接失败：${e?.message || e}。请先双击 claude-boss-clicker/run.command 启动。` });
      if (els.externalClickerHint) {
        els.externalClickerHint.textContent = '未连通';
        els.externalClickerHint.style.color = '#fca5a5';
      }
    }
  });
  els.externalClickerEnabled?.addEventListener('change', refreshClickerHint);
  els.externalClickerEndpoint?.addEventListener('input', refreshClickerHint);

  // 1.1.3：一键无人值守 — 勾上 = 关弹窗 + 关 idle gate + 立即保存
  els.unattendedMode?.addEventListener('change', async () => {
    const on = !!els.unattendedMode?.checked;
    if (on) {
      if (!confirm('🚀 启用无人值守模式？\n\n' +
        '· 关闭"每次点击前弹确认"（不再有弹窗打断）\n' +
        '· 关闭"等候空闲"（鼠标会立刻被脚本接管，不管你在不在动）\n' +
        '· 立即保存\n\n' +
        '适合"我马上离开电脑"的场景。\n' +
        '取消勾选后会恢复成"弹确认 + 等空闲 30 秒"。\n\n' +
        '继续吗？')) {
        els.unattendedMode.checked = false;
        return;
      }
      if (els.externalClickerPerClickConfirm) els.externalClickerPerClickConfirm.checked = false;
      if (els.externalClickerIdleMinSec) els.externalClickerIdleMinSec.value = '0';
      appendLogLine({ ts: Date.now(), level: 'warn', message: '🚀 已切到无人值守模式 — 鼠标即将被脚本接管，建议你立刻离开电脑' });
    } else {
      if (els.externalClickerPerClickConfirm) els.externalClickerPerClickConfirm.checked = true;
      if (els.externalClickerIdleMinSec) els.externalClickerIdleMinSec.value = '30';
      appendLogLine({ ts: Date.now(), level: 'success', message: '✓ 已退出无人值守 — 恢复"弹确认 + 等空闲 30 秒"' });
    }
    refreshClickerHint();
    await saveSettings();
  });

  // 1.1.x：silent ping clicker；返回 true 表示在线
  async function pingClickerOnce() {
    const ep = String(settings?.externalClicker?.endpoint || els.externalClickerEndpoint?.value || 'http://127.0.0.1:12345').replace(/\/+$/, '');
    try {
      const r = await fetch(`${ep}/health`, { method: 'GET' });
      const j = await r.json();
      return !!j?.ok;
    } catch { return false; }
  }

  // 1.1.x：clicker 没运行时，引导用户启动；返回 true 表示已在跑（或用户已确认）
  // 设计目标：路径不写死，无论用户把 zip 解压到哪里都适用
  async function promptToStartClickerIfMissing() {
    if (!settings?.externalClicker?.enabled) return true; // 没启用点击器，跳过
    const ok = await pingClickerOnce();
    if (ok) return true;
    // 优先尝试用 launchctl kickstart 拉起（如果之前装过 LaunchAgent，这条命令路径固定）
    // 注意：复制的是命令，不是自动执行
    const restartCmd = 'launchctl kickstart -k gui/$UID/com.claude-boss.clicker';
    const msg =
      '⚠️ 本机点击器没在运行 —— 半自动/全自动模式需要它才能干活。\n\n' +
      '【场景 A】如果你之前装过开机自启（双击过 install.command 或 install_autostart.command）：\n' +
      '  点【确定】 → 复制重启命令到剪贴板 → 终端 ⌘V + 回车，clicker 会被拉起。\n\n' +
      '【场景 B】如果你从来没装过开机自启（推荐这次装上，以后永久不用管）：\n' +
      '  点【取消】 → 去 Finder 里你的安装包文件夹 →\n' +
      '   - macOS 安装包根目录：双击 install.command（自动装开机自启）\n' +
      '   - 或：进 claude-boss-clicker 子文件夹 → 双击 install_autostart.command\n' +
      '  装完会自动启动，并设置每次开机自动启动。\n\n' +
      '你的选择？';
    const wantRestart = confirm(msg);
    if (wantRestart) {
      try { await navigator.clipboard.writeText(restartCmd); } catch {}
      appendLogLine({
        ts: Date.now(),
        level: 'warn',
        message: `已复制启动命令到剪贴板：${restartCmd} （终端 ⌘V + 回车）。若提示"Could not find specified service"= 你还没装开机自启，请走【场景 B】。`,
      });
    } else {
      appendLogLine({
        ts: Date.now(),
        level: 'warn',
        message: `请去你的安装包文件夹双击 install.command 配置开机自启（一次配置永久生效）。`,
      });
    }
    return false;
  }

  async function setRunMode(nextMode) {
    if (nextMode === 'low') {
      settings.riskMode = 'low';
      appendLogLine({ ts: Date.now(), level: 'success', message: '✓ 已切到 🛡 低风险模式 — 仅生成草稿，点击器不会被调用' });
    } else if (nextMode === 'semiauto') {
      if (String(settings.riskMode || 'low') !== 'auto') {
        const msg = '⚠️ 切到「半自动」会启用自动点击行为。\n\n' +
          '· 每次点击前会在本机弹确认，你可以随时取消（ESC）\n' +
          '· 仍有触发 Boss 风控的可能，建议小批量试跑\n\n继续？';
        if (!confirm(msg)) { applyRunModeUiState(); return; }
      }
      settings.riskMode = 'auto';
      settings.externalClicker = settings.externalClicker || {};
      settings.externalClicker.perClickConfirm = true;
      if (els.externalClickerPerClickConfirm) els.externalClickerPerClickConfirm.checked = true;
      if (els.unattendedMode) els.unattendedMode.checked = false;
      appendLogLine({ ts: Date.now(), level: 'warn', message: '⚡ 已切到 半自动 — 自动点击，每次弹确认' });
    } else if (nextMode === 'auto') {
      const msg = '⚠️ 切到「全自动」会取消每次点击的确认弹窗，完全无人值守。\n\n' +
        '· 封号风险最高，建议仅老熟号 + 小批量（≤30/次）使用\n' +
        '· 强烈建议：仿人节奏=强、随机延迟拉大\n\n确认继续？';
      if (!confirm(msg)) { applyRunModeUiState(); return; }
      settings.riskMode = 'auto';
      settings.externalClicker = settings.externalClicker || {};
      settings.externalClicker.perClickConfirm = false;
      if (els.externalClickerPerClickConfirm) els.externalClickerPerClickConfirm.checked = false;
      if (els.unattendedMode) els.unattendedMode.checked = true;
      appendLogLine({ ts: Date.now(), level: 'warn', message: '⚠ 已切到 全自动 — 无人值守，封号风险最高' });
    }
    applyRunModeUiState();
    renderRiskModeBadge();
    refreshStatusBar().catch(() => {});
    await saveSettings();
    // 1.1.x：切到 半自动/全自动 时，自动检测 clicker 是否在跑；没跑就引导启动
    if (nextMode === 'semiauto' || nextMode === 'auto') {
      promptToStartClickerIfMissing().catch(() => {});
    }
  }
  els.runModeLow?.addEventListener('click', () => setRunMode('low'));
  els.runModeSemi?.addEventListener('click', () => setRunMode('semiauto'));
  els.runModeAuto?.addEventListener('click', () => setRunMode('auto'));
  // 点击器开关变化时也刷新警告显示
  els.externalClickerEnabled?.addEventListener('change', applyRunModeUiState);

  // 1.1.2：状态栏「风险」徽章 → 点击切换 low ↔ auto，切到 auto 必须二次确认
  els.sbRiskModeWrap?.addEventListener('click', async () => {
    const cur = String(settings.riskMode || 'low') === 'auto' ? 'auto' : 'low';
    if (cur === 'low') {
      const msg = '⚠️ 你确定要启用「自动打招呼」模式吗？\n\n' +
        '· AI 命中候选人后会自动点击 Boss 的「打招呼」按钮 + 自动发送模板\n' +
        '· 平台明令禁止脚本化操作，账号有被风控/封号的真实风险\n' +
        '· 强烈建议保持 humanizer = 强、随机延迟拉大、每次最多联系人数压低（≤30）\n' +
        '· 切回低风险模式随时可以点这个徽章\n\n' +
        '继续启用吗？';
      if (!confirm(msg)) return;
      settings.riskMode = 'auto';
      appendLogLine({ ts: Date.now(), level: 'warn', message: '⚠ 已切换到 自动打招呼 模式 — 账号有封号风险，请谨慎使用' });
    } else {
      settings.riskMode = 'low';
      appendLogLine({ ts: Date.now(), level: 'success', message: '✓ 已切回 低风险 模式 — 仅生成草稿，关键动作人工确认' });
    }
    renderRiskModeBadge();
    refreshStatusBar().catch(() => {});
    await saveSettings();
  });

  // 1.1.1：状态栏「模式」可点击切换 AI ↔ 无AI
  if (els.sbMode) {
    els.sbMode.style.cursor = 'pointer';
    els.sbMode.title = '点击切换 AI / 无AI 模式';
    els.sbMode.addEventListener('click', async () => {
      const cur = String(settings.outreachMode || 'auto');
      const hasAi = !!(settings.ai?.baseUrl && settings.ai?.apiKey && settings.ai?.model);
      const effective = cur === 'auto' ? (hasAi ? 'ai' : 'noai') : cur;
      const next = effective === 'ai' ? 'noai' : 'ai';
      settings.outreachMode = next;
      if (els.outreachModeAI) els.outreachModeAI.checked = next === 'ai';
      if (els.outreachModeNoAI) els.outreachModeNoAI.checked = next === 'noai';
      try { applyModeUI(); } catch {}
      await saveSettings();
      refreshStatusBar();
      appendLogLine({ ts: Date.now(), level: 'info', message: `已切换为「${next === 'ai' ? 'AI 模式' : '无 AI 模式'}」` });
    });
  }
  els.btnSave?.addEventListener('click', async () => {
    await ensureAiOriginPermissionBestEffort();
    await saveSettings();
    appendLogLine({ ts: Date.now(), level: 'success', message: '设置已保存（本机）' });
    renderKeyStatus();
    await testAiConfigAfterSave();
  });

  els.btnSaveAi?.addEventListener('click', async () => {
    await ensureAiOriginPermissionBestEffort();
    await saveSettings();
    appendLogLine({ ts: Date.now(), level: 'success', message: 'AI 配置已保存（本机）' });
    renderKeyStatus();
    await testAiConfigAfterSave();
    // 1.1.x：保存测试完后自动收起面板（如果测试通过的话；失败则保留打开方便修改）
    setTimeout(() => {
      const ok = String(els.aiTestStatus?.textContent || '').includes('成功');
      if (ok && els.aiConfigPanel) els.aiConfigPanel.style.display = 'none';
    }, 1500);
  });

  // 1.1.x：⚙ AI 设置按钮 — 切换浮动 AI 配置面板
  els.btnToggleAi?.addEventListener('click', () => {
    if (!els.aiConfigPanel) return;
    const isOpen = els.aiConfigPanel.style.display !== 'none';
    els.aiConfigPanel.style.display = isOpen ? 'none' : '';
    if (!isOpen) {
      // 打开时 scroll 到顶部
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
    }
  });
  els.btnCloseAi?.addEventListener('click', () => {
    if (els.aiConfigPanel) els.aiConfigPanel.style.display = 'none';
  });

  // 1.1.x：评分维度 — 恢复默认按钮
  els.btnRestoreScoringDims?.addEventListener('click', () => {
    if (!confirm('恢复 4 维默认权重（25 / 25 / 25 / 25 = 100）？当前自定义权重会被覆盖。')) return;
    restoreDefaultScoringDimensions();
  });

  // 1.1.x：本次运行卡片区 — 清空显示
  els.btnClearRunResults?.addEventListener('click', () => {
    runResultsClearAt = Date.now();
    runResultsShownKeys.clear();
    refreshRunResultsCards().catch(() => {});
    appendLogLine({ ts: Date.now(), level: 'info', message: '✓ 已清空本次显示（历史/统计页的记录不受影响）' });
  });

  els.btnSaveReply?.addEventListener('click', async () => {
    await saveSettings();
    appendLogLine({ ts: Date.now(), level: 'success', message: '自动回复配置已保存（下一位会按新配置执行）' });
  });

  els.btnClearManualQueue?.addEventListener('click', async () => {
    manualReviewQueue = [];
    await chrome.storage.local.set({ [STORAGE_KEYS.manualReviewQueue]: [] });
    renderManualReviewSummary();
    appendLogLine({ ts: Date.now(), level: 'success', message: '本地待人工处理汇总已清空' });
  });

  els.btnSaveJobCalib?.addEventListener('click', async () => {
    const key = String(els.jobSelect?.value || '').trim();
    if (!key) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: '请先选择一个岗位，再保存本岗位校准' });
      return;
    }
    // 1.2.x：完整保存"本岗位校准"= 关键词四件套 + 硬过滤四件套（年龄/学历/Gap）
    // 之前只传了关键词，没传硬过滤；upsertJobKeywordOverride 老逻辑会把没传的硬过滤字段
    // 默默重置为 0/'0'，导致用户刚填的年龄学历存完就消失。现在显式全量传齐。
    await upsertJobKeywordOverride(key, {
      requiredKeywords: els.requiredKeywords?.value || '',
      includeKeywords: els.includeKeywords.value,
      excludeKeywords: els.excludeKeywords.value,
      aiNiceKeywords: els.aiNiceKeywords?.value || '',
      minAge: els.minAge?.value,
      maxAge: els.maxAge?.value,
      minEdu: els.minEdu?.value,
      maxRecentGapMonths: els.maxRecentGapMonths?.value,
    });
    // 1.2.x：把当前 JD 也持久化到 jobs[].jdText，下次切回该岗位不再触发自动重抓
    const jdNow = String(els.jdText?.value || '').trim();
    if (jdNow) {
      try { await persistJdToJobsCache(key, jdNow); } catch {}
    }
    // 同步写入 settings（让当前运行也立刻生效）
    await saveSettings();
    appendLogLine({ ts: Date.now(), level: 'success', message: '已保存：本岗位校准（关键词 + 硬过滤 + JD）' });
  });

  els.btnAiGenKeywords?.addEventListener('click', async () => {
    const ok = await maybeAiFillKeywords({ force: true });
    if (!ok) appendLogLine({ ts: Date.now(), level: 'warn', message: 'AI生成关键词失败：请检查 JD 与 AI 配置' });
  });
  els.btnClearLogs.addEventListener('click', async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.logs]: [] });
    logBuffer.length = 0;
    els.logBox.innerHTML = '';
    // 1.1.x：日志清空后把卡片再插回去（卡片来源是 processedOutreach，不归"日志清空"管）
    refreshRunResultsCards().catch(() => {});
  });
  els.btnCollapse?.addEventListener('click', async () => {
    collapsed = !collapsed;
    await chrome.storage.local.set({ bossAssistPanelCollapsed: collapsed });
    applyCollapsed();
  });

  els.btnRefreshJd?.addEventListener('click', async () => {
    const key = String(els.jobSelect?.value || '').trim();
    if (!key) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: '请先选择一个岗位，再刷新 JD' });
      return;
    }
    appendLogLine({ ts: Date.now(), level: 'info', message: '正在从职位管理刷新 JD（会覆盖当前 JD）...' });
    try {
      const tab = await getBossJobOpsTab();
      if (!tab) {
        appendLogLine({ ts: Date.now(), level: 'warn', message: '未找到 Boss 标签页：请先打开 Boss（*.zhipin.com）' });
        return;
      }
      await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id });
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_SYNC_JOB_JD', jobKey: key, force: true }, { frameId: 0 });
      if (resp?.success && resp.jdText) {
        els.jdText.value = resp.jdText;
        updateJdSummaryHint();
        appendLogLine({ ts: Date.now(), level: 'success', message: 'JD 刷新成功' });
        // 若该岗位没有“人工维护的关键词”，才用 JD 自动提炼一次
        if (!jobKeywordOverrides?.[key] && !els.includeKeywords.value.trim()) {
          const filled = await maybeAiFillKeywords({ force: false });
          if (!filled) {
            const kw = extractKeywordsFromJd(resp.jdText);
            els.includeKeywords.value = kw.join('\n');
          }
        }
        await saveSettings();
      } else {
        appendLogLine({ ts: Date.now(), level: 'warn', message: `JD 刷新失败：${resp?.error || '未抓到 JD'}` });
      }
    } catch (e) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: `JD 刷新失败：${e?.message || '无法连接到页面脚本'}` });
    }
  });

  els.btnRefreshCommonPhrases?.addEventListener('click', async () => {
    appendLogLine({ ts: Date.now(), level: 'info', message: '正在从 Boss 沟通页读取常用语...' });
    try {
      const tab = await getTargetBossTab();
      if (!tab?.id) {
        appendLogLine({ ts: Date.now(), level: 'warn', message: '未找到 Boss 标签页：请先打开 Boss（*.zhipin.com）并进入沟通页' });
        return;
      }
      await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id }).catch(() => {});
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_FETCH_COMMON_PHRASES' }, { frameId: 0 });
      if (resp?.success && Array.isArray(resp.phrases)) {
        commonPhrases = resp.phrases;
        await chrome.storage.local.set({ [STORAGE_KEYS.commonPhrases]: commonPhrases }).catch(() => {});
        renderCommonPhrasesSelect();
        appendLogLine({ ts: Date.now(), level: 'success', message: `常用语已更新（${commonPhrases.length}条）` });
      } else {
        appendLogLine({ ts: Date.now(), level: 'warn', message: `读取常用语失败：${resp?.error || '未抓到列表（请先打开任意会话后重试）'}` });
      }
    } catch (e) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: `读取常用语失败：${e?.message || '无法连接到页面脚本'}` });
    }
  });

  els.btnCloseHang?.addEventListener('click', async () => {
    try { window.close(); } catch {}
  });
}

async function ensureAiOriginPermissionBestEffort() {
  // 解决“别人用 AI 报 failed to fetch”：很多网关需要扩展对该域名的 host 权限，否则会被 CORS/权限拦截
  const baseUrl = String(els.aiBaseUrl?.value || '').trim();
  if (!baseUrl) return;
  let origin = '';
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    // baseUrl 非法时不请求权限，交由后续 AI 调用报错
    return;
  }

  const pattern = `${origin}/*`;
  try {
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return;
    const ok = await chrome.permissions.request({ origins: [pattern] });
    if (!ok) {
      appendLogLine({
        ts: Date.now(),
        level: 'warn',
        message: `未授权访问 AI 网关域名：${origin}。若运行时提示“AI失败：failed to fetch”，请点保存并允许该域名权限。`,
      });
    }
  } catch {
    // ignore
  }
}

async function loadCollapsed() {
  const r = await chrome.storage.local.get(['bossAssistPanelCollapsed']);
  collapsed = !!r?.bossAssistPanelCollapsed;
}

function applyCollapsed() {
  document.body.classList.toggle('collapsed', !!collapsed);
  if (els.btnCollapse) els.btnCollapse.textContent = collapsed ? '展开' : '折叠';
}

async function loadAll() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.logs, STORAGE_KEYS.runState]);
  settings = normalizeSettingsWithPromptMigration(result[STORAGE_KEYS.settings] || {});

  // logs
  const logs = Array.isArray(result[STORAGE_KEYS.logs]) ? result[STORAGE_KEYS.logs] : [];
  els.logBox.innerHTML = '';
  logs.forEach(appendLogLine);
  // 1.1.x：把候选人卡片按时间穿插进 logBox
  refreshRunResultsCards().catch(() => {});

  renderRunState(result[STORAGE_KEYS.runState] || { running: false, stopping: false });
}

async function loadJobs() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.jobs]);
  const raw = Array.isArray(result[STORAGE_KEYS.jobs]) ? result[STORAGE_KEYS.jobs] : [];
  jobs = raw.map(normalizeStoredJobStateForPopup);
}

async function loadJobKeywordOverrides() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.jobKeywordOverrides]);
  const v = result?.[STORAGE_KEYS.jobKeywordOverrides];
  jobKeywordOverrides = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
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
  const resolvedName =
    String(jobName || '').trim()
    || String(jobs.find((item) => String(item?.key || '').trim() === key)?.name || '').trim();
  return getLocalPresetOverrideForJobName(resolvedName);
}

async function upsertJobKeywordOverride(jobKey, override) {
  const key = String(jobKey || '').trim();
  if (!key) return;
  const prev = jobKeywordOverrides?.[key] || {};
  // 1.2.x：真正的"局部更新" —— 调用方没传的字段保留原值，绝不默默清零
  // 之前的 bug：override?.minAge 是 undefined 时，clampInt(undefined,...,0) 返回 0，
  //   把用户刚填好的年龄 / 学历 / Gap 重置成 0；
  //   再叠加 persistJdToJobsCache 触发 storage 更新 → renderJobsSelect →
  //   applySelectedJobScopedFiltersToUI 用清零后的值覆写表单，可视化为"年龄过滤消失"。
  const merged = { ...prev };
  if (override?.requiredKeywords !== undefined)    merged.requiredKeywords    = String(override.requiredKeywords || '');
  if (override?.includeKeywords !== undefined)     merged.includeKeywords     = String(override.includeKeywords || '');
  if (override?.excludeKeywords !== undefined)     merged.excludeKeywords     = String(override.excludeKeywords || '');
  if (override?.keywordsAndMode !== undefined)     merged.keywordsAndMode     = !!override.keywordsAndMode;
  if (override?.aiNiceKeywords !== undefined)      merged.aiNiceKeywords      = String(override.aiNiceKeywords || '');
  if (override?.minAge !== undefined)              merged.minAge              = clampInt(override.minAge, 0, 70, 0);
  if (override?.maxAge !== undefined)              merged.maxAge              = clampInt(override.maxAge, 0, 70, 0);
  if (override?.minEdu !== undefined)              merged.minEdu              = normalizeEduRequirementValue(override.minEdu);
  if (override?.maxRecentGapMonths !== undefined)  merged.maxRecentGapMonths  = clampInt(override.maxRecentGapMonths, 0, 240, 0);
  merged.updatedAt = Date.now();
  const next = { ...jobKeywordOverrides, [key]: merged };
  jobKeywordOverrides = next;
  await chrome.storage.local.set({ [STORAGE_KEYS.jobKeywordOverrides]: next });
}

function render() {
  if (els.enableOutreach) els.enableOutreach.checked = true;
  if (els.autoReplyJobSelect) els.autoReplyJobSelect.value = String(settings.autoReplyJobKey || '');
  els.passScore.value = String(settings.thresholds?.passScore ?? 60);
  if (els.replyPassScore) els.replyPassScore.value = String(settings.thresholds?.passScore ?? 60);
  els.maxPerRun.value = String(settings.maxPerRun ?? 30);
  renderCommonPhrasesSelect();
  if (els.replyCommonPhrase) els.replyCommonPhrase.value = String(settings.replyCommonPhrase || '');
  if (els.autoReplyPassMode) els.autoReplyPassMode.value = normalizeReplySendMode(settings.autoReplyPassMode, getDefaultPassReplyMode(settings));
  if (els.autoReplyPassCommonPhrase) els.autoReplyPassCommonPhrase.value = String(settings.autoReplyPassCommonPhrase || settings.replyCommonPhrase || '');
  if (els.autoReplyPassPortfolioCommonPhrase) els.autoReplyPassPortfolioCommonPhrase.value = String(settings.autoReplyPassPortfolioCommonPhrase || '');
  if (els.autoReplyPassTemplate) els.autoReplyPassTemplate.value = String(settings.autoReplyPassTemplate || settings.autoReplyTemplate || DEFAULT_SETTINGS.autoReplyTemplate);
  if (els.autoReplyCandidateRejectMode) els.autoReplyCandidateRejectMode.value = normalizeReplySendMode(settings.autoReplyCandidateRejectMode, 'template');
  if (els.autoReplyCandidateRejectCommonPhrase) els.autoReplyCandidateRejectCommonPhrase.value = String(settings.autoReplyCandidateRejectCommonPhrase || '');
  if (els.autoReplyCandidateRejectTemplate) els.autoReplyCandidateRejectTemplate.value = String(settings.autoReplyCandidateRejectTemplate || DEFAULT_SETTINGS.autoReplyCandidateRejectTemplate);
  if (els.autoReplyOurRejectMode) els.autoReplyOurRejectMode.value = normalizeReplySendMode(settings.autoReplyOurRejectMode, 'template');
  if (els.autoReplyOurRejectCommonPhrase) els.autoReplyOurRejectCommonPhrase.value = String(settings.autoReplyOurRejectCommonPhrase || '');
  if (els.autoReplyOurRejectTemplate) els.autoReplyOurRejectTemplate.value = String(settings.autoReplyOurRejectTemplate || DEFAULT_SETTINGS.autoReplyOurRejectTemplate);
  if (els.autoReplyClickNotFit) els.autoReplyClickNotFit.checked = settings.autoReplyClickNotFit !== false;
  els.replyCooldownMin.value = String(settings.replyCooldownMin ?? 120);
  els.delayMinMs.value = String(settings.delayMinMs ?? 1200);
  els.delayMaxMs.value = String(settings.delayMaxMs ?? 2600);
  if (els.freqBackoffSec) els.freqBackoffSec.value = String(settings.freqBackoffSec ?? 25);
  // 1.1.2：humanizer 字段回填
  {
    const h = (settings.humanizer && typeof settings.humanizer === 'object') ? settings.humanizer : {};
    if (els.humanizerIntensity) els.humanizerIntensity.value = ['weak','med','strong'].includes(h.intensity) ? h.intensity : 'strong';
    if (els.humanizerRestEveryMinMin) els.humanizerRestEveryMinMin.value = String(Number.isFinite(h.restEveryMinMin) ? h.restEveryMinMin : 25);
    if (els.humanizerRestEveryMinMax) els.humanizerRestEveryMinMax.value = String(Number.isFinite(h.restEveryMinMax) ? h.restEveryMinMax : 40);
    if (els.humanizerRestDurationSecMin) els.humanizerRestDurationSecMin.value = String(Number.isFinite(h.restDurationSecMin) ? h.restDurationSecMin : 60);
    if (els.humanizerRestDurationSecMax) els.humanizerRestDurationSecMax.value = String(Number.isFinite(h.restDurationSecMax) ? h.restDurationSecMax : 180);
    if (els.humanizerRandomSkipPct) els.humanizerRandomSkipPct.value = String(Number.isFinite(h.randomSkipPct) ? h.randomSkipPct : 5);
  }
  // 1.1.3：本机点击器字段
  {
    const ec = (settings.externalClicker && typeof settings.externalClicker === 'object') ? settings.externalClicker : {};
    if (els.externalClickerEnabled) els.externalClickerEnabled.checked = !!ec.enabled;
    if (els.externalClickerEndpoint) els.externalClickerEndpoint.value = String(ec.endpoint || 'http://127.0.0.1:12345');
    if (els.externalClickerPerClickConfirm) els.externalClickerPerClickConfirm.checked = ec.perClickConfirm !== false;
    if (els.externalClickerIdleMinSec) els.externalClickerIdleMinSec.value = String(Number.isFinite(ec.idleMinSec) ? ec.idleMinSec : 0);
    if (els.externalClickerIdleMaxWaitSec) els.externalClickerIdleMaxWaitSec.value = String(Number.isFinite(ec.idleMaxWaitSec) ? ec.idleMaxWaitSec : 300);
    // 1.1.3：根据 perClickConfirm + idleMinSec 推断当前是否为"无人值守"
    if (els.unattendedMode) {
      const isUnattended = (ec.perClickConfirm === false) && (Number(ec.idleMinSec) === 0) && !!ec.enabled;
      els.unattendedMode.checked = isUnattended;
    }
    refreshClickerHint();
  }
  // 1.1.2：风险模式徽章渲染（render 时调用，存储变更时也会调）
  renderRiskModeBadge();
  // 1.1.x：本机点击器面板的"运行模式"三档高亮同步
  try { applyRunModeUiState(); } catch {}
  // 1.1.x：评分维度与权重渲染
  try { renderScoringDimensions(); } catch {}
  if (els.minAge) els.minAge.value = String(settings.minAge ?? 0);
  if (els.maxAge) els.maxAge.value = String(settings.maxAge ?? 0);
  if (els.minEdu) els.minEdu.value = normalizeEduRequirementValue(settings.minEdu);
  if (els.maxRecentGapMonths) els.maxRecentGapMonths.value = String(settings.maxRecentGapMonths ?? 0);
  els.jdText.value = settings.jdText || '';
  if (els.outreachTemplate) els.outreachTemplate.value = settings.outreachTemplate || '';
  if (els.autoReplyTemplate) els.autoReplyTemplate.value = settings.autoReplyTemplate || '';
  renderAiPresetOptions();
  const resolvedBaseUrl = String(settings.ai?.baseUrl || AI_BASE_URL_PRESETS[0].value || '').trim();
  const resolvedModel = String(settings.ai?.model || getDefaultModelForBaseUrl(resolvedBaseUrl) || AI_MODEL_PRESETS[0].value || '').trim();
  els.aiBaseUrl.value = resolvedBaseUrl;
  // 安全：不在 UI 中回显已保存的 key（避免误泄露/录屏暴露）
  els.aiApiKey.value = '';
  els.aiModel.value = resolvedModel;
  syncAiPresetSelectionsFromInputs();
  renderKeyStatus();
  renderAiTestStatus('idle');
  {
    const hasAi = !!(settings.ai?.baseUrl && settings.ai?.apiKey && settings.ai?.model);
    const mode = settings.outreachMode || 'auto';
    const effective = mode === 'auto' ? (hasAi ? 'ai' : 'noai') : mode;
    if (els.outreachModeAI) els.outreachModeAI.checked = effective === 'ai';
    if (els.outreachModeNoAI) els.outreachModeNoAI.checked = effective === 'noai';
  }
  if (els.requiredKeywords) els.requiredKeywords.value = getEffectiveRequiredKeywordsText(settings);
  if (els.aiNiceKeywords) els.aiNiceKeywords.value = settings.aiNiceKeywords || '';
  els.includeKeywords.value = getEffectiveIncludeKeywordsText(settings);
  els.excludeKeywords.value = settings.excludeKeywords || '';
  renderOutreachListMode();
  applyModeUI();
  applyAutoReplyDirectionVisibility();
  renderManualReviewSummary();
  // 1.1.x：tab 上的小绿灯不再表示"功能启用"，改由 applyPageUI 按当前选中页设置（避免两个 tab 都亮误导）
  setDirty(false);
}

function renderAiPresetOptions() {
  if (els.aiBaseUrlPreset) {
    els.aiBaseUrlPreset.innerHTML = [
      ...AI_BASE_URL_PRESETS.map((item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}（${item.value}）</option>`),
      `<option value="${CUSTOM_PRESET_VALUE}">自定义（手写）</option>`,
    ].join('');
  }
  if (els.aiModelPreset) {
    els.aiModelPreset.innerHTML = [
      ...AI_MODEL_PRESETS.map((item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}（${item.value}）</option>`),
      `<option value="${CUSTOM_PRESET_VALUE}">自定义（手写）</option>`,
    ].join('');
  }
}

function syncAiPresetSelectionsFromInputs() {
  const baseUrl = String(els.aiBaseUrl?.value || '').trim();
  const model = resolveAiModelFromUI();
  if (els.aiBaseUrlPreset) {
    const hit = AI_BASE_URL_PRESETS.find((item) => item.value === baseUrl);
    els.aiBaseUrlPreset.value = hit ? hit.value : CUSTOM_PRESET_VALUE;
  }
  if (els.aiModelPreset) {
    const hit = AI_MODEL_PRESETS.find((item) => item.value === model);
    els.aiModelPreset.value = hit ? hit.value : CUSTOM_PRESET_VALUE;
  }
}

function renderCommonPhrasesSelect() {
  const selects = [
    els.replyCommonPhrase,
    els.autoReplyPassCommonPhrase,
    els.autoReplyPassPortfolioCommonPhrase,
    els.autoReplyCandidateRejectCommonPhrase,
    els.autoReplyOurRejectCommonPhrase,
  ].filter(Boolean);
  if (!selects.length) return;
  const list = Array.isArray(commonPhrases) ? commonPhrases : [];
  const opts = [];
  opts.push(`<option value="">（不发送常用语）</option>`);
  for (const t of list) {
    const text = String(t || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    opts.push(`<option value="${escapeAttr(text)}">${escapeHtml(text.slice(0, 80))}${text.length > 80 ? '…' : ''}</option>`);
  }
  for (const select of selects) {
    select.innerHTML = opts.join('');
  }
  if (els.replyCommonPhrase) els.replyCommonPhrase.value = String(settings.replyCommonPhrase || '');
  if (els.autoReplyPassCommonPhrase) els.autoReplyPassCommonPhrase.value = String(settings.autoReplyPassCommonPhrase || settings.replyCommonPhrase || '');
  if (els.autoReplyPassPortfolioCommonPhrase) els.autoReplyPassPortfolioCommonPhrase.value = String(settings.autoReplyPassPortfolioCommonPhrase || '');
  if (els.autoReplyCandidateRejectCommonPhrase) els.autoReplyCandidateRejectCommonPhrase.value = String(settings.autoReplyCandidateRejectCommonPhrase || '');
  if (els.autoReplyOurRejectCommonPhrase) els.autoReplyOurRejectCommonPhrase.value = String(settings.autoReplyOurRejectCommonPhrase || '');
}

function renderManualReviewSummary() {
  if (!els.manualReviewSummary) return;
  const list = Array.isArray(manualReviewQueue) ? [...manualReviewQueue] : [];
  list.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  if (!list.length) {
    els.manualReviewSummary.innerHTML = '<div class="manualSummaryEmpty">当前没有待人工处理项</div>';
    return;
  }
  const html = list.slice(0, 30).map((item) => {
    const rawName = String(item?.candidateName || '').trim();
    const name = escapeHtml(rawName || '未命名候选人');
    const position = escapeHtml(String(item?.positionName || '未识别岗位'));
    const actionLabel = escapeHtml(String(item?.actionLabel || '待处理'));
    const tagClass = escapeAttr(String(item?.tagClass || 'info'));
    const metaBits = [
      position,
      String(item?.sourceLabel || '').trim(),
      formatQueueTime(item?.ts),
    ].filter(Boolean).map(escapeHtml);
    const reason = String(item?.reason || '').trim();
    const lastInbound = String(item?.lastInboundText || '').trim();
    const preview = String(item?.draftText || '').trim();
    const body = [
      reason ? `判断：${reason}` : '',
      lastInbound ? `对方最后一句：${lastInbound}` : '',
      preview ? `建议草稿：${preview}` : '',
    ].filter(Boolean).join('\n');
    // 1.2.x：有姓名即可点击跳转 Boss 沟通页定位
    const clickable = !!rawName;
    const clickableCls = clickable ? ' manualSummaryClickable' : '';
    const dataName = clickable ? ` data-cand-name="${escapeAttr(rawName)}"` : '';
    const openHint = clickable
      ? `<div class="manualSummaryOpenHint">在 Boss 沟通页打开 →</div>`
      : '';
    const titleAttr = clickable ? ' title="点击切到 Boss 沟通页并复制姓名（粘贴搜索定位）"' : '';
    return `
      <div class="manualSummaryItem${clickableCls}"${dataName}${titleAttr}>
        <div class="manualSummaryHead">
          <div>
            <div class="manualSummaryName">${name}</div>
            <div class="manualSummaryMeta">${metaBits.join(' · ')}</div>
          </div>
          <span class="manualSummaryTag ${tagClass}">${actionLabel}</span>
        </div>
        <div class="manualSummaryText">${escapeHtml(body || '待人工查看')}</div>
        ${openHint}
      </div>
    `;
  }).join('');
  els.manualReviewSummary.innerHTML = html;
  // 1.2.x：挂点击跳转
  attachManualReviewClickHandlers(els.manualReviewSummary);
}

/** 1.2.x：给待人工汇总卡片绑点击 —— 复用历史卡 isReply 的跳转路径（复制姓名 + 切到 Boss 沟通页） */
function attachManualReviewClickHandlers(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.manualSummaryItem.manualSummaryClickable').forEach((row) => {
    if (row._handlerBound) return;
    row._handlerBound = true;
    row.addEventListener('click', async (ev) => {
      // 不拦截内部按钮 / tag 元素的点击穿透（manualSummaryTag 是只读标签，让点击照常冒泡到 row）
      const name = String(row.dataset?.candName || '').trim();
      if (!name) return;
      try { await navigator.clipboard.writeText(name); } catch {}
      try { appendLogLine({ ts: Date.now(), level: 'info', message: `[待人工·定位] 切到 Boss 沟通页定位「${name}」（已复制姓名）` }); } catch {}
      try {
        await navigateBossToChatBestEffort();
      } catch (e) {
        appendLogLine({ ts: Date.now(), level: 'warn', message: `打开 Boss 沟通页失败：${e?.message || e}` });
      }
    });
  });
}

function applyModeUI() {
  const isAiMode = !!els.outreachModeAI?.checked;
  if (els.aiOnlyBlock) els.aiOnlyBlock.style.display = isAiMode ? '' : 'none';

  if (els.modeTip) {
    els.modeTip.textContent = isAiMode
      ? 'AI 模式：用大模型对“简历 vs JD”评分（会消耗 token）。'
      : '无 AI 模式：只按关键词筛选（不调用大模型，不消耗 token）。';
  }

  if (els.includeKeywordsLabel) {
    els.includeKeywordsLabel.textContent = '任意关键词（OR；每行一个；命中任意一个即可）';
  }
}

function setDisplay(el, visible) {
  if (!el) return;
  el.style.display = visible ? '' : 'none';
}

function applyAutoReplyDirectionVisibility() {
  const passMode = normalizeReplySendMode(els.autoReplyPassMode?.value, getDefaultPassReplyMode(settings));
  const candidateRejectMode = normalizeReplySendMode(els.autoReplyCandidateRejectMode?.value, 'template');
  const ourRejectMode = normalizeReplySendMode(els.autoReplyOurRejectMode?.value, 'template');

  setDisplay(els.autoReplyPassCommonPhraseWrap, passMode === 'commonPhrase');
  setDisplay(els.autoReplyPassTemplateWrap, passMode === 'template');

  setDisplay(els.autoReplyCandidateRejectCommonPhraseWrap, candidateRejectMode === 'commonPhrase');
  setDisplay(els.autoReplyCandidateRejectTemplateWrap, candidateRejectMode === 'template');

  setDisplay(els.autoReplyOurRejectCommonPhraseWrap, ourRejectMode === 'commonPhrase');
  setDisplay(els.autoReplyOurRejectTemplateWrap, ourRejectMode === 'template');
}

function applySelectedJobScopedFiltersToUI() {
  const key = String(els.jobSelect?.value || settings.selectedJobKey || '').trim();
  const ov = getEffectiveJobKeywordOverride(key);
  if (!ov) return;
  if (els.requiredKeywords) els.requiredKeywords.value = String(ov.requiredKeywords || (ov.keywordsAndMode ? ov.includeKeywords || '' : ''));
  if (els.includeKeywords) els.includeKeywords.value = String(ov.keywordsAndMode ? '' : ov.includeKeywords || '');
  if (els.excludeKeywords) els.excludeKeywords.value = String(ov.excludeKeywords || '');
  if (els.aiNiceKeywords) els.aiNiceKeywords.value = String(ov.aiNiceKeywords || '');
  if (els.minAge) els.minAge.value = String(clampInt(ov.minAge, 0, 70, 0));
  if (els.maxAge) els.maxAge.value = String(clampInt(ov.maxAge, 0, 70, 0));
  if (els.minEdu) els.minEdu.value = normalizeEduRequirementValue(ov.minEdu);
  if (els.maxRecentGapMonths) els.maxRecentGapMonths.value = String(clampInt(ov.maxRecentGapMonths, 0, 240, 0));
}

// 1.1.x：basicCard 顶部"正在筛选 [岗位名]"badge 更新
function updateCurrentJobBadge() {
  if (!els.currentJobBadge) return;
  const key = String(settings?.selectedJobKey || '').trim();
  let name = '';
  if (key) {
    const j = (Array.isArray(jobs) ? jobs : []).find((x) => x?.key === key);
    name = String(j?.name || settings?.positionName || '').trim();
  }
  if (name) {
    els.currentJobBadge.textContent = name;
    els.currentJobBadge.classList.remove('empty');
    els.currentJobBadge.title = name;
  } else {
    els.currentJobBadge.textContent = '未选岗位（请在下方下拉选择）';
    els.currentJobBadge.classList.add('empty');
    els.currentJobBadge.title = '从下方下拉选择岗位';
  }
}

function renderJobsSelect() {
  const hasOutreachSelect = !!els.jobSelect;
  const hasReplySelect = !!els.autoReplyJobSelect;
  if (!hasOutreachSelect && !hasReplySelect) return;
  const current = settings.selectedJobKey || '';
  const currentReply = settings.autoReplyJobKey || '';
  const opts = [];
  opts.push(`<option value="">请选择岗位</option>`);
  const all = Array.isArray(jobs) ? jobs : [];
  // UI 去重：同一岗位只显示一条；优先保留“已同步JD”的版本
  const map = new Map();
  for (const j of all) {
    const key = String(j?.key || '').trim();
    if (!key) continue;
    const prev = map.get(key);
    const hasJd = j?.jdText && String(j.jdText).trim().length > 0;
    const prevHasJd = prev?.jdText && String(prev.jdText).trim().length > 0;
    const newer = (j?.updatedAt || 0) >= (prev?.updatedAt || 0);
    if (!prev) map.set(key, j);
    else if (hasJd && !prevHasJd) map.set(key, j);
    else if (hasJd === prevHasJd && newer) map.set(key, j);
  }

  const values = Array.from(map.values()).map(normalizeStoredJobStateForPopup);
  // 1.2.x：严格过滤 —— 只显示职位管理页"发布中"的岗位（isOpen === true）。
  // 已关闭 / 已暂停 / 已下线（isOpen === false）→ 直接删除不展示。
  // 状态未同步（isOpen === null，例如还没打开过职位管理页）→ 也不展示，避免误导。
  // 用户体验：如果下拉是空的，说明要先去 Boss 左侧「职位管理」打开一次让插件读到岗位列表。
  const list = values.filter((j) => j?.isOpen === true);
  // 有 JD 的排前面，其次最近更新
  list.sort((a, b) => {
    const aj = a?.jdText && String(a.jdText).trim().length > 0 ? 1 : 0;
    const bj = b?.jdText && String(b.jdText).trim().length > 0 ? 1 : 0;
    if (bj !== aj) return bj - aj;
    return (b?.updatedAt || 0) - (a?.updatedAt || 0);
  });

  // 1.2.x：之前的"当前已选但已关闭"保留条目已移除 —— 关闭/删除的岗位不再"以已选名义"留在下拉

  for (const j of list) {
    const hasJd = j.jdText && String(j.jdText).trim().length > 0;
    const hasCalib = !!(jobKeywordOverrides && jobKeywordOverrides[j.key]);
    // 1.1.1：把 [JD] [校准] 徽标贴到岗位名上，让用户切岗位时一眼判断
    const badges = [];
    if (hasJd) badges.push('JD');
    if (hasCalib) badges.push('校准');
    const badgeStr = badges.length ? ` [${badges.join('·')}]` : '';
    const noJdSuffix = hasJd ? '' : '（未同步JD）';
    const label = `${j.name}${badgeStr}${noJdSuffix}`;
    opts.push(`<option value="${escapeAttr(j.key)}">${escapeHtml(label)}</option>`);
  }
  if (hasOutreachSelect) {
    els.jobSelect.innerHTML = opts.join('');
    // 1.2.x：当前选中的岗位若已不在发布中 → 自动清空选择
    const canKeep = current && list.some((j) => j.key === current);
    els.jobSelect.value = canKeep ? current : '';
  }
  // 1.1.x：basicCard 顶部"正在筛选"高亮 —— 显示当前选中岗位名
  updateCurrentJobBadge();

  if (hasReplySelect) {
    const replyOpts = [];
    replyOpts.push(`<option value="">全部职位</option>`);
    for (const j of list) {
      replyOpts.push(`<option value="${escapeAttr(j.key)}">${escapeHtml(j.name || '')}</option>`);
    }
    els.autoReplyJobSelect.innerHTML = replyOpts.join('');
    // 1.2.x：自动回复岗位选中已不在发布中 → 自动回退到"全部职位"
    const canKeepReply = currentReply && list.some((j) => j.key === currentReply);
    els.autoReplyJobSelect.value = canKeepReply ? currentReply : '';
  }
  applySelectedJobScopedFiltersToUI();
  // 1.2.x：折叠区收起时也能在 summary 看到当前岗位范围
  updateAutoReplyScopeHint();
}

// 1.2.x：把当前 textarea 的 JD 持久化到 jobs[].jdText（按 key 匹配的那条记录）
//   - 解决：保存岗位校准 / 切回岗位时 JD 丢失，每次都需要手动点"刷新 JD"
//   - 写完会触发 chrome.storage.onChanged → 自动 reload 本地 jobs 数组 + 重渲下拉
async function persistJdToJobsCache(key, jdText) {
  if (!key || !jdText) return;
  const k = String(key).trim();
  const v = String(jdText).trim();
  if (!k || !v) return;
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.jobs]);
    const arr = Array.isArray(r?.[STORAGE_KEYS.jobs]) ? r[STORAGE_KEYS.jobs] : [];
    const idx = arr.findIndex((j) => j && String(j.key || '').trim() === k);
    const now = Date.now();
    if (idx >= 0) {
      arr[idx] = { ...arr[idx], jdText: v, updatedAt: now };
    } else {
      // 走到这里说明该 key 在缓存里没有，但用户还是选中并保存了 —— 兜底也写一条
      arr.push({ key: k, name: getSelectedJobName() || '', jdText: v, updatedAt: now });
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: arr });
  } catch (e) {
    appendLogLine({ ts: Date.now(), level: 'warn', message: `持久化 JD 失败：${e?.message || e}` });
  }
}

// 1.2.x：自动回复岗位范围折叠区的 summary hint —— 显示当前选中的岗位
function updateAutoReplyScopeHint() {
  const hintEl = document.getElementById('autoReplyScopeHint');
  if (!hintEl) return;
  const sel = els.autoReplyJobSelect;
  if (!sel) return;
  const opt = sel.options?.[sel.selectedIndex];
  const label = String(opt?.textContent || '').trim();
  hintEl.textContent = label ? `当前：${label}` : '岗位 / 模板 / 常用语 / 冷却';
}

function normalizeStoredJobStateForPopup(job) {
  const next = { ...(job || {}) };
  const current = next.isOpen;
  if (current !== true && current !== false) {
    const statusText = String(next.statusText || '').replace(/\s+/g, ' ').trim();
    if (/开放中/.test(statusText)) next.isOpen = true;
    else if (/已关闭|关闭中|已暂停|暂停中|已下线|下线/.test(statusText)) next.isOpen = false;
    else if (String(next.sourceUrl || '').includes('dom:job-management:open')) next.isOpen = true;
    else next.isOpen = null;
  }
  return next;
}

function markDirty() {
  setDirty(true);
}

async function saveSettings() {
  if (savePromise) return savePromise;
  isSaving = true;
  updateSaveButton();
  savePromise = (async () => {
    settings = collectSettingsFromUI();
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });

    // 每个岗位一套关键词：有选择岗位时，把关键词跟着岗位保存
    if (settings.selectedJobKey) {
      await upsertJobKeywordOverride(settings.selectedJobKey, {
        requiredKeywords: settings.requiredKeywords,
        includeKeywords: settings.includeKeywords,
        excludeKeywords: settings.excludeKeywords,
        keywordsAndMode: !!settings.keywordsAndMode,
        aiNiceKeywords: settings.aiNiceKeywords,
        minAge: settings.minAge,
        maxAge: settings.maxAge,
        minEdu: settings.minEdu,
        maxRecentGapMonths: settings.maxRecentGapMonths,
      });
    }

    // 尝试通知页面更新（不强依赖）
    try {
      const tab = await getTargetBossTab();
      if (!tab) return;
      // 固定发给顶层 frame（推荐牛人候选人列表在 iframe，顶层负责转发）
      await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_UPDATE_SETTINGS' }, { frameId: 0 });
    } catch {}
    setDirty(false);
  })();

  try {
    await savePromise;
  } finally {
    savePromise = null;
    isSaving = false;
    updateSaveButton();
  }
}

function collectSettingsFromUI() {
  const s = mergeDeep(DEFAULT_SETTINGS, settings);
  s.enableOutreach = true;
  s.enableAutoReply = true;
  s.selectedJobKey = els.jobSelect?.value || '';
  s.autoReplyJobKey = els.autoReplyJobSelect?.value || '';
  s.autoReplySummaryOnly = false;
  s.positionName = getSelectedJobName();
  s.outreachListMode = getOutreachListModeFromUI();
  s.thresholds.passScore = clampInt(els.passScore.value, 0, 100, 60);
  if (els.replyPassScore && String(document.activeElement?.id || '') === 'replyPassScore') {
    s.thresholds.passScore = clampInt(els.replyPassScore.value, 0, 100, 60);
  } else if (els.replyPassScore && !String(els.passScore?.value || '').trim()) {
    s.thresholds.passScore = clampInt(els.replyPassScore.value, 0, 100, 60);
  }
  s.maxPerRun = clampInt(els.maxPerRun.value, 1, 500, 30);
  s.replyCommonPhrase = String(els.replyCommonPhrase?.value || s.replyCommonPhrase || '');
  s.autoReplyPassMode = normalizeReplySendMode(els.autoReplyPassMode?.value, getDefaultPassReplyMode(settings));
  s.autoReplyPassCommonPhrase = String(els.autoReplyPassCommonPhrase?.value || '');
  s.autoReplyPassPortfolioCommonPhrase = String(els.autoReplyPassPortfolioCommonPhrase?.value || '');
  s.autoReplyPassTemplate = String(els.autoReplyPassTemplate?.value || '');
  s.autoReplyCandidateRejectMode = normalizeReplySendMode(els.autoReplyCandidateRejectMode?.value, 'template');
  s.autoReplyCandidateRejectCommonPhrase = String(els.autoReplyCandidateRejectCommonPhrase?.value || '');
  s.autoReplyCandidateRejectTemplate = String(els.autoReplyCandidateRejectTemplate?.value || '');
  s.autoReplyOurRejectMode = normalizeReplySendMode(els.autoReplyOurRejectMode?.value, 'template');
  s.autoReplyOurRejectCommonPhrase = String(els.autoReplyOurRejectCommonPhrase?.value || '');
  s.autoReplyOurRejectTemplate = String(els.autoReplyOurRejectTemplate?.value || '');
  s.autoReplyClickNotFit = !!els.autoReplyClickNotFit?.checked;
  s.replyCooldownMin = clampInt(els.replyCooldownMin.value, 1, 1440, 120);
  s.delayMinMs = clampInt(els.delayMinMs.value, 0, 60000, 1200);
  s.delayMaxMs = clampInt(els.delayMaxMs.value, 0, 60000, 2600);
  if (s.delayMaxMs < s.delayMinMs) s.delayMaxMs = s.delayMinMs;
  s.freqBackoffSec = clampInt(els.freqBackoffSec?.value, 3, 600, 25);
  // 1.1.2：humanizer 收集（riskMode 单独由切换按钮维护，不在表单收集）
  {
    const intensity = String(els.humanizerIntensity?.value || 'strong');
    s.humanizer = {
      intensity: ['weak','med','strong'].includes(intensity) ? intensity : 'strong',
      restEveryMinMin: clampInt(els.humanizerRestEveryMinMin?.value, 5, 240, 25),
      restEveryMinMax: clampInt(els.humanizerRestEveryMinMax?.value, 5, 240, 40),
      restDurationSecMin: clampInt(els.humanizerRestDurationSecMin?.value, 20, 600, 60),
      restDurationSecMax: clampInt(els.humanizerRestDurationSecMax?.value, 20, 600, 180),
      randomSkipPct: clampInt(els.humanizerRandomSkipPct?.value, 0, 30, 5),
    };
    if (s.humanizer.restEveryMinMax < s.humanizer.restEveryMinMin) s.humanizer.restEveryMinMax = s.humanizer.restEveryMinMin;
    if (s.humanizer.restDurationSecMax < s.humanizer.restDurationSecMin) s.humanizer.restDurationSecMax = s.humanizer.restDurationSecMin;
  }
  // 1.1.3：本机点击器
  {
    const ep = String(els.externalClickerEndpoint?.value || '').trim() || 'http://127.0.0.1:12345';
    s.externalClicker = {
      enabled: !!els.externalClickerEnabled?.checked,
      endpoint: ep,
      perClickConfirm: els.externalClickerPerClickConfirm?.checked !== false,
      idleMinSec: clampInt(els.externalClickerIdleMinSec?.value, 0, 3600, 0),
      idleMaxWaitSec: clampInt(els.externalClickerIdleMaxWaitSec?.value, 30, 3600, 300),
    };
  }
  // riskMode 不在表单收集；保留现有值
  if (!['low','auto'].includes(String(s.riskMode))) s.riskMode = 'low';
  s.minAge = clampInt(els.minAge?.value, 0, 70, 0);
  s.maxAge = clampInt(els.maxAge?.value, 0, 70, 0);
  s.minEdu = normalizeEduRequirementValue(els.minEdu?.value);
  s.maxRecentGapMonths = clampInt(els.maxRecentGapMonths?.value, 0, 240, 0);

  s.jdText = els.jdText.value;
  s.outreachTemplate = String(els.outreachTemplate?.value || s.outreachTemplate || '');
  s.autoReplyTemplate = String(els.autoReplyTemplate?.value || s.autoReplyPassTemplate || s.autoReplyTemplate || '');
  if (!s.replyCommonPhrase) s.replyCommonPhrase = String(s.autoReplyPassCommonPhrase || '');
  s.ai.baseUrl = resolveAiBaseUrlFromUI();
  // 留空 = 不覆盖已保存 key；需要清空请点“清空Key”
  {
    const v = els.aiApiKey.value.trim();
    s.ai.apiKey = v ? v : (settings.ai?.apiKey || '');
  }
  s.ai.model = resolveAiModelFromUI();
  // 口径：只用“AI/无AI”单选决定是否调用大模型
  if (els.outreachModeAI?.checked) {
    s.outreachMode = 'ai';
    s.allowOutreachWithoutAI = false;
  } else {
    s.outreachMode = 'noai';
    s.allowOutreachWithoutAI = true;
  }
  s.keywordsAndMode = false;
  s.requiredKeywords = String(els.requiredKeywords?.value || '');
  s.aiNiceKeywords = String(els.aiNiceKeywords?.value || '');
  s.includeKeywords = els.includeKeywords.value;
  s.excludeKeywords = els.excludeKeywords.value;
  return s;
}

function normalizeReplySendMode(value, fallback = 'template') {
  const v = String(value || '').trim();
  if (v === 'template' || v === 'commonPhrase' || v === 'none') return v;
  return fallback;
}

function getDefaultPassReplyMode(source) {
  return String(source?.replyCommonPhrase || '').trim() ? 'commonPhrase' : 'template';
}

function bindOutreachListModeButtons() {
  const buttons = getOutreachListModeButtons();
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((item) => item.classList.toggle('active', item === btn));
      // 1.1.3：立即同步折叠 summary 上的 hint（不要等保存）
      const hint = document.getElementById('recommendListHint');
      if (hint) {
        const map = { recommend: '推荐', featured: '精选', latest: '最新' };
        hint.textContent = map[btn.dataset.value] || btn.dataset.value || '';
      }
      markDirty();
    });
  });
}

function getOutreachListModeButtons() {
  return [
    els.outreachListModeRecommend,
    els.outreachListModeFeatured,
    els.outreachListModeLatest,
  ].filter(Boolean);
}

function normalizeOutreachListMode(value) {
  const v = String(value || '').trim();
  if (v === 'featured' || v === 'latest') return v;
  return 'recommend';
}

function getOutreachListModeFromUI() {
  const active = getOutreachListModeButtons().find((btn) => btn.classList.contains('active'));
  return normalizeOutreachListMode(active?.dataset?.value || settings.outreachListMode);
}

function renderOutreachListMode() {
  const current = normalizeOutreachListMode(settings.outreachListMode);
  getOutreachListModeButtons().forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === current);
  });
  // 1.1.1：折叠 summary 上同步显示当前选的列表
  const hint = document.getElementById('recommendListHint');
  if (hint) {
    const map = { recommend: '推荐', featured: '精选', latest: '最新' };
    hint.textContent = map[current] || current;
  }
}

function getSelectedJobName() {
  const key = String(els.jobSelect?.value || '').trim();
  if (!key) return '';
  const job = jobs.find((item) => item.key === key);
  return String(job?.name || '').trim();
}

function normalizeEduRequirementValue(value) {
  const v = String(value ?? '').trim();
  if (['3', '4', '5', '6', '985', '211', 'art'].includes(v)) return v;
  return '0';
}

function getEffectiveRequiredKeywordsText(source) {
  const required = String(source?.requiredKeywords || '').trim();
  if (required) return required;
  if (source?.keywordsAndMode) return String(source?.includeKeywords || '').trim();
  return '';
}

function getEffectiveIncludeKeywordsText(source) {
  if (source?.keywordsAndMode) return '';
  return String(source?.includeKeywords || '').trim();
}

function renderKeyStatus() {
  if (!els.aiKeyStatus) return;
  const hasKey = !!(settings.ai?.apiKey && String(settings.ai.apiKey).trim());
  els.aiKeyStatus.textContent = hasKey ? 'Key：已保存（不回显）' : 'Key：未保存';
}

function renderAiTestStatus(state = 'idle', detail = '') {
  if (!els.aiTestStatus) return;
  if (state === 'running') {
    els.aiTestStatus.textContent = '测试：检查中...';
    return;
  }
  if (state === 'success') {
    els.aiTestStatus.textContent = `测试：成功${detail ? `（${detail}）` : ''}`;
    return;
  }
  if (state === 'failed') {
    els.aiTestStatus.textContent = `测试：失败${detail ? `（${detail}）` : ''}`;
    return;
  }
  els.aiTestStatus.textContent = '测试：未运行';
}

function setDirty(v) {
  isDirty = !!v;
  updateSaveButton();
}

function updateSaveButton() {
  const buttons = [
    { el: els.btnSave, dirtyText: '保存' },
    { el: els.btnSaveReply, dirtyText: '保存自动回复' },
  ].filter((item) => !!item.el);
  if (!buttons.length) return;
  if (isSaving) {
    buttons.forEach(({ el }) => {
      el.disabled = true;
      el.classList.remove('dirty');
      el.textContent = '保存中...';
    });
    return;
  }
  buttons.forEach(({ el, dirtyText }) => {
    el.disabled = false;
    if (isDirty) {
      el.classList.add('dirty');
      el.textContent = dirtyText;
    } else {
      el.classList.remove('dirty');
      el.textContent = '已保存';
    }
  });
}

async function renderAiUsage(nextValue) {
  let v = nextValue;
  if (!v) {
    try { v = (await chrome.storage.local.get([STORAGE_KEYS.aiUsage]))?.[STORAGE_KEYS.aiUsage] || null; } catch {}
  }
  // AI 面板里的细节文字
  if (els.aiUsageTip) {
    try {
      const total = Number(v?.total_tokens);
      if (Number.isFinite(total) && total > 0) {
        const p = Number(v?.prompt_tokens) || 0;
        const c = Number(v?.completion_tokens) || 0;
        els.aiUsageTip.textContent = `Token：${total}（p=${p}, c=${c}）`;
      } else {
        els.aiUsageTip.textContent = 'Token：-';
      }
    } catch {
      els.aiUsageTip.textContent = 'Token：-';
    }
  }
  // 1.1.x：顶部 token 用量徽章
  updateTokenGauge(v);
}

// 1.1.x：把数字格式化成 K / M
function formatTokenCount(n) {
  const num = Number(n) || 0;
  if (num >= 1e6) return (num / 1e6).toFixed(num >= 1e7 ? 0 : 1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(num >= 1e4 ? 0 : 1) + 'K';
  return String(num);
}

// 1.1.x：顶部 token 用量小徽章
// 用法：累计 token 数 vs 你在 settings.tokenMonthlyQuota 设的月度配额（默认 100 万 token）
// 真实价格 / 余额请点徽章去网关后台看
function updateTokenGauge(usage) {
  if (!els.tgUsed) return;
  const total = Number(usage?.total_tokens) || 0;
  const quota = Number(settings?.tokenMonthlyQuota) || 1000000; // 默认 100 万 tokens
  const pct = quota > 0 ? Math.min(100, Math.round(total / quota * 100)) : 0;

  els.tgUsed.textContent = formatTokenCount(total);
  els.tgQuota.textContent = formatTokenCount(quota);
  els.tgPct.textContent = pct + '%';
  els.tgPct.classList.toggle('warn',  pct >= 70 && pct < 90);
  els.tgPct.classList.toggle('alert', pct >= 90);
  if (els.tgBarFill) els.tgBarFill.style.width = pct + '%';
}

function hasAiConfigInUI() {
  const baseUrl = resolveAiBaseUrlFromUI();
  const model = resolveAiModelFromUI();
  const key = String(els.aiApiKey?.value || '').trim() || String(settings.ai?.apiKey || '').trim();
  return !!(baseUrl && model && key);
}

function getMissingAiFieldsInUI() {
  const missing = [];
  const baseUrl = resolveAiBaseUrlFromUI();
  const model = resolveAiModelFromUI();
  const key = String(els.aiApiKey?.value || '').trim() || String(settings.ai?.apiKey || '').trim();
  if (!baseUrl) missing.push('baseUrl');
  if (!key) missing.push('apiKey');
  if (!model) missing.push('model');
  return missing;
}

async function testAiConfigAfterSave() {
  const missing = getMissingAiFieldsInUI();
  if (missing.length) {
    renderAiTestStatus('failed', `缺少 ${missing.join('/')}`);
    return false;
  }

  const baseUrl = resolveAiBaseUrlFromUI();
  const model = resolveAiModelFromUI();
  const apiKey = String(els.aiApiKey?.value || '').trim() || String(settings.ai?.apiKey || '').trim();
  renderAiTestStatus('running');
  appendLogLine({ ts: Date.now(), level: 'info', message: `正在测试 AI 配置（${model}）...` });

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'AI_CALL',
      baseUrl,
      apiKey,
      model,
      temperature: 0,
      max_tokens: 8,
      messages: [
        { role: 'system', content: '你是一个连通性测试助手，只回复 OK。' },
        { role: 'user', content: '请只回复 OK' },
      ],
    });
    if (resp?.success) {
      renderAiTestStatus('success', model);
      appendLogLine({ ts: Date.now(), level: 'success', message: `AI 测试成功：${model}` });
      return true;
    }
    const errText = String(resp?.error || '未知错误').slice(0, 120);
    renderAiTestStatus('failed', errText);
    appendLogLine({ ts: Date.now(), level: 'warn', message: `AI 测试失败：${errText}` });
    return false;
  } catch (e) {
    const errText = String(e?.message || e || '未知错误').slice(0, 120);
    renderAiTestStatus('failed', errText);
    appendLogLine({ ts: Date.now(), level: 'warn', message: `AI 测试失败：${errText}` });
    return false;
  }
}

async function maybeAiFillKeywords({ force } = {}) {
  const isAiMode = !!els.outreachModeAI?.checked;
  if (!isAiMode) return false;

  const key = String(els.jobSelect?.value || '').trim();
  const jd = String(els.jdText?.value || '').trim();
  if (!jd) return false;

  // 已有人工关键词时：非强制不覆盖
  if (!force) {
    const hasManual =
      !!String(els.requiredKeywords?.value || '').trim()
      || !!String(els.includeKeywords?.value || '').trim()
      || !!jobKeywordOverrides?.[key];
    if (hasManual) return false;
  }

  if (!hasAiConfigInUI()) {
    if (force) appendLogLine({ ts: Date.now(), level: 'warn', message: 'AI生成关键词：AI 配置不完整（需 baseUrl / apiKey / model）' });
    return false;
  }

  appendLogLine({ ts: Date.now(), level: 'info', message: 'AI 正在根据 JD 生成关键词...' });
  try {
    // 先把 UI 中的 AI 配置落盘（包含 apiKey：留空不覆盖旧值）
    await saveSettings();

    const resp = await chrome.runtime.sendMessage({
      type: 'AI_CALL',
      baseUrl: String(settings.ai?.baseUrl || '').trim(),
      apiKey: String(settings.ai?.apiKey || '').trim(),
      model: String(settings.ai?.model || '').trim(),
      messages: [
        {
          role: 'system',
          content: '你是招聘JD关键词提炼助手。你会把JD转成用于检索/筛选的关键词规则。只输出严格JSON，不要多余文本。',
        },
        {
          role: 'user',
          content: [
            '请从下面 JD 提取关键词规则，用于“无AI关键词筛选”。需要同时支持“必含关键词（AND）”和“任意关键词（OR）”。',
            '要求：',
            '- 输出 JSON：{"requireAll": ["..."], "includeAny": ["..."], "nice": ["..."], "exclude": ["..."], "note": "一句话说明提取依据（<=60字）"}',
            '- requireAll 表示必含关键词（AND），通常 1-3 个，必须是 JD 中最硬的门槛',
            '- includeAny 表示任意关键词（OR），通常 2-4 个，表示同类能力里命中任意一个即可',
            '- 不要把泛词、软词、场景修饰词塞进去，例如：负责、熟悉、优先、良好、相关经验、沟通能力',
            '- nice 是加分项（0-3 个）：仅保留确实能拉开差异的加分项',
            '- exclude 0-4 个：只写明显不匹配方向；若JD未提及可为空',
            '- 如果 JD 本身条件很聚焦，优先少而准，不要为了凑数而多写',
            '- 只输出 JSON',
            '',
            `JD:\n${jd.slice(0, 12000)}`,
          ].join('\n'),
        },
      ],
      temperature: 0,
      max_tokens: 400,
    });

    if (!resp?.success) throw new Error(resp?.error || 'AI 调用失败');
    const parsed = safeJsonParseLoose(resp.text);
    const required = normalizeKeywordList(parsed?.requireAll, 3);
    const nice = normalizeKeywordList(parsed?.nice, 3);
    const include = normalizeKeywordList(parsed?.includeAny ?? parsed?.include, 4);
    const exclude = normalizeKeywordList(parsed?.exclude, 4);
    const note = String(parsed?.note || '').trim();

    if (required.length === 0 && include.length === 0 && nice.length === 0) throw new Error('未生成关键词');

    if (els.requiredKeywords) els.requiredKeywords.value = required.join('\n');
    if (els.aiNiceKeywords) els.aiNiceKeywords.value = nice.join('\n');
    // 无AI筛选：若 includeAny 没给，默认用 nice 补齐
    const fallbackInclude = Array.from(new Set([...nice].filter(Boolean))).slice(0, 4);
    els.includeKeywords.value = (include.length ? include : fallbackInclude).join('\n');
    els.excludeKeywords.value = exclude.join('\n');

    // 记录 usage（累计展示）
    if (resp.usage) await recordAiUsage(resp.usage);
    await saveSettings();

    appendLogLine({ ts: Date.now(), level: 'success', message: `AI关键词已填充${note ? `：${note}` : ''}` });
    return true;
  } catch (e) {
    appendLogLine({ ts: Date.now(), level: 'warn', message: `AI生成关键词失败：${e?.message || '未知错误'}` });
    return false;
  } finally {
    renderAiUsage().catch(() => {});
  }
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

function safeJsonParseLoose(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  throw new Error('AI 返回不是有效 JSON');
}

function normalizeKeywordList(list, limit) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

async function onStart() {
  await saveSettings();
  appendLogLine({ ts: Date.now(), level: 'info', message: '发送开始指令...' });

  try {
    try {
      const latest = await chrome.storage.local.get([STORAGE_KEYS.settings]);
      settings = normalizeSettingsWithPromptMigration(latest?.[STORAGE_KEYS.settings] || {});
      const aiBaseUrl = String(settings.ai?.baseUrl || '').trim();
      const aiModel = String(settings.ai?.model || '').trim();
      if (aiBaseUrl || aiModel) {
        appendLogLine({
          ts: Date.now(),
          level: 'info',
          message: `当前AI配置：${aiBaseUrl || '-'} | ${aiModel || '-'}`,
        });
      }
    } catch {}

    // 口径：按当前页签启动，避免“自动回复开始后又跳推荐牛人”
    // - 在「自动回复」页点开始：只跑自动回复（保持在沟通页）
    // - 在「主动寻访」页点开始：只跑主动寻访（跳推荐牛人）
    const preferredMode =
      activePage === 'reply' ? 'reply'
      : activePage === 'outreach' ? 'outreach'
      : 'auto';

    if (preferredMode === 'reply' && !hasAiConfigInUI()) {
      const missing = getMissingAiFieldsInUI();
      appendLogLine({
        ts: Date.now(),
        level: 'warn',
        message: `开始失败：自动回复缺少 AI 配置（${missing.join(' / ') || 'baseUrl / apiKey / model'}）`,
      });
      return;
    }

    const isEmbed = new URLSearchParams(location.search || '').get('embed') === '1' || window.top !== window;
    const rs = await chrome.storage.local.get([STORAGE_KEYS.runState]).catch(() => ({}));
    const prev = rs?.[STORAGE_KEYS.runState] || {};
    const wasRunning = !!prev?.running;

    if (isEmbed) {
      // 关键兜底：嵌入式面板不依赖 tabs.query，统一走后台定位 Boss tab 再转发
      const tab = await getTargetBossTab().catch(() => null);
      const r = await chrome.runtime.sendMessage({
        type: 'BOSS_UI_START',
        tabId: tab?.id || null,
        payload: { mode: preferredMode },
      });
      if (r?.success) appendLogLine({ ts: Date.now(), level: 'success', message: '已开始（会自动跳推荐牛人→切岗位→寻访）' });
      else appendLogLine({ ts: Date.now(), level: 'warn', message: `开始失败：${r?.error || '未知错误'}` });
      return;
    }

    const tab = await getTargetBossTab();
    if (!tab) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: '未找到 Boss 标签页：请先打开并登录 Boss（*.zhipin.com）' });
      return;
    }

    try {
      const u = tab.url ? new URL(tab.url) : null;
      const where = u ? `${u.pathname}${u.search || ''}` : '';
      appendLogLine({ ts: Date.now(), level: 'info', message: `目标 Boss 页面：${where || (tab.title || '')}` });
    } catch {}

    // 口径：点开始后把 Boss 页切到前台，方便你“看见它在操作”
    try {
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } catch {}

    // 自动补注入内容脚本（无需手动刷新 Boss 页面）
    await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id });

    // 固定发给顶层 frame（顶层负责把主动寻访转发到 recommendFrame/search frame）
    // 注意：不再在 UI 侧强制 stop→start，避免用户多次点击“开始”导致反复重启；
    // 内容脚本内部会基于心跳自动判定“卡住”并自愈。
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_START', mode: preferredMode }, { frameId: 0 });
    if (resp?.success) appendLogLine({ ts: Date.now(), level: 'success', message: '已开始（请保持 Boss 页面在前台）' });
    else appendLogLine({ ts: Date.now(), level: 'warn', message: `开始失败：${resp?.error || '未知错误'}` });
  } catch (e) {
    appendLogLine({ ts: Date.now(), level: 'warn', message: `无法连接到页面脚本：请刷新 Boss 页面后再试` });
  }
}

async function onStop() {
  appendLogLine({ ts: Date.now(), level: 'info', message: '发送停止指令...' });
  try {
    const isEmbed = new URLSearchParams(location.search || '').get('embed') === '1' || window.top !== window;
    if (isEmbed) {
      const tab = await getTargetBossTab().catch(() => null);
      const r = await chrome.runtime.sendMessage({ type: 'BOSS_UI_STOP', tabId: tab?.id || null });
      if (r?.success) appendLogLine({ ts: Date.now(), level: 'success', message: '已发送停止指令' });
      else appendLogLine({ ts: Date.now(), level: 'warn', message: `停止指令发送失败：${r?.error || '未知错误'}` });
      return;
    }

    const tab = await getTargetBossTab();
    if (!tab) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: '未找到 Boss 标签页：请先打开 Boss（*.zhipin.com）' });
      return;
    }
    await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id });
    await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_STOP' }, { frameId: 0 });
    appendLogLine({ ts: Date.now(), level: 'success', message: '已发送停止指令' });
  } catch {
    appendLogLine({ ts: Date.now(), level: 'warn', message: '停止指令发送失败（页面脚本未连接）' });
  }
}

/* ===== 1.1.1 日志缓冲 + 过滤 + 自动滚动 ===== */
const LOG_BUFFER_MAX = 1000;
const logBuffer = [];

// 1.1.x：被候选人卡片完全覆盖的日志行 —— 直接吞掉不渲染（避免一条候选人在 logBox 出现两遍）
//   这些行的内容（评分 / 决策 / 原因）卡片里都有了
function isLineCoveredByCard(message) {
  const s = String(message || '');
  if (!s) return false;
  if (/^AI评分[：:]/.test(s)) return true;
  if (/^关键词判定[：:]/.test(s)) return true;
  if (/^不匹配[：:]/.test(s)) return true;
  if (/^待人工打招呼\s*\[/.test(s)) return true;
  if (/^已联系\s*\[/.test(s)) return true;
  if (/^已跳过\s+/.test(s)) return true;
  if (/^重新评分[：:]/.test(s)) return true;
  if (/^跳过[：:]/.test(s)) return true;        // 年龄/学历/Gap 硬过滤
  if (/^简历正文(?:正文)?来源[：:]/.test(s)) return true;
  if (/^\[简历跳转\]/.test(s)) return true;
  if (/^\[定位\]/.test(s)) return true;
  return false;
}

function appendLogLine(entry) {
  const e = {
    ts: entry.ts || Date.now(),
    level: String(entry.level || 'info'),
    message: String(entry.message || ''),
  };
  // 1.1.x：已被候选人卡片覆盖的内容直接丢弃（不入 buffer，不渲染），减少重复
  if (isLineCoveredByCard(e.message)) return;
  logBuffer.push(e);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);

  // 增量追加：当前过滤通过才渲染，免得全量重绘
  if (logEntryMatchesFilter(e)) {
    renderLogLineToDom(e);
    if (els.logAutoScroll?.checked !== false) {
      els.logBox.scrollTop = els.logBox.scrollHeight;
    }
  }
}

function logEntryMatchesFilter(e) {
  const lvl = String(els.logLevelFilter?.value || 'all');
  if (lvl !== 'all' && e.level !== lvl) return false;
  const q = String(els.logSearch?.value || '').trim().toLowerCase();
  if (q && !e.message.toLowerCase().includes(q)) return false;
  return true;
}

function renderLogLineToDom(e) {
  const ts = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const div = document.createElement('div');
  div.className = `logLine ${e.level}`;
  div.setAttribute('data-ts', String(e.ts || 0));  // 1.1.x：用于和候选人卡片按时间交错
  div.innerHTML = `<span class="ts">[${ts}]</span>${escapeHtml(e.message)}`;
  els.logBox.appendChild(div);
}

function rerenderLogBox() {
  if (!els.logBox) return;
  els.logBox.innerHTML = '';
  for (const e of logBuffer) {
    if (logEntryMatchesFilter(e)) renderLogLineToDom(e);
  }
  // 1.1.x：清空后 candidate 卡片也没了，重新拉一次让它们按时间穿插回来
  refreshRunResultsCards().catch(() => {});
  if (els.logAutoScroll?.checked !== false) {
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }
}

function renderRunState(state) {
  const running = !!state?.running;
  const stopping = !!state?.stopping;
  els.runState.textContent = running ? (stopping ? '停止中' : '运行中') : '未运行';
  els.runState.className = 'pill ' + (running ? (stopping ? 'stopping' : 'running') : '');
  // 同步顶部状态栏
  if (els.sbRunState) {
    els.sbRunState.textContent = running ? (stopping ? '停止中' : '运行中') : '未运行';
    els.sbRunState.className = 'sbVal ' + (running ? (stopping ? 'warn' : 'run') : 'idle');
  }
  // 状态栏「停止」按钮：仅运行中可见
  if (els.sbStopBtn) {
    els.sbStopBtn.style.display = running ? '' : 'none';
    els.sbStopBtn.disabled = stopping;
    els.sbStopBtn.textContent = stopping ? '停止中…' : '⏹ 停止';
  }
  refreshStatusBar().catch(() => {});
}

/* ===== 可折叠区记忆（1.1.1） ===== */
const COLLAPSE_STORAGE_KEY = 'bossAssistCollapsedSections';
async function loadCollapsedSections() {
  try {
    const r = await chrome.storage.local.get([COLLAPSE_STORAGE_KEY]);
    const v = r?.[COLLAPSE_STORAGE_KEY];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  return {};
}
async function saveCollapsedSections(map) {
  try { await chrome.storage.local.set({ [COLLAPSE_STORAGE_KEY]: map || {} }); } catch {}
}
async function bindCollapseSections() {
  const sections = document.querySelectorAll('details.collapseSec[data-key]');
  if (!sections.length) return;
  const saved = await loadCollapsedSections();
  for (const d of sections) {
    const key = d.dataset.key;
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(saved, key)) {
      d.open = !!saved[key];
    }
    d.addEventListener('toggle', async () => {
      const map = await loadCollapsedSections();
      map[key] = !!d.open;
      await saveCollapsedSections(map);
    });
    // 阻止 summary 内部的按钮/输入控件触发折叠
    const summary = d.querySelector(':scope > summary');
    if (summary) {
      summary.querySelectorAll('button, input, select, textarea, a').forEach((el) => {
        el.addEventListener('click', (e) => e.stopPropagation());
      });
    }
  }
  // 初次渲染 JD 字数 hint
  updateJdSummaryHint();
  els.jdText?.addEventListener('input', updateJdSummaryHint);
}

function updateJdSummaryHint() {
  const hint = document.getElementById('jdSummaryHint');
  if (!hint) return;
  const len = String(els.jdText?.value || '').trim().length;
  hint.textContent = len > 0 ? `已填 ${len} 字` : '未填';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getTargetBossTab() {
  const active = await getActiveTab().catch(() => null);
  if (active?.url && /(^https?:\/\/)([^/]+\.)?zhipin\.com\//.test(active.url)) {
    return active;
  }

  // 如果当前是在“打开面板”的扩展页，则选一个 Boss 标签页作为目标
  const inWindow = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
  const bossInWindow = inWindow.filter(t => t?.url && /(^https?:\/\/)([^/]+\.)?zhipin\.com\//.test(t.url));
  if (bossInWindow.length > 0) {
    // 优先最近激活的（lastAccessed 最大）
    bossInWindow.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return bossInWindow[0];
  }

  // 兜底：全局找 Boss 标签页
  const all = await chrome.tabs.query({}).catch(() => []);
  const bossAll = all.filter(t => t?.url && /(^https?:\/\/)([^/]+\.)?zhipin\.com\//.test(t.url));
  if (bossAll.length === 0) return null;
  bossAll.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return bossAll[0];
}

async function navigateBossToChatBestEffort() {
  try {
    const tab = await getTargetBossTab();
    if (!tab?.id) {
      appendLogLine({ ts: Date.now(), level: 'warn', message: '自动回复：未找到 Boss 标签页（请先打开 Boss 沟通页）' });
      return false;
    }

    // 让用户“肉眼看到跳转”：尽量把 Boss 页切到前台
    try {
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } catch {}

    await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id }).catch(() => {});
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_GO_CHAT' }, { frameId: 0 });
    if (resp?.success) {
      appendLogLine({ ts: Date.now(), level: 'success', message: '已跳转到「沟通」页面' });
      return true;
    }
    appendLogLine({ ts: Date.now(), level: 'warn', message: `跳转沟通页失败：${resp?.error || '页面未响应'}` });
    return false;
  } catch (e) {
    appendLogLine({ ts: Date.now(), level: 'warn', message: '跳转沟通页失败：无法连接到页面脚本（可先刷新 Boss 页面）' });
    return false;
  }
}

async function refreshChatJobsBestEffort() {
  try {
    const tab = await getTargetBossTab();
    if (!tab?.id) return false;
    await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id }).catch(() => {});

    // Boss SPA：跳转到沟通页后，顶部岗位下拉可能延迟渲染；这里做等待重试
    let resp = null;
    for (let i = 0; i < 10; i++) {
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_FETCH_CHAT_JOBS' }, { frameId: 0 }).catch(() => null);
      if (resp?.success && Array.isArray(resp.jobs) && resp.jobs.length > 0) break;
      await new Promise((r) => setTimeout(r, 700 + i * 120));
    }
    if (!resp?.success || !Array.isArray(resp.jobs) || resp.jobs.length === 0) return false;

    // 将沟通页岗位列表合并进 jobs 缓存（只补全 name/jobId，不覆盖已有 jdText）
    const now = Date.now();
    const fromChat = resp.jobs
      .filter((x) => x && typeof x === 'object' && !x.isAll)
      .map((x) => {
        const jobId = String(x.value || '').trim();
        const name = String(x.text || '').replace(/\s+/g, ' ').trim();
        if (!jobId || !name) return null;
        return {
          key: `jobId:${jobId}`,
          jobId,
          encryptJobId: null,
          name,
          jdText: '',
          isOpen: null,
          statusText: '',
          sourceUrl: 'dom:chat-top-job',
          updatedAt: now,
        };
      })
      .filter(Boolean);

    if (fromChat.length === 0) return false;

    const cur = (await chrome.storage.local.get([STORAGE_KEYS.jobs]).catch(() => ({})))?.[STORAGE_KEYS.jobs];
    const existing = Array.isArray(cur) ? cur : [];
    const map = new Map();
    for (const j of existing) {
      const key = String(j?.key || '').trim();
      if (!key) continue;
      map.set(key, j);
    }
    for (const j of fromChat) {
      const prev = map.get(j.key);
      if (prev) {
        map.set(j.key, {
          ...j,
          // 保留已同步的 JD
          jdText: String(prev.jdText || ''),
          encryptJobId: prev.encryptJobId || null,
          statusText: String(prev.statusText || ''),
          isOpen: prev.isOpen ?? null,
          updatedAt: Math.max(Number(prev.updatedAt || 0), now),
        });
      } else {
        map.set(j.key, j);
      }
    }

    const merged = Array.from(map.values());
    await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: merged }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function getBossJobOpsTab() {
  // 优先找一个已经打开的「职位管理/岗位编辑」标签页，避免打断你正在沟通的页面
  const all = await chrome.tabs.query({}).catch(() => []);
  const bossAll = all.filter(t => t?.url && /(^https?:\/\/)([^/]+\.)?zhipin\.com\//.test(t.url));
  if (bossAll.length === 0) return null;

  const prefer = bossAll.filter(t => /\/web\/chat\/job\/(list|edit)/.test(String(t.url || '')));
  const candidates = (prefer.length > 0 ? prefer : bossAll);
  candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates[0];
}

async function refreshJobsListBestEffort() {
  try {
    const tab = await getBossJobOpsTab();
    if (!tab) return;
    await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id });
    // 让顶层页面执行（职位管理列表有时在 iframe，顶层负责扫描同源 iframe）
    await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_ASSIST_REFRESH_JOBS' }, { frameId: 0 });
  } catch {
    // ignore
  }
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;');
}

function formatQueueTime(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const d = new Date(n);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return '';
  }
}

function extractKeywordsFromJd(jdText) {
  const text = String(jdText || '');
  const lower = text.toLowerCase();

  const tokens = lower.match(/[a-z][a-z0-9+.#/-]{1,25}/g) || [];
  const cnParts = text
    .replace(/[【】（）()]/g, ' ')
    .split(/[\n\r，。,;；、:：\t ]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 12);

  const stop = new Set(['and', 'or', 'the', 'with', 'for', 'from', 'this', 'that', 'you', 'are']);
  const merged = [];
  for (const t of tokens) {
    if (stop.has(t)) continue;
    merged.push(t);
  }
  for (const c of cnParts) {
    if (/^(负责|要求|熟悉|掌握|优先|具备|以上|相关|能力|经验|工作|我们|公司|岗位|职责)$/.test(c)) continue;
    merged.push(c);
  }

  const seen = new Set();
  const out = [];
  for (const k of merged) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= 25) break;
  }
  return out;
}

/* =================================================================
 * claude-boss 1.1.0 新增模块：状态栏 / 评分历史 / 夜间模式提示
 * 全部为只读视图 + 设置写入，不修改原有业务流程。
 * ================================================================= */

// 1.1.x：与 boss_content.js 中 PROCESSED_OUTREACH_RETAIN_DAYS 保持一致
const PROCESSED_OUTREACH_RETAIN_DAYS = 30;

async function getProcessedOutreachMap() {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.processedOutreach]);
    const v = r?.[STORAGE_KEYS.processedOutreach];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // 顺手剪掉超出保留期的旧记录；如有删减则写回，避免无限累积
      const removed = pruneOldProcessedRecords(v, PROCESSED_OUTREACH_RETAIN_DAYS);
      if (removed > 0) {
        try { await chrome.storage.local.set({ [STORAGE_KEYS.processedOutreach]: v }); } catch {}
      }
      return v;
    }
  } catch {}
  return {};
}

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
 * 把 #historyDateRange 的值换算成开始时间戳（含），返回 0 表示不限。
 * - today: 今天 00:00:00
 * - 7d:    7 天前的此刻
 * - 30d:   30 天前的此刻（默认）
 * - all:   不限（实际仍受 30 天本地保留期约束）
 */
function getHistoryDateRangeStartTs() {
  const v = String(els.historyDateRange?.value || '30d');
  const now = Date.now();
  if (v === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (v === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  if (v === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  return 0; // all
}

function getHistoryDateRangeLabel() {
  const v = String(els.historyDateRange?.value || '30d');
  if (v === 'today') return '今日';
  if (v === '7d') return '近7天';
  if (v === '30d') return '近30天';
  return '全部';
}

/**
 * 1.1.x：本会话内"已尝试定位但 Boss 推荐流找不到"的候选人黑名单
 *   - popup 重开会清空（也就是"重新打开侧边栏 = 给所有卡片重试机会"）
 *   - 在该集合里的卡片不再显示"在 Boss 中定位"，避免反复点击徒劳
 */
const failedLocateKeys = new Set();

/**
 * 1.1.x：本次 popup 会话开始时间 + 已展示的卡片 dedupKey
 *   - 用于主动寻访页的"本次运行"实时卡片区
 *   - popup 重开 = 新会话，老记录不显示
 */
const RUN_SESSION_START_TS = Date.now();
const runResultsShownKeys = new Set();
let runResultsClearAt = 0; // 用户点"清空显示"后，比这之前的记录都不再显示

/** 1.1.x：候选人记录的统一去重/查找 key —— (身份 + 岗位 + 时间戳)，自动回复来源也兼容 */
function getRecordDedupKey(r) {
  const cand = r?.candidate || {};
  const idHint = String(
    cand.encryptGeekId
    || cand.geekId
    || cand.id
    || cand.display
    || cand.name
    || r?.threadKey  // 1.1.x：自动回复来源
    || r?.key
    || ''
  ).trim();
  const sourceTag = String(r?.source || 'outreach');
  return `${sourceTag}__${idHint}__${String(r?.jobKey || '')}__${Number(r?.ts || 0)}`;
}

/**
 * 1.1.x：把 map 转成不重复的记录数组
 *   背景：为了防止同一候选人在不同 ID 类型下被重复评分（domGeekId / encryptGeekId / geekId 等），
 *        boss_content.js 里使用了 cross-link —— 一条记录写到候选人所有可能 key 下，
 *        所以同一条记录在 map 里出现多次，导致历史列表也被重复显示。
 *   策略：用 getRecordDedupKey 去重；身份按 encryptGeekId > geekId > id > name 取首个非空。
 */
function dedupeProcessedRecords(map) {
  const allRecords = Object.entries(map || {}).map(([k, v]) => ({ key: k, ...v }));
  const seen = new Map();
  for (const r of allRecords) {
    const dedupKey = getRecordDedupKey(r);
    if (!seen.has(dedupKey)) seen.set(dedupKey, r);
  }
  return Array.from(seen.values());
}

function summarizeHistory(map, opts = {}) {
  // 1.1.x：所有统计字段都遵循"日期范围"过滤（与下方列表保持一致），
  // 状态过滤不影响统计（否则"通过率/待人工"等指标会自相矛盾）
  const dateStartTs = Number(opts?.dateStartTs || 0);
  const allRecords = dedupeProcessedRecords(map);
  const records = dateStartTs > 0
    ? allRecords.filter(r => Number(r.ts || 0) >= dateStartTs)
    : allRecords;
  const total = records.length;
  const today = (() => {
    const d = new Date();
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    // 今日仅基于"绝对日期"，永远是真今日，不被日期范围限制（除非范围窄于今日）
    return allRecords.filter(r => {
      const t = new Date(r.ts || 0);
      return t.getFullYear() === y && t.getMonth() === m && t.getDate() === day;
    }).length;
  })();
  let passed = 0, failed = 0, pending = 0, hardFiltered = 0, scoreSum = 0, scoreCnt = 0;
  for (const r of records) {
    const stage2 = r.stage2 || {};
    const reason = String(stage2.reason || '');
    if (r.pendingManualContact) pending++;
    if (stage2.decision === true) passed++;
    else if (stage2.decision === false) failed++;
    if (/年龄过滤|学历过滤|Gap过滤|硬过滤/.test(reason)) hardFiltered++;
    const sc = Number(stage2.score);
    if (Number.isFinite(sc)) { scoreSum += sc; scoreCnt++; }
  }
  const passRate = (passed + failed) > 0 ? Math.round((passed / (passed + failed)) * 100) : null;
  const avgScore = scoreCnt > 0 ? Math.round(scoreSum / scoreCnt) : null;
  return { records, total, today, passed, failed, pending, hardFiltered, passRate, avgScore };
}

async function refreshStatusBar() {
  try {
    const map = await getProcessedOutreachMap();
    // 顶部状态栏总是基于"全量"记录，不受历史页的日期筛选影响
    const sum = summarizeHistory(map);
    if (els.sbProcessed) els.sbProcessed.textContent = String(sum.total);
    if (els.sbPassed)    els.sbPassed.textContent    = String(sum.passed);
    if (els.sbManual) {
      const mq = Array.isArray(manualReviewQueue) ? manualReviewQueue.length : 0;
      els.sbManual.textContent = String(Math.max(mq, sum.pending));
    }
    if (els.sbMode) {
      // 模式：参考 settings 决定文案
      const isAi = (settings.outreachMode === 'ai') || (settings.outreachMode !== 'noai' && !!(settings.ai?.apiKey));
      const reply = settings.enableAutoReply ? '回复' : '';
      const out = settings.enableOutreach ? '寻访' : '';
      const tag = [out, reply].filter(Boolean).join('+') || '-';
      els.sbMode.textContent = `${tag}${isAi ? ' · AI' : ' · 关键词'}`;
    }
  } catch {}
}

async function renderHistoryView() {
  if (!els.historyList) return;
  const map = await getProcessedOutreachMap();
  // 1.1.x：统计 + 列表都遵循"日期范围"，让顶部数字和下方列表数量对得上
  const dateStartTs = getHistoryDateRangeStartTs();
  const dateLabel = getHistoryDateRangeLabel();
  const sum = summarizeHistory(map, { dateStartTs });

  // 顶部统计（标题旁加一个范围标签，提示用户"以下数字是该范围内的"）
  const totalLabelEl = document.querySelector('#historyStats .hsItem:first-child .hsLabel');
  if (totalLabelEl) totalLabelEl.textContent = `总记录（${dateLabel}）`;
  if (els.hsTotal)        els.hsTotal.textContent        = String(sum.total);
  if (els.hsToday)        els.hsToday.textContent        = String(sum.today);
  if (els.hsPassRate)     els.hsPassRate.textContent     = sum.passRate == null ? '-' : `${sum.passRate}%`;
  if (els.hsAvgScore)     els.hsAvgScore.textContent     = sum.avgScore == null ? '-' : String(sum.avgScore);
  if (els.hsPending)      els.hsPending.textContent      = String(sum.pending);
  if (els.hsHardFiltered) els.hsHardFiltered.textContent = String(sum.hardFiltered);

  // 列表（dateStartTs 已在上方声明，复用）
  const filterMode = String(els.historyFilter?.value || 'all');
  const q = String(els.historySearch?.value || '').trim().toLowerCase();

  const rows = sum.records
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .filter(r => recordMatchesHistoryFilters(r, { filterMode, q, dateStartTs }))
    .slice(0, 200); // 视图最多 200 条，避免长列表卡顿；CSV 仍是按筛选条件全量导出

  if (rows.length === 0) {
    els.historyList.innerHTML = '<div class="historyEmpty">没有匹配的记录</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    frag.appendChild(buildCandidateCardDiv(r));
  }
  els.historyList.innerHTML = '';
  els.historyList.appendChild(frag);
  // 1.1.x：统一通过 attachCandidateCardHandlers 挂载交互（与"本次运行卡片"复用）
  attachCandidateCardHandlers(els.historyList, renderHistoryView);
}

/**
 * 1.1.x：判断历史记录是否有"足够定位线索"，用来决定卡片是否可点击
 *   Boss 没有按候选人 id 直接打开简历的稳定 URL，所以策略是：
 *     popup → Boss 推荐牛人页 → content script 按 id/姓名 找卡片 → 滚到位 + 高亮
 *   只要有 encryptGeekId / geekId / 真实姓名 任一项，就算可定位。
 */
function canLocateCandidate(cand) {
  if (!cand || typeof cand !== 'object') return false;
  if (String(cand.encryptGeekId || '').trim()) return true;
  if (String(cand.geekId || '').trim()) return true;
  const t = String(cand.type || '');
  const id = String(cand.id || '').trim();
  if (id && (t === 'encryptGeekId' || t === 'domEncryptGeekId')) return true;
  if (id && (t === 'geekId' || t === 'domGeekId') && /^\d+$/.test(id)) return true;
  // 真实姓名（非脱敏）也能用来定位；这里宽松一点，有 name 就算
  if (String(cand.name || '').trim()) return true;
  return false;
}

/** 把可用线索整理成发给 content script 的目标 */
function buildLocateTarget(cand) {
  if (!cand || typeof cand !== 'object') return null;
  const t = String(cand.type || '');
  const id = String(cand.id || '').trim();
  const out = {
    encryptGeekId: String(cand.encryptGeekId || '').trim(),
    geekId:        String(cand.geekId || '').trim(),
    name:          String(cand.name || '').trim(),
  };
  if (!out.encryptGeekId && id && (t === 'encryptGeekId' || t === 'domEncryptGeekId')) out.encryptGeekId = id;
  if (!out.geekId && id && (t === 'geekId' || t === 'domGeekId') && /^\d+$/.test(id)) out.geekId = id;
  if (!out.encryptGeekId && !out.geekId && !out.name) return null;
  return out;
}

/**
 * 点候选人历史卡时调用：
 *   1) 复制候选人姓名到剪贴板（兜底，万一定位失败可手动搜）
 *   2) 找 Boss 标签页 → 必要时跳到 /web/chat/recommend
 *   3) 发 BOSS_ASSIST_LOCATE_CANDIDATE 消息让 content script 定位 + 高亮
 *      若不在推荐页，content script 会自己写 storage + 跳转，跳完后 init 时继续定位
 */
async function locateCandidateInBoss(target, name) {
  if (!target) return { ok: false, notFound: false };
  // 1) 先把姓名/id 复制到剪贴板，便于在 Boss 上手动搜
  try {
    if (name) await navigator.clipboard.writeText(name);
    else if (target.encryptGeekId) await navigator.clipboard.writeText(target.encryptGeekId);
  } catch {}

  try {
    const tab = await getTargetBossTab().catch(() => null);
    if (!tab?.id) {
      // 没有 Boss 标签页 → 新开一个推荐牛人页 + 把目标存到 storage 让脚本接力
      try {
        await chrome.storage.local.set({
          bossAssistLocateTarget: { ...target, ts: Date.now() },
        });
      } catch {}
      try { await chrome.tabs.create({ url: 'https://www.zhipin.com/web/chat/recommend?ka=menu-geek-recommend' }); } catch {}
      return { ok: true, notFound: false };
    }
    // 把 Boss 标签切到前台
    try {
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } catch {}
    await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: tab.id }).catch(() => {});
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'BOSS_ASSIST_LOCATE_CANDIDATE',
      ...target,
    }, { frameId: 0 }).catch(() => null);
    if (resp?.success) return { ok: true, notFound: false };
    appendLogLine({ ts: Date.now(), level: 'warn', message: `定位失败：${resp?.error || '页面未响应（可先把 Boss 切到推荐牛人页再试）'}` });
    return { ok: false, notFound: !!resp?.notFound, error: resp?.error || '' };
  } catch (e) {
    try { appendLogLine({ ts: Date.now(), level: 'warn', message: `定位候选人失败：${e?.message || e}` }); } catch {}
    return { ok: false, notFound: false, error: e?.message || String(e) };
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * 1.1.x：构造一张候选人卡片 DOM —— 历史页 + 主动寻访"本次运行"卡片区共用
 *   挂载点击行为（定位 / 复制 ID）由调用方负责（attachCandidateCardHandlers）
 */
function buildCandidateCardDiv(r) {
  const stage2 = r.stage2 || {};
  const div = document.createElement('div');
  div.className = 'histRow';
  const isReply = String(r?.source || '') === 'reply';
  const decision = stage2.decision;
  const cand = r.candidate || {};
  const name = String(cand.name || '').trim() || '(未知)';
  const fullId = String(cand.id || cand.geekId || cand.encryptGeekId || cand.display || '').trim();
  const shortId = fullId.length > 12 ? fullId.slice(0, 12) + '…' : fullId;
  const score = Number.isFinite(Number(stage2.score)) ? stage2.score : '-';
  const ts = new Date(r.ts || 0);
  const tsStr = `${pad2(ts.getMonth()+1)}-${pad2(ts.getDate())} ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}`;
  const locateFailed = failedLocateKeys.has(getRecordDedupKey(r));
  // 1.1.x：来源不同点击行为不同
  //   - 主动寻访（默认）：跳推荐牛人页定位卡片
  //   - 自动回复（source='reply'）：跳沟通页 + 定位该候选人会话
  const locatable = isReply ? !!String(cand.name || '').trim()
                            : (canLocateCandidate(cand) && !locateFailed);
  if (locatable) {
    div.classList.add('histRowClickable');
    div.title = isReply
      ? '点击切到 Boss 沟通页该候选人会话（草稿已填好，⌘ 回车发送）'
      : '点击在 Boss 推荐牛人页定位该候选人';
  } else if (locateFailed && !isReply) {
    div.classList.add('histRowFailed');
    div.title = '该候选人已不在 Boss 推荐流（重开侧边栏可重试）';
  }
  const jobLabel = String(r.jobName || '').trim();
  let conclusionLabel, conclusionClass, reasonLabel;
  if (isReply) {
    conclusionLabel = String(r.replyTag || '自动回复');
    conclusionClass = (r.sent ? 'pass' : (r.draftPrepared ? 'manual' : 'fail'));
    reasonLabel = '回复说明';
  } else if (r.pendingManualContact) {
    conclusionLabel = '待人工跟进'; conclusionClass = 'manual'; reasonLabel = '推荐理由';
  } else if (decision === true) {
    conclusionLabel = '推荐';       conclusionClass = 'pass';   reasonLabel = '推荐理由';
  } else if (decision === false) {
    conclusionLabel = '不匹配';     conclusionClass = 'fail';   reasonLabel = '淘汰理由';
  } else {
    conclusionLabel = '未判定';     conclusionClass = '';       reasonLabel = '说明';
  }
  const reasonHtml = renderReasonBullets(stage2.reason);
  const openHint = isReply
    ? (locatable ? `<div class="histOpenHint">在 Boss 沟通页打开 →</div>` : '')
    : (locatable ? `<div class="histOpenHint">在 Boss 中定位 →</div>`
                 : (locateFailed ? `<div class="histOpenHint failed">已不在 Boss 推荐流</div>` : ''));
  const sourceTag = isReply ? `<span class="histSourceTag reply">💬 自动回复</span>` : `<span class="histSourceTag outreach">🔍 主动寻访</span>`;
  div.innerHTML = `
    <div class="histRowHead">
      <span class="histName" title="${escapeHtml(name)}${fullId ? ' · ' + escapeHtml(fullId) : ''}">${escapeHtml(name)}</span>
      <span class="histConclusion ${conclusionClass}">${escapeHtml(conclusionLabel)}${(!isReply && Number.isFinite(Number(score))) ? ` · ${escapeHtml(String(score))}分` : ''}</span>
      <span class="histTs">${escapeHtml(tsStr)}</span>
    </div>
    ${reasonHtml ? `<div class="histReasonGroup">
      <div class="histReasonLabel ${conclusionClass}">${escapeHtml(reasonLabel)}：</div>
      ${reasonHtml}
    </div>` : ''}
    ${jobLabel ? `<div class="histJob" title="该候选人当时所属岗位">岗位：${escapeHtml(jobLabel)}${sourceTag}</div>` : `<div class="histJob">${sourceTag}</div>`}
    ${(!isReply && fullId) ? `<div class="histId" title="${escapeHtml(fullId)}（点击复制）" data-id="${escapeHtml(fullId)}">${escapeHtml(shortId)}</div>` : ''}
    ${openHint}
  `;
  if (locatable) {
    div._candidate = cand;
    div._record = r;
    div._isReply = isReply;
  }
  return div;
}

/** 1.1.x：给一组卡片 DOM 挂上点击交互（定位 / 复制 ID） */
function attachCandidateCardHandlers(rootEl, onRerender) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.histRowClickable').forEach((row) => {
    if (row._handlerBound) return; row._handlerBound = true;
    row.addEventListener('click', async (ev) => {
      const t = ev.target;
      if (t && (t.classList?.contains('histId') || t.closest?.('.histId'))) return;
      const cand = row._candidate; if (!cand) return;
      const name = String(cand.name || '').trim();

      // 1.1.x：自动回复来源的卡片 → 切到 Boss 沟通页 + 复制姓名（用户在沟通页可粘贴搜索）
      if (row._isReply) {
        try { if (name) await navigator.clipboard.writeText(name); } catch {}
        try { appendLogLine({ ts: Date.now(), level: 'info', message: `[定位] 切到 Boss 沟通页定位「${name || '未知候选人'}」（已复制姓名）` }); } catch {}
        try {
          await navigateBossToChatBestEffort();
        } catch (e) {
          appendLogLine({ ts: Date.now(), level: 'warn', message: `打开 Boss 沟通页失败：${e?.message || e}` });
        }
        return;
      }

      // 主动寻访来源 → 跳推荐牛人页定位
      const target = buildLocateTarget(cand); if (!target) return;
      target.jobKey  = String(row._record?.jobKey  || '').trim();
      target.jobName = String(row._record?.jobName || '').trim();
      const jobHint = target.jobName ? `（岗位：${target.jobName}）` : '';
      try { appendLogLine({ ts: Date.now(), level: 'info', message: `[定位] 准备在 Boss 推荐页定位「${name || target.encryptGeekId || target.geekId}」${jobHint}（已复制姓名到剪贴板）` }); } catch {}
      const result = await locateCandidateInBoss(target, name);
      try { appendLogLine({ ts: Date.now(), level: result.ok ? 'success' : 'warn', message: `[定位] ${result.ok ? '已下发定位指令，到 Boss 标签页查看金色高亮' : (result.notFound ? '该候选人已不在 Boss 推荐流，已把卡片置灰' : '定位失败')}` }); } catch {}
      if (!result.ok && result.notFound && row._record) {
        failedLocateKeys.add(getRecordDedupKey(row._record));
        if (typeof onRerender === 'function') await onRerender();
      }
    });
  });
  rootEl.querySelectorAll('.histId').forEach((el) => {
    if (el._handlerBound) return; el._handlerBound = true;
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const v = el.dataset.id || ''; if (!v) return;
      try {
        await navigator.clipboard.writeText(v);
        const orig = el.textContent;
        el.textContent = '✓ 已复制';
        setTimeout(() => { el.textContent = orig; }, 900);
      } catch {}
    });
  });
}

/**
 * 1.1.x：从 processedOutreach storage 全量拉一次，渲染"本次会话"内的所有新评分卡片
 *   - 仅显示 ts >= max(RUN_SESSION_START_TS, runResultsClearAt) 的记录
 *   - 卡片直接挂到 logBox 当 .logLine 的 sibling，按 ts 时间正序穿插
 *   - 通过 data-cardkey 跟踪避免重复；先清掉已有的所有卡片再重新挂（避免重复 + 顺序错乱）
 */
async function refreshRunResultsCards() {
  if (!els.logBox) return;
  try {
    const r = await chrome.storage.local.get([STORAGE_KEYS.processedOutreach, STORAGE_KEYS.replyRunResults]);
    const map = r?.[STORAGE_KEYS.processedOutreach] || {};
    const replyArr = Array.isArray(r?.[STORAGE_KEYS.replyRunResults]) ? r[STORAGE_KEYS.replyRunResults] : [];
    const cutoff = Math.max(RUN_SESSION_START_TS, runResultsClearAt);
    // 1.1.x：合并两个来源 —— 主动寻访（processedOutreach）+ 自动回复（replyRunResults）
    const records = [
      ...dedupeProcessedRecords(map),
      ...replyArr,
    ]
      .filter(rec => Number(rec.ts || 0) >= cutoff)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    // 清掉旧的卡片节点（保留系统消息 .logLine 不动）
    els.logBox.querySelectorAll('.histRow[data-cardkey]').forEach(n => n.remove());
    // 按时间顺序逐条插入到 logBox 里"对应时间点的位置"
    //   策略：找第一个 ts > rec.ts 的 .logLine（或卡片），插到它前面；
    //   若没有更晚的，就 append 到末尾
    for (const rec of records) {
      const div = buildCandidateCardDiv(rec);
      div.setAttribute('data-cardkey', getRecordDedupKey(rec));
      div.setAttribute('data-ts', String(rec.ts || 0));
      const insertBefore = findFirstLogEntryAfterTs(rec.ts);
      if (insertBefore) {
        els.logBox.insertBefore(div, insertBefore);
      } else {
        els.logBox.appendChild(div);
      }
      runResultsShownKeys.add(getRecordDedupKey(rec));
    }
    attachCandidateCardHandlers(els.logBox, refreshRunResultsCards);
    if (els.runResultsCount) els.runResultsCount.textContent = String(records.length);
    // 自动滚到底（如果勾了自动滚动）
    if (els.logAutoScroll?.checked !== false) {
      els.logBox.scrollTop = els.logBox.scrollHeight;
    }
  } catch {}
}

// 1.1.x：在 logBox 里找第一个 ts 严格大于给定值的子节点（系统消息或卡片）
function findFirstLogEntryAfterTs(ts) {
  if (!els.logBox) return null;
  const target = Number(ts || 0);
  for (const child of els.logBox.children) {
    // 系统消息没有 data-ts，但我们可以从 .ts span 的文本反推 —— 略复杂，简化为：
    //   .logLine 不带 data-ts → 假定它们是按时间顺序追加的；只比较卡片之间和卡片 vs .logLine 的相对位置
    const childTs = Number(child.getAttribute('data-ts') || 0);
    if (childTs > target) return child;
  }
  return null;
}

/**
 * 1.1.x：把 AI/关键词返回的 reason 字符串切成多条要点
 * AI 常见格式：
 *   "1) 命中 X；2) 命中 Y；3) 命中 Z"
 *   "1. xxx 2. xxx"
 *   "①xxx ②xxx"
 *   "命中：a、b、c；缺口：d"
 *   或一整段长文本 → 按 "；;。\n" 切
 * 切完后过滤掉空串，trim，最多保留 5 条。
 */
function splitReasonToBullets(reasonStr) {
  const s = String(reasonStr || '').trim();
  if (!s) return [];
  // 1) 编号开头：1. / 1) / 1、 / ① / 一、 等
  const numRe = /(?:^|[^0-9])(?:\d+[\.\)、:：]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十][、\.])/g;
  if (numRe.test(s)) {
    const parts = s
      .split(/(?:\d+[\.\)、:：]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十][、\.])/)
      .map(x => x.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 5);
  }
  // 2) 中英文分号 / 句号 / 换行：作为多条要点
  const parts = s.split(/[；;。\n]+/).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 5);
  // 3) 整段：当一条
  return [s];
}

/** 渲染一条 reason → HTML（带编号） */
function renderReasonBullets(reasonStr) {
  const bullets = splitReasonToBullets(reasonStr);
  if (bullets.length === 0) return '';
  if (bullets.length === 1) return `<div class="histReasonLine">${escapeHtml(bullets[0])}</div>`;
  const items = bullets.map((b, i) => `<div class="histReasonLine"><span class="histReasonNum">${i + 1}.</span> ${escapeHtml(b)}</div>`).join('');
  return items;
}

/**
 * 1.1.x：渲染列表与导出 CSV 共用的过滤逻辑
 *  - filterMode：状态（all / passed / failed / manual）
 *  - q：姓名/原因模糊匹配（小写）
 *  - dateStartTs：日期范围下界（含），0 表示不限
 */
function recordMatchesHistoryFilters(r, { filterMode, q, dateStartTs }) {
  const stage2 = r.stage2 || {};
  const decision = stage2.decision;
  if (filterMode === 'passed' && decision !== true) return false;
  if (filterMode === 'failed' && decision !== false) return false;
  if (filterMode === 'manual' && !r.pendingManualContact) return false;
  if (dateStartTs > 0) {
    const ts = Number(r.ts || 0);
    if (!ts || ts < dateStartTs) return false;
  }
  if (q) {
    const name = String(r.candidate?.name || r.candidate?.display || '').toLowerCase();
    const reason = String(stage2.reason || '').toLowerCase();
    if (!name.includes(q) && !reason.includes(q)) return false;
  }
  return true;
}

async function exportHistoryCSV() {
  try {
    const map = await getProcessedOutreachMap();
    // 1.1.x：CSV 导出也按"候选人 + 岗位 + 时间戳"去重，避免 cross-link 写出重复行
    const allRecords = dedupeProcessedRecords(map);
    if (allRecords.length === 0) {
      alert('暂无评分历史可导出');
      return;
    }
    // 1.1.x：复用列表的「日期范围 + 状态 + 关键词」筛选条件，避免 CSV 一次性吐几千条
    const filterMode = String(els.historyFilter?.value || 'all');
    const q = String(els.historySearch?.value || '').trim().toLowerCase();
    const dateStartTs = getHistoryDateRangeStartTs();
    const dateLabel = getHistoryDateRangeLabel();
    const records = allRecords
      .filter(r => recordMatchesHistoryFilters(r, { filterMode, q, dateStartTs }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (records.length === 0) {
      alert(`当前筛选条件（${dateLabel}）下没有可导出的记录`);
      return;
    }
    // 列加上「岗位」一栏，方便跨岗位区分
    const headers = ['时间', '岗位', '姓名', '候选人ID', 'stage1分', 'stage1原因', 'stage2分', 'stage2原因', '决策', '待人工', '草稿'];
    const csvRows = [headers.join(',')];
    for (const r of records) {
      const ts = new Date(r.ts || 0);
      const tsStr = `${ts.getFullYear()}-${pad2(ts.getMonth()+1)}-${pad2(ts.getDate())} ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}:${pad2(ts.getSeconds())}`;
      const stage1 = r.stage1 || {};
      const stage2 = r.stage2 || {};
      const decision = stage2.decision === true ? '通过' : (stage2.decision === false ? '不通过' : '');
      const cand = r.candidate || {};
      const candId = cand.id || cand.geekId || cand.encryptGeekId || cand.display || '';
      const jobLabel = String(r.jobName || r.jobKey || '').trim();
      const row = [
        tsStr,
        jobLabel,
        cand.name || '',
        candId,
        stage1.score ?? '',
        stage1.reason || '',
        stage2.score ?? '',
        stage2.reason || '',
        decision,
        r.pendingManualContact ? '是' : '',
        r.draftText || '',
      ].map(csvEscape);
      csvRows.push(row.join(','));
    }
    const csv = '﻿' + csvRows.join('\r\n'); // BOM 让 Excel 正确识别 UTF-8
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const today = new Date();
    // 文件名带上日期范围，方便区分多次导出
    const rangeTag = String(els.historyDateRange?.value || '30d');
    a.download = `claude-boss-history-${rangeTag}-${today.getFullYear()}${pad2(today.getMonth()+1)}${pad2(today.getDate())}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); document.body.removeChild(a); } catch {} }, 1000);
  } catch (e) {
    alert('导出失败：' + (e?.message || e));
  }
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/* ===== 1.1.2 风险模式徽章 + humanizer hint ===== */
// 1.1.x：本机点击器面板里的「运行模式」三档（顶层声明，方便 renderRiskModeBadge 调用）
function getCurrentRunMode() {
  const isAuto = String(settings.riskMode || 'low') === 'auto';
  if (!isAuto) return 'low';
  const ec = settings.externalClicker || {};
  return ec.perClickConfirm === false ? 'auto' : 'semiauto';
}
function applyRunModeUiState() {
  const mode = getCurrentRunMode();
  const btns = [els.runModeLow, els.runModeSemi, els.runModeAuto];
  const vals = ['low', 'semiauto', 'auto'];
  btns.forEach((b, i) => b && b.classList.toggle('active', vals[i] === mode));
  if (els.runModeTip) {
    const tips = {
      low:      '当前：🛡 低风险（仅生成草稿；本机点击器不被调用）',
      semiauto: '当前：⚡ 半自动（自动点击，但每次点击前本机弹确认；ESC 可终止）',
      auto:     '当前：⚠️ 全自动（自动点击 + 不弹确认；封号风险最高）',
    };
    els.runModeTip.textContent = tips[mode] || '';
  }
  if (els.clickerLowRiskWarn) {
    const enabled = !!els.externalClickerEnabled?.checked;
    els.clickerLowRiskWarn.style.display = (enabled && mode === 'low') ? '' : 'none';
  }
  // 1.1.x：自动回复页"当前运行模式"徽章同步
  if (els.replyRunModeBadge) {
    const labels = { low: '🛡 低风险', semiauto: '⚡ 半自动', auto: '⚠️ 全自动' };
    els.replyRunModeBadge.textContent = labels[mode] || '🛡 低风险';
    els.replyRunModeBadge.classList.remove('semiauto', 'auto');
    if (mode === 'semiauto') els.replyRunModeBadge.classList.add('semiauto');
    if (mode === 'auto')     els.replyRunModeBadge.classList.add('auto');
  }
  // 1.1.x：自动回复「点'不合适'按钮」开关只在半自动/全自动模式下生效
  // 低风险模式禁用控件（仍允许显示之前的勾选状态，仅 UI 标灰），并提示用户
  if (els.autoReplyClickNotFit) {
    const isLow = (mode === 'low');
    els.autoReplyClickNotFit.disabled = isLow;
    if (els.autoReplyClickNotFitLabel) {
      els.autoReplyClickNotFitLabel.style.opacity = isLow ? '0.5' : '';
      els.autoReplyClickNotFitLabel.style.cursor = isLow ? 'not-allowed' : '';
      els.autoReplyClickNotFitLabel.title = isLow ? '低风险模式下不会执行点击；切换到半自动 / 全自动后生效' : '';
    }
    if (els.autoReplyClickNotFitHint) {
      els.autoReplyClickNotFitHint.style.display = isLow ? '' : 'none';
    }
  }
}

function renderRiskModeBadge() {
  if (!els.sbRiskMode) return;
  const isAuto = String(settings.riskMode || 'low') === 'auto';
  els.sbRiskMode.textContent = isAuto ? '⚠ 自动打招呼' : '🛡 低风险';
  els.sbRiskMode.className = 'sbRiskMode ' + (isAuto ? 'auto' : 'low');
  if (els.humanizerHint) {
    const h = settings.humanizer || {};
    const intensityLabel = { weak: '弱', med: '中', strong: '强' }[h.intensity] || '强';
    els.humanizerHint.textContent = isAuto ? `生效中（${intensityLabel}）` : '仅自动模式生效';
  }
  // 1.1.x：状态栏切换 risk 时同步面板里的三档高亮
  try { applyRunModeUiState(); } catch {}
}

/* ===== 1.1.3 本机点击器 hint ===== */
function refreshClickerHint() {
  if (!els.externalClickerHint) return;
  const enabled = !!els.externalClickerEnabled?.checked;
  if (!enabled) {
    els.externalClickerHint.textContent = '未启用';
    els.externalClickerHint.style.color = '';
    return;
  }
  const ep = String(els.externalClickerEndpoint?.value || '').trim();
  els.externalClickerHint.textContent = `已启用 → ${ep || '127.0.0.1:12345'}`;
  els.externalClickerHint.style.color = '#fbbf24';
}
