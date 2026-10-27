
const { execSync } = require('child_process');

function findAntigravityPorts() {
  const ports = [55972, 56018, 55975, 49961, 49985];
  try {
    if (process.platform === 'win32') {
      const netstat = execSync('netstat -ano', { encoding: 'utf8' });
      const tasklist = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /FO CSV /NH', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of tasklist.split('\n')) {
        const parts = line.split(',');
        if (parts.length >= 2) {
          const pid = parts[1].replace(/"/g, '').trim();
          if (pid) pids.add(pid);
        }
      }
      for (const line of netstat.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const addr = parts[1];
        const pid = parts[4];
        if (pids.has(pid) && addr && addr.startsWith('127.0.0.1:')) {
          const port = parseInt(addr.split(':')[1], 10);
          if (!isNaN(port) && !ports.includes(port)) ports.unshift(port);
        }
      }
    } else if (process.platform === 'linux') {
      try {
        const ssOut = execSync('ss -tlnp 2>/dev/null', { encoding: 'utf8' });
        for (const line of ssOut.split('\n')) {
          const match = line.match(/127\.0\.0\.1:(\d+)/);
          if (match) {
            const port = parseInt(match[1], 10);
            if (!isNaN(port) && !ports.includes(port)) ports.unshift(port);
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return ports;
}

async function getWsUrl() {
  const ports = findAntigravityPorts();
  for (const port of ports) {
    for (const endpoint of ['/json', '/json/list']) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`);
        const list = await res.json();
        const page = list.find(p => p.type === 'page' || (p.url && p.url.includes('/c/')));
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch (e) {}
    }
  }
  throw new Error('No CDP page found on ports: ' + ports.join(', '));
}

async function evaluate(code) {
  const wsUrl = await getWsUrl();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: code,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    };
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id === 1) {
        ws.close();
        if (data.result?.exceptionDetails) {
          reject(new Error('CDP Eval Exception: ' + JSON.stringify(data.result.exceptionDetails)));
        } else {
          resolve(data.result?.result?.value);
        }
      }
    };
    ws.onerror = reject;
  });
}

module.exports = { evaluate, getWsUrl };

if (require.main === module) {
  const code = process.argv[2] || `(() => {
    return Array.from(document.querySelectorAll('*')).filter(el => {
      const t = (el.innerText || '').toLowerCase();
      return t.includes('gemini') || t.includes('flash') || t.includes('pro') || t.includes('high');
    }).map(el => ({
      tag: el.tagName,
      className: typeof el.className === 'string' ? el.className : '',
      text: el.innerText.trim().slice(0, 100),
      rect: el.getBoundingClientRect()
    })).slice(0, 10);
  })()`;
  evaluate(code).then(res => console.log(JSON.stringify(res, null, 2))).catch(console.error);
}
