import { Column, getTableName, is } from 'drizzle-orm';

const entityKind = Symbol.for('drizzle:entityKind');
const Columns = Symbol.for('drizzle:Columns');

export type MemoryRows = Record<string, Array<Record<string, unknown>>>;
export type MemoryFail = { op: 'insert' | 'delete'; table: string } | null;

function kindOf(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const marker = (value as { constructor?: { [entityKind]?: string } }).constructor?.[entityKind];
  return marker ?? '';
}

function columnKey(column: { name: string; table: object }) {
  const columns = (column.table as Record<symbol, Record<string, unknown>>)[Columns];
  for (const [key, value] of Object.entries(columns ?? {})) if (value === column) return key;
  return column.name;
}

function rowMatches(row: Record<string, unknown>, condition: unknown): boolean {
  if (condition == null) return true;
  if (kindOf(condition) !== 'SQL') return true;
  const chunks = (condition as { queryChunks: unknown[] }).queryChunks;
  const operands: unknown[][] = [[]];
  let mode: 'and' | 'or' | null = null;
  for (const chunk of chunks) {
    if (kindOf(chunk) === 'StringChunk') {
      const text = ((chunk as { value: string[] }).value ?? []).join('');
      if (text.includes(' and ')) {
        mode = 'and';
        operands.push([]);
        continue;
      }
      if (text.includes(' or ')) {
        mode = 'or';
        operands.push([]);
        continue;
      }
      if (text.trim() === '' || text.trim() === '(' || text.trim() === ')') continue;
      operands[operands.length - 1]?.push(chunk);
      continue;
    }
    operands[operands.length - 1]?.push(chunk);
  }
  const values = operands.filter((part) => part.length > 0).map((part) => matchOperand(row, part));
  if (!values.length) return true;
  return mode === 'or' ? values.some(Boolean) : values.every(Boolean);
}

function matchOperand(row: Record<string, unknown>, part: unknown[]) {
  if (part.length === 1 && kindOf(part[0]) === 'SQL') return rowMatches(row, part[0]);
  const nested = part.filter((item) => kindOf(item) === 'SQL');
  const column = part.find((item) => is(item, Column)) as { name: string; table: object } | undefined;
  if (!column) return nested.length === 1 ? rowMatches(row, nested[0]) : nested.every((item) => rowMatches(row, item));
  const param = part.find((item) => kindOf(item) === 'Param') as { value: unknown } | undefined;
  const text = part.filter((item) => kindOf(item) === 'StringChunk').map((item) => ((item as { value: string[] }).value ?? []).join('')).join('');
  const actual = row[columnKey(column)];
  if (text.includes('is not null')) return actual != null;
  if (text.includes('is null')) return actual == null;
  if (text.includes('<>')) return !Object.is(actual, param?.value);
  if (text.includes('=')) return Object.is(actual, param?.value);
  return true;
}

function readable(rows: Array<Record<string, unknown>>) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    orderBy() { return this; },
    limit(count: number) { return promise.then((list) => list.slice(0, count)); }
  });
}

function createHandle(state: MemoryRows, fail: MemoryFail) {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where(condition: unknown) {
              const name = getTableName(table as never);
              return readable((state[name] ?? []).filter((row) => rowMatches(row, condition)));
            }
          };
        }
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: unknown) {
              const apply = () => {
                const name = getTableName(table as never);
                const rows = (state[name] ?? []).filter((row) => rowMatches(row, condition));
                for (const row of rows) Object.assign(row, values);
                return rows;
              };
              const promise = Promise.resolve().then(apply);
              return Object.assign(promise, { returning: () => promise });
            }
          };
        }
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown> | Array<Record<string, unknown>>) {
          const promise = Promise.resolve().then(() => {
            const name = getTableName(table as never);
            if (fail?.op === 'insert' && fail.table === name) throw new Error(`inject ${name} insert`);
            const rows = Array.isArray(values) ? values : [values];
            for (const row of rows) (state[name] ??= []).push({ ...row });
          });
          return Object.assign(promise, { onConflictDoNothing: () => promise });
        }
      };
    },
    delete(table: unknown) {
      return {
        where(condition: unknown) {
          return Promise.resolve().then(() => {
            const name = getTableName(table as never);
            if (fail?.op === 'delete' && fail.table === name) throw new Error(`inject ${name} delete`);
            const kept: Array<Record<string, unknown>> = [];
            for (const row of state[name] ?? []) {
              if (!rowMatches(row, condition)) kept.push(row);
            }
            state[name] = kept;
          });
        }
      };
    },
    async transaction<T>(fn: (tx: ReturnType<typeof createHandle>) => Promise<T>) {
      const snap = structuredClone(state);
      try {
        return await fn(createHandle(state, fail));
      } catch (error) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, snap);
        throw error;
      }
    }
  };
}

export function createMemoryDb(seed: MemoryRows, fail: MemoryFail = null) {
  const state = structuredClone(seed);
  return { state, db: createHandle(state, fail) };
}
