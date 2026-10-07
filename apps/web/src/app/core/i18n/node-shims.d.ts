/**
 * Minimal ambient typings for the Node built-ins used by the i18n bundle spec
 * (the web tsconfig deliberately has no @types/node; vitest runs the spec in Node).
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare const process: { cwd(): string };
