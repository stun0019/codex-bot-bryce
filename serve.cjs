const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const baseUrl = 'https://open-api.bingx.com/openApi/swap';
const port = Number(process.env.PORT || 8765);

async function getMarketData(endpoint) {
  const response = await fetch(`${baseUrl}/${endpoint}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`BingX HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 0 || !Array.isArray(result.data)) {
    throw new Error(`BingX 資料錯誤（${result.code ?? '未知代碼'}）`);
  }
  return result.data;
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return;
  }

  try {
    if (request.url === '/' || request.url === '/index.html') {
      const page = await readFile(path.join(__dirname, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
    } else if (request.url === '/api/markets') {
      const [tickers, schedule] = await Promise.all([
        getMarketData('v2/quote/ticker'),
        getMarketData('v1/quote/tradingSchedule'),
      ]);
      const classifications = schedule.map(({ symbol, contractType }) => ({ symbol, contractType }));
      const quotes = tickers.map(({ symbol, lastPrice, priceChangePercent, quoteVolume }) => (
        { symbol, lastPrice, priceChangePercent, quoteVolume }
      ));
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ quotes, classifications, fetchedAt: Date.now() }));
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error(error);
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BingX 行情榜 http://127.0.0.1:${port}/`);
});
