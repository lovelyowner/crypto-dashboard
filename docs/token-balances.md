# Token balances

Open **Overview → Token balances**. Add an Ethereum or Solana public owner to the watchlist first, then choose **Watch token**, select that owner, and enter an ERC20 contract or SPL mint address. The network comes from the selected owner; an Ethereum-format address cannot identify an EVM network on its own. This version reads Ethereum and Solana mainnet tokens.

Amounts use exact integer arithmetic with the token's decimals. Multiple SPL token accounts for the same owner/mint are summed. Token values stay separate from the native-coin USD total; no token USD price or portfolio valuation is invented. An unavailable or unsupported read never appears as a zero balance.

ERC20 reads use `eth_chainId` and read-only `eth_call` for `balanceOf`, decimals, and optional symbol/name. Missing optional names or symbols leave the exact balance available with a metadata note. Solana reads validate the parsed mint, program, owner, decimals, and token accounts. Ordinary SPL and parsed Token-2022 public balances are supported; confidential balances and special interest/scaled display extensions are unsupported.

The app never approves, signs, or broadcasts a token transfer. Token watches contain only public owner/contract addresses and labels in this browser's local storage. They do not include wallet keys or sync with account storage. Removing or changing a watched owner stops its token reads and marks the saved token watch unavailable until the matching owner is restored or the token watch is removed.

Public token-watch JSON import/export backs up public token configuration: the owner network/address, token contract or mint, and token label. Wallet keys, recovery phrases, private account data, and balance results are excluded. Keep wallet-key backups separate; token-watch backups do not restore wallets.

Import strictly validates the complete file before saving, then merges compatible entries with the current token configuration and deduplicates owner/token pairs. It matches an existing watched owner by network and normalized public address, so backups work when that owner's local ID differs in another browser. Owners absent from the current watchlist are skipped; add those public owners manually and import again. Import does not add owners or replace the watchlist. See the [preview workflow](preview-workflow.md) for development deployments.

Reads refresh every 60 seconds while the panel is open, visible, online, and unpaused. **Refresh tokens** is also stopped by workspace sync pause. Hiding balances masks amounts on screen; it does not hide the public addresses from the selected RPC provider or prevent reads. Providers receive the queried addresses and client IP; outages, CORS restrictions, and rate limits can make reads unavailable.

RPC endpoints are `https://ethereum-rpc.publicnode.com` and `https://solana-rpc.publicnode.com`. Automated tests use fixtures and do not prove current live-provider availability. Run `npm run test:tokens` and `npm run test:token-backups` against the local dev server to check reads, backup previews, merging, and failed storage writes. Token indexing, NFTs, staking, complete transaction history, and token pricing are outside this feature.
