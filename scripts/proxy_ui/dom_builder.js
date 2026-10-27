var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

class ProxyDomBuilder {
    static injectStyles(cssContent) {
        const fn = (typeof injectStyles === 'function') ? injectStyles : ((typeof globalThis.__agyInjectStyles === 'function') ? globalThis.__agyInjectStyles : null);
        if (fn) {
            fn(cssContent || (typeof PROXY_CSS !== 'undefined' ? PROXY_CSS : ''), 'agy-proxy-styles');
            return;
        }
        const STYLE_ID = 'agy-proxy-styles';
        if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = cssContent || (typeof PROXY_CSS !== 'undefined' ? PROXY_CSS : '');
        (document.head || document.documentElement).appendChild(style);
    }

    static buildProxyPane(container, controller) {
        this.injectStyles();

        let pane = document.getElementById('agy-proxy-settings-pane');
        if (!pane) {
            pane = document.createElement('div');
            pane.id = 'agy-proxy-settings-pane';
            pane.className = 'p-6 flex flex-col gap-6 w-full max-w-2xl mx-auto';
            container.appendChild(pane);
        }
        pane.innerHTML = '';

        const curConfig = controller.currentConfig || {
            enabled: false,
            type: 'socks5',
            host: '',
            port: 0,
            username: '',
            password: '',
            bypass: '<local>;127.0.0.1;localhost;::1'
        };

        let isEnabled = Boolean(curConfig.enabled);
        let selectedType = (curConfig.type || 'socks5').toLowerCase().startsWith('socks') ? 'socks5' : 'http';

        // 1. Header
        const header = document.createElement('div');
        header.className = 'flex flex-col gap-2 w-full mb-2 bg-transparent';
        header.innerHTML = `
            <div class="flex justify-between items-start gap-4 w-full bg-transparent pr-8 lg:pr-0">
                <div class="flex-1 flex flex-col gap-1 min-w-0 bg-transparent">
                    <h2 class="text-xl m-0 font-medium truncate flex-1 text-foreground">${_t('proxy.title', 'Proxy')}</h2>
                    <div class="text-sm text-muted-foreground bg-transparent">
                        ${_t('proxy.subtitle', 'Route network traffic through a third-party SOCKS5 or HTTP(S) proxy server.')}
                    </div>
                </div>
            </div>
        `;
        pane.appendChild(header);

        // 2. Section: Основные параметры (Enable switch & Protocol pills)
        const mainSection = document.createElement('div');
        mainSection.className = 'space-y-2';
        mainSection.innerHTML = `
            <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <h3 class="m-0 text-sm font-medium text-foreground">${_t('proxy.main_section', 'Main Settings')}</h3>
                    </div>
                </div>
            </div>
            <div>
                <div class="bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border">
                    <div class="py-2.5 px-3 w-full bg-transparent flex justify-between gap-4 items-center">
                        <div class="flex-1 flex flex-col gap-0.5">
                            <div class="flex items-center gap-1.5">
                                <span class="text-sm font-medium text-foreground">${_t('proxy.enable_label', 'Enable Proxy')}</span>
                            </div>
                            <span class="text-xs text-muted-foreground">${_t('proxy.enable_desc', 'Route language server and model traffic through proxy.')}</span>
                        </div>
                        <div class="shrink-0">
                            <button type="button" role="switch" id="agy-proxy-toggle-switch" aria-checked="${isEnabled ? 'true' : 'false'}" class="relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out shrink-0 h-6 w-11 ${isEnabled ? 'bg-primary' : 'bg-secondary'} cursor-pointer">
                                <span id="agy-proxy-toggle-thumb" class="inline-block rounded-full bg-white transition-transform duration-200 ease-in-out shadow-sm h-4 w-4" style="transform: ${isEnabled ? 'translateX(24px)' : 'translateX(4px)'};"></span>
                            </button>
                        </div>
                    </div>
                    <div class="py-2.5 px-3 w-full bg-transparent flex justify-between gap-4 items-center">
                        <div class="flex-1 flex flex-col gap-0.5">
                            <span class="text-sm font-medium text-foreground">${_t('proxy.protocol_label', 'Protocol')}</span>
                            <span class="text-xs text-muted-foreground">${_t('proxy.protocol_desc', 'SOCKS5 with remote DNS (RFC 1928/1929) or HTTP CONNECT with TLS.')}</span>
                        </div>
                        <div class="flex items-center gap-1 bg-muted p-1 rounded-lg border border-border shrink-0">
                            <button type="button" id="agy-proxy-pill-socks5" class="px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none ${selectedType === 'socks5' ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-transparent text-muted-foreground hover:text-foreground'}">SOCKS5</button>
                            <button type="button" id="agy-proxy-pill-http" class="px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none ${selectedType === 'http' ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-transparent text-muted-foreground hover:text-foreground'}">HTTP(S)</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        pane.appendChild(mainSection);

        // 3. Section: Быстрая вставка (Quick-Paste)
        const quickSection = document.createElement('div');
        quickSection.className = 'space-y-2';
        quickSection.innerHTML = `
            <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <h3 class="m-0 text-sm font-medium text-foreground">${_t('proxy.quick_paste', 'Quick Paste')}</h3>
                    </div>
                </div>
            </div>
            <div>
                <div class="bg-transparent rounded-xl border border-border overflow-hidden p-3 flex flex-col gap-2">
                    <span class="text-xs text-muted-foreground">${_t('proxy.quick_paste_desc', 'Paste proxy string (supports: <code class="bg-muted px-1.5 py-0.5 rounded text-foreground font-mono text-[11px]">socks5://user:pass@host:port</code> or <code class="bg-muted px-1.5 py-0.5 rounded text-foreground font-mono text-[11px]">host:port:user:pass</code>):')}</span>
                    <div class="flex items-center gap-2">
                        <input type="text" id="agy-proxy-quick-paste" placeholder="${_t('proxy.quick_paste_placeholder', 'Paste proxy string here...')}" class="flex-1 text-sm bg-muted border border-border text-foreground px-3 py-1.5 rounded-lg focus:outline-none focus:border-primary placeholder:text-muted-foreground transition-colors" />
                        <button type="button" id="agy-proxy-quick-paste-btn" class="inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-8 text-sm rounded-lg gap-1.5 px-3 shrink-0">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
                            <span>${_t('proxy.paste_btn', 'Paste')}</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
        pane.appendChild(quickSection);

        // 4. Section: Параметры подключения (Host, Port, User, Pass, Bypass)
        const connSection = document.createElement('div');
        connSection.className = 'space-y-2';
        connSection.innerHTML = `
            <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <h3 class="m-0 text-sm font-medium text-foreground">${_t('proxy.server_section', 'Connection Settings')}</h3>
                    </div>
                </div>
            </div>
            <div>
                <div class="bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border">
                    <div class="py-2.5 px-3 w-full bg-transparent flex flex-col sm:flex-row gap-3 items-center">
                        <div class="flex-1 w-full flex flex-col gap-1">
                            <label class="text-xs font-medium text-muted-foreground">${_t('proxy.host_label', 'Host / IP')}</label>
                            <input type="text" id="agy-proxy-host" placeholder="${_t('proxy.host_placeholder', 'proxy.example.com or 192.168.1.100')}" class="text-sm bg-muted border border-border text-foreground px-3 py-1.5 rounded-lg focus:outline-none focus:border-primary placeholder:text-muted-foreground transition-colors w-full" />
                        </div>
                        <div class="w-full sm:w-28 flex flex-col gap-1">
                            <label class="text-xs font-medium text-muted-foreground">${_t('proxy.port_label', 'Port')}</label>
                            <input type="number" id="agy-proxy-port" placeholder="1080" min="1" max="65535" class="text-sm bg-muted border border-border text-foreground px-3 py-1.5 rounded-lg focus:outline-none focus:border-primary placeholder:text-muted-foreground transition-colors w-full" />
                        </div>
                    </div>

                    <div class="py-2.5 px-3 w-full bg-transparent flex flex-col sm:flex-row gap-3 items-center">
                        <div class="flex-1 w-full flex flex-col gap-1">
                            <label class="text-xs font-medium text-muted-foreground">${_t('proxy.username_label', 'Username')}</label>
                            <input type="text" id="agy-proxy-username" placeholder="${_t('proxy.username_placeholder', 'Username (optional)')}" class="text-sm bg-muted border border-border text-foreground px-3 py-1.5 rounded-lg focus:outline-none focus:border-primary placeholder:text-muted-foreground transition-colors w-full" />
                        </div>
                        <div class="flex-1 w-full flex flex-col gap-1">
                            <label class="text-xs font-medium text-muted-foreground">${_t('proxy.password_label', 'Password')}</label>
                            <div class="relative flex items-center">
                                <input type="password" id="agy-proxy-password" placeholder="${_t('proxy.password_placeholder', 'Password (optional)')}" class="text-sm bg-muted border border-border text-foreground pl-3 pr-9 py-1.5 rounded-lg focus:outline-none focus:border-primary placeholder:text-muted-foreground transition-colors w-full" />
                                <button type="button" id="agy-proxy-pwd-toggle" class="absolute right-2 text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-1 flex items-center justify-center transition-colors" title="${_t('proxy.pwd_toggle_title', 'Show/hide password')}">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                        <circle cx="12" cy="12" r="3"></circle>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="py-2.5 px-3 w-full bg-transparent flex flex-col gap-1">
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-medium text-muted-foreground">${_t('proxy.bypass_section', 'Bypass List')}</span>
                            <span class="text-[11px] text-muted-foreground">${_t('proxy.bypass_hint', 'Separator is semicolon (;)')}</span>
                        </div>
                        <input type="text" id="agy-proxy-bypass" class="text-sm bg-muted border border-border text-foreground px-3 py-1.5 rounded-lg focus:outline-none focus:border-primary placeholder:text-muted-foreground transition-colors w-full" />
                        <span class="text-[11px] text-muted-foreground">${_t('proxy.bypass_desc', 'Local addresses <local>;127.0.0.1;localhost;::1 are protected and cannot be disabled.')}</span>
                    </div>
                </div>
            </div>
        `;
        pane.appendChild(connSection);

        // 5. Status Result Box
        const statusBox = document.createElement('div');
        statusBox.id = 'agy-proxy-status-box';
        statusBox.style.display = 'none';
        pane.appendChild(statusBox);

        // 6. Restart Banner Container
        const bannerContainer = document.createElement('div');
        bannerContainer.id = 'agy-proxy-banner-container';
        pane.appendChild(bannerContainer);

        // 7. Actions Row
        const actionsRow = document.createElement('div');
        actionsRow.className = 'flex items-center justify-between gap-3 pt-2';
        actionsRow.innerHTML = `
            <button type="button" id="agy-proxy-test-btn" class="inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-8 text-sm rounded-lg gap-1.5 px-3">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                <span>${_t('proxy.test_btn', 'Test Connection')}</span>
            </button>
            <div class="flex items-center gap-2">
                <button type="button" id="agy-proxy-save-btn" class="inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-primary text-primary-foreground hover:opacity-90 shadow-sm border-none h-8 text-sm rounded-lg gap-1.5 px-4">
                    ${_t('proxy.save_btn', 'Save Settings')}
                </button>
            </div>
        `;
        pane.appendChild(actionsRow);

        // --- Elements & Event Binding ---
        const switchBtn = pane.querySelector('#agy-proxy-toggle-switch');
        const switchThumb = pane.querySelector('#agy-proxy-toggle-thumb');
        const socksPill = pane.querySelector('#agy-proxy-pill-socks5');
        const httpPill = pane.querySelector('#agy-proxy-pill-http');
        const quickInput = pane.querySelector('#agy-proxy-quick-paste');
        const quickBtn = pane.querySelector('#agy-proxy-quick-paste-btn');
        const hostInput = pane.querySelector('#agy-proxy-host');
        const portInput = pane.querySelector('#agy-proxy-port');
        const userInput = pane.querySelector('#agy-proxy-username');
        const passInput = pane.querySelector('#agy-proxy-password');
        const pwdToggle = pane.querySelector('#agy-proxy-pwd-toggle');
        const bypassInput = pane.querySelector('#agy-proxy-bypass');
        const testBtn = pane.querySelector('#agy-proxy-test-btn');
        const saveBtn = pane.querySelector('#agy-proxy-save-btn');

        // Safe property assignment (immune to quote injection in passwords/usernames)
        hostInput.value = curConfig.host || '';
        portInput.value = curConfig.port ? String(curConfig.port) : '';
        userInput.value = curConfig.username || '';
        passInput.value = curConfig.password || '';
        bypassInput.value = curConfig.bypass || '<local>;127.0.0.1;localhost;::1';

        // Toggle Switch UI update
        function updateSwitchUI() {
            switchBtn.setAttribute('aria-checked', isEnabled ? 'true' : 'false');
            if (isEnabled) {
                switchBtn.classList.remove('bg-secondary');
                switchBtn.classList.add('bg-primary');
                switchThumb.style.transform = 'translateX(24px)';
            } else {
                switchBtn.classList.remove('bg-primary');
                switchBtn.classList.add('bg-secondary');
                switchThumb.style.transform = 'translateX(4px)';
            }
        }

        switchBtn.onclick = () => {
            isEnabled = !isEnabled;
            updateSwitchUI();
        };

        // Protocol Pills UI update
        function updatePillsUI(type) {
            selectedType = type;
            if (type === 'socks5') {
                socksPill.className = 'px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none bg-primary text-primary-foreground shadow-sm';
                httpPill.className = 'px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none bg-transparent text-muted-foreground hover:text-foreground';
            } else {
                httpPill.className = 'px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none bg-primary text-primary-foreground shadow-sm';
                socksPill.className = 'px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none bg-transparent text-muted-foreground hover:text-foreground';
            }
        }

        socksPill.onclick = () => updatePillsUI('socks5');
        httpPill.onclick = () => updatePillsUI('http');

        // Quick-Paste execution
        function applyQuickPaste(val) {
            if (!val) return;
            const parsed = ProxyController.parseQuickPaste(val);
            if (parsed) {
                updatePillsUI(parsed.type);
                hostInput.value = parsed.host;
                portInput.value = parsed.port;
                userInput.value = parsed.username || '';
                passInput.value = parsed.password || '';
                isEnabled = true;
                updateSwitchUI();
                showStatus(statusBox, 'info', _t('proxy.parsed_info', { type: parsed.type.toUpperCase(), host: parsed.host, port: parsed.port }, `✓ Recognized: ${parsed.type.toUpperCase()} ${parsed.host}:${parsed.port}`));
            } else {
                showStatus(statusBox, 'error', _t('proxy.parse_error', 'Failed to recognize proxy string format'));
            }
        }

        quickInput.addEventListener('input', () => {
            if (quickInput.value.trim()) {
                applyQuickPaste(quickInput.value.trim());
            }
        });

        quickBtn.onclick = async () => {
            try {
                if (navigator.clipboard && navigator.clipboard.readText) {
                    const clip = await navigator.clipboard.readText();
                    if (clip && clip.trim()) {
                        quickInput.value = clip.trim();
                        applyQuickPaste(clip.trim());
                        return;
                    }
                }
            } catch (_) {}
            if (quickInput.value.trim()) {
                applyQuickPaste(quickInput.value.trim());
            }
        };

        // Password Show/Hide toggle
        pwdToggle.onclick = () => {
            passInput.type = passInput.type === 'password' ? 'text' : 'password';
        };

        // Test connection
        testBtn.onclick = async () => {
            const candidate = {
                enabled: true,
                type: selectedType,
                host: hostInput.value.trim(),
                port: parseInt(portInput.value, 10) || 0,
                username: userInput.value.trim(),
                password: passInput.value
            };

            if (!candidate.host || !candidate.port) {
                showStatus(statusBox, 'error', _t('proxy.host_port_required', 'Specify host and port to test connection'));
                return;
            }

            testBtn.disabled = true;
            testBtn.innerHTML = '<span class="agy-proxy-spinner"></span> <span>' + _t('proxy.testing', 'Testing...') + '</span>';
            showStatus(statusBox, 'info', _t('proxy.connecting_to', { type: candidate.type.toUpperCase(), host: candidate.host, port: candidate.port }, `Connecting to Google CloudCode via ${candidate.type.toUpperCase()} ${candidate.host}:${candidate.port}...`));

            const res = await controller.testConnection(candidate);
            testBtn.disabled = false;
            testBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                <span>${_t('proxy.test_btn', 'Test Connection')}</span>
            `;

            if (res && res.success) {
                showStatus(statusBox, 'success', _t('proxy.test_success', { ms: res.latencyMs, ip: res.ip }, `✓ Connection successful! (Latency: ${res.latencyMs}ms)`));
            } else {
                showStatus(statusBox, 'error', _t('proxy.test_error', { error: res ? res.error : 'No response' }, `✗ Connection error: ${res ? res.error : 'No response'}`));
            }
        };

        // Save configuration
        saveBtn.onclick = async () => {
            const configToSave = {
                enabled: isEnabled,
                type: selectedType,
                host: hostInput.value.trim(),
                port: parseInt(portInput.value, 10) || 0,
                username: userInput.value.trim(),
                password: passInput.value,
                bypass: bypassInput.value.trim() || '<local>;127.0.0.1;localhost;::1'
            };

            if (configToSave.enabled && (!configToSave.host || !configToSave.port)) {
                showStatus(statusBox, 'error', _t('proxy.enable_requires_host_port', 'To enable proxy, specify host and port'));
                return;
            }

            saveBtn.disabled = true;
            saveBtn.innerHTML = '<span class="agy-proxy-spinner"></span> <span>' + _t('proxy.saving', 'Saving...') + '</span>';

            const res = await controller.saveConfig(configToSave);
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<span>' + _t('proxy.save_btn', 'Save Settings') + '</span>';

            if (res && res.success) {
                showStatus(statusBox, 'success', _t('proxy.saved', '✓ Proxy settings successfully saved and applied!'));
                showRestartBanner(bannerContainer, _t('proxy.restart_notice', 'Settings saved. Restart Antigravity to apply environment variables in language_server.'), controller);
            } else {
                showStatus(statusBox, 'error', _t('proxy.save_error', { error: res ? res.error : 'Unknown error' }, `✗ Save error: ${res ? res.error : 'Unknown error'}`));
            }
        };

        function showStatus(el, type, text) {
            el.style.display = 'flex';
            if (type === 'success') {
                el.className = 'text-xs py-2.5 px-3 rounded-lg border bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400 font-medium flex items-center gap-2';
            } else if (type === 'error') {
                el.className = 'text-xs py-2.5 px-3 rounded-lg border bg-destructive/10 border-destructive/30 text-destructive font-medium flex items-center gap-2';
            } else {
                el.className = 'text-xs py-2.5 px-3 rounded-lg border bg-secondary border-border text-foreground flex items-center gap-2';
            }
            el.textContent = text;
        }

        function showRestartBanner(c, msg, ctrl) {
            const renderFn = (typeof renderRestartBanner === 'function')
                ? renderRestartBanner
                : ((typeof require !== 'undefined') ? require('../ui/restart_banner.js').renderRestartBanner : null);
            if (renderFn) {
                renderFn(c, {
                    message: msg,
                    controller: ctrl,
                    styleVariant: 'tailwind',
                    bannerId: 'agy-proxy-restart-banner',
                    buttonText: _t('proxy.restart_btn', 'Restart')
                });
            }
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ProxyDomBuilder };
}
