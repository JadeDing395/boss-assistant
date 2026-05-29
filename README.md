# 招聘 Assistant-Boss

> Boss 直聘半自动招聘助手 · Chrome 扩展 + macOS 后台点击器

基于「AI 评分 + 关键词过滤 + 硬性条件（年龄/学历/Gap）」对 Boss 直聘推荐流候选人做**低风险半自动筛选**：默认只生成草稿、不会自动发消息，关键动作仍由人工确认。

---

## ⬇️ 立即下载使用

### 📦 [👉 点这里下载最新发布包 v1.1.1（macOS）](boss-assistant-v1.1.1-macOS.zip)

> 下载后按下面步骤即可，**3 分钟搞定**。
>
> 📖 完整使用手册 → **[USAGE.md](USAGE.md)**（推荐先大致扫一遍）

### 🚀 macOS 用户（含后台点击器）—— 三步走

1. 下载并解压 `boss-assistant-v1.1.1-macOS.zip`
2. **双击 `install.command`**，跟随终端中文提示一步步走
3. 完成后双击 `USAGE.html` 看图文使用指南

### 🌐 Windows / Linux（只用 Chrome 扩展）

1. 下载并解压 zip
2. 打开 `chrome://extensions/`，右上角打开「**开发者模式**」
3. 点 「**加载已解压的扩展程序**」→ 选 `boss-assistant/` 文件夹
4. Boss 直聘网页 → 点 Chrome 右上角扩展图标 → 配置 AI Key + 关键词 → 开始

### ⚙️ 准备一个 AI API Key

任选一家 OpenAI 兼容的：
- 🇨🇳 [DeepSeek](https://platform.deepseek.com/)（推荐，便宜稳定）
- 🇨🇳 [硅基流动 SiliconFlow](https://siliconflow.cn/)
- 🇨🇳 [智谱 BigModel](https://bigmodel.cn/)
- 🇺🇸 [OpenAI 官方](https://platform.openai.com/)

---

## 功能亮点 (v1.1.2)

- **AI 评分**：调 OpenAI 兼容接口，根据 JD + 候选人简历自动判断匹配度（0-100 分），生成推荐理由 / 淘汰理由
- **多维筛选条件**：必含 / 任意 / 排除关键词 + 加分项 + 年龄区间 + 学历/院校 + 最近 Gap 上限
- **跨岗位独立**：每个岗位独立保存关键词与硬过滤，切岗位时自动切换；同一候选人在不同岗位会被重新评分
- **历史去重 + 节省 Token**：已评过的候选人在下次出现时自动跳过，不重复调用 AI（按岗位作用域）
- **历史卡片 + 在 Boss 中定位**：评分历史以卡片形式展示，点击后自动跳到推荐牛人页并高亮该候选人
- **本地保留 30 天 + 多维度 CSV 导出**：超期记录自动清理；CSV 可按日期范围 / 状态 / 关键词组合导出
- **macOS 后台点击器**（可选）：通过本机 OS 级真鼠标点击，绕开 Boss 的 `isTrusted` 检测
- 🆕 **v1.1.2 自动回复全流程**：未读会话逐个 AI 评估 → 自动点「继续沟通」打开输入框 → 填回复草稿 → ⚡半自动留人工核对发，⚠️全自动一键发完切下一位
- 🆕 **v1.1.2 待人工汇总卡片可点击跳转**：在「自动回复」页直接点候选人卡 → 复制姓名 + 切 Boss 沟通页，⌘V 一秒定位
- 🆕 **v1.1.2 三页视觉统一升级**：主动寻访 / 自动回复 / 历史 三个 tab 一套设计语言，玻璃质感卡片 + 科技感配色 + 自定义滚动条 + 折叠区

---

## 系统要求

- macOS 10.15 (Catalina) 或更新（**Mac 后台点击器**仅 macOS 可用；Chrome 扩展本身跨平台）
- Chrome / Edge / Brave 等基于 Chromium 的浏览器
- Python 3.10+（仅当启用后台点击器时需要；`install.command` 会引导你装）
- OpenAI 兼容的 API Key（任选：硅基流动、DeepSeek、智谱、OpenAI 官方等）

---

> Windows / Linux 用户无法用 OS 级真鼠标点击器，会用浏览器内合成事件方式工作，触发 Boss 风控的概率略高。

---

## 配置示例

第一次打开会要求你填：

- **AI 配置**：BaseURL + API Key + Model（推荐硅基流动 + DeepSeek-V3，便宜稳）
- **岗位**：从 Boss 「职位管理」自动读取，下拉选择即可
- **通过阈值**：建议 70-80 起步
- **关键词**：参考 `boss-assistant/local_job_keyword_presets.json` 里的示例结构

---

## 风险与免责声明

⚠️ **此工具违反 Boss 直聘服务条款，使用账号有被风控 / 封禁的风险。请自行承担风险。**

建议：
- 用工作账号慎用，新号尤其慎用
- 第一次跑量级压到 ≤5，观察是否触发风控
- 任何"操作过于频繁"提示出现立即停
- 不要 24 小时不间断运行
- 不要在公开渠道传播你的使用截图 / 经验

**本项目不收集任何用户数据**：所有评分历史、API Key 都仅存在你本机的 `chrome.storage.local`，不会上传到任何服务器。

---

## 项目结构

```
boss-assistant-v1.1.1/
├── README.md             # 本文件
├── LICENSE               # Apache 2.0
├── CHANGELOG.md          # 版本变更记录
├── USAGE.html            # 图文使用指南（推荐先看）
├── install.command       # macOS 一键安装（双击运行）
├── boss-assistant/       # Chrome 扩展源码
│   ├── manifest.json
│   ├── background.js
│   ├── popup/            # 侧边栏 UI
│   ├── content/          # 注入 Boss 页面的脚本
│   ├── icons/
│   └── local_job_keyword_presets.json   # 岗位预设（含示例）
└── claude-boss-clicker/  # macOS 后台点击器（Python + LaunchAgent）
    ├── clicker_server.py
    ├── requirements.txt
    ├── install_autostart.command   # 配置开机自启
    └── uninstall_autostart.command # 卸载
```

---

## 卸载

1. 双击 `claude-boss-clicker/uninstall_autostart.command`（移除后台服务，如装过）
2. `chrome://extensions/` 移除「招聘 Assistant-Boss」
3. 数据完全清除（无残留）

---

## 贡献与反馈

提 Issue 描述：浏览器版本 / 复现步骤 / 截图（隐去敏感信息）。

代码风格：保持现有模块化结构，新加功能优先放在「进阶运行设置」或「筛选条件」折叠区。

---

## License

**Apache License 2.0** — 详见 [LICENSE](./LICENSE)

简单说：你可以自由使用、修改、商用，但需要：
- 保留原版权声明
- 在修改过的文件里标注「我改了什么」
- 不能用本项目作者的名字 / 商标做二次推广

另外本项目自带额外免责声明：自动化操作 Boss 直聘可能违反其服务条款，使用风险自担，作者不为账号封禁等后果负责。
