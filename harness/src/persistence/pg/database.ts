import {
  Kysely,
  PostgresDialect,
  type Generated,
  type ColumnType,
} from "kysely";
import { Pool, type Client } from "pg";
interface Tables {
  pi_session: { id: string; sealed: string; expires: number };
  pi_journal: { seq: Generated<string>; batches: Buffer };
  pi_requests: { cid: number; request: string; prompt: string };
  pi_owner: { cid: number; owner: string };
  pi_call: {
    id: string;
    cid: number;
    digest: string;
    pod: string;
    boot: string;
    result: ColumnType<
      import("../../tools/cmd/executor.ts").Result | null,
      string | null,
      string | null
    >;
  };
}
export type Database = Kysely<Tables>;
export function pooledDatabase(connectionString: string) {
  return new Kysely<Tables>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 }) }) });
}
// The pg Client that holds the advisory lock is the only connection. Never reconnect a retired writer.
export function database(client: Client): Database {
  let available = Promise.resolve();
  const connect = async () => {
    const previous = available;
    const { promise, resolve } = Promise.withResolvers<void>();
    available = promise;
    await previous;
    return Object.assign(client, { release: () => resolve() });
  };
  return new Kysely({
    dialect: new PostgresDialect({
      pool: { options: {}, connect, end: async () => {} },
    }),
  });
}
