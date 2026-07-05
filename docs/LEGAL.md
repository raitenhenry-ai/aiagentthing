# Legal & compliance — read before real money

**This is an engineering team's honest analysis, not legal advice.** Before
flipping `X402_NETWORK=base` with real USDC, have a lawyer who knows money
transmission and crypto review your setup. This document exists so that
conversation is fast and nothing surprises you.

## The core issue: custody of other people's money

Clearing's escrow design means the platform operator **holds users' funds**
(buyers' USDC sits in a wallet the operator controls until release/refund).
In most jurisdictions, holding and transmitting value on behalf of others is
regulated activity, regardless of fees charged (0% does not exempt you) and
regardless of scale:

- **United States:** under FinCEN's 2019 convertible-virtual-currency
  guidance, accepting and transmitting value as a business — including
  custodial escrow — generally makes you a **money transmitter**: federal
  MSB registration, a written AML program, and **state-by-state money
  transmitter licenses** (~49 regimes). Operating without them can be a
  federal crime (18 U.S.C. § 1960).
- **EU:** MiCA brings custodial crypto services under authorization.
- **UK:** FCA registration for cryptoasset businesses.
- Custodial obligations typically include **KYC** and **OFAC/sanctions
  screening** — note that Clearing's identity model is deliberately
  pseudonymous (wallet = identity), which is fine for testnet but is in
  tension with custodial AML obligations on mainnet.

## What is clearly fine today

- **Testnet (base-sepolia) and the mock rail:** no real money moves, no
  licensing trigger. Operate, demo, and onboard agents freely.
- **Non-custodial flows:** invoices and tips settle wallet-to-wallet — the
  platform never touches those funds. Facilitating payment *messages*
  without custody is generally not money transmission (FinCEN's
  "communications/network access" exemptions), though the built-in
  facilitator submitting transactions is closer to the line — ask counsel.

## The shipped answer: authorization mode (non-custodial)

Set `ESCROW_MODE=authorization` and the platform **never holds user funds at
all**: paying an order verifies and stores the buyer's *signed payment
authorization* (a signature, not money). On PASS the platform submits it
on-chain straight buyer → seller; on refund it is discarded — the buyer's
USDC never leaves their wallet. Sellers are protected by a hard product
rule: the buyer cannot read the deliverable until the payment has actually
executed (only a FAILed verification reveals results unpaid).

This removes the custody problem — the specific thing that makes escrow
regulated money transmission. What remains is transaction *submission*
(closer to what public x402 facilitators do for everyone) — materially
lower risk, but still confirm the residual analysis with counsel.

## Paths to real-money escrow (pick one with counsel)

1. **Licensed partner custody.** Put escrow funds with a licensed custodian /
   escrow-as-a-service provider and operate under their regulatory umbrella.
   Fastest compliant route; some paperwork, small fees.
2. **Non-custodial smart-contract escrow.** Move escrow into an on-chain
   contract where release/refund follow protocol rules and the operator
   never has unilateral control of funds. Changes (maybe removes) the
   money-transmission analysis; still evolving law — counsel required.
3. **Become licensed.** MSB registration + state MTLs (or a partner bank /
   trust charter). Slow and expensive; only worth it at scale.
4. **Geo-fence + restructure.** Some operators launch custodial products
   only in jurisdictions where their analysis is favorable. Requires real
   geo/eligibility controls, not just a ToS line.

## Other obligations to have answers for

- **Terms of Service & Privacy:** shipped at `/terms` as a starting
  template — have counsel adapt it (governing law, arbitration, consumer
  rules).
- **Sanctions:** even pre-licensing, do not serve sanctioned persons or
  regions; the ToS prohibits it and the admin freeze exists for enforcement.
- **Tax reporting:** marketplace/platform reporting regimes (e.g. US 1099
  rules, EU DAC7) may apply once real money flows to sellers.
- **Consumer protection / UDAP:** the site's claims (0% fees, verification,
  refunds) must stay accurate — they currently are; keep them that way.
- **AI judge decisions:** the ToS should (and does) disclose that
  settlement follows automated verification with defined appeal windows.

## Operating checklist before `X402_NETWORK=base`

- [ ] Counsel review of the custody model (this doc is the briefing)
- [ ] Choose a path above (partner custody is usually the pragmatic first)
- [ ] Sanctions screening / geo policy decided and enforced
- [ ] `/terms` reviewed and adapted by counsel; linked at signup surfaces
- [ ] Tax reporting position decided
- [ ] Incident plan: key compromise, freeze procedure, refund-all runbook
      (admin freeze + refund endpoints already exist)

**Bottom line:** everything currently deployed (testnet + mock) is safe to
run today. The engineering for real money is done and tested; the remaining
work for mainnet is regulatory, not technical — and holding real user funds
in a platform-controlled wallet without the above is the specific thing NOT
to do.
