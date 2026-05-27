# Agentic Git Sync

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

為不懂 git 的 Obsidian 使用者打造的 GitHub 雙向同步外掛。核心是三件事。

![Obsidian 中的 Agentic Git Sync 面板](./docs/screenshots/dashboard.png)

## 核心特性

### AI Agent 處理 Git 技術細節

把繁瑣的 Git 操作全權交給 AI。

![AI 輔助的三欄衝突解決介面，附 AI 推理](./docs/screenshots/conflict-resolver.png)

- **AI 衝突解決** — 本地與遠端分叉時自動嘗試合併，僅在無法判定時彈出視覺化對話框。打開後是 Local / Remote / AI Suggestion 三欄視圖，附 AI 信心度評級與模型選擇該側的推理依據。
- **Git 操作診斷** — 不是 fast forward？需要 git merge before push？這些 git 使用規範你都不需要了解，Agentic 一手包辦。
- **AI 起草 commit message** — DeepSeek 或 Gemini 讀 diff 後生成語意化的提交訊息，可在提交前編輯。
- **空 repo 自動初始化** — 貼上 URL 即可，外掛靜默處理首次 commit 與 push。

### 適配個人資料同步 / 團隊協作的場景

既保護個人隱私，又能高效適配團隊協作，互不干擾。

![Team 模式下新增 submodule](./docs/screenshots/add-submodule.png)

- 個人的知識永遠保持私有。
- 與團隊共享的知識透過 submodule 維護。
- 使用者友善的衝突管理介面。
- 簡單易懂的個人分支與團隊主分支管理機制。

### 無感雙向同步

背景排程器週期性 pull 與 push，使用者照常寫筆記。Token 與本機狀態留在 `.obsidian/`（不入 repo），遠端設定與 submodule 清單寫在 `.github-sync.json` 中隨倉庫走，換機器 clone 後設定自動還原。

## 安裝

**社群外掛**：設定 → 第三方外掛 → 瀏覽 → 搜尋 *Agentic Git Sync* → 安裝 → 啟用。

**手動安裝**：從 [最新 release](https://github.com/leweii/agentic-git-sync/releases/latest) 下載 `main.js`、`manifest.json`、`styles.css`，放到 `<vault>/.obsidian/plugins/agentic-git-sync/`，重啟 Obsidian 並啟用。

## 快速開始

設定 → Agentic Git Sync → **執行設定精靈**：

1. 貼上 GitHub Personal Access Token（點選 `?` 圖示會開啟 GitHub Token 建立頁）。Classic 需要 `repo` 權限；Fine-grained 需要 **Contents: read & write**。
2. 貼上主倉庫的 HTTPS URL，外掛會自動處理首次 commit 與 push。
3. （選用）在面板中以資料夾為單位新增 submodule。

## 資料安全

**金鑰永遠不離開裝置。** Token 存於 `<vault>/.obsidian/plugins/agentic-git-sync/data.json`，僅本機持有。提交到倉庫的 `.github-sync.json` 在 schema 上就沒有 token 欄位，憑證無法被寫入 commit。

## Git 歷史

不離開 Obsidian 即可瀏覽任意檔案的提交歷史。點擊某次提交（或 shift-點擊選範圍）查看內嵌 diff；commit message 就是同步時由 AI 生成的語意化訊息。

![檔案歷史對話框，含提交清單與內嵌 diff](./docs/screenshots/file-history.png)

## 授權

[MIT](./LICENSE)
