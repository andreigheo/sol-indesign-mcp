import { SafeBridgeError } from "../core/errors";
import { collectionItems, collectionLength } from "../core/records";

export interface BoundedCollectionScan {
  readonly items: unknown[];
  readonly complete: boolean;
  readonly total: number;
}

export function scanBoundedCollection(
  collection: unknown,
  label: string,
  maximum = 20_000,
): BoundedCollectionScan {
  const total = collectionLength(collection);
  if (total === undefined) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `This runtime cannot enumerate ${label} with a bounded collection API.`);
  }
  const requested = Math.min(total, maximum);
  const items = collectionItems(collection, requested);
  if (items.length !== requested) {
    throw new SafeBridgeError("UNSUPPORTED_CAPABILITY", `This runtime could not enumerate ${label} deterministically.`);
  }
  return { items, complete: total <= maximum, total };
}
