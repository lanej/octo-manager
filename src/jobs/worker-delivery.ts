export async function sendWorkerResult(value: object, attempt: number): Promise<void> {
  if (!process.connected || process.send === undefined) throw new Error("Worker result channel is disconnected");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.off("message", acknowledge);
      process.off("disconnect", disconnected);
    };
    const acknowledge = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "result_ack" ||
        !("attempt" in message) ||
        message.attempt !== attempt
      )
        return;
      cleanup();
      resolve();
    };
    const disconnected = () => {
      cleanup();
      reject(new Error("Worker result channel disconnected before acknowledgment"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Worker result was not acknowledged"));
    }, 5000);
    process.on("message", acknowledge);
    process.once("disconnect", disconnected);
    process.send?.({ ...value, attempt }, undefined, undefined, (error) => {
      if (error !== null) {
        cleanup();
        reject(error);
      }
    });
  });
}
