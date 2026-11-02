import process from 'node:process';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => {
  process.stdout.write(`${JSON.stringify(JSON.parse(line))}\n`);
});
