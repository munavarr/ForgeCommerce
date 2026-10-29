import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommerceAccess, AccessContext } from '../commerce/access';
import { object } from './inventory.dto';
import { inventoryTransaction } from './transaction';
import { InventoryEngine } from './inventory.engine';
import { inventoryFailure } from './inventory.error';

/** All client-facing inventory access is administrator-only. Audit identity is server-derived. */
@Injectable()
export class InventoryService {
  constructor(private readonly db:DataSource,private readonly access:CommerceAccess,private readonly engine:InventoryEngine) {}
  private async mutation(context:AccessContext,input:unknown,fields:string[],operation:'createLocation'|'manageLocation'|'initializeStock'|'adjustStock') {
    await this.access.catalogManager(context);
    const v=object(input,['key','reason',...fields]);
    try {
      return await inventoryTransaction(this.db,async tx=>{
        const {actor}=await this.access.catalogManager(context,tx);
        // Engine performs the complete, strict operation-specific validation before any writes.
        return this.engine[operation]({...v,actor} as never,tx);
      });
    } catch(error) { return inventoryFailure(error); }
  }
  createLocation(context:AccessContext,input:unknown) { return this.mutation(context,input,['code','name'],'createLocation'); }
  manageLocation(context:AccessContext,input:unknown) { return this.mutation(context,input,['locationId','name','archived'],'manageLocation'); }
  initializeStock(context:AccessContext,input:unknown) { return this.mutation(context,input,['variantId','locationId','quantity'],'initializeStock'); }
  adjustStock(context:AccessContext,input:unknown) { return this.mutation(context,input,['variantId','locationId','delta'],'adjustStock'); }
  async listLocations(context:AccessContext) { await this.access.catalogManager(context); return this.engine.listLocations(); }
  async readStock(context:AccessContext,variantId:string,locationId:string) { await this.access.catalogManager(context); return this.engine.readStock(variantId,locationId); }
}
