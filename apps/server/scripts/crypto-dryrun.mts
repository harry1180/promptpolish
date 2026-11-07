/**
 * Dry run: what does ONE production scan emit at a given confidence floor?
 * Writes only to a COPY of crypto.db (pass CRYPTO_DB), never the live one.
 *
 *   CRYPTO_DB=<copy> CRYPTO_MIN_SIGNAL_CONFIDENCE=0.5 node scripts/crypto-dryrun.mts
 */
import { ensureSpotPortfolio } from '../src/crypto/broker.ts';
import { cryptoConfigFromEnv } from '../src/crypto/config.ts';
import { runCryptoScan } from '../src/crypto/engine.ts';
import { KrakenProvider } from '../src/crypto/providers/kraken-provider.ts';
import { openCryptoDb } from '../src/crypto/schema.ts';

const config = cryptoConfigFromEnv(process.env);
const db = openCryptoDb(process.env.CRYPTO_DB ?? config.dbPath);
ensureSpotPortfolio(db, config);
const provider = new KrakenProvider();

const res = await runCryptoScan({ db, provider, config });
console.log('floor', config.minSignalConfidence, '| weights', JSON.stringify(config.fusionWeights), '| target', config.targetMode);
console.log(JSON.stringify(res, null, 2));
if (res.created.length > 0) {
  console.log('\nwould-be signals:');
  for (const s of res.created) console.log(`  ${s.ticker} ${s.signal} conf=${s.confidence.toFixed(3)} id=${s.id}`);
  const orders = db.prepare(`SELECT ticker, side, qty, limit_price, status FROM paper_orders WHERE status='PENDING'`).all();
  console.log('pending orders:', JSON.stringify(orders));
}
db.close();
