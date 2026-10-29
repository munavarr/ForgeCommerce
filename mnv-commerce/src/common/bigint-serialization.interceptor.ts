import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import { stringifyCommerce } from './money';

@Injectable()
export class BigintSerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map(value => value === undefined ? value : JSON.parse(stringifyCommerce(value))));
  }
}
