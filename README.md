# PDF TransNote

PDF の英文を選んで，翻訳の前に原文を直し，ローカル LLM（LM Studio など）で和訳して，ハイライトのコメントとして PDF に保存するビューアです．表示には Mozilla の [PDF.js](https://mozilla.github.io/pdf.js/) 6.5.438 を使い，Windows のデスクトップアプリ（Edge WebView2）として動きます．

画面の言語は英語です（PDF.js の部分も含みます）．訳文は設定の翻訳先の言語（既定は日本語）になります．以下では，画面の名前を英語のまま書きます．

既定では，LM Studio で動かす [PLaMo 3 翻訳モデル](https://huggingface.co/pfnet)（`plamo-3-translate-0.8b`）を使います．OpenAI 互換の API を持つほかの翻訳サービスも登録できます．

## ダウンロード

[Releases](https://github.com/mkto3510/PDFTransNote/releases) から，次のどちらかを取ってきます．

- `PdfTransNote-<版>-setup.exe`：インストーラー．管理者の権限は要りません．Windows の「設定 → アプリ」から消せるように，アンインストーラーを今のユーザーの範囲だけに登録します．新しい版は，前と同じフォルダに上書きで入れられます．
- `PdfTransNote-<版>-portable.zip`：ポータブル版．解凍するだけで使えます．レジストリは使いません．

動作環境は 64 ビット版の Windows 10・11 です．画面の表示に Microsoft Edge WebView2 ランタイムを使います（Windows 11 には標準で入っています）．

## 使い方

PDF を開く方法は三つあります．

- Zotero の「PDF 文書を開く」に指定して開く（下記）．
- `PdfTransNote.exe` に PDF をドロップする．
- アプリの「開く」（`Ctrl+O`）を使う．

### 文字を選んだとき

英文を選ぶと，その下にポップアップが出ます（下に場所がなければ上に出ます）．上から順に，次のものが並びます．

| 部品 | 動き |
|---|---|
| **色の丸**（8 色） | その色でハイライトを作り，翻訳を順番待ちの列に入れます．ポップアップは閉じるので，すぐに次の文字を選べます．訳が届くとコメントに入り，PDF が保存されます． |
| **原文の欄** | 選んだ文字が出ます．ここで直した文字が翻訳に使われます．改行，行末のハイフン，ﬁ などの合字は自動で整えます． |
| **Translate**（`Alt+T`，欄の中では `Ctrl+Enter`） | ポップアップの中で翻訳します．訳文は直せます．**Add Annotation**（訳文の欄で `Ctrl+Enter`）か色の丸を押すと，その訳文をコメントにしたハイライトができます．翻訳中に押した場合は，ハイライトを先に作り，訳が届いたらコメントに入れます． |
| **Annotate & Translate**（`Alt+Shift+T`） | 最後に使った色で，色の丸と同じことをします． |
| サービスの切り替え | 使う翻訳サービスを選びます（設定と同じものです）． |

- 翻訳は，一つが終わるのを待たずに何件でも続けて頼めます．翻訳サーバーに同時に送る数は，設定の **Concurrent requests**（既定 2）で決まり，超えた分は順番を待ちます．
- 翻訳中のハイライトには，点線の枠が付きます．
- `Esc` か，ポップアップの外を押すと閉じます．注釈にしていない訳は残りません．

### ハイライトをクリックしたとき

このセッションで作ったハイライトも，ファイルにもともとあったハイライトも，クリックすると次のポップアップが出ます．

| 部品 | 動き |
|---|---|
| **色の丸** | 今の色に印が付いています．押すと色を変えます． |
| コメント | 今のコメント（訳文など）です． |
| **原文の欄** | ハイライトの範囲の文字です．ここで直せます． |
| **Translate** | ポップアップの中で翻訳します．**Save to Comment** で，その訳文をコメントにします． |
| **Translate to Comment** | 翻訳を列に入れ，訳が届いたらコメントを置き換えて保存します．ポップアップは閉じます． |
| **Delete** | ハイライトを消します． |

- ハイライトの上でダブルクリックしても，PDF.js の編集モードには入りません．大きさの変更などの細かい編集は，ツールバーのハイライトのボタンで編集モードにして行います．
- 作れる注釈はハイライトだけです（PDF.js には下線の注釈を作る機能がありません）．

### 注釈の一覧（左のパネルの Annotations）

左のパネル（ツールバーの左端のボタンで開く，「Pages」「Document outline」などを選べるパネル）で **Annotations** を選ぶと，PDF のすべてのハイライトがカードで並びます（Zotero の注釈の一覧と同じ形）．選んだビューは，PDF ごとに次に開いたときも残ります．

| カードの部分 | 動き |
|---|---|
| 見出し（色と **Page 3** など） | 押すと，そのハイライトへ移動して，注釈のポップアップを開きます． |
| 原文 | ハイライトの範囲の文字です（3 行まで．押すと全部出ます）．まだ表示していないページのハイライトも出ます． |
| コメント | 訳文などのコメントです．押すとその場で直せます（`Ctrl+Enter` か外を押すと保存，`Esc` で取り消し）． |
| 翻訳の状態 | **Waiting**（待機中．**Cancel** で取り消し），**Translating…**（届いた訳が少しずつ出ます），**Failed**（理由が出ます．**Retry** でやり直し，**Edit** でポップアップを開いて直す）． |

- ページの上でハイライトを押すと，そのカードが選ばれます．
- 翻訳に失敗したときは，左下にも知らせが出ます．パネルが閉じていれば，開閉ボタンに赤い印が付きます．

### ハイライトの色

- 色は Zotero と同じ 8 色です（Yellow，Red，Green，Blue，Purple，Magenta，Orange，Gray）．
- 画面では，Zotero の表示と同じく，色を不透明度 0.4・乗算で重ねるので，文字は黒いまま読めます．
- ファイルには，Zotero が書くものと同じく不透明な色で保存します．Zotero で開いても同じ色として扱われます．
- ほかのアプリが不透明度（`/CA`）付きで書いたハイライトは，Zotero の取り込みと同じく，色を白に寄せてから重ねます．

### そのほか

- 訳は，ハイライトのコメントアイコンで読み返せます．標準の PDF 注釈なので，Zotero，Firefox，Acrobat でも見えます．
- 保存は `Ctrl+S` か，ツールバーの保存ボタンでも行えます．保存していない変更があるときは，ボタンに赤い印が付きます．
- 元のファイルは，その起動で初めて保存する前に `data\backups` に複製されます（新しいものから 200 個まで残します）．
- 開いた後にほかのアプリが PDF を変えていた場合は，上書きしてよいかを確かめます．
- 保存していない変更や翻訳中のものがあるときは，閉じる前に確かめます．

## 設定（⚙）

Translate for Zotero の Custom GPT と同じ考え方で，OpenAI 互換の chat/completions の翻訳サービスを，名前を付けて何件でも登録できます．**Add**，**Duplicate**，**Delete** で増減し，**Use this service** で使うものを選びます．

### サービスごとの項目

| 項目 | 説明 | 既定値（PLaMo 3 Translate 0.8B） |
|---|---|---|
| Endpoint | 土台の URL を入れると `/v1/chat/completions` を付けます．`…/chat/completions` で終わる URL は，そのまま使います． | `http://localhost:1234`（LM Studio の既定） |
| API key | 任意．`Authorization: Bearer` として送ります． | 空 |
| Model | **Test Connection** で，サーバーにあるモデルを候補に出します． | `plamo-3-translate-0.8b` |
| temperature | 0〜2 | 0 |
| System prompt | system メッセージとして送ります（空なら送りません）．使える変数は `${langFrom}`，`${langTo}`． | `[plamo-translate]`↵`target_lang=${langTo}`↵`form=plain` |
| Prompt | user メッセージとして送ります．`${sourceText}`（必須），`${langFrom}`，`${langTo}` が使えます． | `${sourceText}` |
| Stream the response | 訳を少しずつ受け取ります． | オン |
| Extra parameters | JSON のオブジェクト．要求の本文に混ぜます（例：`{"max_tokens": 4096}`）．同じ名前の項目は上書きします． | 空 |

PLaMo 3 Translate では，`[plamo-translate]` から始まる指定をシステムプロンプトに入れてください．user メッセージ（プロンプト）に入れると，訳文の頭にその指定がそのまま出てくることがあります．

### 共通の項目

| 項目 | 既定値 |
|---|---|
| Source language（`${langFrom}`）・Target language（`${langTo}`） | English (en)・Japanese (ja) |
| Concurrent requests（翻訳サーバーに同時に送る数） | 2（1〜8） |
| Save the PDF after putting a translation into a comment | オン |

- 翻訳サーバーへの要求はアプリの中で中継するので，LM Studio の「Enable CORS」は要りません．API キーは，中継するときにアプリのサーバーが付けます．
- 設定ファイルの中で読めない項目は捨てて，既定値で始めます．

## Zotero から開く

Zotero の「編集 → 設定 → 一般 → リーダー」にある「PDF 文書を開く」で，`PdfTransNote.exe` を選びます．Zotero のデータベースにある注釈（Zotero の内蔵リーダーで付けたもの）は，このビューアには出ません．

## データの置き場所

`PdfTransNote.exe` の横の `data` フォルダに，次のものを置きます．

| ファイル・フォルダ | 中身 |
|---|---|
| `settings.json` | 設定（API キーを含みます） |
| `backups\` | 保存前に複製した PDF |
| `webview\` | WebView2 の表示用データ |
| `transnote.log` | 動作の記録 |

そこに書き込めないときだけ，`%LOCALAPPDATA%\PdfTransNote` を使います．

消すときは，次のようにします．

- setup.exe で入れた場合：Windows の「設定 → アプリ → インストールされているアプリ」で PDF TransNote をアンインストールします．最後に `data` フォルダ（設定とバックアップ）も消すかを尋ねます．既定は「残す」です．
- zip の場合：アプリのフォルダごと削除します．

## ソースから作る

```powershell
py -3.14 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
.venv\Scripts\python -m tools.fetch_pdfjs
powershell -ExecutionPolicy Bypass -File build.ps1
```

- PDF.js はリポジトリに含めていません．`tools.fetch_pdfjs` が PDF.js の公式の Release から `pdfjs-<版>-dist.zip` を取ってきて，SHA-256 を確かめてから `vendor/` に展開します（`build.ps1` も，なければ取ってきます）．
- 版は `transnote/__init__.py` の `VERSION` で決まります．

- 出力は `release\` の zip（解凍するだけで使える）と setup.exe（Inno Setup 7 が必要）です．
- テストだけなら，`node --test tests/` と `.venv\Scripts\python -m unittest discover -s tests` を実行します．
- 開発中は `.venv\Scripts\python PdfTransNote.py <PDF>` で動かせます．
- ブラウザーで画面だけ試すときは `.venv\Scripts\python -m tools.devserver <PDF>` を使います．

## 構成

PDF.js に触れるコードは `web/pdfjs/` の `bridge.js` と `overrides.css` だけです（同じ場所の `highlight-math.mjs` は PDF.js に触れない計算だけ）．独自の部分（`web/app/`）は PDF.js の名前や CSS 変数を使わず，`bridge.js` が出す API と `--tn-…` の変数だけを使います．PDF.js を更新したときに直すのは `web/pdfjs/` だけで済みます．

| パス | 役割 |
|---|---|
| `transnote/app.py` | ウインドウ（pywebview）．同時に一つだけ動かし，二つ目の起動からファイルを受け取る． |
| `transnote/server.py` | 127.0.0.1 だけで動く小さな HTTP サーバー．PDF.js の配布，PDF の読み出しと保存，設定，登録した翻訳サービスへの中継． |
| `transnote/settings.py`，`transnote/paths.py` | 設定の既定値と検査，ポータブルの置き場所． |
| `web/pdfjs/bridge.js` | PDF.js との境目．起動時の設定（英語の画面など），選択とクリックの検出，ハイライトの作成・色・コメント・削除，ファイルにあった注釈の扱いと一覧，ハイライトの薄い表示，左のパネルの Annotations のビュー，保存・開く・ドロップの差し替え． |
| `web/pdfjs/highlight-math.mjs` | ハイライトの計算（不透明度を色に混ぜる，quadPoints の中の文字，並べ方）．PDF.js にも画面にも触れない． |
| `web/pdfjs/overrides.css` | PDF.js の見た目の値を `--tn-…` の変数に移す．PDF.js の要素に当てる見た目（ハイライトの薄さなど）． |
| `web/app/main.js` | 入口．`bridge` と独自の部品をつなぐ． |
| `web/app/popup.js` | 選択ポップアップと注釈ポップアップ． |
| `web/app/sidebar.js` | 左のパネルの Annotations のカード（翻訳の状態を含む）． |
| `web/app/settings-dialog.js` | 設定画面． |
| `web/app/core.mjs` | 原文の整形，chat の要求の組み立て，SSE の読み取り（画面に依存しない）． |
| `web/app/jobs.mjs` | 翻訳の順番待ちの列（同時に送る数の上限，取り消し，やり直し）と，保存をまとめる仕組み（画面に依存しない）． |
| `web/app/api.js`，`web/app/dom.js`，`web/app/app.css` | サーバーとデスクトップとのやりとり，要素を作る小道具，独自の部品の見た目． |
| `vendor/pdfjs-6.5.438-dist/` | PDF.js の公式配布物（`tools/fetch_pdfjs.py` が取ってくる．変更しない）． |
| `installer/` | Inno Setup 7 の台本． |

## ライセンス

PDF TransNote は [GNU General Public License v3.0](LICENSE) またはそれ以降の版（GPL-3.0-or-later）で公開しています．

- 配布物に同梱しているソフト（PDF.js など）のライセンスは，配布物の `LICENSES/` にあります（ビルドのときに `tools/collect_licenses.py` が集めます）．
- 翻訳に使うモデル（PLaMo 3 翻訳モデルなど）やサービスは同梱していません．それぞれの利用条件に従ってください．
