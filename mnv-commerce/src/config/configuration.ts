import { validateEnvironment } from './env.validation';

function required(key: string): string {
  const value = process.env[key];
  if (!value?.trim()) throw new Error(`Invalid environment configuration: ${key} is required`);
  return value;
}
export default () => {
  validateEnvironment();
  return ({
  port: Number(process.env['PORT'] ?? 3000),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  database: { host: required('DB_HOST'), port: Number(process.env['DB_PORT'] ?? 5432), name: required('DB_NAME'),
    user: required('DB_USER'), password: required('DB_PASSWORD'), schema: required('DB_SCHEMA'),
    poolSize: Number(process.env['DB_POOL_SIZE'] ?? 10) },
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  });
};
