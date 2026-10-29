import 'reflect-metadata';
import { createDataSource } from './options';

// For explicit tooling only. Application startup always uses the runtime credentials.
export default createDataSource(true);
