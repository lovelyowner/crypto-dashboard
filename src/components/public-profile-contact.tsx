import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Heart,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Send,
  Wallet,
} from "lucide-react";
import {
  validateContactConfiguration,
  validateContactText,
  exactContactAmount,
  type ContactConfiguration,
} from "@/lib/creator-contact";
import {
  validatePaymentResponse,
  type PaymentResponse,
  type PaymentView,
  type PaymentMethod,
} from "@/lib/payment-types";
import { getPublicProfilePath } from "@/lib/profile-url";
import { formatTransactionDate } from "@/lib/format";
import { contactError, contactRequest } from "./contact-request";
import "./public-profile-contact.css";

type PaymentProgressProps = {
  paymentId: string;
  capabilityToken?: string;
  initial?: PaymentResponse;
  onComplete?: () => void;
};
type ContactSession = { id: string; name: string };
function readContactSession(result: unknown): ContactSession | null {
  const user =
    result &&
    typeof result === "object" &&
    "user" in result &&
    result.user &&
    typeof result.user === "object"
      ? (result.user as Record<string, unknown>)
      : null;
  return user && typeof user.id === "string" && user.id
    ? { id: user.id, name: typeof user.name === "string" ? user.name : "Your account" }
    : null;
}

type EthereumProvider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};

