export class PriceService {
  async getQuote(sku: string): Promise<{ sku: string; total: number }> {
    return this.computeQuote(sku);
  }

  private async computeQuote(sku: string): Promise<{ sku: string; total: number }> {
    return {
      sku,
      total: 119,
    };
  }
}
