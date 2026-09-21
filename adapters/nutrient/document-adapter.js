import { ok, reject } from "../../core/kernel/result.js";
import { BaseAdapter } from "../kernel/adapter.js";
import { CircuitOpenError } from "../kernel/circuit-breaker.js";
const NUTRIENT_DEVIATIONS = [
  {
    id: "NUTR-DEV-001",
    summary: "Extraction confidence is conventionally a floating point score in [0,1].",
    containment: "Converted at the boundary to an integer per ten thousand, rounding down, so a borderline extraction is treated as the weaker reading and routes to operations rather than discharging a gate.",
    verificationRef: "OI-05"
  },
  {
    id: "NUTR-DEV-002",
    summary: "Locked template regions may be a template convention rather than an API-enforced guarantee.",
    containment: "The adapter refuses any render whose merge fields are not a subset of the template version\u2019s declared fields, before the call is made.",
    verificationRef: "OI-05"
  }
];
class NutrientDocumentAdapter extends BaseAdapter {
  constructor(config, credentials, transport) {
    super(config, credentials);
    this.transport = transport;
  }
  // One product satisfying three capabilities. An institution may well split
  // them across three, which is why they are three interfaces.
  capabilities = ["DOCUMENT_RENDERING", "SIGNING", "DOCUMENT_INTELLIGENCE"];
  vendorName = "Nutrient";
  deviations = NUTRIENT_DEVIATIONS;
  // -- Rendering --------------------------------------------------------------
  async resolveTemplateVersion(tenantId, templateId, version) {
    if (!Number.isInteger(version) || version <= 0) {
      return reject(
        "SH-17",
        "TEMPLATE_VERSION_NOT_EXPLICIT",
        'Rendering is always against an explicit approved version, never "latest"',
        { templateId }
      );
    }
    const response = await this.#invoke("template.resolve", tenantId, { templateId, version });
    if (!response.ok) return response;
    const body = response.value;
    const templateVersionId = body["templateVersionId"];
    const shariahApprovalRef = body["shariahApprovalRef"];
    if (typeof templateVersionId !== "string" || typeof shariahApprovalRef !== "string") {
      return reject(
        "SH-17",
        "TEMPLATE_METADATA_INCOMPLETE",
        "A template version must carry the approval reference it was approved under",
        { templateId }
      );
    }
    return ok({
      templateVersionId,
      templateId,
      version,
      lockedRegionIds: stringArray(body["lockedRegionIds"]),
      mergeFieldNames: stringArray(body["mergeFieldNames"]),
      shariahApprovalRef
    });
  }
  /**
   * Render one leg into one document.
   *
   * `LegRenderRequest` holds a single leg, so there is no combined-rendering
   * path to close off here — the type closed it (SH-07).
   */
  async render(request) {
    const template = await this.resolveTemplateVersionById(
      request.tenantId,
      request.templateVersionId
    );
    if (!template.ok) return template;
    const declared = new Set(template.value.mergeFieldNames);
    const undeclared = Object.keys(request.mergeFields).filter((f) => !declared.has(f));
    if (undeclared.length > 0) {
      return reject(
        "SH-07",
        "UNDECLARED_MERGE_FIELD",
        "A render may only substitute into fields the approved template declares; Board-approved clauses are not substitutable",
        { templateVersionId: request.templateVersionId, undeclared: undeclared.join(",") }
      );
    }
    const response = await this.#invoke(
      "document.render",
      request.tenantId,
      {
        templateVersionId: request.templateVersionId,
        legId: request.leg.legId,
        legType: request.leg.legType,
        governingLocale: request.governingLocale,
        translationLocale: request.translationLocale,
        mergeFields: request.mergeFields,
        shariahApprovalId: request.shariahApprovalId
      },
      request.correlationId
    );
    if (!response.ok) return response;
    const body = response.value;
    const documentId = body["documentId"];
    const contentHash = body["contentHash"];
    const artefactUri = body["artefactUri"];
    if (typeof documentId !== "string" || typeof contentHash !== "string" || typeof artefactUri !== "string") {
      return reject("OP-CHAIN", "RENDER_RESPONSE_MALFORMED", "The render response was not understood");
    }
    return ok({
      documentId,
      contentHash,
      artefactUri,
      templateVersionId: request.templateVersionId,
      pageCount: numberOr(body["pageCount"], 0),
      sizeBytes: numberOr(body["sizeBytes"], 0)
    });
  }
  async compareToTemplate(documentId, templateVersionId) {
    const response = await this.#invoke("document.compare", this.config.tenantId, {
      documentId,
      templateVersionId
    });
    if (!response.ok) return response;
    const altered = stringArray(response.value["alteredLockedRegionIds"]);
    return ok({
      documentId,
      templateVersionId,
      hasDrift: altered.length > 0 || response.value["hasDrift"] === true,
      alteredLockedRegionIds: altered,
      summary: typeof response.value["summary"] === "string" ? response.value["summary"] : ""
    });
  }
  async archive(documentId, retentionYears) {
    const response = await this.#invoke("document.archive", this.config.tenantId, {
      documentId,
      retentionYears,
      format: "LONG_TERM_PRESERVATION",
      embedValidationMaterial: true
    });
    if (!response.ok) return response;
    const archiveUri = response.value["archiveUri"];
    if (typeof archiveUri !== "string") {
      return reject("OP-DETERMINACY", "ARCHIVE_URI_MISSING", "The archive response carried no location");
    }
    return ok({ archiveUri });
  }
  // -- Signature --------------------------------------------------------------
  async signMasterAgreement(params) {
    return this.#sign("signature.padesLtv", "PADES_LTV", params);
  }
  async sealLeg(params) {
    return this.#sign("signature.seal", "INSTITUTIONAL_SEAL", params);
  }
  async validate(documentId) {
    const response = await this.#invoke("signature.validate", this.config.tenantId, { documentId });
    if (!response.ok) return response;
    const body = response.value;
    return ok({
      documentId,
      signatureValid: body["signatureValid"] === true,
      certificateChainValid: body["certificateChainValid"] === true,
      timestampValid: body["timestampValid"] === true,
      longTermValidationPresent: body["longTermValidationPresent"] === true,
      validatedAgainstEpochSeconds: BigInt(numberOr(body["validatedAtEpochSeconds"], 0))
    });
  }
  // -- Document intelligence --------------------------------------------------
  async extract(params) {
    const response = await this.#invoke(
      "intelligence.extract",
      params.tenantId,
      {
        artefactUri: params.artefactUri,
        expectedDocumentClass: params.expectedDocumentClass,
        locales: [...params.locales]
      },
      params.correlationId
    );
    if (!response.ok) return response;
    const raw = response.value["fields"];
    if (!Array.isArray(raw)) {
      return reject("OP-DETERMINACY", "EXTRACTION_MALFORMED", "The extraction response was not understood");
    }
    const fields = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry;
      const name = e["name"];
      const value = e["value"];
      if (typeof name !== "string" || typeof value !== "string") continue;
      fields.push({
        name,
        value,
        // NUTR-DEV-001. Floor, never round to nearest.
        confidencePerTenThousand: toPerTenThousand(e["confidence"])
      });
    }
    const lowest = fields.reduce(
      (min, f) => f.confidencePerTenThousand < min ? f.confidencePerTenThousand : min,
      1e4
    );
    return ok({
      artefactUri: params.artefactUri,
      documentClass: typeof response.value["documentClass"] === "string" ? response.value["documentClass"] : params.expectedDocumentClass,
      fields,
      lowestConfidencePerTenThousand: fields.length === 0 ? 0 : lowest
    });
  }
  async redact(params) {
    const applicable = params.rules.filter((r) => r.recipientClass === params.recipientClass);
    if (applicable.length === 0) {
      return reject(
        "OP-DETERMINACY",
        "NO_REDACTION_RULES",
        "Disclosure outside the institution requires an explicit redaction rule set; an empty set is not a decision to disclose everything",
        { recipientClass: params.recipientClass }
      );
    }
    const response = await this.#invoke(
      "intelligence.redact",
      params.tenantId,
      {
        documentId: params.documentId,
        recipientClass: params.recipientClass,
        fieldNames: applicable.map((r) => r.fieldName).sort((a, b) => a.localeCompare(b))
      },
      params.correlationId
    );
    if (!response.ok) return response;
    const redactedDocumentId = response.value["redactedDocumentId"];
    const artefactUri = response.value["artefactUri"];
    if (typeof redactedDocumentId !== "string" || typeof artefactUri !== "string") {
      return reject("OP-DETERMINACY", "REDACTION_MALFORMED", "The redaction response was not understood");
    }
    return ok({ redactedDocumentId, artefactUri });
  }
  // ---------------------------------------------------------------------------
  async resolveTemplateVersionById(tenantId, templateVersionId) {
    const response = await this.#invoke("template.resolve", tenantId, { templateVersionId });
    if (!response.ok) return response;
    const body = response.value;
    const shariahApprovalRef = body["shariahApprovalRef"];
    if (typeof shariahApprovalRef !== "string") {
      return reject(
        "SH-17",
        "TEMPLATE_METADATA_INCOMPLETE",
        "A template version must carry its approval reference",
        { templateVersionId }
      );
    }
    return ok({
      templateVersionId,
      templateId: typeof body["templateId"] === "string" ? body["templateId"] : "",
      version: numberOr(body["version"], 0),
      lockedRegionIds: stringArray(body["lockedRegionIds"]),
      mergeFieldNames: stringArray(body["mergeFieldNames"]),
      shariahApprovalRef
    });
  }
  async #sign(operation, profile, params) {
    const response = await this.#invoke(
      operation,
      params.tenantId,
      {
        documentId: params.documentId,
        // The hash of the exact rendition presented. What is signed is what was seen.
        contentHash: params.contentHash,
        identityAssertionId: params.signatoryAssertion.value,
        requestTimestamp: true
      },
      params.correlationId
    );
    if (!response.ok) return response;
    const body = response.value;
    const signatureId = body["signatureId"];
    const signedHash = body["contentHash"];
    if (typeof signatureId !== "string" || typeof signedHash !== "string") {
      return reject("OP-CHAIN", "SIGNATURE_RESPONSE_MALFORMED", "The signing response was not understood");
    }
    if (signedHash !== params.contentHash) {
      return reject(
        "OP-CHAIN",
        "SIGNED_RENDITION_DIFFERS",
        "The rendition that was signed is not the rendition that was presented",
        { documentId: params.documentId }
      );
    }
    const timestamp = readTimestamp(body["timestamp"]);
    if (timestamp === void 0) {
      return reject(
        "SH-06",
        "NO_TRUSTED_TIMESTAMP",
        "The signature carried no verifiable timestamp; the leg does not execute",
        { documentId: params.documentId }
      );
    }
    return ok({ documentId: params.documentId, signatureId, contentHash: signedHash, timestamp, profile });
  }
  async #invoke(operation, tenantId, payload, correlationId = "") {
    try {
      const apiKey = await this.credential("api_key", correlationId);
      const body = await this.breaker.execute(
        () => this.transport.call(
          operation,
          { ...payload, tenantReference: tenantId },
          {
            Authorization: `Bearer ${apiKey.expose()}`,
            ...correlationId === "" ? {} : { "X-Correlation-Id": correlationId }
          }
        )
      );
      return ok(body);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return reject(
          "OP-DETERMINACY",
          "DOCUMENT_PLATFORM_CIRCUIT_OPEN",
          "The document platform is unavailable; generation is queued and will resume automatically",
          { operation }
        );
      }
      return reject(
        "OP-DETERMINACY",
        "DOCUMENT_PLATFORM_CALL_FAILED",
        "The document platform did not complete the request",
        { operation }
      );
    }
  }
}
function toPerTenThousand(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1e4;
  return Math.floor(value * 1e4);
}
function readTimestamp(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const t = value;
  const genTime = t["genTimeEpochSeconds"];
  const tokenDigest = t["tokenDigest"];
  const authorityId = t["authorityId"];
  if (t["verified"] !== true) return void 0;
  if (typeof tokenDigest !== "string" || typeof authorityId !== "string") return void 0;
  if (typeof genTime !== "number" && typeof genTime !== "string") return void 0;
  return {
    verified: true,
    genTimeEpochSeconds: BigInt(genTime),
    tokenDigest,
    authorityId
  };
}
function stringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export {
  NUTRIENT_DEVIATIONS,
  NutrientDocumentAdapter
};
