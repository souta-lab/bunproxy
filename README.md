# 🌐 BunProxy

Cloudflare Workers 上で動く Web プロキシ。`bunproxy.s0u7a.f5.si` で稼働。

## ✨ 仕組み

- 🎯 **多段のターゲット解決** — `__proxy_target__` パラメータ → 旧 `targetUrl` パラメータ → `/proxy/<encoded>` パス → Referer からの復旧、の順に接続先を決定する
- 🍪 **Cookie 中継** — `X-Proxy-Cookie` / `X-Proxy-Set-Cookie` ヘッダで、プロキシ越しにターゲットサイトの Cookie を保持する
- 🧹 **ヘッダ整形** — CSP・HSTS・Clear-Site-Data 等の応答ヘッダと `integrity` / `crossorigin` 属性を取り除き、書き換え後のコンテンツが壊れないようにする。Cloudflare 由来のリクエストヘッダも転送前に除去
- 📜 **クライアント補助** — `/s_override.js` でブラウザ側の URL 書き換えを補助し、フォーム送信などでパラメータが衝突するケース（Bing 等）にも Referer 復旧で対応する

## 🚀 デプロイ

```sh
bunx wrangler deploy --config wrangler.jsonc
```

| 項目 | 値 |
| --- | --- |
| Worker 名 | `bunproxy` |
| カスタムドメイン | `bunproxy.s0u7a.f5.si` |
| エントリ | `src/index.js`（ビルド済みバンドル） |

> ℹ️ アーカイブ済み Cloudflare Worker の renamed deployment です。オリジナルの Worker 版はローカルにバックアップがあります。
