declare module 'node:test' {
  function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
  }
  const assert: Assert;
  export default assert;
}
