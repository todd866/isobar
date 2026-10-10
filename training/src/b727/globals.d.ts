// Minimal Node declarations for the generator and renderer; the repo carries no @types/node.
declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}

declare const process: { argv: string[] };
