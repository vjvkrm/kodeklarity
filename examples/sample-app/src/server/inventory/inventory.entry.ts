import { InventoryService as Service } from "@server/inventory/inventory-barrel";

const inventoryService = new Service();

export async function inventoryEntry(sku: string): Promise<{ sku: string; stock: number }> {
  return inventoryService.getInventory(sku);
}
