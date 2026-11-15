import { sendWorkerResult } from '../src/worker-delivery.ts';
process.once('message', async message => {
  try {
    await sendWorkerResult(message.type === "start" ? message.task.input?.result ?? {type: "done", text: "{}"} : message.result, message.attempt);
    process.exit(0);
  } catch { process.exit(1); }
});
