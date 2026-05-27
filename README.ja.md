# Agentic Git Sync

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

git を知らない Obsidian ユーザーのための GitHub 双方向同期プラグイン。コアは 3 つ。

![Obsidian 上の Agentic Git Sync パネル](./docs/screenshots/dashboard.png)

## コア機能

### AI エージェントが Git の細部を処理

煩雑な Git 操作はすべて AI に任せる。

![セマンティックなコミットメッセージと diff のファイル履歴](./docs/screenshots/file-history.png)

- **AI コンフリクト解決** — ローカルとリモートが分岐した際に自動マージを試み、判断できない場合のみビジュアル解決ダイアログを表示。
- **Git エラー診断** — fast-forward じゃない？push の前に merge が必要？こうした git の作法は知らなくて OK、エージェントがすべて処理する。
- **AI による commit メッセージ生成** — DeepSeek または Gemini が diff を読み、編集可能なセマンティックなコミットメッセージを生成。
- **空リポジトリの自動初期化** — URL を貼るだけで、プラグインが初回 commit と push を静かに処理。

### 個人同期とチーム協業の両方に対応

プライバシーを守りつつ、チーム協業も効率的に。互いに独立し、干渉しない。

![Team モードで submodule を追加するダイアログ](./docs/screenshots/add-submodule.png)

- 個人の知識はずっとプライベートのまま。
- チームと共有する知識は submodule で管理。
- 使いやすいコンフリクト管理 UI。
- シンプルな「個人ブランチ／チーム main ブランチ」モデル。

### シームレスな双方向同期

バックグラウンドスケジューラが定期的に pull / push し、ユーザーは普段通りノートを書くだけ。トークンとマシンローカルな状態は `.obsidian/` に置かれ（コミットされない）、リモート設定と submodule 一覧は `.github-sync.json` に書かれてリポジトリと一緒に移動するため、別マシンでクローンすれば設定が自動的に復元される。

## インストール

**コミュニティプラグイン**：設定 → コミュニティプラグイン → 閲覧 → *Agentic Git Sync* を検索 → インストール → 有効化。

**手動インストール**：[最新リリース](https://github.com/leweii/agentic-git-sync/releases/latest) から `main.js`、`manifest.json`、`styles.css` をダウンロードし、`<vault>/.obsidian/plugins/agentic-git-sync/` に配置、Obsidian を再起動して有効化。

## はじめに

設定 → Agentic Git Sync → **セットアップウィザードを実行**：

1. GitHub Personal Access Token を貼り付ける（`?` アイコンで GitHub のトークン作成ページが開く）。Classic は `repo` スコープ、Fine-grained は **Contents: read & write** が必要。
2. メイン vault のリポジトリの HTTPS URL を貼り付ける。プラグインが初回 commit と push を処理する。
3. （任意）ダッシュボードからフォルダー単位で submodule を追加。

## データセキュリティ

**シークレットはデバイスから出ない。** トークンは `<vault>/.obsidian/plugins/agentic-git-sync/data.json` に保存され、ローカルのみ。コミットされる `.github-sync.json` はスキーマ上トークンフィールドを持たないため、認証情報がコミットに漏れる経路は存在しない。

## ライセンス

[MIT](./LICENSE)
