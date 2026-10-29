import { Body, Controller, Get, Headers, Param, Post, Put } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CatalogService } from './catalog.service';
import { InventoryService } from '../inventory/inventory.service';
import * as dto from './commerce.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders:OrdersService) {}
  @Post() create(@Headers('authorization') context:unknown,@Body() input:{key:string}) { return this.orders.createDraft(context,input); }
  @Get(':id') read(@Headers('authorization') context:unknown,@Param('id') id:string) { return this.orders.read(context,id); }
  @Put('lines') setLine(@Headers('authorization') context:unknown,@Body() input:dto.LineInput) { return this.orders.setLine(context,input); }
  @Post('lines/remove') removeLine(@Headers('authorization') context:unknown,@Body() input:dto.OrderCommand & {variantId:string}) { return this.orders.removeLine(context,input); }
  @Post('checkout') checkout(@Headers('authorization') context:unknown,@Body() input:dto.OrderCommand) { return this.orders.checkout(context,input); }
  @Post('cancel') cancel(@Headers('authorization') context:unknown,@Body() input:dto.OrderCommand) { return this.orders.cancel(context,input); }
}
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly catalog:CatalogService) {}
  @Post('products') product(@Headers('authorization') context:unknown,@Body() input:dto.ProductInput) { return this.catalog.createProduct(context,input); }
  @Put('products/:id') updateProduct(@Headers('authorization') context:unknown,@Param('id') id:string,@Body() input:dto.ProductInput) { return this.catalog.updateProduct(context,id,input); }
  @Post('products/:id/variants') variant(@Headers('authorization') context:unknown,@Param('id') id:string,@Body() input:dto.VariantInput) { return this.catalog.createVariant(context,id,input); }
  @Put('products/:productId/variants/:id') updateVariant(@Headers('authorization') context:unknown,@Param('productId') productId:string,@Param('id') id:string,@Body() input:dto.VariantInput) { return this.catalog.updateVariant(context,productId,id,input); }
}
@Controller('admin/inventory')
export class AdminInventoryController {
  constructor(private readonly inventory:InventoryService) {}
  @Get('locations') locations(@Headers('authorization') context:unknown) { return this.inventory.listLocations(context); }
  @Post('locations') createLocation(@Headers('authorization') context:unknown,@Body() input:unknown) { return this.inventory.createLocation(context,input); }
  @Put('locations') manageLocation(@Headers('authorization') context:unknown,@Body() input:unknown) { return this.inventory.manageLocation(context,input); }
  @Get('stock/:variantId/:locationId') stock(@Headers('authorization') context:unknown,@Param('variantId') variantId:string,@Param('locationId') locationId:string) { return this.inventory.readStock(context,variantId,locationId); }
  @Post('initialize') initialize(@Headers('authorization') context:unknown,@Body() input:unknown) { return this.inventory.initializeStock(context,input); }
  @Post('adjust') adjust(@Headers('authorization') context:unknown,@Body() input:unknown) { return this.inventory.adjustStock(context,input); }
}
