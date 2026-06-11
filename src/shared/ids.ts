import { randomUUID } from 'node:crypto';

export type IdGenerator = (prefix: string) => string;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
