import {
  afterEach,
  beforeEach,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { WorkScheduler } from "../src/scheduling/work.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function microtasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1000 });
});
afterEach(() => {
  mock.restore();
  jest.useRealTimers();
});

test("registered tasks create no idle timer and duplicate keys fail", async () => {
  const timer = spyOn(globalThis, "setTimeout"),
    work = mock(() => {});
  const scheduler = new WorkScheduler();
  try {
    const task = scheduler.task("idle", work);
    scheduler.start();
    jest.advanceTimersByTime(60000);
    expect(timer).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(() => scheduler.task("idle", work)).toThrow(
      "Duplicate scheduled task: idle",
    );
    task.close();
    task.wake();
    task.runNow();
    task.at(Date.now());
    expect(jest.getTimerCount()).toBe(0);
    expect(work).not.toHaveBeenCalled();
  } finally {
    await scheduler.close();
  }
});

test("one clock selects the earliest deadline and safely rearms long deadlines", async () => {
  const observed: string[] = [],
    scheduler = new WorkScheduler();
  const timer = spyOn(globalThis, "setTimeout");
  const first = scheduler.task("first", () => {
    observed.push("first");
  });
  const second = scheduler.task("second", () => {
    observed.push("second");
  });
  const long = scheduler.task("long", () => {
    observed.push("long");
  });
  try {
    first.at(1030);
    second.at(1020);
    long.at(1000 + 2147483647 + 100);
    scheduler.start();
    expect(jest.getTimerCount()).toBe(1);
    first.at(1010);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(10);
    expect(observed).toEqual(["first"]);
    jest.advanceTimersByTime(10);
    expect(observed).toEqual(["first", "second"]);
    expect(timer.mock.calls.at(-1)?.[1]).toBe(2147483647);
    jest.advanceTimersByTime(2147483647);
    expect(observed).toEqual(["first", "second"]);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(79);
    expect(observed).toEqual(["first", "second"]);
    jest.advanceTimersByTime(1);
    expect(observed).toEqual(["first", "second", "long"]);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    await scheduler.close();
  }
});

test("input wakes coalesce before start and while asynchronous work is in flight", async () => {
  const blocked = gate(),
    scheduler = new WorkScheduler();
  let calls = 0,
    active = 0,
    maximum = 0;
  const task = scheduler.task("input", async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    try {
      if (calls === 1) {
        await blocked.promise;
        return Date.now() + 1000;
      }
      return undefined;
    } finally {
      active--;
    }
  });
  try {
    task.wake();
    task.wake();
    task.wake();
    expect(jest.getTimerCount()).toBe(0);
    scheduler.start();
    jest.advanceTimersByTime(0);
    expect(calls).toBe(1);
    task.wake();
    task.wake();
    task.runNow();
    expect(calls).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
    blocked.release();
    await microtasks();
    jest.advanceTimersByTime(0);
    await microtasks();
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
    jest.advanceTimersByTime(1000);
    expect(calls).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    blocked.release();
    await scheduler.close();
  }
});

test("a stalled key does not block other keys or create a second clock", async () => {
  const blocked = gate(),
    scheduler = new WorkScheduler();
  let fastCalls = 0;
  const slow = scheduler.task("slow", () => blocked.promise);
  const fast = scheduler.task("fast", () => {
    fastCalls++;
  });
  try {
    slow.wake();
    fast.wake();
    scheduler.start();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(0);
    expect(fastCalls).toBe(1);
    fast.at(Date.now() + 50);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(50);
    expect(fastCalls).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    blocked.release();
    await scheduler.close();
  }
});

