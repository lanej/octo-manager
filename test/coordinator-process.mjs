import { assembleApplication } from '../dist/application/composition.js';
const assembly = await assembleApplication(process.argv[2], { workerPath: new URL('./fake-worker.mjs', import.meta.url).pathname, workerEnv: { PG_TEST_MODE: process.argv[3] ?? 'hang' } });
const coordinator={store:assembly.store,start:()=>assembly.runtime.start(),close:()=>assembly.runtime.close()};
const save = coordinator.store.save.bind(coordinator.store);
coordinator.store.save = (job, kind, detail) => {
  if (kind === 'worker_started' && process.argv[3] === 'crash-before-pid') process.kill(process.pid, 'SIGKILL');
  save(job, kind, detail);
  if (kind === 'worker_started' && process.argv[3] === 'crash-after-pid') process.kill(process.pid, 'SIGKILL');
};
await coordinator.start();
console.log('ready');
process.on('SIGTERM', () => { void coordinator.close().then(() => process.exit(0)); });
