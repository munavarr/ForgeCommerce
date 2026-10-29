import { CommerceModule } from './commerce/commerce.module';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from './health.controller';
import { DatabaseModule } from './database/database.module';
import { InventoryModule } from './inventory/inventory.module';
import { BigintSerializationInterceptor } from './common/bigint-serialization.interceptor';

@Module({
  imports: [DatabaseModule, InventoryModule, CommerceModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: BigintSerializationInterceptor },
  ],
  controllers: [HealthController],
})
export class AppModule {}