/** Resumable for signed-in senders; anonymous receipt capabilities never enter a URL or browser storage. */
export function PaymentProgress(props: PaymentProgressProps) {
  return <PaymentProgressState key={props.paymentId} {...props} />;
}
function PaymentProgressState({
  paymentId,
  capabilityToken,
  initial,
  onComplete,
}: PaymentProgressProps) {
  const [payment, setPayment] = useState<PaymentView | null>(initial?.payment ?? null);
  const [transactionHash, setTransactionHash] = useState(initial?.payment.transactionHash ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const requestBusy = useRef(false);
  const completed = useRef(false);
  const completion = useRef(onComplete);
  const capability = capabilityToken ?? initial?.capabilityToken;
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    completion.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    active.current = true;
    const requests = controllers.current;
    return () => {
      active.current = false;
      for (const request of requests) request.abort();
      requests.clear();
    };
  }, []);

  const refresh = useCallback(
    async (verifyHash?: string, quiet = false) => {
      if (requestBusy.current) return;
      const controller = new AbortController();
      controllers.current.add(controller);
      requestBusy.current = true;
      if (!quiet) {
        setBusy(true);
        setError("");
        setNotice("");
      }
      try {
        const data = validatePaymentResponse(
          await contactRequest(
            `/api/payments/${encodeURIComponent(paymentId)}${verifyHash ? "/verify" : ""}`,
            {
              method: verifyHash ? "POST" : "GET",
              ...(verifyHash ? { body: { transactionHash: verifyHash } } : {}),
              capabilityToken: capability,
              signal: controller.signal,
            },
          ),
        );
        if (!active.current) return;
        if (data.payment.id !== paymentId)
          throw new Error("The payment receipt does not match this message.");
        setPayment(data.payment);
        if (data.payment.transactionHash) setTransactionHash(data.payment.transactionHash);
        if (!quiet && data.payment.status === "pending")
          setNotice(
            data.payment.method === "ethereum"
              ? `Waiting for ${Math.max(0, 3 - data.payment.confirmations)} more Ethereum confirmation${3 - data.payment.confirmations === 1 ? "" : "s"}.`
              : "Payment is still pending. Complete checkout, then refresh its status.",
          );
      } catch (cause) {
        if (active.current && !controller.signal.aborted) setError(contactError(cause));
      } finally {
        controllers.current.delete(controller);
        requestBusy.current = false;
        if (active.current && !quiet) setBusy(false);
      }
    },
    [capability, paymentId],
  );
  useEffect(() => {
    if (!initial) void refresh();
  }, [initial, refresh]);
  useEffect(() => {
    if (payment?.status !== "paid" || completed.current) return;
    completed.current = true;
    completion.current?.();
  }, [payment?.status]);
  useEffect(() => {
    if (
      payment?.status !== "pending" ||
      (payment.method === "ethereum" && !payment.transactionHash)
    )
      return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (++attempts > 20) window.clearInterval(timer);
      else void refresh(undefined, true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [payment?.status, payment?.method, payment?.transactionHash, refresh]);

  useEffect(() => {
    if (payment?.status !== "pending") return;
    const remaining = Date.parse(payment.expiresAt) - Date.now();
    const timer = window.setTimeout(
      () => {
        setPayment((value) =>
          value?.status === "pending" ? { ...value, status: "expired" } : value,
        );
      },
      Math.max(0, Math.min(remaining, 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [payment?.status, payment?.expiresAt]);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
      setError("");
    } catch {
      setError(
        `Clipboard access is unavailable. Select and copy the ${label.toLowerCase()} below.`,
      );
    }
  }
  async function sendWithWallet() {
    if (
      !payment?.transaction ||
      busy ||
      requestBusy.current ||
      payment.status !== "pending" ||
      payment.transactionHash
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (Date.parse(payment.expiresAt) <= Date.now()) {
        setPayment((value) => (value ? { ...value, status: "expired" } : value));
        throw new Error(
          "This payment quote has expired. Check any existing transaction before preparing a new payment.",
        );
      }
      const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
      if (!provider)
        throw new Error(
          "No browser Ethereum wallet was found. Use the manual transaction details below, or choose hosted checkout for a new message.",
        );
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (
        !Array.isArray(accounts) ||
        typeof accounts[0] !== "string" ||
        !/^0x[0-9a-f]{40}$/i.test(accounts[0])
      )
        throw new Error("Choose an Ethereum account in your wallet.");
      const chain = await provider.request({ method: "eth_chainId" });
      if (chain !== "0x1")
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x1" }],
        });
      if ((await provider.request({ method: "eth_chainId" })) !== "0x1")
        throw new Error("Switch your wallet to Ethereum mainnet before sending.");
      if (Date.parse(payment.expiresAt) <= Date.now()) {
        setPayment((value) => (value ? { ...value, status: "expired" } : value));
        throw new Error(
          "This payment quote expired while choosing a wallet. No new transaction was requested.",
        );
      }
      const transaction = payment.transaction;
      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: accounts[0],
            to: transaction.to,
            value: transaction.value,
            data: transaction.data,
          },
        ],
      });
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash))
        throw new Error("The wallet did not return a valid transaction hash.");
      if (!active.current) return;
      setTransactionHash(hash);
      setPayment((value) => (value ? { ...value, transactionHash: hash } : value));
      setBusy(false);
      await refresh(hash);
    } catch (cause) {
      if (active.current)
        setError(
          cause && typeof cause === "object" && "code" in cause && cause.code === 4001
            ? "The wallet request was cancelled. No payment was confirmed."
            : contactError(cause),
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <section className="creator-payment-progress" aria-label="Payment for message">
      <h3>
        {payment?.status === "paid" ? <Check size={16} /> : <Wallet size={16} />}{" "}
        {payment?.status === "paid"
          ? "Payment verified · message delivered"
          : "Complete payment for this message"}
      </h3>
      {error && (
        <p className="creator-contact-feedback" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="creator-contact-feedback" role="status">
          {notice}
        </p>
      )}
      {!payment ? (
        <p role="status" className="creator-contact-help">
          Loading your payment receipt…
        </p>
      ) : (
        <>
          <p className="creator-payment-amount">
            {payment.amount} {payment.currency}
            <span>
              {payment.status === "paid"
                ? "Verified"
                : payment.status === "failed"
                  ? "Payment failed"
                  : payment.status === "expired"
                    ? "Payment expired"
                    : "Awaiting verified payment"}
            </span>
          </p>
          {payment.status !== "paid" && (
            <p className="creator-contact-help">
              Quote expires{" "}
              <time dateTime={payment.expiresAt}>
                {formatTransactionDate(Date.parse(payment.expiresAt))}{" "}
                {new Date(payment.expiresAt).toISOString().slice(11, 16)} UTC
              </time>
              . Do not approve a wallet transfer after this deadline.
            </p>
          )}
          {payment.status === "pending" && payment.method === "ethereum" && payment.transaction && (
            <>
              <p className="creator-contact-help">
                Ethereum mainnet only. Your wallet will show the amount and network fee before you
                approve. This payment includes a random reference, not your private message. Three
                confirmations are required.
              </p>
              <button
                type="button"
                onClick={() => void sendWithWallet()}
                disabled={busy || Boolean(payment.transactionHash)}
              >
                <Wallet size={14} />
                {busy
                  ? "Waiting for wallet…"
                  : payment.transactionHash
                    ? "Transaction submitted"
                    : "Pay with browser wallet"}
              </button>
              <details className="creator-payment-manual">
                <summary>Send with another wallet</summary>
                <label>
                  Receiving address
                  <div className="creator-copy-field">
                    <input
                      readOnly
                      value={payment.transaction.to}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      aria-label="Copy receiving address"
                      onClick={() => void copy(payment.transaction!.to, "Receiving address")}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </label>
                <label>
                  Amount · ETH
                  <div className="creator-copy-field">
                    <input
                      readOnly
                      value={payment.amount}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      aria-label="Copy ETH amount"
                      onClick={() => void copy(payment.amount, "ETH amount")}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </label>
                <label>
                  Required transaction data
                  <div className="creator-copy-field">
                    <input
                      readOnly
                      value={payment.transaction.data}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      aria-label="Copy transaction data"
                      onClick={() => void copy(payment.transaction!.data, "Transaction data")}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </label>
                <p className="creator-contact-help">
                  Include this exact data value when sending. A normal transfer without it cannot be
                  linked to this message. Use a wallet that supports transaction data.
                </p>
              </details>
              <label>
                Ethereum transaction hash
                <input
                  value={transactionHash}
                  onChange={(event) => setTransactionHash(event.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                disabled={busy || !/^0x[0-9a-f]{64}$/i.test(transactionHash)}
                onClick={() => void refresh(transactionHash)}
              >
                <Check size={14} />
                Verify transaction
              </button>
              {payment.transactionHash && (
                <p className="creator-contact-help">
                  Confirmations: {payment.confirmations} / 3. You can refresh while Ethereum
                  confirms the transfer.
                </p>
              )}
            </>
          )}
          {payment.status === "pending" && payment.method === "nowpayments" && (
            <>
              {payment.checkoutUrl ? (
                <a
                  className="creator-contact-button"
                  href={payment.checkoutUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={14} />
                  Open NOWPayments checkout
                </a>
              ) : (
                <p className="creator-contact-help">
                  Checkout is being prepared. Refresh the payment status.
                </p>
              )}
              <p className="creator-contact-help">
                Complete the provider’s checkout. The message is delivered only after the service
                verifies a completed payment; returning from checkout alone does not confirm it.
              </p>
            </>
          )}
          {(payment.status === "pending" || payment.status === "expired") && (
            <button type="button" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw size={14} />
              Refresh payment status
            </button>
          )}
          {(payment.status === "failed" || payment.status === "expired") && (
            <p className="creator-contact-help">
              This payment has not unlocked the message. Check the transaction or provider receipt
              before making another payment.
            </p>
          )}
          {capability && payment.status !== "paid" && (
            <p className="creator-contact-help">
              Keep this tab open until confirmation. Anonymous payment receipt access is kept only
              in this tab and is not included in a share link.
            </p>
          )}
          {!capability && (
            <p className="creator-contact-help">
              Signed-in senders can resume pending payments from Inbox → Sent. Payment does not
              guarantee a reply.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function PublicProfileContact({ handle }: { handle: string }) {
  return <PublicContactComposer key={handle} handle={handle} />;
}
function PublicContactComposer({ handle }: { handle: string }) {
  const [configuration, setConfiguration] = useState<ContactConfiguration | null>(null);
  const [loadError, setLoadError] = useState("");
  const [kind, setKind] = useState<"dm" | "donation" | null>(null);
  const [identity, setIdentity] = useState<"anonymous" | "account">("anonymous");
  const [session, setSession] = useState<ContactSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [checkingSession, setCheckingSession] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>("ethereum");
  const [amount, setAmount] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [payment, setPayment] = useState<PaymentResponse | null>(null);
  const [reload, setReload] = useState(0);
  const active = useRef(false);
  const checkBusy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const signInUrl = `/login?next=${encodeURIComponent(getPublicProfilePath(handle))}`;
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    active.current = true;
    setLoadError("");
    contactRequest(`/api/creators/${encodeURIComponent(handle)}/contact`, {
      signal: request.signal,
      anonymous: true,
    })
      .then(validateContactConfiguration)
      .then((data) => {
        if (data.handle !== handle) throw new Error("Unexpected creator contact options.");
        if (active.current) setConfiguration(data);
      })
      .catch((cause) => {
        if (active.current && !request.signal.aborted) setLoadError(contactError(cause));
      });
    return () => {
      active.current = false;
      request.abort();
    };
  }, [handle, reload]);

  async function checkSession() {
    if (checkBusy.current || sessionChecked) return;
    checkBusy.current = true;
    setCheckingSession(true);
    try {
      const result = await contactRequest("/api/auth/get-session", {
        signal: controller.current?.signal,
      });
      if (active.current) {
        setSession(readContactSession(result));
        setSessionChecked(true);
      }
    } catch {
      if (active.current) {
        setSession(null);
        setSessionChecked(true);
      }
    } finally {
      checkBusy.current = false;
      if (active.current) setCheckingSession(false);
    }
  }
  const ethereumReady = Boolean(
    configuration?.settings.ethDonationAddressId &&
    configuration.ethereumAddresses.some(
      (address) => address.id === configuration.settings.ethDonationAddressId,
    ),
  );
  const nowpaymentsReady = Boolean(configuration?.nowpaymentsConfigured);
  const methodReady =
    method === "ethereum"
      ? ethereumReady && (kind !== "dm" || Boolean(configuration?.settings.dmEthPrice))
      : nowpaymentsReady && (kind !== "dm" || Boolean(configuration?.settings.dmUsdPrice));
  const needsPayment =
    kind === "donation" || (kind === "dm" && configuration?.settings.dmMode === "paid");
  const needsAccount = kind === "dm" || identity === "account";
  const readyIdentity = !needsAccount || Boolean(session);

  function open(next: "dm" | "donation") {
    if (!configuration || payment) return;
    setKind(next);
    setError("");
    setNotice("");
    if (next === "dm") {
      setIdentity("account");
      void checkSession();
    }
    const canEthereum =
      ethereumReady && (next !== "dm" || Boolean(configuration.settings.dmEthPrice));
    const chosen = canEthereum ? "ethereum" : "nowpayments";
    setMethod(chosen);
    setAmount(
      chosen === "ethereum"
        ? configuration.settings.minimumDonationEth
        : configuration.settings.minimumDonationUsd,
    );
  }
  function chooseMethod(next: PaymentMethod) {
    setMethod(next);
    setAmount(
      next === "ethereum"
        ? (configuration?.settings.minimumDonationEth ?? "")
        : (configuration?.settings.minimumDonationUsd ?? ""),
    );
    setError("");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!kind || !configuration || busy || !readyIdentity) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (kind === "dm" && configuration.settings.dmMode === "closed")
        throw new Error("This creator’s direct messages are closed.");
      if (kind === "donation" && !configuration.settings.donationNotesEnabled)
        throw new Error("This creator is not accepting donation messages.");
      const message = validateContactText(text);
      const anonymous = kind === "donation" && identity === "anonymous";
      if (!anonymous) {
        const currentSession = readContactSession(
          await contactRequest("/api/auth/get-session", { signal: controller.current?.signal }),
        );
        if (!active.current) return;
        setSession(currentSession);
        setSessionChecked(true);
        if (!currentSession) throw new Error("Sign in again before sending this message.");
        if (currentSession.id !== session?.id)
          throw new Error(
            "Your signed-in account changed. Review the sending name, then send again.",
          );
      }
      if (needsPayment) {
        if (!methodReady)
          throw new Error("This payment method is not configured for this creator.");
        const result = validatePaymentResponse(
          await contactRequest("/api/payments", {
            method: "POST",
            signal: controller.current?.signal,
            body: {
              handle,
              kind,
              text: message,
              anonymous,
              method,
              ...(kind === "donation"
                ? { amount: exactContactAmount(amount, method === "ethereum" ? 18 : 2) }
                : {}),
            },
            anonymous,
          }),
        );
        if (active.current) setPayment(result);
      } else {
        await contactRequest(`/api/creators/${encodeURIComponent(handle)}/messages`, {
          method: "POST",
          signal: controller.current?.signal,
          body: { kind: "dm", text: message, anonymous: false },
        });
        if (active.current) {
          setText("");
          setNotice("Private message sent. You can find the conversation in your Inbox.");
        }
      }
    } catch (cause) {
      if (active.current) setError(contactError(cause));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <section className="public-profile-contact" aria-label="Contact this creator">
      <h2>
        <MessageSquare size={16} /> Contact &amp; support
      </h2>
      {loadError && (
        <>
          <p className="creator-contact-help">
            Messaging is currently unavailable. The creator’s public links and wallet addresses
            above still work.
          </p>
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            <RefreshCw size={13} />
            Reload contact options
          </button>
        </>
      )}
      {!configuration && !loadError && (
        <p className="creator-contact-help" role="status">
          Loading contact options…
        </p>
      )}
      {configuration && (
        <>
          {!kind && !payment && (
            <div className="creator-contact-actions">
              <button
                type="button"
                onClick={() => open("donation")}
                disabled={!configuration.settings.donationNotesEnabled}
              >
                <Heart size={14} />
                Donate with a message
              </button>
              <button
                type="button"
                onClick={() => open("dm")}
                disabled={configuration.settings.dmMode === "closed"}
              >
                <MessageSquare size={14} />
                {configuration.settings.dmMode === "paid"
                  ? "Send a paid DM"
                  : "Send a private message"}
              </button>
            </div>
          )}
          {!kind && configuration.settings.dmMode === "closed" && (
            <p className="creator-contact-help">This creator’s direct messages are closed.</p>
          )}
          {kind && !payment && (
            <form onSubmit={(event) => void submit(event)}>
              <div className="creator-contact-composer-heading">
                <h3>
                  {kind === "donation"
                    ? "Donate with a message"
                    : configuration.settings.dmMode === "paid"
                      ? "Send a paid DM"
                      : "Send a private message"}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setKind(null);
                    setText("");
                    setError("");
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
              {kind === "donation" && (
                <label>
                  Show your identity
                  <select
                    aria-label="Show your identity"
                    value={identity}
                    onChange={(event) => {
                      const next = event.target.value as "anonymous" | "account";
                      setIdentity(next);
                      if (next === "account") void checkSession();
                    }}
                    disabled={busy}
                  >
                    <option value="anonymous">Anonymous to the creator</option>
                    <option value="account">With my account</option>
                  </select>
                </label>
              )}
              {needsAccount && (
                <div className="creator-contact-identity">
                  {checkingSession ? (
                    <span>Checking your account…</span>
                  ) : session ? (
                    <span>Sending as {session.name}</span>
                  ) : (
                    <p>
                      Sign in to{" "}
                      {kind === "dm"
                        ? "send a direct message"
                        : "attach your account to this donation"}
                      . <a href={signInUrl}>Sign in or create an account</a>
                    </p>
                  )}
                </div>
              )}
              {kind === "donation" && identity === "anonymous" && (
                <p className="creator-contact-help">
                  Your account identity is hidden from the creator. Blockchain transfers remain
                  public, and the payment provider keeps its own records.
                </p>
              )}
              <label>
                Your message
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={4000}
                  rows={5}
                  required
                  disabled={busy}
                  placeholder="Write a private message for this creator…"
                />
              </label>
              <p className="creator-contact-help">
                Up to 2,000 characters. Messages are stored by the account service and are not
                end-to-end encrypted.
              </p>
              {needsPayment && (
                <>
                  <label>
                    Payment option
                    <select
                      aria-label="Payment option"
                      value={method}
                      onChange={(event) => chooseMethod(event.target.value as PaymentMethod)}
                      disabled={busy}
                    >
                      <option
                        value="ethereum"
                        disabled={
                          !ethereumReady || (kind === "dm" && !configuration.settings.dmEthPrice)
                        }
                      >
                        Direct Ethereum · ETH{!ethereumReady ? " · unavailable" : ""}
                      </option>
                      <option
                        value="nowpayments"
                        disabled={
                          !nowpaymentsReady || (kind === "dm" && !configuration.settings.dmUsdPrice)
                        }
                      >
                        NOWPayments checkout · USD{!nowpaymentsReady ? " · setup required" : ""}
                      </option>
                    </select>
                  </label>
                  {kind === "donation" ? (
                    <label>
                      Donation amount · {method === "ethereum" ? "ETH" : "USD"}
                      <input
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        inputMode="decimal"
                        required
                        disabled={busy}
                      />
                    </label>
                  ) : (
                    <p className="creator-payment-price">
                      Price per incoming message:{" "}
                      {method === "ethereum"
                        ? `${configuration.settings.dmEthPrice || "Unavailable"} ETH`
                        : `${configuration.settings.dmUsdPrice || "Unavailable"} USD`}
                    </p>
                  )}
                  <p className="creator-contact-help">
                    This message is delivered after verified payment. Payment does not guarantee a
                    reply. Direct ETH transfers need the issued transaction reference and three
                    confirmations.
                  </p>
                  {!methodReady && (
                    <p className="creator-contact-help">
                      The creator has not finished setting up this payment option.
                    </p>
                  )}
                </>
              )}
              {error && (
                <p className="creator-contact-feedback" role="alert">
                  {error}
                </p>
              )}
              {notice && (
                <p className="creator-contact-feedback" role="status">
                  <Check size={14} />
                  {notice}
                </p>
              )}
              <button
                type="submit"
                disabled={
                  busy ||
                  checkingSession ||
                  !readyIdentity ||
                  !text.trim() ||
                  (needsPayment && !methodReady)
                }
              >
                {busy ? (
                  <LoaderCircle size={14} className="creator-contact-spin" />
                ) : (
                  <Send size={14} />
                )}
                {busy
                  ? "Preparing…"
                  : needsPayment
                    ? "Continue to payment"
                    : "Send private message"}
              </button>
            </form>
          )}
          {payment && (
            <>
              <PaymentProgress
                paymentId={payment.payment.id}
                capabilityToken={payment.capabilityToken}
                initial={payment}
              />
              <p className="creator-contact-help">
                Your message is tied to this receipt. Do not create another payment for the same
                message while confirmation is pending.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
