
export class Resolvable<T> {
  private resolveFunc = (value: T) => {}
  private rejectFunc = (reason?: any) => {}
  private readonly promiseField: Promise<T>;
  private completedField = false;

  constructor() {
    this.promiseField = new Promise<T>((resolve, reject) => { this.resolveFunc = resolve; this.rejectFunc = reject; });
    this.promiseField.finally(() => {this.completedField = true;});
  }

  get completed(): boolean {
    return this.completedField;
  }

  resolve(value: T) {
    this.resolveFunc(value);
  }

  reject(reason?: any) {
    this.rejectFunc(reason);
  }

  get promise(): Promise<T> {
    return this.promiseField;
  }

  get callable(): (value: T) => void {
    return this.resolveFunc;
  }
}

export class WaitableFlag {
  private flag = new Resolvable<void>();

  constructor() {
  }

  async wait() {
    await this.flag.promise;
    this.flag = new Resolvable<void>();
  }

  set() {
    this.flag.resolve();
  }
}

export class OperationQueue {
  private head = Promise.resolve();

  async push<TResult>(op: () => TResult | PromiseLike<TResult>): Promise<TResult> {
    const result = new Resolvable<TResult>();
    this.head = this.head.then(async () => {
      result.resolve(await op());
    }).catch(e => {
      result.reject(e);
    });
    return result.promise;
  }
}

export type BatchedConsumerFunc<T> = (produced: T[]) => void | PromiseLike<void>;
export type BatchedConsumerThenFunc = () => void | PromiseLike<void>;

export class BatchedProducerConsumerFlow<T> {
  private consumerOp: Promise<void>;
  private consumer = multicast<BatchedConsumerFunc<T>>();
  private batchInProduction: T[] = [];

  constructor(public batchSize: number) {
    // Make this starts as an async op so that `then` doesn't complete immediately.
    this.consumerOp = sleep(0);
  }

  consume(consumer: BatchedConsumerFunc<T>) {
    this.consumer.add(consumer);
  }

  produce(value: T) {
    this.batchInProduction.push(value);
    if (this.batchInProduction.length >= this.batchSize) {
      this.flushProduced();
    }
  }

  flushProduced() {
    if (this.batchInProduction.length <= 0) {
      return;
    }
    const batchToConsume = this.batchInProduction;
    this.batchInProduction = [];

    this.consumerThen(async () => {
      await this.consumer(batchToConsume);
    });
  }

  consumerThen(task: BatchedConsumerThenFunc) {
    const oldConsumerOp = this.consumerOp;
    this.consumerOp = oldConsumerOp.then(task);
  }

  async join(abort = false) {
    if (!abort) {
      this.flushProduced();
    }
    await this.consumer;
  }
}

export class AsyncProducerConsumerQueue<T> {
  private readonly queued: T[] = [];
  private readonly flag = new WaitableFlag();

  add(value: T) {
    this.queued.push(value);
    this.flag.set();
  }

  addRange(values: T[]) {
    this.queued.push(...values);
    this.flag.set();
  }

  async pop(): Promise<T> {
    while (this.queued.length <= 0) {
      await this.flag.wait();
    }
    return this.queued.splice(0, 1)[0];
  }
}

export class LruCache<TKey, TValue> {
  private readonly values = new Map<TKey, TValue>();

  constructor(public readonly maxEntries: number) {}

  get(key: TKey): TValue|undefined {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // peek the entry, re-insert for LRU strategy
    this.values.delete(key);
    this.values.set(key, entry);
    return entry;
  }

  put(key: TKey, value: TValue) {
    if (this.values.size >= this.maxEntries) {
      // least-recently used cache eviction strategy
      const keyToDelete = this.values.keys().next().value;
      this.values.delete(keyToDelete);
    }
    this.values.set(key, value);
  }

  clear() {
    this.values.clear();
  }
}

export interface Subscribable<TFunc extends Function> {
  add(handler: TFunc): void;
  remove(handler: TFunc): void;
}

export type Multicast<TFunc extends Function> = Subscribable<TFunc> & TFunc;

export function multicast<TFunc extends Function>(...handlers: TFunc[]): Multicast<TFunc> {
  handlers = Array.from(handlers);

  const subscribable: Subscribable<TFunc> = {
    add(handler) {
      handlers.push(handler);
    },
    remove(handler) {
      handlers = handlers.filter(h => h !== handler);
    }
  };

  const invoke: TFunc = ((...args: any[]) => {
    let result: any;
    handlers.forEach(handler => result = handler.apply(null, args));
    return result;
  }) as any;
  return merge(invoke, subscribable);
}

export function sleep(delayMillis: number): Promise<void> {
  return new Promise(resolve => { setInterval(resolve, delayMillis); });
}

export function parseIntOr(str: string|undefined, defaultValue?: number) {
  if (str === undefined) {
    return defaultValue;
  }
  const result = parseInt(str);
  if (Number.isNaN(result)) {
    return defaultValue;
  }
  return result;
}

export function formatDuration(durationSeconds: number|undefined): string {
  if (durationSeconds === undefined) {
    return '';
  }
  const signStr = durationSeconds < 0 ? '-' : '';
  const totalSeconds = Math.trunc(Math.abs(durationSeconds)) || 0;
  const seconds = Math.trunc(totalSeconds % 60) || 0;
  const totalMinutes = Math.trunc(totalSeconds / 60) || 0;
  const minutes = Math.trunc(totalMinutes % 60) || 0;
  const totalHours = Math.trunc(totalMinutes / 60) || 0;
  const hours = totalHours;
  if (hours > 0) {
    return `${signStr}${hours}:${formatIntPadded(minutes, 2)}:${formatIntPadded(seconds, 2)}`;
  }
  return `${signStr}${minutes}:${formatIntPadded(seconds, 2)}`;
}

export function formatIntPadded(value: number, minDigits: number): string {
  const signStr = value < 0 ? '-' : '';
  const absValue = Math.abs(value) || 0;
  let str = absValue.toString();
  while (str.length < minDigits) {
    str = '0' + str;
  }
  return str;
}

export function filePathWithoutExtension(path: string): string {
  const splitIndex = path.lastIndexOf('.');
  if (splitIndex < 0) {
    return path;
  }
  return path.slice(0, splitIndex);
}

export function* mapAll<TIn, TOut>(values: Iterable<TIn>, callback: (value: TIn) => Iterable<TOut>|undefined) {
  for (const value of values) {
    const valueResult = callback(value);
    if (valueResult === undefined) {
      continue;
    }
    for (const result of valueResult) {
      yield result;
    }
  }
}

export function setAddRange<T>(set: Set<T>, values: Iterable<T>) {
  for (const value of values) {
    set.add(value);
  }
}

export function merge<T1 extends object, T2 extends object>(onto: T1, from: T2): T1 & T2 {
  if (typeof from !== "object" || from instanceof Array) {
      throw new Error("merge: 'from' must be an ordinary object");
  }
  Object.keys(from).forEach(key => (onto as any)[key] = (from as any)[key]);
  return onto as T1 & T2;
}
