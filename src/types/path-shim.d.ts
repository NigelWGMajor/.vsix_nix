// Minimal path typings to satisfy TypeScript without pulling full @types/node
declare module 'path' {
    export function dirname(p: string): string;
    export function basename(p: string, ext?: string): string;
    export function join(...paths: string[]): string;
}
