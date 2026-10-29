import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { createQuerier, sql } from "../src/index.js";

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? "1000", 10);
if (!Number.isInteger(iterations) || iterations < 1) {
  throw new TypeError("BENCH_ITERATIONS must be a positive integer");
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/querier",
  max: 1,
});
const db = createQuerier(pool);
const prepared = sql.prepare<{ value: number }>("benchmark.select-value");

interface Measurement {
  readonly scenario: string;
  readonly operations: number;
  readonly milliseconds: number;
  readonly operationsPerSecond: number;
}

async function measure(
  scenario: string,
  operation: () => Promise<unknown>,
): Promise<Measurement> {
  const warmup = Math.min(50, iterations);
  for (let index = 0; index < warmup; index += 1) await operation();

  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await operation();
  const milliseconds = performance.now() - started;
  return {
    scenario,
    operations: iterations,
    milliseconds: Math.round(milliseconds * 100) / 100,
    operationsPerSecond: Math.round(iterations / (milliseconds / 1000)),
  };
}

try {
  const measurements = [
    await measure("pg raw object row", () =>
      pool.query<{ value: number }>("select $1::int as value", [42])),
    await measure("querier object row", () =>
      db.one<{ value: number }>()`select ${42}::int as value`),
    await measure("querier prepared row", () =>
      db.one(prepared`select ${42}::int as value`)),
    await measure("querier tuple row", () =>
      db.oneTuple<[value: number]>()`select ${42}::int as value`),
  ];

  console.table(measurements);
} finally {
  await pool.end();
}
