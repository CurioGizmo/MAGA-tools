const { getWsUrl } = require('./inspect_cdp.js');

async function main() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to CDP, enabling Network domain...');
    ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.method === 'Network.requestWillBeSent') {
      const { request } = data.params;
      console.log(`[REQ] ${request.method} ${request.url}`);
    } else if (data.method === 'Network.responseReceived') {
      const { response } = data.params;
      console.log(`[RES] ${response.status} ${response.url} (${response.mimeType})`);
    }
  };

  // Keep running for 30 seconds
  setTimeout(() => {
    console.log('Done monitoring.');
    ws.close();
    process.exit(0);
  }, 15000);
}

main().catch(console.error);
