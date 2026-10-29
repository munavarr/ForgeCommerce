import { PaymentsService } from '../payments/payments.service';
import { DevelopmentPaymentProvider, PaymentProvider } from '../payments/provider';
import { AuthModule } from '../auth/auth.module';
import { OrdersController, AdminCatalogController, AdminInventoryController } from './commerce.controller';
import { Controller, Get, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogService } from './catalog.service';
import { OrdersService } from './orders.service';
import { PaymentResultVerifier } from './access';
import { PricingPolicy } from './pricing';

@Controller('catalog')
export class PublicCatalogController {
  constructor(private readonly catalog:CatalogService) {}
  @Get() list() { return this.catalog.listPublic(); }
}
@Module({
  imports:[DatabaseModule,InventoryModule,AuthModule],controllers:[PublicCatalogController,OrdersController,AdminCatalogController,AdminInventoryController],
  providers:[CatalogService,OrdersService,PaymentResultVerifier,PaymentsService,
    {provide:PaymentProvider,useFactory:()=>new DevelopmentPaymentProvider()},
    {provide:PricingPolicy,useFactory:()=>new PricingPolicy({currency:process.env['COMMERCE_CURRENCY']??'INR',
      taxBasisPoints:Number(process.env['COMMERCE_TAX_BPS']??0),shipping:process.env['COMMERCE_SHIPPING']??'0',
      reservationSeconds:Number(process.env['COMMERCE_RESERVATION_SECONDS']??900),
      fulfillmentLocationCode:process.env['COMMERCE_STOCK_LOCATION_CODE']??'MAIN'})}],
  exports:[CatalogService,OrdersService,PaymentsService],
})
export class CommerceModule {}
