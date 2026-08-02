import type { DocumentRef, InDesignObjectRef } from "@sol/protocol";

export const FIXTURE_DOCUMENT_UUID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_PAGE_UUID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_ITEM_UUID = "33333333-3333-4333-8333-333333333333";

export function fixtureDocumentRef(revision = 1): DocumentRef {
  return {
    documentUuid: FIXTURE_DOCUMENT_UUID,
    nativeId: 100,
    name: "Contract Fixture.indd",
    revision,
    identityPersistent: true,
  };
}

export function fixturePageRef(): InDesignObjectRef {
  return {
    documentUuid: FIXTURE_DOCUMENT_UUID,
    nativeId: 200,
    persistentUuid: FIXTURE_PAGE_UUID,
    kind: "page",
    name: "1",
    page: {
      documentUuid: FIXTURE_DOCUMENT_UUID,
      nativeId: 200,
      name: "1",
    },
    fingerprint: "page:200:612x792",
  };
}

export function fixtureItemRef(nativeId = 300, kind: InDesignObjectRef["kind"] = "rectangle"): InDesignObjectRef {
  return {
    documentUuid: FIXTURE_DOCUMENT_UUID,
    nativeId,
    persistentUuid: FIXTURE_ITEM_UUID,
    kind,
    name: `Fixture ${kind}`,
    page: {
      documentUuid: FIXTURE_DOCUMENT_UUID,
      nativeId: 200,
      name: "1",
    },
    fingerprint: `${kind}:${nativeId}:36,36,144,72`,
  };
}
