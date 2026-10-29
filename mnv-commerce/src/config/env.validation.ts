export enum AppEnvironment { Development = 'development', Test = 'test', Production = 'production' }

function required(config: NodeJS.ProcessEnv, key: string): string {
  const value = config[key];
  if (!value?.trim()) throw new Error(`Invalid environment configuration: ${key} is required`);
  return value;
}
function port(config: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = config[key] ?? String(fallback); const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid environment configuration: ${key} must be a valid port`);
  return value;
}
export function validateEnvironment(config: NodeJS.ProcessEnv = process.env): void {
  const nodeEnv = config['NODE_ENV'] ?? AppEnvironment.Development;
  if (!Object.values(AppEnvironment).includes(nodeEnv as AppEnvironment)) throw new Error('Invalid environment configuration: NODE_ENV is invalid');
  port(config, 'PORT', 3000); required(config, 'DB_HOST'); port(config, 'DB_PORT', 5432);
  required(config, 'DB_NAME'); required(config, 'DB_USER'); required(config, 'DB_PASSWORD'); required(config, 'DB_SCHEMA');
  for (const key of ['DB_NAME', 'DB_USER', 'DB_SCHEMA', 'DB_MIGRATION_USER']) {
    if (config[key] !== undefined && !/^[a-z_][a-z0-9_]*$/.test(config[key]!)) {
      throw new Error(`Invalid environment configuration: ${key} must be a lowercase database identifier`);
    }
  }
  if (Boolean(config['DB_MIGRATION_USER']) !== Boolean(config['DB_MIGRATION_PASSWORD'])) {
    throw new Error('Invalid environment configuration: both migration credentials are required together');
  }
  const poolSize = Number(config['DB_POOL_SIZE'] ?? 10);
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 100) throw new Error('Invalid environment configuration: DB_POOL_SIZE is invalid');
}
