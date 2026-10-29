import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { minorUnitsTransformer } from '../../common/money';

@Entity('users')
export class Users {
  @Column({ type: 'text', default: 'customer' }) role!: 'customer' | 'administrator';
  @Column({ type: 'timestamptz', nullable: true }) email_verified_at!: Date | null;
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'text' }) email!: string;
  @Column({ type: 'text', select: false }) password_hash!: string;
  @Column({ type: 'timestamptz', nullable: true }) archived_at!: Date | null;
}

@Entity('sessions')
export class Sessions {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) user_id!: string;
  @Column({ type: 'text', select: false }) token_hash!: string;
  @Column({ type: 'timestamptz' }) expires_at!: Date;
  @Column({ type: 'timestamptz', nullable: true }) revoked_at!: Date | null;
}

@Entity('products')
export class Products {
  @Column({ type: 'text' }) description!: string;
  @Column({ type: 'boolean' }) active!: boolean;
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'timestamptz', nullable: true }) archived_at!: Date | null;
}

@Entity('product_variants')
export class ProductVariants {
  @Column({ type: 'boolean' }) active!: boolean;
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) product_id!: string;
  @Column({ type: 'text' }) sku!: string;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'bigint', transformer: minorUnitsTransformer }) price!: bigint;
  @Column({ type: 'timestamptz', nullable: true }) archived_at!: Date | null;
  @Column({ type: 'varchar', length: 3 }) currency!: string;
}

@Entity('stock_locations')
export class StockLocations {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'text' }) code!: string;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'timestamptz', nullable: true }) archived_at!: Date | null;
}

@Entity('stock_levels')
export class StockLevels {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) variant_id!: string;
  @Column({ type: 'uuid' }) location_id!: string;
  @Column({ type: 'integer' }) on_hand!: number;
  @Column({ type: 'integer' }) reserved!: number;
}

@Entity('orders')
export class Orders {
  @Column({ type: 'bigint', transformer: minorUnitsTransformer }) subtotal!: bigint;
  @Column({ type: 'bigint', transformer: minorUnitsTransformer }) tax!: bigint;
  @Column({ type: 'bigint', transformer: minorUnitsTransformer }) shipping!: bigint;
  @Column({ type: 'jsonb', nullable: true }) pricing!: unknown | null;
  @Column({ type: 'timestamptz', nullable: true }) checked_out_at!: Date | null;
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'text' }) code!: string;
  @Column({ type: 'uuid', nullable: true }) user_id!: string | null;
  @Column({ type: 'text' }) state!: string;
  @Column({ type: 'bigint', transformer: minorUnitsTransformer }) total!: bigint;
  @Column({ type: 'varchar', length: 3 }) currency!: string;
}

@Entity('order_lines')
export class OrderLines {
  @Column({ type: 'text', nullable: true }) product_description!: string | null;
  @Column({ type: 'varchar', length: 3, nullable: true }) currency!: string | null;
  @Column({ type: 'jsonb', nullable: true }) pricing!: unknown | null;
  @Column({ type: 'timestamptz', nullable: true }) removed_at!: Date | null;
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) order_id!: string;
  @Column({ type: 'uuid' }) variant_id!: string;
  @Column({ type: 'text' }) sku!: string;
  @Column({ type: 'text' }) product_name!: string;
  @Column({ type: 'text' }) variant_name!: string;
  @Column({ type: 'integer' }) quantity!: number;
  @Column({ type: 'bigint', transformer: minorUnitsTransformer }) unit_price!: bigint;
}

@Entity('stock_reservations')
export class StockReservations {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) order_line_id!: string;
  @Column({ type: 'uuid' }) stock_level_id!: string;
  @Column({ type: 'integer' }) quantity!: number;
  @Column({ type: 'text' }) state!: string;
  @Column({ type: 'timestamptz' }) expires_at!: Date;
}

@Entity('stock_movements')
export class StockMovements {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) stock_level_id!: string;
  @Column({ type: 'uuid', nullable: true }) order_line_id!: string | null;
  @Column({ type: 'integer' }) quantity_delta!: number;
  @Column({ type: 'text' }) reason!: string;
  @Column({ type: 'text' }) kind!: string;
  @Column({ type: 'integer', nullable: true }) on_hand_delta!: number | null;
  @Column({ type: 'integer', nullable: true }) reserved_delta!: number | null;
  @Column({ type: 'uuid', nullable: true }) reservation_id!: string | null;
  @Column({ type: 'text' }) actor!: string;
  @Column({ type: 'text', nullable: true }) request_key!: string | null;
}

@Entity('order_transitions')
export class OrderTransitions {
  @Column({ type: 'text' }) actor!: string;
  @Column({ type: 'text' }) reason!: string;
  @Column({ type: 'text', nullable: true }) request_key!: string | null;
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) order_id!: string;
  @Column({ type: 'text' }) from_state!: string;
  @Column({ type: 'text' }) to_state!: string;
}

@Entity('payment_attempts')
export class PaymentAttempts {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'uuid' }) order_id!: string;
  @Column({ type: 'text' }) provider!: string;
  @Column({ type: 'text', nullable: true }) provider_reference!: string | null;
  @Column({ type: 'text' }) idempotency_key!: string;
  @Column({ type: 'text', nullable: true }) request_hash!: string | null;
  @Column({ type: 'bigint', transformer: minorUnitsTransformer }) amount!: bigint;
  @Column({ type: 'text' }) state!: string;
  @Column({ type: 'varchar', length: 3 }) currency!: string;
}

@Entity('idempotency_records')
export class IdempotencyRecords {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'text' }) scope!: string;
  @Column({ type: 'text' }) key!: string;
  @Column({ type: 'text' }) request_hash!: string;
  @Column({ type: 'text' }) state!: string;
  @Column({ type: 'smallint', nullable: true }) response_status!: number | null;
  @Column({ type: 'jsonb', nullable: true }) response_body!: unknown | null;
}

export const commerceEntities = [Users, Sessions, Products, ProductVariants, StockLocations, StockLevels, Orders, OrderLines, StockReservations, StockMovements, OrderTransitions, PaymentAttempts, IdempotencyRecords];
