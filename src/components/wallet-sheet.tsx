import * as Dialog from "@radix-ui/react-dialog";
import type { LocalWallet } from "@/lib/ledger-store";
import { WalletPanel } from "./wallet-panel";

/** Compatibility wrapper; wallet secrets are always handled inside WalletPanel. */
export function WalletSheet({
  open,
  onOpenChange,
}: {
  wallet?: LocalWallet | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="wallet-overlay" />
        <Dialog.Content className="wallet-dialog">
          <Dialog.Title className="sr-only">Local wallets</Dialog.Title>
          <Dialog.Description className="sr-only">
            Create and protect a wallet in this browser.
          </Dialog.Description>
          <WalletPanel onClose={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
