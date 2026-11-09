import { Coordinator } from '../dist/coordinator.js';
const coordinator = new Coordinator(process.argv[2], { workerPath: new URL('./fake-worker.mjs', import.meta.url).pathname, workerEnv: { PG_TEST_MODE: 'resolve' }, reviewReader: async url => ({ url, title: 'Controlled PR', state: 'open', headSha: 'controlled', observedAtMs: 1234, messages: [{ id: 'review:1', url, author: 'reviewer', kind: 'review', state: 'APPROVED', bodyMarkdown: 'Looks good', atMs: 1233, path: '', commitSha: 'controlled', bodyTruncated: false }], mayHaveMoreMessages: false }) });
await coordinator.start();
coordinator.command({ op: 'pause' });
console.log(JSON.stringify({ ready: true }));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void coordinator.close().then(() => process.exit(0)); });
