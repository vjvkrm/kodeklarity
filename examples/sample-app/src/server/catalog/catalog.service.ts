export class CatalogService {
  async loadItem(itemId: string): Promise<{ id: string; type: string }> {
    return this.fetchItem(itemId);
  }

  private async fetchItem(itemId: string): Promise<{ id: string; type: string }> {
    return {
      id: itemId,
      type: "catalog",
    };
  }
}
