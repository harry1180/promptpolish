
const uas = ['Mozilla/5.0', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'];
for (const ua of uas) {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/MSFT?range=2y&interval=1d', { headers: { 'user-agent': ua, accept: 'application/json' } });
    console.log('node fetch', ua.slice(0, 20), '->', res.status);
  } catch (e) { console.log('node fetch', ua.slice(0, 20), 'THREW', (e as Error).message); }
  await new Promise((r) => setTimeout(r, 800));
}
process.exit(0);
