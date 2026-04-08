export class InventoryService {
  async getInventory(sku: string): Promise<{ sku: string; stock: number }> {
    return this.loadFromStore(sku);
  }

  private async loadFromStore(sku: string): Promise<{ sku: string; stock: number }> {
    return {
      sku,
      stock: 42,
    };
  }
}
