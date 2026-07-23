export type EmptyResponseSource =
  | "acp-no-text"
  | "bridge-capture-lost"
  | "bridge-processing-removed"

export interface EmptyResponseDiagnostic {
  source: EmptyResponseSource
  acpChars: number
  bridgeChars: number
  cleanChars: number
}

export function diagnoseEmptyResponse(
  acpResponse: string,
  bridgeResponse: string,
  cleanResponse: string,
): EmptyResponseDiagnostic | null {
  if (cleanResponse.length > 0) return null

  let source: EmptyResponseSource
  if (acpResponse.length === 0 && bridgeResponse.length === 0) {
    source = "acp-no-text"
  } else if (bridgeResponse.length === 0) {
    source = "bridge-capture-lost"
  } else {
    source = "bridge-processing-removed"
  }

  return {
    source,
    acpChars: acpResponse.length,
    bridgeChars: bridgeResponse.length,
    cleanChars: cleanResponse.length,
  }
}
