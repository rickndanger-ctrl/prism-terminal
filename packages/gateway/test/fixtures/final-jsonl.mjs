import process from 'node:process';

process.stdout.write(JSON.stringify({ id: 99, result: 'final message' }));
