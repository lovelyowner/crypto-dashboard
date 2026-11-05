# Development status and next proposals

## Implemented for development

| Requested change | Result |
| --- | --- |
| Block/report controls | Conversation block/unblock, prospective message/reply/payment-quote guards, report snapshots, and a reviewer-only queue. Existing pending payments remain verifiable. Truly anonymous identities cannot be account-blocked. |
| ERC20/SPL balances | Exact Ethereum mainnet ERC20 and parsed Solana SPL/Token-2022 public token quantities for explicit owner/contract watches. Native USD totals remain separate. |
| Public token-watch backups | Strictly validated JSON import/export of public token configuration. Imports merge and deduplicate, matching existing owners by network/address even when local IDs differ. Unmatched owners are skipped until added manually; wallet keys, private accounts, and balances are excluded. |
| Passkeys | Real WebAuthn registration, sign-in, rename, and removal, bound to the configured origin, with fresh management sessions and existing TOTP/recovery/session policies preserved. |
| Decorative balance graph | Removed the fixed rising SVG and its styles. No balance history is implied. |
| Inactive login buttons | Only configured, implemented providers remain actionable; unavailable providers use compact status text. |
| Repeated promotional copy | Simplified address/activity empty states and wallet instructions; removed duplicate sidebar and network promotional cards. |

The development changes also include the exact white/gray palette, simpler headers, inbox search/unread filters, conversation drafts, copying, and an offline sample inbox preview. Search covers loaded messages and latest replies. Development uses the `preview` branch; production stays on `main`. Check Vercel for deployment readiness as described in the [preview workflow](preview-workflow.md).

## Add next

1. **Inbox keyboard focus management:** arrow keys between conversations, Enter to open, and focus restoration after Messages.
2. **Account/message export and deletion:** owner-scoped exports, defined retention, and clear handling of shared conversations and payment records.
3. **Verified token pricing:** an explicitly selected pricing source, timestamps, and honest unavailable states before combining token values with portfolio totals.
4. **Review and reattach orphan token watches:** show affected watches together and offer an explicit reattachment after the same public owner is added again; reject network/address mismatches.
5. **One additional real identity provider:** implement and verify Bluesky, Fluxer, or Stoat sign-in/linking before making it actionable.

## Simplify next

- Hide the global **Create wallet / Add address** buttons on Profile and Inbox; keep those pages focused on publishing and conversations.
- Replace the separate native/token refresh buttons with a clearly scoped **Refresh all** action, while retaining per-source timestamps and failures.
- Shorten always-visible token setup guidance once watches exist; keep import details collapsed and payment, recovery, and unavailable-data notices explicit.

Keep white backgrounds (`#fff`), borders/outlines (`#ccc`), text 1/icons (`#999`), text 2 (`#666`), and text 3 (`#333`). All eight footer links stay at `https://lovelyowner.com/` until new destinations are provided.
