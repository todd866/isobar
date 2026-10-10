import type { Browser } from 'playwright-core';
export function chromePath(): string | null;
export function launch(): Promise<Browser | null>;
