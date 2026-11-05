import { Globe2, KeyRound, ShieldCheck } from "lucide-react";
export function AccountPanel({ onClose }: { onClose: () => void }) {
  return (
    <section className="add-address-form">
      <span className="modal-symbol">
        <ShieldCheck size={24} />
      </span>
      <span className="eyebrow">BROWSER EDITION</span>
      <h2>Your private workspace</h2>
      <p>
        No sign-up is needed to watch addresses or create local wallets. Your watchlist and
        encrypted wallets stay in this browser.
      </p>
      <div className="notice">
        <KeyRound size={18} />
        <p>
          Keep your recovery words and encrypted wallet backup somewhere safe. Clearing browser data
          can remove your local wallet copy. Moving to another browser or website address will not
          move your saved workspace.
        </p>
      </div>
      <div className="notice">
        <Globe2 size={18} />
        <p>
          Email sign-in, passkeys, social accounts, and account 2FA require the account server
          included in the full application. They are not enabled in this browser-only edition.
        </p>
      </div>
      <button className="button primary full-width" onClick={onClose}>
        Back to dashboard
      </button>
    </section>
  );
}
