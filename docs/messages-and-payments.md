# Creator messages and payments

Choose your public ID in **Profile → Your public page** and publish. The share address is `https://your-site.example/your-id`; existing `/u/your-id` links also work. Application paths such as `/login`, `/api`, and `/inbox` cannot be claimed as new creator IDs.

## Receiving wallets and contact settings

In the profile's Donations section, **Choose wallets from this workspace** copies selected public receiving addresses from locally generated wallets and the watchlist. Confirm you control the addresses. The picker never copies encrypted wallet data, associations, recovery phrases, or private keys. It changes the draft; publish the update separately.

**Messages & donations** lets the creator close DMs, allow free DMs, or set a price per incoming message. Choose the Ethereum receiving address from wallets already published in the profile. ETH and hosted-checkout USD prices are separate amounts chosen by the creator, not an automatic exchange-rate quote. Donation-message minimums can be set separately. Saving contact settings updates availability without publishing an edited profile draft. After publishing newly added wallets, choose **Reload settings** to refresh the receiving-wallet list.

DM senders must sign in. Donation messages may use an account identity or appear as Anonymous to the creator. Anonymous hides the account name; blockchain transfers remain public and checkout providers retain their own records. Messages are private to the participants and stored by the account service; they are not end-to-end encrypted or part of public profile exports. Payment does not guarantee a reply.

## Direct Ethereum payments

This payment option supports **native ETH on Ethereum mainnet**. Other networks remain available as public donation addresses; their transfers do not automatically unlock a paid message.

The server prepares a fixed recipient, exact ETH amount, and random transaction-data reference. The private message never goes on-chain. The payer can explicitly open a browser Ethereum wallet or copy the instructions into another wallet that supports transaction data. Include the exact data reference: an ordinary transfer without it cannot be attributed to that message. The payer approves the transaction and gas fee in their wallet; the server never signs or broadcasts it.

A pasted transaction hash alone is insufficient. Verification checks Ethereum mainnet, recipient, amount, reference, a successful receipt, canonical block inclusion, the quoted payment deadline, and at least three confirmations. One chain transaction can release only one message. Recipient safety is checked before a quote is issued; contract and delegated smart-account receiving addresses are currently unsupported for this flow.

The default read-only RPC is `https://ethereum-rpc.publicnode.com`. Optionally set server-only `ETHEREUM_PAYMENTS_RPC_URL` to your HTTPS Ethereum mainnet provider in Vercel. Provider URLs may contain credentials; never use a `VITE_` variable. RPC outages leave payment pending or unavailable, never paid.

## NOWPayments hosted checkout

Each creator uses their **own NOWPayments merchant account**, with payout wallets configured in that service. The selected profile ETH wallet is for the direct option; it does not override the merchant's hosted-checkout payout configuration.

Sign in recently, then save the merchant API key and IPN secret in **Messages & donations → NOWPayments**. Enter values in that private form, never in a public profile, shared link, source code, or chat. Credentials are encrypted on the server with AES-GCM, using the stable application authentication secret, and are never returned by the configuration API. Replacing credentials retains encrypted versions needed by existing invoices. Keep old provider keys valid until those checkouts finish. Keep database backups and the stable `BETTER_AUTH_SECRET` together.

Hosted checkout requires a public HTTPS application origin. The app creates the invoice with a unique server order ID, locked USD price, and the merchant-specific callback URL shown in settings. Only trusted HTTPS NOWPayments checkout URLs are opened. Supported currencies, minimums, fees, regional availability, and payout behavior are determined by NOWPayments.

A checkout return URL does not confirm payment. Callbacks require the merchant IPN secret's HMAC-SHA512 signature; the server then queries the merchant-authenticated payment API and checks the order, any supplied invoice ID, exact price/currency, and final `finished` status. Waiting, partially paid, invalid, or unsigned notifications cannot deliver a message. Provider payment IDs cannot be reused for another message.

The API implementation follows the [official NOWPayments JavaScript SDK](https://github.com/NowPaymentsIO/nowpayments-api-js). Merchant credentials and live checkout behavior must still be verified on the actual deployment; automated tests use provider and blockchain fixtures and send no funds.

## Inbox and pending payments

Open **Inbox** for received messages, sent conversations, and donation notes. The server checks participant ownership on every read and reply. Creator replies are free; incoming follow-ups respect the creator's current DM policy. Unpaid messages are absent from the recipient inbox. Signed-in senders can resume their own pending payments from **Inbox → Sent**.

Anonymous payment receipt access stays in the current tab through an opaque capability token, never a URL or browser storage. Keep that tab open until confirmation. Ordinary bank/merchant links and other public crypto addresses remain external donation options; following a link or claiming to have paid does not unlock an in-app message.

Production requires the existing PostgreSQL/authentication configuration and migrations `0007_creator_contact.sql` and `0008_creator_payments.sql`. The Vercel build applies pending migrations when `DATABASE_URL` is configured. Local watchlists, wallets, and draft editing remain usable without account services.
