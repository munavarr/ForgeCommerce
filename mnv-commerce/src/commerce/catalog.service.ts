import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CommerceAccess, AccessContext } from './access';
import { CommerceStore } from './store';
import * as dto from './commerce.dto';
import { InventoryError, inventoryFailure } from '../inventory/inventory.error';

export interface CatalogSnapshot {
  id:string; sku:string; variant_name:string; unit_price:string; currency:string;
  product_name:string; product_description:string;
}

@Injectable()
export class CatalogService extends CommerceStore {
  constructor(db: DataSource, private readonly access: CommerceAccess) { super(db); }

  /** Public projection excludes inactive/archived products and variants. Mutations require an administrator session. */
  async listPublic() {
    try { return await this.db.query(`SELECT p.id AS product_id,p.name AS product_name,p.description,
      v.id AS variant_id,v.sku,v.name AS variant_name,v.price,v.currency
      FROM ${this.table('products')} p JOIN ${this.table('product_variants')} v ON v.product_id=p.id
      WHERE p.active AND v.active AND p.archived_at IS NULL AND v.archived_at IS NULL
      ORDER BY p.id,v.id LIMIT 100`); }
    catch(error) { return inventoryFailure(error); }
  }
  async createProduct(context: AccessContext, input: dto.ProductInput) { return this.product(context,input); }
  async updateProduct(context: AccessContext, id: string, input: dto.ProductInput) { return this.product(context,input,dto.uuid(id,'productId')); }
  private async product(context: AccessContext, input: unknown, id?: string) {
    const { actor }=await this.access.catalogManager(context);
    const v=dto.object(input,['key','name','description','active','archived']);
    const command={ key:dto.text(v['key'],'key'),actor:dto.text(actor,'actor'),id:id??null,
      name:dto.text(v['name'],'name'),description:dto.description(v['description']),
      active:dto.boolean(v['active'],'active'),archived:dto.boolean(v['archived'],'archived') };
    return this.mutate(id?'updateProduct':'createProduct',command,async tx=>{
      const params=[command.name,command.description,command.active,command.archived];
      const [row]=id ? await tx.query(`WITH changed AS (UPDATE ${this.table('products')}
        SET name=$1,description=$2,active=$3,archived_at=CASE WHEN $4 THEN coalesce(archived_at,now()) ELSE NULL END
        WHERE id=$5 RETURNING *) SELECT * FROM changed`,[...params,id]) :
        await tx.query(`INSERT INTO ${this.table('products')}(name,description,active,archived_at)
        VALUES ($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END) RETURNING *`,params);
      if (!row) throw new InventoryError('PRODUCT_NOT_FOUND','Product does not exist',404);
      return row;
    },async tx=>{ await this.access.catalogManager(context,tx); });
  }
  async createVariant(context: AccessContext, productId: string, input: dto.VariantInput) {
    return this.variant(context,dto.uuid(productId,'productId'),input);
  }
  async updateVariant(context: AccessContext, productId: string, id: string, input: dto.VariantInput) {
    return this.variant(context,dto.uuid(productId,'productId'),input,dto.uuid(id,'variantId'));
  }
  private async variant(context: AccessContext, productId: string, input: unknown, id?:string) {
    const { actor }=await this.access.catalogManager(context);
    const v=dto.object(input,['key','sku','name','price','currency','active','archived']);
    const command={key:dto.text(v['key'],'key'),actor:dto.text(actor,'actor'),productId,id:id??null,
      sku:dto.text(v['sku'],'sku'),name:dto.text(v['name'],'name'),price:dto.money(v['price']),currency:dto.currency(v['currency']),
      active:dto.boolean(v['active'],'active'),archived:dto.boolean(v['archived'],'archived')};
    return this.mutate(id?'updateVariant':'createVariant',command,async tx=>{
      // Product then variant locks match checkout, preventing catalog edits during pricing.
      const [product]=await tx.query(`SELECT id FROM ${this.table('products')} WHERE id=$1 FOR SHARE`,[productId]);
      if (!product) throw new InventoryError('PRODUCT_NOT_FOUND','Product does not exist',404);
      const params=[productId,command.sku,command.name,command.price,command.currency,command.active,command.archived];
      const [row]=id ? await tx.query(`WITH changed AS (UPDATE ${this.table('product_variants')}
        SET sku=$2,name=$3,price=$4,currency=$5,active=$6,archived_at=CASE WHEN $7 THEN coalesce(archived_at,now()) ELSE NULL END
        WHERE product_id=$1 AND id=$8 RETURNING *) SELECT * FROM changed`,[...params,id]) :
        await tx.query(`INSERT INTO ${this.table('product_variants')}(product_id,sku,name,price,currency,active,archived_at)
        VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END) RETURNING *`,params);
      if (!row) throw new InventoryError('VARIANT_NOT_FOUND','Variant does not exist',404);
      return row;
    },async tx=>{ await this.access.catalogManager(context,tx); });
  }
  async eligible(tx:EntityManager, ids:string[], currency:string) {
    // First discover immutable product IDs, then lock every product and variant in stable order.
    const products=await tx.query(`SELECT DISTINCT product_id FROM ${this.table('product_variants')}
      WHERE id=ANY($1::uuid[]) ORDER BY product_id`,[ids]);
    for (const p of products) await tx.query(`SELECT id FROM ${this.table('products')} WHERE id=$1 FOR SHARE`,[p.product_id]);
    const rows=await tx.query<CatalogSnapshot[]>(`SELECT v.id,v.sku,v.name AS variant_name,v.price AS unit_price,v.currency,
      p.name AS product_name,p.description AS product_description
      FROM ${this.table('product_variants')} v JOIN ${this.table('products')} p ON p.id=v.product_id
      WHERE v.id=ANY($1::uuid[]) AND p.active AND v.active AND p.archived_at IS NULL AND v.archived_at IS NULL
      AND v.currency=$2 ORDER BY v.id FOR SHARE OF v`,[ids,currency]);
    if (rows.length!==ids.length) throw new InventoryError('VARIANT_UNAVAILABLE','Variant is unavailable or uses a different currency');
    return new Map(rows.map(row=>[row.id,row]));
  }
}
