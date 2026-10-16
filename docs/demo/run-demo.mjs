// Panel on demo data (docs/demo/data), port 4779 — your real data/ folder is not touched.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.WC_DATA_DIR = path.join(here, 'data');
process.env.PORT = process.env.PORT || '4779';
await import('../../server.js');
