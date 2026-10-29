import { Injectable } from '@nestjs/common';
import { currency, invalid, MAX_MONEY, money, text, quantity } from './commerce.dto';

export interface PricingConfiguration {
  currency: string; taxBasisPoints: number; shipping: string; reservationSeconds: number; fulfillmentLocationCode?: string;
}
@Injectable()
export class PricingPolicy {
  readonly configuration: Readonly<PricingConfiguration>;
  constructor(configuration: PricingConfiguration = { currency:'INR',taxBasisPoints:0,shipping:'0',reservationSeconds:900 }) {
    currency(configuration.currency); money(configuration.shipping,'shipping');
    if (!Number.isInteger(configuration.taxBasisPoints) || configuration.taxBasisPoints<0 || configuration.taxBasisPoints>10000) invalid('taxBasisPoints');
    if (!Number.isInteger(configuration.reservationSeconds) || configuration.reservationSeconds<1 || configuration.reservationSeconds>86400) invalid('reservationSeconds');
    if(configuration.fulfillmentLocationCode!==undefined) text(configuration.fulfillmentLocationCode,'fulfillmentLocationCode');
    this.configuration=Object.freeze({ ...configuration });
  }
  calculate(lines: { unit_price: string; quantity: number }[]) {
    // Exclusive tax on the aggregate merchandise subtotal; nearest minor unit, ties upward.
    // Shipping is a flat, untaxed minor-unit amount. No binary floating point arithmetic.
    const subtotal=lines.reduce((sum,l)=>sum+BigInt(money(l.unit_price,'unit_price'))*BigInt(quantity(l.quantity,'quantity')),0n);
    const tax=(subtotal*BigInt(this.configuration.taxBasisPoints)+5000n)/10000n;
    const shipping=lines.length ? BigInt(this.configuration.shipping) : 0n;
    const total=subtotal+tax+shipping;
    if (total>MAX_MONEY) invalid('total exceeds database range');
    return { subtotal:subtotal.toString(),tax:tax.toString(),shipping:shipping.toString(),total:total.toString(),
      pricing:{ taxBasisPoints:this.configuration.taxBasisPoints,rounding:'subtotal-half-up',shippingTaxable:false } };
  }
}
