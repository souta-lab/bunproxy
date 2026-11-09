var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var CONFIG = {
  PARAM_TARGET: "__proxy_target__",
  PARAM_FALLBACK: "targetUrl",
  HEADER_REQ_COOKIE: "X-Proxy-Cookie",
  HEADER_RES_COOKIE: "X-Proxy-Set-Cookie",
  PATH_PROXY: "/proxy",
  PATH_SCRIPT: "/s_override.js",
  // Headers to strictly remove for security/compatibility
  BLOCKED_REQ_HEADERS: ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-proto", "x-real-ip"],
  BLOCKED_RES_HEADERS: ["content-security-policy", "content-security-policy-report-only", "clear-site-data", "content-encoding", "content-length", "transfer-encoding", "alt-svc", "strict-transport-security"],
  // Attributes to strip for integrity
  STRIP_ATTRS: ["integrity", "crossorigin"]
};
var UrlManager = class {
  static {
    __name(this, "UrlManager");
  }
  /**
   * Resolves the target URL from the request context.
   * Strategies: 1. Primary Param -> 2. Legacy Param -> 3. Path Suffix -> 4. MediaWiki Fix -> 5. Referer Recovery
   */
  static resolveTarget(reqUrl, request) {
    let target = reqUrl.searchParams.get(CONFIG.PARAM_TARGET) || reqUrl.searchParams.get(CONFIG.PARAM_FALLBACK);
    if (!target && reqUrl.pathname.startsWith(CONFIG.PATH_PROXY + "/")) {
      const potentialEncoded = reqUrl.pathname.slice(CONFIG.PATH_PROXY.length + 1);
      if (potentialEncoded) {
        target = this.decodeSafe(potentialEncoded);
      }
    }
    if (target) {
      try {
        target = target.replace(/^(https?:\/\/[^\/]+).*load\.php(.*)$/, "$1/load.php$2");
        new URL(target);
        return target;
      } catch {
        return this.recoverFromReferer(request.headers.get("Referer"), reqUrl.href, target);
      }
    }
    return null;
  }
  /**
   * Attempts to reconstruct the target URL using the Referer header + current query params.
   * Useful when sites (like Bing) submit forms with relative parameters that collide/override our params.
   */
  static recoverFromReferer(referer, currentFullUrl, invalidTargetFragment) {
    if (!referer) return null;
    try {
      const refUrl = new URL(referer);
      if (refUrl.pathname.includes(CONFIG.PATH_PROXY)) {
        const baseTarget = refUrl.searchParams.get(CONFIG.PARAM_TARGET) || refUrl.searchParams.get(CONFIG.PARAM_FALLBACK);
        if (baseTarget) {
          console.log(`[Proxy] Recovering target via Referer: ${baseTarget}`);
          return this.mergeQueryParams(baseTarget, currentFullUrl, invalidTargetFragment);
        }
      }
    } catch (e) {
      console.warn("[Proxy] Referer recovery failed", e);
    }
    return null;
  }
  static mergeQueryParams(baseUrl, overrideUrl, excludeVal) {
    try {
      const base = new URL(baseUrl);
      const override = new URL(overrideUrl);
      override.searchParams.forEach((val, key) => {
        if (key !== CONFIG.PARAM_TARGET && key !== CONFIG.PARAM_FALLBACK && val !== excludeVal) {
          base.searchParams.set(key, val);
        }
      });
      return base.href;
    } catch {
      return baseUrl;
    }
  }
  /** Encodes a target URL for use in the proxy. */
  static wrap(targetUrl) {
    return `${CONFIG.PATH_PROXY}?${CONFIG.PARAM_TARGET}=${encodeURIComponent(targetUrl)}`;
  }
  /** Rewrites a resource URL (CSS/JS import) to be proxied. */
  static proxify(resource, baseUrl) {
    if (!resource) return "";
    try {
      if (resource.startsWith("http")) return this.wrap(resource);
      return this.wrap(new URL(resource, baseUrl).href);
    } catch (e) {
      return resource;
    }
  }
  static decodeSafe(str) {
    try {
      return decodeURIComponent(str);
    } catch {
      return str;
    }
  }
};
var HeaderManager = class {
  static {
    __name(this, "HeaderManager");
  }
  static prepareRequest(headers, targetUrl) {
    const cleaned = new Headers(headers);
    CONFIG.BLOCKED_REQ_HEADERS.forEach((h) => cleaned.delete(h));
    const proxyCookies = cleaned.get(CONFIG.HEADER_REQ_COOKIE);
    if (proxyCookies) {
      cleaned.set("Cookie", proxyCookies);
      cleaned.delete(CONFIG.HEADER_REQ_COOKIE);
    }
    const origin = new URL(targetUrl).origin;
    cleaned.set("Origin", origin);
    const referer = cleaned.get("Referer");
    if (referer && referer.includes(CONFIG.PARAM_TARGET)) {
      try {
        const refUrl = new URL(referer);
        const embeddedTarget = refUrl.searchParams.get(CONFIG.PARAM_TARGET) || refUrl.searchParams.get(CONFIG.PARAM_FALLBACK);
        if (embeddedTarget) cleaned.set("Referer", embeddedTarget);
        else cleaned.set("Referer", origin);
      } catch {
        cleaned.set("Referer", origin);
      }
    } else {
      cleaned.set("Referer", origin);
    }
    if (origin.includes("googlevideo.com")) {
      cleaned.set("Origin", "https://www.youtube.com");
      cleaned.set("Referer", "https://www.youtube.com/");
    }
    return cleaned;
  }
  static prepareResponse(headers, status) {
    const cleaned = new Headers(headers);
    const initCookies = [];
    CONFIG.BLOCKED_RES_HEADERS.forEach((h) => cleaned.delete(h));
    const rawCookies = typeof cleaned.getSetCookie === "function" ? cleaned.getSetCookie() : [];
    if (rawCookies.length === 0) {
      const c = cleaned.get("set-cookie");
      if (c) rawCookies.push(c);
    }
    if (rawCookies.length > 0) {
      cleaned.delete("Set-Cookie");
      initCookies.push(...rawCookies);
      cleaned.set(CONFIG.HEADER_RES_COOKIE, JSON.stringify(rawCookies));
      cleaned.append("Access-Control-Expose-Headers", CONFIG.HEADER_RES_COOKIE);
    }
    cleaned.set("Access-Control-Allow-Origin", "*");
    cleaned.set("Access-Control-Allow-Credentials", "true");
    return { headers: cleaned, initCookies };
  }
};
var ContentRewriter = class {
  static {
    __name(this, "ContentRewriter");
  }
  static async transform(res, targetUrl) {
    const contentType = (res.headers.get("Content-Type") || "").toLowerCase();
    if (contentType.includes("text/html")) {
      return this.rewriteHtml(res, targetUrl);
    } else if (contentType.includes("text/css")) {
      return this.rewriteCss(res, targetUrl);
    } else if (contentType.includes("javascript") || contentType.includes("x-javascript")) {
      return this.rewriteJs(res, targetUrl);
    }
    const { headers } = HeaderManager.prepareResponse(res.headers, res.status);
    return new Response(res.body, { status: res.status, headers });
  }
  static async rewriteHtml(res, targetUrl) {
    const { headers, initCookies } = HeaderManager.prepareResponse(res.headers, res.status);
    const buffer = await res.arrayBuffer();
    let rewriter = new HTMLRewriter();
    rewriter.on("meta", {
      element(el) {
        if (el.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy") el.remove();
      }
    });
    const stripHandler = {
      element(el) {
        CONFIG.STRIP_ATTRS.forEach((attr) => el.removeAttribute(attr));
      }
    };
    rewriter.on("script", stripHandler).on("link", stripHandler);
    rewriter.on("head", {
      element(el) {
        const cookieData = JSON.stringify(initCookies);
        const scriptSrc = `${CONFIG.PATH_SCRIPT}?${CONFIG.PARAM_TARGET}=${encodeURIComponent(targetUrl)}`;
        el.prepend(`<script>window.__INITIAL_COOKIES__ = ${cookieData};<\/script>`, { html: true });
        el.prepend(`<script src="${scriptSrc}"><\/script>`, { html: true });
      }
    });
    rewriter.on("form", {
      element(el) {
        const action = el.getAttribute("action");
        if (!action) return;
        let absoluteAction = action;
        try {
          absoluteAction = new URL(action, targetUrl).href;
        } catch {
        }
        const method = (el.getAttribute("method") || "GET").toUpperCase();
        if (method === "GET") {
          el.setAttribute("action", CONFIG.PATH_PROXY);
          el.prepend(`<input type="hidden" name="${CONFIG.PARAM_TARGET}" value="${absoluteAction}" />`, { html: true });
        } else {
          el.setAttribute("action", `${CONFIG.PATH_PROXY}?${CONFIG.PARAM_TARGET}=${encodeURIComponent(absoluteAction)}`);
        }
      }
    });
    return rewriter.transform(new Response(buffer, { headers, status: res.status }));
  }
  static async rewriteCss(res, targetUrl) {
    const text = await res.text();
    const rewritten = text.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (_, url) => {
      return `url("${UrlManager.proxify(url, targetUrl)}")`;
    });
    const { headers } = HeaderManager.prepareResponse(res.headers, res.status);
    return new Response(rewritten, { status: res.status, headers });
  }
  static async rewriteJs(res, targetUrl) {
    const text = await res.text();
    let rewritten = text.replace(/(from|import\s+)\s*['"]([^'"]+)['"]/g, (match, sep, url) => {
      return `${sep} "${UrlManager.proxify(url, targetUrl)}"`;
    });
    rewritten = rewritten.replace(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, (match, url) => {
      return `import("${UrlManager.proxify(url, targetUrl)}")`;
    });
    const { headers } = HeaderManager.prepareResponse(res.headers, res.status);
    return new Response(rewritten, { status: res.status, headers });
  }
};
var CLIENT_SCRIPT = `
(function() {
    const CFG = {
        PARAM: "${CONFIG.PARAM_TARGET}",
        COOKIE_KEY_REQ: "${CONFIG.HEADER_REQ_COOKIE}",
        COOKIE_KEY_RES: "${CONFIG.HEADER_RES_COOKIE}",
        PROXY_PATH: "${CONFIG.PATH_PROXY}"
    };
    
    // --- Context Setup ---
    let currentTarget = "";
    try {
        // Current target passed via query param to this script
        const src = document.currentScript && document.currentScript.getAttribute("src");
        if (src) {
            const u = new URL(src, window.location.href);
            currentTarget = u.searchParams.get(CFG.PARAM) || sessionStorage.getItem("p_target");
        }
        if (currentTarget) sessionStorage.setItem("p_target", currentTarget);
    } catch(e) {}

    // --- Hardening & Overrides ---
    // Force Bing/etc to use location.replace (hooked) instead of location.href assignment
    try {
        Object.defineProperty(document, "referrer", { get: () => "", configurable: true });
    } catch(e) {}
    
    // Kill Service Workers (they bypass proxy)
    if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistrations().then(r => r.forEach(reg => reg.unregister()));
    }

    // --- Cookie Jar ---
    const CookieJar = {
        key: () => "cj_" + (currentTarget ? new URL(currentTarget).origin : "default"),
        get: () => {
            try { return JSON.parse(localStorage.getItem(CookieJar.key()) || "{}"); } catch { return {}; }
        },
        set: (map) => localStorage.setItem(CookieJar.key(), JSON.stringify(map)),
        ingest: (list) => {
            if (!Array.isArray(list)) return;
            const map = CookieJar.get();
            list.forEach(c => {
                const [pair] = c.split(";");
                const [k, ...v] = pair.split("=");
                if (k) map[k.trim()] = v.join("=").trim();
            });
            CookieJar.set(map);
        },
        toHeader: () => {
            const map = CookieJar.get();
            return Object.entries(map).map(([k,v]) => k + "=" + v).join("; ");
        }
    };
    // Initial Ingest
    if (window.__INITIAL_COOKIES__) CookieJar.ingest(window.__INITIAL_COOKIES__);

    // --- URL Rewriter ---
    function proxify(url) {
        if (!url || !currentTarget) return url;
        if (url.includes(CFG.PROXY_PATH + "?" + CFG.PARAM)) return url;
        
        try {
            // Resolve relative to current proxy page -> effectively relative to origin. 
            // We need to act as if resolving against target.
            // Simplification: Append to Proxy API
            const base = new URL(currentTarget);
            let absolute;
            if (url.startsWith("http")) absolute = url;
            else if (url.startsWith("//")) absolute = base.protocol + url;
            else absolute = new URL(url, base).href; // Resolve relative
            
            return CFG.PROXY_PATH + "?" + CFG.PARAM + "=" + encodeURIComponent(absolute);
        } catch { return url; }
    }

    // --- Interceptors ---
    // 1. Fetch
    const origFetch = window.fetch;
    window.fetch = async function(input, init = {}) {
        let url = input instanceof Request ? input.url : input;
        url = proxify(url);
        
        // Headers
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
        const cookies = CookieJar.toHeader();
        if (cookies) headers.set(CFG.COOKIE_KEY_REQ, cookies);
        
        const newInit = { ...init, headers };
        if (input instanceof Request && input.body && !newInit.body) newInit.body = input.body;

        const res = await origFetch(url, newInit);
        
        // Response Cookies
        const setCookies = res.headers.get(CFG.COOKIE_KEY_RES);
        if (setCookies) CookieJar.ingest(JSON.parse(setCookies));
        
        return res;
    };

    // 2. XHR
    const origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return origXhrOpen.call(this, method, proxify(url), ...args);
    };
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
        const cookies = CookieJar.toHeader();
        if (cookies) this.setRequestHeader(CFG.COOKIE_KEY_REQ, cookies);
        
        this.addEventListener("readystatechange", () => {
            if (this.readyState === 4) {
                const h = this.getResponseHeader(CFG.COOKIE_KEY_RES);
                if (h) CookieJar.ingest(JSON.parse(h));
            }
        });
        return origXhrSend.call(this, body);
    };

    // --- DOM Observer (Auto-Rewrite) ---
    const ATTRS = ["src", "href", "action", "data", "poster"];
    function processNode(node) {
        if (node.nodeType !== 1) return;
        // Strip Integrity/CORS
        if (node.hasAttribute("integrity")) node.removeAttribute("integrity");
        if (node.hasAttribute("crossorigin")) node.removeAttribute("crossorigin");

        // Rewrite URLs
        ATTRS.forEach(a => {
            if (node.hasAttribute(a)) {
                const val = node.getAttribute(a);
                const p = proxify(val);
                if (val !== p) node.setAttribute(a, p);
            }
        });
        // Special: Styles
        if (node.hasAttribute("style")) {
             const val = node.getAttribute("style");
             if (val.includes("url(")) {
                 node.setAttribute("style", val.replace(/url\\(['"]?(.+?)['"]?\\)/g, (_, u) => "url('"+proxify(u)+"')"));
             }
        }
    }
    
    new MutationObserver(ms => {
        ms.forEach(m => {
            if (m.type === "attributes") processNode(m.target);
            else m.addedNodes.forEach(processNode);
        });
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [...ATTRS, "style"] });
    
    console.log("[Proxy] Loaded");
})();
`;
function serveRoot() {
  return new Response(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>BunProxy — Web Proxy</title>
      <style>
        :root {
            --paper: #f4f5f8;
            --surface: #ffffff;
            --ink: #191b24;
            --muted: #555967;
            --line: #d5d8e1;
            --heat: #e0332b;
            --font-body: system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif;
            --font-mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        }
        * { box-sizing: border-box; }
        body {
            font-family: var(--font-body);
            background: var(--paper);
            color: var(--ink);
            margin: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
            line-height: 1.8;
            -webkit-font-smoothing: antialiased;
        }
        ::selection { background: var(--ink); color: var(--paper); }
        .container {
            width: min(100% - 48px, 800px);
            padding: 64px 0 0;
            text-align: left;
        }
        .logo-container { margin-bottom: 28px; }
        .logo {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 56px;
            height: 56px;
            border: 1.5px solid var(--ink);
            border-radius: 6px 18px 6px 18px;
            font-family: var(--font-mono);
            font-weight: 700;
            font-size: 1.05rem;
            letter-spacing: 0.06em;
            color: var(--ink);
        }
        h1 {
            font-size: clamp(2.2rem, 6vw, 3rem);
            font-weight: 720;
            letter-spacing: -0.05em;
            line-height: 1.15;
            margin: 0 0 14px;
            color: var(--ink);
        }
        .tagline {
            font-size: 0.98rem;
            color: var(--muted);
            margin: 0 0 40px;
            line-height: 1.95;
            max-width: 600px;
        }
        .search-box {
            background: var(--surface);
            padding: 24px;
            border: 1px solid var(--line);
            border-radius: 8px;
            margin-bottom: 56px;
        }
        form { display: flex; gap: 12px; }
        input {
            flex: 1;
            min-width: 0;
            padding: 12px 14px;
            background: var(--paper);
            border: 1px solid var(--line);
            border-radius: 4px;
            color: var(--ink);
            font-family: inherit;
            font-size: 1rem;
            outline: none;
        }
        input:focus { border-color: var(--ink); }
        button {
            padding: 12px 26px;
            background: var(--heat);
            color: #fff;
            border: none;
            border-radius: 4px 14px 4px 14px;
            font-family: inherit;
            font-size: 0.95rem;
            font-weight: 700;
            letter-spacing: 0.02em;
            cursor: pointer;
            white-space: nowrap;
        }
        button:hover { background: #c2271f; }
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 0 32px;
            text-align: left;
            margin-bottom: 48px;
        }
        .feature-card {
            border-top: 1px solid var(--line);
            padding: 18px 0 20px;
        }
        .feature-card h3 {
            margin: 0 0 8px;
            font-size: 0.95rem;
            font-weight: 650;
            letter-spacing: -0.02em;
            color: var(--ink);
        }
        .feature-card p { font-size: 0.88rem; color: var(--muted); margin: 0; line-height: 1.85; }
        .limitations {
            font-size: 0.8rem;
            color: var(--muted);
            margin-bottom: 2rem;
            border-top: 1px solid var(--line);
            padding-top: 1rem;
            width: 100%;
        }
        footer {
            margin-top: auto;
            width: min(100% - 48px, 800px);
            padding: 22px 0 34px;
            border-top: 1px solid var(--line);
            color: var(--muted);
            font-family: var(--font-mono);
            font-size: 0.78rem;
        }
        footer a { color: var(--ink); text-decoration: none; }
        footer a:hover { text-decoration: underline; text-underline-offset: 3px; }
        @media (max-width: 640px) {
            .container { padding-top: 44px; }
            form { flex-direction: column; }
            button { width: 100%; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo-container">
            <span class="logo" aria-hidden="true">BP</span>
        </div>
        <h1>BunProxy</h1>
        <p class="tagline">
           \u30A4\u30F3\u30BF\u30FC\u30CD\u30C3\u30C8\u3067\u771F\u306E\u81EA\u7531\u3092\u5F97\u308B\u305F\u3081\u306E\u30BD\u30EA\u30E5\u30FC\u30B7\u30E7\u30F3\u3002<br>
           \u76E3\u8996\u3068\u30D5\u30A3\u30EB\u30BF\u30EA\u30F3\u30B0\u306F\u901A\u4FE1\u306E\u81EA\u7531\u306B\u9055\u53CD\u3057\u3066\u3044\u307E\u3059\u3002<br>
           \u305D\u308C\u306B\u6297\u3044\u307E\u3057\u3087\u3046\u3002<br>(Created by @s0u7a Comment:\u5B66\u6821\u3067\u4F7F\u3063\u3066\u306D)
        </p>

        <div class="search-box">
            <form action="/proxy" method="GET">
                <input type="url" name="targetUrl" placeholder="https://youtube.com" required autofocus>
                <button type="submit">Unlock</button>
            </form>
        </div>

        <div class="features">
            <div class="feature-card">
                <h3>All URL Parser</h3>
                <p>\u8907\u96D1\u306AURL\u3084\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u3092\u5F37\u529B\u306B\u89E3\u6790\u30FB\u6B63\u898F\u5316\u3002</p>
            </div>
            <div class="feature-card">
                <h3>Anti Redirect System</h3>
                <p>\u30B5\u30FC\u30D0\u30FC\u30B5\u30A4\u30C9\u3067\u306E\u8FFD\u8DE1\u3092\u9632\u304E\u3001\u5B89\u5168\u306A\u30EB\u30FC\u30C8\u3092\u78BA\u4FDD\u3002\u3042\u3089\u3086\u308B\u65B9\u6CD5\u304B\u3089\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u3092\u906E\u65AD\u3002</p>
            </div>
            <div class="feature-card">
                <h3>Native Protection</h3>
                <p>\u751FURL\u3078\u306E\u76F4\u63A5\u30A2\u30AF\u30BB\u30B9\u3092\u906E\u65AD\u3057\u3001\u5E38\u306B\u30D7\u30ED\u30AD\u30B7\u7D4C\u7531\u3067\u4FDD\u8B77\u3002\u5F37\u529B\u306Ajavascript\u3092\u633F\u5165\u3057\u3001\u3059\u3079\u3066\u3092\u4FDD\u8B77\u3002</p>
            </div>
            <div class="feature-card">
                <h3>Powered by web standard&bun</h3>
                <p>\u3059\u3079\u3066\u306E\u6A5F\u80FD\u3092Web\u6A19\u6E96\u3068Bun\u3067\u5B9F\u88C5\u3002\u6700\u9069\u306A\u6027\u80FD\u3068\u5B89\u5168\u6027\u3092\u63D0\u4F9B\u3002</p>
            </div>
            <div class="feature-card">
                <h3>Minimal</h3>
                <p>\u6700\u5C0F\u9650\u306E\u4F9D\u5B58\u95A2\u4FC2\u3068\u30B3\u30FC\u30C9\u3002\u8EFD\u91CF\u3067\u9AD8\u901F\u3002\u30D5\u30A1\u30A4\u30EB\u306Findex.ts\u306E\u307F\u3002</p>
            </div>
            <div class="feature-card">
                <h3>cloudflare workers</h3>
                <p>Cloudflare Workers\u4E0A\u3067\u52D5\u4F5C\u3002Cloudflare\u306E\u4FE1\u983C\u6027\u3068\u30BB\u30AD\u30E5\u30EA\u30C6\u30A3\u3092\u6D3B\u7528\u3002</p>
            </div>
        </div>

        <div class="limitations">
            <p><strong>\u52D5\u4F5C\u30B9\u30C6\u30FC\u30BF\u30B9:</strong> ALPN/HSTS\u306A\u3069\u306E\u4E00\u90E8\u306E\u9AD8\u5EA6\u306A\u30D7\u30ED\u30C8\u30B3\u30EB\u62E1\u5F35\u306F\u610F\u56F3\u7684\u306B\u7121\u52B9\u5316\u3055\u308C\u3066\u3044\u307E\u3059\u3002<br>HTTP3\u3084QUIC\u306A\u3069\u306E\u9AD8\u5EA6\u306A\u30D7\u30ED\u30C8\u30B3\u30EB\u306F\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u305B\u3093\u3002\u4ECA\u5F8C\u5BFE\u5FDC\u4E88\u5B9A\u3067\u3059\u3002
            <br>\u4E3B\u8981\u306Aweb\u30B5\u30A4\u30C8\u3067\u30C6\u30B9\u30C8\u3055\u308C\u3001\u554F\u984C\u306A\u304F\u52D5\u4F5C\u3057\u3066\u3044\u307E\u3059\u3002\u554F\u984C\u304C\u3042\u308C\u3070\u3001\u305C\u3072\u5831\u544A\u3057\u3066\u304F\u3060\u3055\u3044\u3002github: <a href="https://github.com/s0u7a/">s0u7a</a></p>
        </div>

        <footer>
            Developed by <a href="https://github.com/s0u7a" target="_blank">@s0u7a</a>
        </footer>
      </div>
    </body>
    </html>`, {
    headers: { "Content-Type": "text/html" }
  });
}
__name(serveRoot, "serveRoot");
var index_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/") return serveRoot();
    if (url.pathname === CONFIG.PATH_SCRIPT) {
      return new Response(CLIENT_SCRIPT, {
        headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600" }
      });
    }
    const targetUrl = UrlManager.resolveTarget(url, req);
    if (!targetUrl) {
      return new Response("Invalid or Missing Target URL", { status: 400 });
    }
    const upstreamReqInit = {
      method: req.method,
      headers: HeaderManager.prepareRequest(req.headers, targetUrl),
      redirect: "manual"
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      const bodyConf = await req.arrayBuffer();
      upstreamReqInit.body = bodyConf;
      if (upstreamReqInit.headers instanceof Headers) {
        upstreamReqInit.headers.set("Content-Length", String(bodyConf.byteLength));
      }
    }
    try {
      const res = await fetch(targetUrl, upstreamReqInit);
      return ContentRewriter.transform(res, targetUrl);
    } catch (e) {
      return new Response(`Proxy Error: ${String(e)}`, { status: 502 });
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
