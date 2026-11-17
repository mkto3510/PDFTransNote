# 変更履歴

このファイルには，公開した版ごとの主な変更を書きます．版の付け方は [Semantic Versioning](https://semver.org/lang/ja/) に従います．

## [0.1.0] - 2026-11-17

最初の公開版です．

- PDF.js 6.5.438 を使った Windows 用のポータブル PDF ビューア．
- 選んだ英文を，ローカル LLM（LM Studio の PLaMo 3 翻訳モデルなど）や OpenAI 互換の API で和訳し，ハイライトのコメントとして PDF に保存する．
- 翻訳の順番待ちの列（同時に送る数の上限，取り消し，やり直し）．
- 左のパネルの Annotations のビュー（ハイライトと訳文の一覧，翻訳の状態）．
- Zotero と同じ 8 色のハイライト．Zotero の「PDF 文書を開く」から使える．
- インストーラー（Inno Setup 7）と，解凍するだけで使える zip．

[0.1.0]: https://github.com/mkto3510/PDFTransNote/releases/tag/v0.1.0
