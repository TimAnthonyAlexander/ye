export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
}

export const deferred = <T>(): Deferred<T> => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
