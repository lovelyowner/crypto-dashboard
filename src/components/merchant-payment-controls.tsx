import { useEffect, useId, useRef, useState } from "react";
import { CirclePause } from "lucide-react";
import { validatePaymentConfiguration, type PaymentConfiguration } from "@/lib/payment-types";
import { contactError, contactRequest } from "./contact-request";
import "./merchant-payment-controls.css";

type Props = {
  configured: boolean;
  disabled?: boolean;
  onDisabled: (configuration: PaymentConfiguration) => void;
  onBusyChange?: (busy: boolean) => void;
};

export function MerchantDisableCheckout({
  configured,
  disabled = false,
  onDisabled,
  onBusyChange,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const id = useId();

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (configured) setNotice("");
  }, [configured]);

  async function disableCheckout() {
    if (!configured || disabled || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    onBusyChange?.(true);
    try {
      const configuration = validatePaymentConfiguration(
        await contactRequest("/api/profile/payments", {
          method: "DELETE",
          signal: request.signal,
        }),
      );
      if (configuration.nowpayments.configured)
        throw new Error("New hosted checkouts are still enabled. Please try again.");
      if (!active.current || request.signal.aborted) return;
      setConfirming(false);
      setNotice("New hosted checkouts are disabled. Existing invoices can still finish.");
      onDisabled(configuration);
    } catch (cause) {
      if (active.current && !request.signal.aborted) setError(contactError(cause));
    } finally {
      if (controller.current === request) controller.current = null;
      if (active.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }

  if (!configured && !notice) return null;

  return (
    <div className="merchant-payment-controls" aria-busy={busy}>
      {configured && (
        <>
          <p id={`${id}-description`}>
            Disable new NOWPayments invoices. Existing pending invoices can still be verified and
            completed using their saved credentials.
          </p>
          {confirming ? (
            <div className="merchant-payment-confirmation">
              <p id={`${id}-confirmation`}>
                Stop creating new hosted checkouts for this profile? You can enable them again by
                saving merchant credentials.
              </p>
              <div className="merchant-payment-actions">
                <button
                  type="button"
                  onClick={() => void disableCheckout()}
                  disabled={disabled || busy}
                  aria-describedby={`${id}-description ${id}-confirmation`}
                >
                  <CirclePause size={14} aria-hidden="true" />
                  {busy ? "Disabling…" : "Confirm disable"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setError("");
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
                setError("");
                setNotice("");
              }}
              disabled={disabled || busy}
              aria-describedby={`${id}-description`}
            >
              <CirclePause size={14} aria-hidden="true" /> Disable new hosted checkouts
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && !configured && <p role="status">{notice}</p>}
    </div>
  );
}
