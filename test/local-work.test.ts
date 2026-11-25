import { expect, test } from "bun:test";
import { LocalWork } from "../src/scheduling/local-work.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("local work sleeps without a deadline and coalesces input wakeups", async () => {
  let calls = 0;
  const work = new LocalWork(Date.now, () => {
    calls++;
    return undefined;
  });
  try {
    work.start();
    expect(calls).toBe(1);
    await sleep(120);
    expect(calls).toBe(1);
    work.wake();
    work.wake();
    work.wake();
    await sleep(20);
    expect(calls).toBe(2);
    work.close();
    work.wake();
    await sleep(20);
    expect(calls).toBe(2);
  } finally {
    work.close();
  }
});

test("local work wakes at its clock deadline and absorbs writes made during a pass", async () => {
  const deadline = Date.now() + 100;
  const observed: number[] = [];
  const work = new LocalWork(Date.now, () => {
    observed.push(Date.now());
    work.wake();
    return observed.length === 1 ? deadline : undefined;
  });
  try {
    work.start();
    await sleep(30);
    expect(observed).toHaveLength(1);
    await sleep(100);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toBeGreaterThanOrEqual(deadline);
    await sleep(30);
    expect(observed).toHaveLength(2);
  } finally {
    work.close();
  }
});
