import { InventoryError } from '../inventory/inventory.error';

const transitions: Readonly<Record<string,readonly string[]>>=Object.freeze({
  draft:['placed','cancelled'],placed:['paid','cancelled'],paid:[],cancelled:[],fulfilled:[],
});
export function assertOrderTransition(from:string,to:string):void {
  if(!transitions[from]?.includes(to)) throw new InventoryError('ORDER_STATE','Illegal order transition');
}
export function lifecycleName(state:string):string {
  return ({draft:'Draft',placed:'PaymentPending',paid:'Paid',cancelled:'Cancelled',fulfilled:'Fulfilled'} as Record<string,string>)[state]??state;
}
