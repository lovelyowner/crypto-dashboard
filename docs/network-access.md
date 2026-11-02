# Public blockchain network access

The managed environment currently restricts outbound destinations. The onboarding draft adds these exact API domains while preserving the package-manager preset. Review and save environment settings to apply them; publishing is separate. A request to the Bitcoin provider returned HTTP 403 from the proxy before this configuration change. Fixture-based tests do not establish live provider readiness.

Allowlist entries do not override browser CORS or provider limits. Requests carry public addresses, not wallet keys. Production deployments need to permit the same third-party connections in any Content Security Policy `connect-src`.

- `api.avax.network`
- `api.coingecko.com`
- `api.nearblocks.io`
- `api.routescan.io`
- `arb1.arbitrum.io`
- `arbitrum.blockscout.com`
- `base.blockscout.com`
- `bsc-rpc.publicnode.com`
- `celestia-rest.publicnode.com`
- `celo.blockscout.com`
- `cosmos-rest.publicnode.com`
- `eth.blockscout.com`
- `ethereum-rpc.publicnode.com`
- `explorer.linea.build`
- `explorer.optimism.io`
- `forno.celo.org`
- `gnosis-rpc.publicnode.com`
- `gnosis.blockscout.com`
- `kusama-rpc.publicnode.com`
- `mainnet.base.org`
- `mainnet.era.zksync.io`
- `mempool.space`
- `optimism-rpc.publicnode.com`
- `osmosis-rest.publicnode.com`
- `polkadot-rpc.publicnode.com`
- `polygon-bor-rpc.publicnode.com`
- `polygon.blockscout.com`
- `rpc.linea.build`
- `rpc.mainnet.near.org`
- `rpc.scroll.io`
- `s1.ripple.com`
- `scroll.blockscout.com`
- `solana-rpc.publicnode.com`

Optional OAuth and mail services require their own deployment networking and credentials; they are not needed for the local watchlist or wallet workflow.
