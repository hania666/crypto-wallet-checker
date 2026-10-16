// The panel in test mode: fixture data from ./data, local chains enabled, port 4778
// (so it never touches the real data/ folder or a panel already running on 4777).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
process.env.WC_TEST = '1';
process.env.WC_DATA_DIR = path.join(DIR, 'data');
process.env.PORT ||= '4778';
await import('../server.js');
