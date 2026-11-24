# Trade Replay

過去の相場をリアルタイムのように再生して、売買を練習できるデモトレードです。実際のお金は動きません。

- **ブラウザ版**: https://kuroron000234.github.io/trade-replay/
- **Windows 版**（AI トレーナー付き）: [Releases](https://github.com/kuroron000234/trade-replay/releases/latest) から `TradeReplay-…-windows-x64.zip` をダウンロード

## できること

- **リプレイ**: 好きな日時から相場を再生します。1 分足を始値→安値→高値→終値（または始値→高値→安値→終値）の順になぞるので、上位足のローソクが形になっていく様子も見えます。週末などの空白は飛ばします。
- **銘柄**: 暗号資産（BTC・ETH・SOL・XRP の USDT 建て。Binance の公開データを読み込みます）と FX 5 ペア（USD/JPY・EUR/USD・GBP/USD・EUR/JPY・GBP/JPY、データは同梱）
- **売買**: 成行・指値・逆指値、レバレッジ、損切り・利確。損切りと利確はチャート上のラインをドラッグして決められます。数量は「資金の 10〜100%」のボタンでも指定できます。
- **描画ツール**: トレンドライン、水平線、水平レイ、垂直線、長方形、フィボナッチ、ロング/ショートポジション
- **インジケーターとストラテジー**: プリセットのほか、JavaScript で自作もできます。ストラテジーテスターで一括バックテストできるほか、リプレイ中に自動売買させて、手動の成績と並べて比べられます。
- **トレード記録**: すべての取引・操作、建玉時と決済時の相場状況をブラウザ内（IndexedDB）に保存します。メモ・タグ・集計ができ、CSV / JSON / AI 用テキストで書き出せます。
- **AI トレーナー**（Windows 版）: Claude と話しながら、機械的に判定できる売買ルールを決めます。決まったルールはそのままコードになり、「▶ チャートで回す」でバックテストや自動売買に使えます。バックテスト結果を渡すと改善案と直したコードが返ってきます。トレード記録を読ませて振り返りを相談することもできます。

## Windows 版

1. zip を展開して `TradeReplay.exe` を実行すると、ブラウザで開きます（インストール不要）。
   「Windows によって PC が保護されました」と出たら「詳細情報」→「実行」を押してください（署名していないため表示されます）。
2. AI トレーナーを初めて使うときは、画面の案内に従います。
   - **インストール**: Anthropic 公式の [Claude Code](https://code.claude.com/docs/en/setup) を、公式のインストーラーで自動的に入れます（管理者権限は不要）。
   - **ログイン**: 窓が開き、ブラウザで Claude へのログインを求められます。Claude の Pro / Max などの有料プラン、または Anthropic Console のアカウントが必要です。

AI トレーナーは `claude -p` をツールなしで呼び出し、会話とコードの出力だけを行います。ファイルの操作やコマンドの実行はしません。

## 開発

ビルドは不要です（素の ES モジュール）。

```sh
python3 tools/serve.py 8080      # 開発サーバー（キャッシュ無効。claude があれば AI トレーナーも使える）
desktop/build.sh 0.1.0           # Windows 版をビルド（Go が必要）→ dist/
python3 tools/fetch.py ...       # FX データの取得（tools/run.sh を参照）
```

- `js/`: アプリ本体（チャート・リプレイ・口座・描画・ストラテジー・記録・AI トレーナー）
- `desktop/`: Windows 版（Go）。サイトを exe に同梱して配信し、`claude -p` を中継し、セットアップを案内します
- `tools/prompts.json`: AI トレーナーのシステムプロンプト（開発サーバーと Windows 版で共有）
- GitHub Pages は main ブランチのルートをそのまま配信します
- `v` で始まるタグを push すると、GitHub Actions が Windows 版をビルドしてリリースに載せます

## データとライセンス

- コードは MIT ライセンスです（[LICENSE](LICENSE)）。
- チャートには [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts)（Apache License 2.0）を使っています。
- 暗号資産の価格は Binance の公開データ（data-api.binance.vision）から取得します。FX の価格は Dukascopy の過去データを変換したものです。データの正確さは保証しません。
- 本ソフトは練習用です。投資助言ではありません。
