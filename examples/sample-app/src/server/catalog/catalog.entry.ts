import { CatalogService as Service } from "./catalog-barrel";

const catalogService = new Service();

export async function catalogEntry(itemId: string): Promise<{ id: string; type: string }> {
  return catalogService.loadItem(itemId);
}
