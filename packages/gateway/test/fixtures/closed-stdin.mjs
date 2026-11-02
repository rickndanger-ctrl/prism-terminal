import { closeSync } from 'node:fs';
import process from 'node:process';
import { setInterval } from 'node:timers';

closeSync(0);
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
setInterval(() => undefined, 1_000);