test("failed work backs off even when it wakes itself and the error reporter throws", async () => {
  let calls = 0,
    now = 1000;
  const errors: string[] = [];
  const scheduler = new WorkScheduler(
    () => now,
    (key) => {
      errors.push(key);
      if (errors.length === 1) throw new Error("Reporter failed");
      return Promise.reject(new Error("Asynchronous reporter failed"));
    },
  );
  const task = scheduler.task("failing", () => {
    calls++;
    if (calls < 3) {
      task.wake();
      if (calls === 1) throw new Error("Synchronous failure");
      return Promise.reject(new Error("Asynchronous failure"));
    }
    return undefined;
  });
  try {
    task.wake();
    scheduler.start();
    jest.advanceTimersByTime(0);
    expect(calls).toBe(1);
    expect(errors).toEqual(["failing"]);
    now += 4999;
    jest.advanceTimersByTime(4999);
    expect(calls).toBe(1);
    now += 1;
    jest.advanceTimersByTime(1);
    await microtasks();
    expect(calls).toBe(2);
    expect(errors).toEqual(["failing", "failing"]);
    now += 5000;
    task.wake();
    jest.advanceTimersByTime(0);
    expect(calls).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    await scheduler.close();
  }
});

test("explicit deadlines and cancellations made during work outrank returned plans", async () => {
  const blocked = gate(),
    cancelled = gate(),
    scheduler = new WorkScheduler();
  let calls = 0,
    cancelledCalls = 0;
  const task = scheduler.task("earlier", async () => {
    calls++;
    if (calls === 1) {
      await blocked.promise;
      return Date.now() + 1000;
    }
    return undefined;
  });
  const cancel = scheduler.task("cancel", async () => {
    cancelledCalls++;
    await cancelled.promise;
    return Date.now() + 1000;
  });
  try {
    task.wake();
    cancel.wake();
    scheduler.start();
    jest.advanceTimersByTime(0);
    task.at(Date.now() + 40);
    cancel.at(undefined);
    blocked.release();
    cancelled.release();
    await microtasks();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(39);
    expect(calls).toBe(1);
    jest.advanceTimersByTime(1);
    await microtasks();
    expect(calls).toBe(2);
    expect(cancelledCalls).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    blocked.release();
    cancelled.release();
    await scheduler.close();
  }
});

test("stop discards queued work and late completions while close joins active work", async () => {
  const blocked = gate(),
    scheduler = new WorkScheduler();
  let calls = 0,
    otherCalls = 0,
    closed = false;
  const task = scheduler.task("running", async () => {
    calls++;
    await blocked.promise;
    return Date.now();
  });
  const other = scheduler.task("queued", () => {
    otherCalls++;
  });
  try {
    task.wake();
    scheduler.start();
    jest.advanceTimersByTime(0);
    other.wake();
    scheduler.stop();
    expect(jest.getTimerCount()).toBe(0);
    scheduler.start();
    blocked.release();
    await microtasks();
    expect(jest.getTimerCount()).toBe(0);
    expect(calls).toBe(1);
    expect(otherCalls).toBe(0);
    const second = gate();
    const pending = scheduler.task("closing", () => second.promise);
    pending.runNow();
    const finish = scheduler.close().then(() => {
      closed = true;
    });
    await microtasks();
    expect(closed).toBe(false);
    task.wake();
    task.runNow();
    other.at(Date.now());
    second.release();
    await finish;
    expect(closed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(calls).toBe(1);
    expect(otherCalls).toBe(0);
    expect(() => scheduler.task("resurrect", () => {})).toThrow(
      "Work scheduler is closed",
    );
  } finally {
    blocked.release();
    await scheduler.close();
  }
});

test("manual synchronous work runs before start and a void observer executes it once", async () => {
  let calls = 0;
  const observed: string[] = [];
  const scheduler = new WorkScheduler(Date.now, undefined, (key, work) => {
    observed.push(key);
    return work();
  });
  const task = scheduler.task("manual", () => {
    calls++;
    return calls === 1 ? Date.now() + 10 : undefined;
  });
  try {
    task.runNow();
    expect(calls).toBe(1);
    expect(observed).toEqual(["manual"]);
    expect(jest.getTimerCount()).toBe(0);
    scheduler.start();
    jest.advanceTimersByTime(10);
    expect(calls).toBe(2);
    expect(observed).toEqual(["manual", "manual"]);
    expect(jest.getTimerCount()).toBe(0);
    expect(() => {
      task.at(NaN);
    }).toThrow("Scheduled deadline must be finite or undefined");
  } finally {
    await scheduler.close();
  }
});
