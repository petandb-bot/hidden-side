# HIDDEN SIDE v0.2 — WebGL Optimized

写真・動画の内部にある輪郭、侵食、反転、凹凸、時間的残滓を露出するp5.jsアプリです。

## v0.2 の変更点

- **GPU描画**: p5.js 1.11.13 を使用した WebGL1 / GLSL ES 1.00。フィルター処理はすべてフラグメントシェーダー上で実行します。
- **再利用できるソーステクスチャ**: 最初のロード・品質変更時のみ `gl.texImage2D`。通常の動画フレーム更新は `gl.texSubImage2D` で再割り当てなし。
- **プレビューと保存の解像度分離**: BALANCED ではプレビュー長辺720px、録画960px、写真PNG保存最大2048px。プレビュー変更は写真の保存解像度に影響しません。
- **動作負荷の選択**: ECO（長辺520px/録画720px/24fps）、BALANCED（720px/960px/24fps）、FINE（960px/1280px/30fps）。実際の処理速度が指定fpsに達する保証はありません。
- **GHOST のGPU履歴**: 小さな512px以下のGPUテクスチャを2枚使うピンポンFBO。過去フレームを蓄積し、時間的にずれて侵食する表現を生成します。このモードのみ2ドローパスです。
- **メモリ配慮**: 高DPIでGPU描画バッファが膨らむのを避ける `pixelDensity(1)`、深度/ステンシル/アンチエイリアス無効、圧縮なし8bit RGBA。

## 使用方法

1. フォルダ内のすべてをGitHub PagesなどのHTTPS対応静的ホストに置きます。`file://`直開きよりHTTP(S)推奨。
2. Safariから写真/動画を読み込み、5モード：**UNDER / NEGATIVE / RELIEF / SEEP / GHOST** を選択します。
3. DEPTH / EROSION / DRIFT の3パラメータ、RESEED、GPU LOADを調整できます。指で触れた場所に局所的な露出が発生します。
4. **SAVE IMAGE** はPNG保存（上限長辺2048px）。**RECORD** は動画の先頭から最大45秒をリアルタイムで録画し、MP4優先・WebM代替で共有/保存します。
5. Safari「ホーム画面に追加」でWebアプリ風に利用できます。

## 特に重要な制限

- 動画の保存はWebGLの映像をMediaRecorderでリアルタイム録画する方式です。**音声は引き継ぎません**。
- iOS / Safari の WebGL / `MediaRecorder` / `canvas.captureStream` / 動画コーデックの実装・バージョンによって動作が変わります。Safariで保存できるMP4形式は端末に依存します。
- HEICやMOVは端末が該当形式を読み込めるときだけ使用可能。
- GHOSTは過去の加工済み映像を使う低解像度の実フレーム・フィードバックです。加工元の複数フレームをランダムアクセスする編集機能ではありません。
- iPhone実機での負荷・発熱・書き出し成功率は未検証。初期設定のBALANCEDで十分重い場合はECOを選んでください。
- データはローカル処理で外部にアップロードしません。ただし最初の起動時にはCDNからp5.jsを読み込みます。

## GitHub Pages

公開リポジトリのルートにこのディレクトリ内の9ファイルをアップロード→ Settings → Pages → Deploy from a branch → main /(root)。HTTPS URLでSafariから開くと、ホーム画面追加とService Workerのキャッシュを利用できます。

## ファイル

`index.html` UI / `app.js` GPUエンジン・保存・操作 / `style.css` / `manifest.webmanifest` / `sw.js` / `icon.svg` / `icon-192.png` / `icon-512.png`
