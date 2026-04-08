import { PriceService } from "@mono-shared/price/price.service";

const priceService = new PriceService();

export async function checkoutEntry(sku: string): Promise<{ sku: string; total: number }> {
  return priceService.getQuote(sku);
}
