import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { InventoryService } from './inventory.service';
import { InventoryEngine } from './inventory.engine';

@Module({ imports:[DatabaseModule,AuthModule],providers:[InventoryService,InventoryEngine],exports:[InventoryService,InventoryEngine] })
export class InventoryModule {}
