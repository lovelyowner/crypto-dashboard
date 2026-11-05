import { WebAuthnAbortService } from "@simplewebauthn/browser";

let pendingCeremony: AbortController | null = null;

export function beginPasskeyCeremony(): AbortController {
  cancelPasskeyCeremony();
  pendingCeremony = new AbortController();
  return pendingCeremony;
}

export function passkeyRequestSignal(): AbortSignal | undefined {
  return pendingCeremony?.signal;
}

export function endPasskeyCeremony(controller: AbortController) {
  if (pendingCeremony === controller) pendingCeremony = null;
}

export function browserSupportsPasskeys(origin?: string): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function" &&
    (!origin || window.location.origin === origin)
  );
}

export function cancelPasskeyCeremony() {
  pendingCeremony?.abort();
  pendingCeremony = null;
  WebAuthnAbortService.cancelCeremony();
}
