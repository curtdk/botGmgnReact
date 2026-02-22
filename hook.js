/**
 * GMGN Network Hook Script
 * 注入到页面上下文中运行，负责拦截XHR请求并捕获数据
 */
(function() {
    'use strict';

    // 防止重复注入
    if (window.__GMGN_HOOK_INJECTED__) return;
    window.__GMGN_HOOK_INJECTED__ = true;

    console.log('[GMGN Hook] Initializing XHR interception...');

    const XHR = XMLHttpRequest.prototype;
    const open = XHR.open;
    const send = XHR.send;
    const setRequestHeader = XHR.setRequestHeader; // [新增] 保存原始 setRequestHeader

    // 目标URL特征
    const TARGET_URL_PATTERNS = [
        '/vas/api/v1/token_holders/',
        '/vas/api/v1/token_trades/',
        '/defi/quotation/v1/trades/',
        '/api/v1/follow/get_remark_info/'
    ];

    /**
     * 检查URL是否匹配目标模式
     */
    function isTargetUrl(url) {
        if (!url) return false;
        return TARGET_URL_PATTERNS.some(pattern => url.includes(pattern));
    }

    /**
     * 重写 open 方法以捕获请求信息
     */
    XHR.open = function(method, url) {
        this._method = method;
        this._url = url;
        this._requestHeaders = {}; // [新增] 初始化 header 存储
        return open.apply(this, arguments);
    };

    /**
     * [新增] 重写 setRequestHeader 以捕获请求头
     */
    XHR.setRequestHeader = function(header, value) {
        if (!this._requestHeaders) {
            this._requestHeaders = {};
        }
        this._requestHeaders[header] = value;
        return setRequestHeader.apply(this, arguments);
    };

    /**
     * 重写 send 方法以捕获响应
     */
    XHR.send = function(postData) {
        this.addEventListener('load', function() {
            try {
                if (isTargetUrl(this._url)) {
                    // 尝试解析响应头
                    const responseHeaders = {};
                    const headersText = this.getAllResponseHeaders();
                    if (headersText) {
                        headersText.trim().split(/[\r\n]+/).forEach(line => {
                            const parts = line.split(': ');
                            const header = parts.shift();
                            const value = parts.join(': ');
                            responseHeaders[header.toLowerCase()] = value;
                        });
                    }

                    // 构建消息载荷
                    const payload = {
                        type: 'xhr',
                        ts: Date.now(),
                        url: this._url,
                        method: this._method,
                        requestHeaders: this._requestHeaders || {}, // [修改] 传递捕获的 headers
                        requestBody: postData,
                        status: this.status,
                        responseHeaders: responseHeaders,
                        responseBody: this.responseText // 原始响应文本
                    };

                    console.log('[GMGN Hook] Captured XHR:', this._url);

                    // 通过自定义事件发送给 content script
                    // HOOK_FETCH_XHR_EVENT 携带完整 responseBody，HeliusIntegration 会从中提取 tx_hash
                    window.dispatchEvent(new CustomEvent('HOOK_FETCH_XHR_EVENT', {
                        detail: payload
                    }));
                }
            } catch (err) {
                console.error('[GMGN Hook] Error capturing XHR:', err);
            }
        });

        return send.apply(this, arguments);
    };

    console.log('[GMGN Hook] XHR interception active');
})();
